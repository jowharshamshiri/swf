import type { Id, ResolvedGeometry, SceneState } from '@swf/core';
import {
  ancestorIds,
  effectiveState,
  nodeFrameGeometry,
  surfaceEffectiveState,
  worldMatrix,
} from '@swf/core';
import type { Mat4, Ray, Vec3 } from '@swf/math';
import type { HitRegion } from '@swf/models';
import { models } from '@swf/models';
import type { ViewGeometry } from '@swf/presentation';
import type { Continuity, Projection } from '@swf/projections';
import type { SceneIndex } from './scene-index.js';

/**
 * What part of the workspace a point is over:
 * - `content`: a surface's content, whose input stays native unless a takeover gesture is active;
 * - `chrome`: a window's frame, or a surface that only shows something;
 * - `resize-handle`: the band along a window's edges;
 * - `background`: no window;
 * - `modal-overlay`: anything outside an active modal, which takes no input.
 */
export type InputRegion = 'content' | 'chrome' | 'resize-handle' | 'background' | 'modal-overlay';

/**
 * The edge or corner of a resize handle, by compass point in the window's own frame: `n` is its
 * top (+Y), `e` its right (+X).
 */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * One thing a pointer ray hits. Only entities that are visible, take pointer input (they and every
 * ancestor) and lie within the camera's depth range are candidates.
 */
export interface PickCandidate {
  /** The window (or other node) hit, or the owner of the surface hit. */
  readonly nodeId: Id;
  /** The surface hit, or null for a node's own frame. */
  readonly surfaceId: Id | null;
  /**
   * What was hit: a surface whose interaction is `content`, a surface that only shows something or
   * a node's frame (`chrome`), or the resize band along a resizable node's edges.
   */
  readonly region: 'content' | 'chrome' | 'resize-handle';
  /**
   * The edge or corner whose resize band the hit lies in, for a resizable node's frame; null for
   * a surface, the frame's interior, or a node that is not resizable.
   */
  readonly edge: ResizeEdge | null;
  /** Distance from the camera along the ray, in world units. */
  readonly distance: number;
  /** Where the ray meets the entity, in world space. */
  readonly worldPoint: Vec3;
  /** The point in the hit entity's own frame: surface-local for a surface, node-local otherwise. */
  readonly localPoint: Vec3;
  /** The surface UV, (0, 0) top-left; null for a node's frame. */
  readonly uv: readonly [number, number] | null;
  /** The owner's plus the surface's presentation priority; higher picks first. */
  readonly priority: number;
  /** A nearer occluding candidate lies in front of this one. */
  readonly occluded: boolean;
  /**
   * The surface is shown here only as a proxy or placeholder: its content cannot take input in
   * this viewport, and the operator can focus or activate it instead.
   */
  readonly proxy: boolean;
}

/**
 * The world ray a viewport point picked along, as the projection's inverse gave it. Part of every
 * {@link PickResult} that has a ray.
 */
export interface RayInfo {
  /** In world space, from the camera's position, with a unit direction. */
  readonly ray: Ray;
  /**
   * Angle right of the camera's heading, in radians; unwrapped across a seam when continuity was
   * given, so it may lie outside (-π, π].
   */
  readonly longitude: number;
  /** Angle above the camera's horizon, in radians. */
  readonly latitude: number;
  /** `exact` when the projection's inverse is exact, `approximate` within `error` radians. */
  readonly confidence: 'exact' | 'approximate';
  /** Bound on the angle between the ray and the true one, in radians; 0 when exact. */
  readonly error: number;
}

/**
 * What lies under a viewport point: a hit, the background, or no ray at all (`outside` the view,
 * or `unpickable` where the projection has no inverse), never a guess.
 */
