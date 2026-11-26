import type { Id, ResolvedGeometry, SceneState } from '@swf/core';
import type { Ray, Vec3 } from '@swf/math';
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
export type PickResult = (RayInfo & {
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
}) | (RayInfo & {
    /** The ray hit nothing that takes pointer input. */
    readonly kind: 'background';
    /** `modal-overlay` while a modal is active, which the background is outside of. */
    readonly region: 'background' | 'modal-overlay';
}) | {
    /** The point is outside the view, or not a finite number. */
    readonly kind: 'outside';
    /** Why, in words for diagnostics. */
    readonly reason: string;
} | {
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
export declare function pick(context: PickContext, x: number, y: number, continuity?: Continuity): PickResult;
//# sourceMappingURL=pick.d.ts.map