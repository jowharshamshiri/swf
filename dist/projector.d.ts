import type { Id, ResolvedGeometry, SceneState } from '@swf/core';
import type { Ray, Vec3 } from '@swf/math';
import type { ViewGeometry, ViewProjector } from '@swf/presentation';
import type { Continuity, Projection, ProjectionModule } from './contract.js';
/**
 * Looks up a surface's geometry as placed in the scene being projected or picked (a workspace's
 * `presentedGeometry`, say); undefined when there is none. It is only read, never retained past
 * the call it is given to.
 */
export type GeometryOf = (surfaceId: Id) => ResolvedGeometry | undefined;
/**
 * The configured projection a view uses, from the module the view names. Throws
 * {@link SwfFailure} (`INVALID_INPUT`, naming the viewport) when the view is malformed, names
 * another projection, or carries a configuration the module rejects. The projection is created
 * afresh on each call and holds no resources.
 */
export declare function projectionFor(module: ProjectionModule, view: ViewGeometry): Projection;
/**
 * Stage 4 for a projection module: the fragments of every visible surface of the scene, as the
 * view's configured projection places them. A surface the scene shows but that has no resolved
 * geometry is an inconsistency, reported as {@link SwfFailure} (`INVALID_INPUT`); so is a view
 * {@link projectionFor} refuses. Given a previous projection, the fragments of each surface whose
 * own record and every ancestor's are unchanged are kept as they were. The projector returned is
 * frozen and stateless, with the module's profile.
 */
export declare function projectorOf(module: ProjectionModule): ViewProjector;
/** A surface a pointer ray hits. */
export interface PickCandidate {
    /** The surface hit: one candidate per surface, however many fragments it shows as. */
    readonly surfaceId: Id;
    /** Distance from the camera along the ray, in world units; within the view's depth range. */
    readonly distance: number;
    /** Where the ray meets the surface, in world coordinates. */
    readonly point: Vec3;
    /**
     * Where on the surface the ray meets it, as its geometry gives it: for a rectangle, (0, 0) is
     * the top-left corner and (1, 1) the bottom-right.
     */
    readonly uv: readonly [number, number];
}
/** What lies under a viewport point. */
export type Pick = {
    /** The point has a ray; `candidates` may still be empty. */
    readonly kind: 'hits';
    /** The interaction ray, in world space from the camera, with a unit direction. */
    readonly ray: Ray;
    /** Bound on the ray's angular error, in radians. */
    readonly error: number;
    /**
     * Angle right of the camera's heading, in radians; unwrapped to the drag's branch when
     * continuity was given.
     */
    readonly longitude: number;
    /** Angle above the camera's horizon, in radians, in [-π/2, π/2]. */
    readonly latitude: number;
    /** Every selectable surface the ray hits, nearest first (then by Surface ID). */
    readonly candidates: readonly PickCandidate[];
} | {
    /** The point is outside the view. */
    readonly kind: 'outside';
    /** Why, in words for diagnostics. */
    readonly reason: string;
} | {
    /** The point is inside the view, where the projection has no inverse; nothing is guessed. */
    readonly kind: 'unpickable';
    /** Why, in words for diagnostics. */
    readonly reason: string;
};
/**
 * The selectable surfaces under a viewport point, as ordered candidates along the projection's
 * interaction ray. Where the projection has no inverse the point is reported unpickable rather than
 * guessed; with `continuity`, the longitude is unwrapped to stay continuous during a drag. A
 * surface counts when it and its owner are effectively selectable, and its hit lies within the
 * view's `near` and `far` distances.
 *
 * @param projection - The projection configured for `view`, from {@link projectionFor}.
 * @param scene - The scene whose surfaces are picked (a workspace's presented scene, so open
 *   previews count).
 * @param x - Viewport CSS pixels from the left edge.
 * @param y - Viewport CSS pixels from the top edge.
 * @param geometry - Each surface's geometry as placed in `scene`.
 * @throws An {@link SwfFailure} (`INVALID_INPUT`) when a selectable surface has no geometry.
 * @example
 * ```ts
 * const view = viewGeometryOf(workspace.getPresented(), 'main');
 * const pick = pickAt(projectionFor(equirectangular, view), workspace.getPresented(), view,
 *   event.offsetX, event.offsetY, (id) => workspace.presentedGeometry(id));
 * const target = pick.kind === 'hits' ? pick.candidates[0]?.surfaceId : undefined;
 * ```
 */
export declare function pickAt(projection: Projection, scene: SceneState, view: ViewGeometry, x: number, y: number, geometry: GeometryOf, continuity?: Continuity): Pick;
//# sourceMappingURL=projector.d.ts.map