export type PickResult =
  | (RayInfo & {
      /** The ray hit something. */
      readonly kind: 'hit';
      /** The best candidate: the first of `candidates`. */
      readonly target: PickCandidate;
      /** The region of the target, or `modal-overlay` when a modal excludes it. */
      readonly region: InputRegion;
      /** Every candidate, best first. */
      readonly candidates: readonly PickCandidate[];
      /**
       * The best two candidates are distinct windows that tie on priority, occlusion and depth:
       * the target was chosen by ID, and a policy may ask the operator.
       */
      readonly ambiguous: boolean;
      /** What the operator can do instead of direct input, for a proxy target. */
      readonly actions: readonly ('focus' | 'activate')[];
    })
  | (RayInfo & {
      /** The ray hit nothing that takes pointer input. */
      readonly kind: 'background';
      /** `modal-overlay` while a modal is active, which the background is outside of. */
      readonly region: 'background' | 'modal-overlay';
    })
  | {
      /** The point is outside the view, or not a finite number. */
      readonly kind: 'outside';
      /** Why, in words for diagnostics. */
      readonly reason: string;
    }
  | {
      /** The point is inside the view, where the projection has no inverse to give. */
      readonly kind: 'unpickable';
      /** Why, in words for diagnostics. */
      readonly reason: string;
    };

/**
 * How a surface is presented in a viewport, as far as input is concerned: `live` when its own
 * content is shown and takes input, `proxy` when it is represented and the framework takes its
 * input. Called during picking; it must not change the scene.
 */
export type PresentationLookup = (surfaceId: Id, viewportId: Id) => 'live' | 'proxy';

/**
 * Whether a hit hides what lies behind it: `transparent` hits are still candidates but do not
 * mark the ones behind as occluded. Called during picking; it must not change the scene.
 */
export type OcclusionLookup = (candidate: {
  readonly nodeId: Id;
  readonly surfaceId: Id | null;
}) => 'occluding' | 'transparent';

/**
 * How {@link pick} decides what is hit. The values are used as given, but a depth tolerance that is
 * not finite and at least zero is refused.
 */
export interface PickOptions {
  /**
   * Width of the resize band along a window's edges, in CSS pixels, converted to a world width at
   * the hit's distance; a band never takes more than a quarter of the window's width or height.
   */
  readonly handlePx: number;
  /** Depths closer than this (world units) count as a tie. */
  readonly depthTolerance: number;
  /**
   * The nodes an active modal consists of, descendants included, or null without a modal. A hit
   * outside it is reported in the `modal-overlay` region.
   */
  readonly modal: ReadonlySet<Id> | null;
  /** How each surface is presented in the viewport picked in. */
  readonly presentation: PresentationLookup;
  /** Which hits hide what lies behind them. */
  readonly occlusion: OcclusionLookup;
}

/** What {@link pick} picks in. It reads all of it and changes none. */
export interface PickContext {
  /** The scene state picked in. */
  readonly scene: SceneState;
  /** The viewport's view of `scene`: its size, camera, depth range and projection. */
  readonly view: ViewGeometry;
  /** The projection of `view`, whose inverse gives the world ray. */
  readonly projection: Projection;
  /** An index brought up to date with `scene`. */
  readonly index: SceneIndex;
  /** Each surface's resolved geometry in `scene`, as the workspace places it. */
  readonly geometry: (surfaceId: Id) => ResolvedGeometry | undefined;
  /** How hits are decided. */
  readonly options: PickOptions;
}

/** Each hit region as the arbitration model names it. */
const HIT_REGIONS: Readonly<Record<PickCandidate['region'], HitRegion['kind']>> = Object.freeze({
  'resize-handle': 'resizeHandle',
  content: 'content',
  chrome: 'chrome',
});

/**
 * Picks at a viewport point: the projection's inverse gives the world ray, the index the entries
 * it may reach, and exact geometry the hits. Hits are kept only for entities that are visible,
 * take pointer input and lie within the camera's depth range, then ordered by presentation
 * priority, occlusion and depth. A surface split by a seam is one entity in the world, so it is
 * picked as one Surface ID wherever its fragments are. Where the projection has no inverse the
 * point is reported unpickable, never guessed.
 *
 * @param x Horizontal position in the viewport's CSS pixels, from its left edge.
 * @param y Vertical position in the viewport's CSS pixels, from its top edge.
 * @param continuity The previous longitude of a drag in progress, so a ray across a panorama's
 *   seam is unwrapped rather than jumping.
 * @throws Error when `context.index` was not brought up to date with `context.scene`.
 * @throws RangeError when `options.depthTolerance` is not finite and at least zero, or a hit's
 *   distance or presentation priority is not finite: the arbitration model orders only finite
 *   numbers.
 */
