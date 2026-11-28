import type { Id, ResolvedGeometry, SceneState } from '@swf/core';
import { ancestorIds, effectiveState, surfaceEffectiveState, worldMatrix } from '@swf/core';
import type { Ray, Vec3 } from '@swf/math';
import { mat4TransformPoint } from '@swf/math';
import type { HitRegion } from '@swf/models';
import { models } from '@swf/models';
import type {
  PointerPrecision,
  ProjectedFragment,
  ResizeEdge,
  ScreenRect,
  ViewGeometry,
} from '@swf/presentation';
import { bandEdgeAt, titleBarOf, WINDOW_HANDLES } from '@swf/presentation';
import type { Continuity, Projection } from '@swf/projections';

/**
 * What part of the workspace a point is over:
 * - `content`: a surface's content, whose input stays native unless a takeover gesture is active;
 * - `chrome`: a window's card where no content takes input: its frame, a surface that only shows
 *   something, or a picture of content (a copy of a card across a seam);
 * - `title-bar`: the bar across the top of a window's card, drawn over every card;
 * - `resize-handle`: the band round a window's outline;
 * - `background`: no window;
 * - `modal-overlay`: anything outside an active modal, which takes no input.
 */
export type InputRegion =
  'content' | 'chrome' | 'title-bar' | 'resize-handle' | 'background' | 'modal-overlay';

export type { ResizeEdge } from '@swf/presentation';

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
   * What was hit: a surface whose interaction is `content`, a surface that only shows something, a
   * picture of a surface's content or a node's frame (`chrome`), a window's title bar, or the
   * resize band round a resizable node's outline.
   */
  readonly region: 'content' | 'chrome' | 'title-bar' | 'resize-handle';
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
  /**
   * The card's CSS pixels for each unit of the hit entity's own size, across and up: how far a
   * pointer moves on screen for a unit of its width or height.
   */
  readonly pixelsPerUnit: readonly [number, number];
  /** The owner's plus the surface's presentation priority; higher picks first. */
  readonly priority: number;
  /** A nearer occluding candidate lies in front of this one. */
  readonly occluded: boolean;
  /**
   * The surface is shown here only as a proxy or placeholder: its content cannot take input in
   * this viewport, and the operator can focus or activate it instead.
   */
  readonly proxy: boolean;
  /**
   * The view brings the window in front of every other, their title bars included (the one focus
   * shows): it is picked before them.
   */
  readonly front: boolean;
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
   * How precisely the pointer points, which sizes the windows' title bars and resize bands as a
   * press counts them (`WINDOW_HANDLES` of `@swf/presentation`).
   */
  readonly precision: PointerPrecision;
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
  /**
   * The view's fragments of `scene`, each surface on its window's card, as the view draws them
   * (`projectorOf` of `@swf/projections`, with the viewport's representation policy).
   */
  readonly cards: readonly ProjectedFragment[];
  /** Each surface's resolved geometry in `scene`, as the workspace places it. */
  readonly geometry: (surfaceId: Id) => ResolvedGeometry | undefined;
  /** How hits are decided. */
  readonly options: PickOptions;
}

/** Each hit region as the arbitration model names it. */
const HIT_REGIONS: Readonly<Record<PickCandidate['region'], HitRegion['kind']>> = Object.freeze({
  'resize-handle': 'resizeHandle',
  'title-bar': 'titleBar',
  content: 'content',
  chrome: 'chrome',
});

/**
 * Picks at a viewport point what the view draws there: each surface where it lies on its window's
 * card, each window's card and its title bar, and the resize band round a resizable window's
 * outline, sized for the pointer's precision (`WINDOW_HANDLES`). Hits are kept only for entities
 * that are visible and take pointer input, then ordered by presentation priority, title bars before
 * the rest (they are drawn over every card), occlusion and depth (the card's distance). A card drawn at
 * both edges of a seam is one window, so it is picked as one Surface ID at either. The projection's
 * inverse gives the ray the point looks along; where it has none the point is reported
 * unpickable, never guessed.
 *
 * @param x Horizontal position in the viewport's CSS pixels, from its left edge.
 * @param y Vertical position in the viewport's CSS pixels, from its top edge.
 * @param continuity The previous longitude of a drag in progress, so a ray across a panorama's
 *   seam is unwrapped rather than jumping.
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
  const raw: Omit<PickCandidate, 'occluded'>[] = [];
  // Each window's card is its frame once, at each place it is drawn.
  const framed = new Set<string>();
  for (const fragment of context.cards) {
    const nodeId = scene.surfaces.get(fragment.surfaceId)?.ownerNodeId;
    if (nodeId === undefined) {
      continue;
    }
    if (inside(fragment.bounds, x, y)) {
      const hit = surfaceHit(context, fragment, x, y);
      if (hit !== null) {
        raw.push(hit);
      }
    }
    const copy = `${nodeId}\u0000${String(fragment.ordinal)}`;
    if (!framed.has(copy)) {
      framed.add(copy);
      const hit = nodeHit(scene, nodeId, fragment, x, y, options.precision);
      if (hit !== null) {
        raw.push(hit);
      }
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
      front: hit.front,
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

/** Whether a point lies in a rect, its left and top edges included. */
function inside([rx, ry, rw, rh]: ScreenRect, x: number, y: number): boolean {
  return x >= rx && x < rx + rw && y >= ry && y < ry + rh;
}

