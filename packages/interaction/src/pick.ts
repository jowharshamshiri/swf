import type { Id, ResolvedGeometry, SceneState } from '@swf/core';
import {
  ancestorIds,
  effectiveState,
  nodeFrameGeometry,
  surfaceEffectiveState,
  worldMatrix,
} from '@swf/core';
import type { Mat4, Ray, Vec3 } from '@swf/math';
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

/** The edge or corner of a resize handle. */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** One thing a pointer ray hits. */
export interface PickCandidate {
  /** The window (or other node) hit, or the owner of the surface hit. */
  readonly nodeId: Id;
  /** The surface hit, or null for a node's own frame. */
  readonly surfaceId: Id | null;
  readonly region: 'content' | 'chrome' | 'resize-handle';
  readonly edge: ResizeEdge | null;
  /** Distance from the camera along the ray. */
  readonly distance: number;
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

interface RayInfo {
  readonly ray: Ray;
  readonly longitude: number;
  readonly latitude: number;
  /** `exact` when the projection's inverse is exact, `approximate` within `error` radians. */
  readonly confidence: 'exact' | 'approximate';
  readonly error: number;
}

/** What lies under a viewport point. */
export type PickResult =
  | (RayInfo & {
      readonly kind: 'hit';
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
  | (RayInfo & { readonly kind: 'background'; readonly region: 'background' | 'modal-overlay' })
  | { readonly kind: 'outside'; readonly reason: string }
  | { readonly kind: 'unpickable'; readonly reason: string };

/** How a surface is presented in a viewport, as far as input is concerned. */
export type PresentationLookup = (surfaceId: Id, viewportId: Id) => 'live' | 'proxy';

/** Whether a hit hides what lies behind it. */
export type OcclusionLookup = (candidate: {
  readonly nodeId: Id;
  readonly surfaceId: Id | null;
}) => 'occluding' | 'transparent';

export interface PickOptions {
  /** Width of the resize band along a window's edges, in CSS pixels. */
  readonly handlePx: number;
  /** Depths closer than this (world units) count as a tie. */
  readonly depthTolerance: number;
  /** The nodes an active modal consists of (with their descendants), or null without a modal. */
  readonly modal: ReadonlySet<Id> | null;
  readonly presentation: PresentationLookup;
  readonly occlusion: OcclusionLookup;
}

export interface PickContext {
  readonly scene: SceneState;
  readonly view: ViewGeometry;
  readonly projection: Projection;
  /** An index brought up to date with `scene`. */
  readonly index: SceneIndex;
  readonly geometry: (surfaceId: Id) => ResolvedGeometry | undefined;
  readonly options: PickOptions;
}

const REGION_RANK = { 'resize-handle': 0, content: 1, chrome: 2 } as const;

/**
 * Picks at a viewport point: the projection's inverse gives the world ray, the index the entries
 * it may reach, and exact geometry the hits. Hits are kept only for entities that are visible,
 * take pointer input and lie within the camera's depth range, then ordered by presentation
 * priority, occlusion and depth. A surface split by a seam is one entity in the world, so it is
 * picked as one Surface ID wherever its fragments are. Where the projection has no inverse the
 * point is reported unpickable, never guessed.
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
  // Inside a window, its frame counts only where no surface of its own covers it, except along
  // its edges, where the resize band comes first.
  const covered = new Set(raw.filter((c) => c.surfaceId !== null).map((c) => c.nodeId));
  const merged = raw.filter((c) => {
    if (c.surfaceId === null && c.region === 'chrome' && covered.has(c.nodeId)) {
      return false;
    }
    if (c.surfaceId !== null) {
      return !raw.some(
        (h) => h.surfaceId === null && h.nodeId === c.nodeId && h.region === 'resize-handle',
      );
    }
    return true;
  });
  const byDepth = [...merged].sort((a, b) => a.distance - b.distance);
  const candidates: PickCandidate[] = merged.map((c) => ({
    ...c,
    occluded: byDepth.some(
      (h) =>
        h !== c &&
        h.distance + options.depthTolerance < c.distance &&
        options.occlusion({ nodeId: h.nodeId, surfaceId: h.surfaceId }) === 'occluding',
    ),
  }));
  candidates.sort(compareCandidates);
  const target = candidates[0];
  if (target === undefined) {
    return {
      ...info,
      kind: 'background',
      region: options.modal === null ? 'background' : 'modal-overlay',
    };
  }
  const second = candidates[1];
  const ambiguous =
    second !== undefined &&
    second.nodeId !== target.nodeId &&
    second.priority === target.priority &&
    second.occluded === target.occluded &&
    Math.abs(second.distance - target.distance) <= options.depthTolerance;
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

function compareCandidates(a: PickCandidate, b: PickCandidate): number {
  const id = (c: PickCandidate) => `${c.nodeId}\u0000${c.surfaceId ?? ''}`;
  return (
    b.priority - a.priority ||
    Number(a.occluded) - Number(b.occluded) ||
    a.distance - b.distance ||
    REGION_RANK[a.region] - REGION_RANK[b.region] ||
    (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0)
  );
}