export function pick(
  context: PickContext,
  x: number,
  y: number,
  continuity?: Continuity,
): PickResult {
  const { scene, view, projection, options } = context;
  if (context.index.state !== scene) {
    throw new Error('the scene index is not up to date with the scene being picked');
  }
  const result = projection.interactionRay(x, y, view, continuity);
  if (result.kind !== 'ray') {
    return result;
  }
  const info: RayInfo = {
    ray: result.ray,
    longitude: result.longitude,
    latitude: result.latitude,
    confidence: result.error === 0 ? 'exact' : 'approximate',
    error: result.error,
  };
  const far = view.far ?? Infinity;
  // The angle one CSS pixel spans across the viewport, for sizing handles in the world.
  const pixelAngle = projection.describeDomain().horizontalCoverage / view.width;
  const raw: Omit<PickCandidate, 'occluded'>[] = [];
  for (const key of context.index.raycast(result.ray, far)) {
    const separator = key.indexOf(':');
    const id = key.slice(separator + 1);
    const hit = key.startsWith('surface:')
      ? surfaceHit(context, id, result.ray)
      : nodeHit(scene, id, result.ray, options.handlePx * pixelAngle);
    if (hit !== null && hit.distance >= view.near && hit.distance <= far) {
      raw.push(hit);
    }
  }
  // The arbitration model (`Swf.Arbitration`) merges the hits (a window's frame counts inside it
  // only where no surface of its own covers it, except along its resize band), marks the occluded
  // ones and orders them. It refuses a number it cannot order: a depth tolerance that is not finite
  // and at least zero, or a hit whose distance or priority is not finite.
  const outcome = models.pickOrder(
    raw.map((hit) => ({
      node: hit.nodeId,
      surface: hit.surfaceId,
      region: { kind: HIT_REGIONS[hit.region] },
      distance: hit.distance,
      priority: hit.priority,
      occluding:
        options.occlusion({ nodeId: hit.nodeId, surfaceId: hit.surfaceId }) === 'occluding',
    })),
    options.depthTolerance,
  );
  if (outcome.kind === 'invalidTolerance') {
    throw new RangeError(
      `the depth tolerance is finite and at least zero (got ${String(options.depthTolerance)})`,
    );
  }
  if (outcome.kind === 'invalidHit') {
    const hit = raw[Number(outcome.hit)];
    if (hit === undefined) {
      throw new Error(
        `the arbitration model refused hit ${String(outcome.hit)}, which is not given`,
      );
    }
    const value = outcome.field === 'distance' ? hit.distance : hit.priority;
    const on = hit.surfaceId === null ? `node "${hit.nodeId}"` : `surface "${hit.surfaceId}"`;
    throw new RangeError(
      `the ${outcome.field} of the hit on ${on} is not finite (got ${String(value)})`,
    );
  }
  const decided = outcome.pick;
  const candidates: PickCandidate[] = decided.order.map((index, k) => {
    const hit = raw[Number(index)];
    const occluded = decided.occluded[k];
    if (hit === undefined || occluded === undefined) {
      throw new Error(`the arbitration model ordered hit ${String(index)}, which is not given`);
    }
    return { ...hit, occluded };
  });
  const target = candidates[0];
  if (target === undefined) {
    return {
      ...info,
      kind: 'background',
      region: options.modal === null ? 'background' : 'modal-overlay',
    };
  }
  const ambiguous = decided.ambiguous;
  const excluded = options.modal !== null && !options.modal.has(target.nodeId);
  return {
    ...info,
    kind: 'hit',
    target,
    region: excluded ? 'modal-overlay' : target.region,
    candidates,
    ambiguous,
    actions: target.proxy ? ['focus', 'activate'] : [],
  };
}