/** A hit at (`x`, `y`) on a surface where it lies on its card, when it takes pointer input. */
function surfaceHit(ctx: PickContext, fragment: ProjectedFragment, x: number, y: number) {
  const { surfaceId } = fragment;
  const surface = ctx.scene.surfaces.get(surfaceId);
  const state = surfaceEffectiveState(ctx.scene, surfaceId);
  const geometry = ctx.geometry(surfaceId);
  if (
    surface === undefined ||
    geometry === undefined ||
    state?.visible !== true ||
    !surface.flags.pointerEnabled ||
    !takesPointer(ctx.scene, surface.ownerNodeId)
  ) {
    return null;
  }
  const [bx, by, bw, bh] = fragment.bounds;
  const uv = [(x - bx) / bw, (y - by) / bh] as const;
  const [w, h] = surface.bounds;
  const localPoint: Vec3 = [(uv[0] - 0.5) * w, (0.5 - uv[1]) * h, 0];
  const owner = ctx.scene.nodes.get(surface.ownerNodeId);
  const proxy = ctx.options.presentation(surfaceId, ctx.view.viewportId) === 'proxy';
  // Live content takes input only where it is itself: a copy of its card across a seam shows a
  // picture of it, which is handled as the window's card.
  const live = surface.interaction === 'content' && (proxy || fragment.nativeOwner);
  return {
    nodeId: surface.ownerNodeId,
    surfaceId,
    region: live ? ('content' as const) : ('chrome' as const),
    edge: null,
    distance: fragment.depth,
    worldPoint: mat4TransformPoint(geometry.world, localPoint),
    localPoint,
    uv,
    pixelsPerUnit: [bw / w, bh / h] as const,
    priority: (owner?.flags.presentationPriority ?? 0) + surface.flags.presentationPriority,
    proxy,
    front: fragment.front,
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
 * A hit at (`x`, `y`) on a window's handles or its card: the resize band round a resizable window's
 * outline first, then its title bar, then its card (its frame), each sized for the pointer's
 * precision (`WINDOW_HANDLES`); null where the point is on none of them.
 */
function nodeHit(
  scene: SceneState,
  nodeId: Id,
  fragment: ProjectedFragment,
  x: number,
  y: number,
  precision: PointerPrecision,
) {
  const node = scene.nodes.get(nodeId);
  const world = worldMatrix(scene.nodes, nodeId);
  if (node === undefined || world === undefined || !takesPointer(scene, nodeId)) {
    return null;
  }
  const { card, representation } = fragment;
  const edge = node.flags.resizable ? bandEdgeAt(card, representation, precision, x, y) : null;
  const bar = titleBarOf(card, representation, WINDOW_HANDLES[precision].titleBar);
  const region =
    edge !== null
      ? ('resize-handle' as const)
      : inside(bar, x, y)
        ? ('title-bar' as const)
        : inside(card, x, y)
          ? ('chrome' as const)
          : null;
  if (region === null) {
    return null;
  }
  const [cx, cy, cw, ch] = card;
  const [w, h] = node.bounds;
  const localPoint: Vec3 = [((x - cx) / cw - 0.5) * w, (0.5 - (y - cy) / ch) * h, 0];
  return {
    nodeId,
    surfaceId: null,
    region,
    edge,
    distance: fragment.depth,
    worldPoint: mat4TransformPoint(world, localPoint),
    localPoint,
    uv: null,
    pixelsPerUnit: [cw / w, ch / h] as const,
    priority: node.flags.presentationPriority,
    proxy: false,
    front: fragment.front,
  };
}