/** A hit on a surface that takes pointer input, or null. */
function surfaceHit(ctx: PickContext, surfaceId: Id, ray: Ray) {
  const surface = ctx.scene.surfaces.get(surfaceId);
  const state = surfaceEffectiveState(ctx.scene, surfaceId);
  if (
    surface === undefined ||
    state?.visible !== true ||
    !surface.flags.pointerEnabled ||
    !takesPointer(ctx.scene, surface.ownerNodeId)
  ) {
    return null;
  }
  const g = ctx.geometry(surfaceId);
  const hit = g?.intersect(ray) ?? null;
  if (hit === null) {
    return null;
  }
  const owner = ctx.scene.nodes.get(surface.ownerNodeId);
  const proxy = ctx.options.presentation(surfaceId, ctx.view.viewportId) === 'proxy';
  return {
    nodeId: surface.ownerNodeId,
    surfaceId,
    region: surface.interaction === 'content' ? ('content' as const) : ('chrome' as const),
    edge: null,
    distance: hit.distance,
    worldPoint: hit.point,
    localPoint: hit.localPoint,
    uv: hit.uv,
    priority: (owner?.flags.presentationPriority ?? 0) + surface.flags.presentationPriority,
    proxy,
  };
}

/** The node and all its ancestors are active, visible and take pointer input. */
function takesPointer(scene: SceneState, nodeId: Id): boolean {
  if (effectiveState(scene.nodes, nodeId)?.visible !== true) {
    return false;
  }
  return [nodeId, ...ancestorIds(scene.nodes, nodeId)].every(
    (id) => scene.nodes.get(id)?.flags.pointerEnabled === true,
  );
}

/**
 * A hit on a node's frame: its bounds rectangle in its local z = 0 plane, with a resize band of
 * `bandAngle` radians (as seen from the ray origin) along its edges.
 */
function nodeHit(scene: SceneState, nodeId: Id, ray: Ray, bandAngle: number) {
  const node = scene.nodes.get(nodeId);
  const world = worldMatrix(scene.nodes, nodeId);
  if (node === undefined || world === undefined || !takesPointer(scene, nodeId)) {
    return null;
  }
  // The frame is the same rectangle window chrome is drawn from.
  const hit = nodeFrameGeometry(scene, nodeId)?.intersect(ray) ?? null;
  if (hit === null) {
    return null;
  }
  const [w, h] = node.bounds;
  const local = hit.localPoint;
  const worldPoint = hit.point;
  const distance = hit.distance;
  const edge = edgeAt(local, w, h, distance * bandAngle, world);
  return {
    nodeId,
    surfaceId: null,
    region:
      edge === null || !node.flags.resizable ? ('chrome' as const) : ('resize-handle' as const),
    edge: node.flags.resizable ? edge : null,
    distance,
    worldPoint,
    localPoint: local,
    uv: null,
    priority: node.flags.presentationPriority,
    proxy: false,
  };
}

/** The edge or corner whose band contains the local point, or null for the interior. */
function edgeAt(local: Vec3, w: number, h: number, band: number, world: Mat4): ResizeEdge | null {
  // The band is a world width; in local units it shrinks with the node's scale, and it never
  // takes more than a quarter of the window, so small windows keep their middle.
  const scaleX = Math.hypot(world[0], world[1], world[2]);
  const scaleY = Math.hypot(world[4], world[5], world[6]);
  const bx = Math.min(band / scaleX, w / 4);
  const by = Math.min(band / scaleY, h / 4);
  const vertical = local[1] >= h / 2 - by ? 'n' : local[1] <= -h / 2 + by ? 's' : '';
  const horizontal = local[0] >= w / 2 - bx ? 'e' : local[0] <= -w / 2 + bx ? 'w' : '';
  const edge = `${vertical}${horizontal}`;
  return edge === '' ? null : (edge as ResizeEdge);
}
