import type { Id, SceneState } from '@swf/core';
import type { Mat4, Ray, Transform3D, Vec3 } from '@swf/math';
/**
 * How a drag maps pointer movement to world movement:
 * - `camera-plane`: on the plane through the grabbed point facing the camera (the default);
 * - `world-plane`: on a fixed world plane through the grabbed point;
 * - `angular-shell`: around the camera at a constant distance, turning the window with it so it
 *   keeps facing the same way relative to the camera.
 * In every mode, distance from the camera changes only through the drag's separate depth.
 */
export type DragMode = 'camera-plane' | 'world-plane' | 'angular-shell';
/** Every drag mode, the default first; frozen. */
export declare const DRAG_MODES: readonly DragMode[];
/** What a drag fixed when it started, in world space and units. */
export interface DragFrame {
    /** How the drag maps pointer movement to world movement. */
    readonly mode: DragMode;
    /** The camera position at the start of the drag. */
    readonly eye: Vec3;
    /** The grabbed world point. */
    readonly anchor: Vec3;
    /**
     * The plane's unit normal (planar modes): the given world-plane normal for `world-plane`, the
     * direction from the eye to the anchor otherwise.
     */
    readonly normal: Vec3;
    /** The anchor's distance from the eye. */
    readonly radius: number;
    /** Nearest distance from the eye the anchor may be moved to. */
    readonly minDistance: number;
}
/**
 * Fixes a drag of the point `anchor`, seen from `eye`, in `mode`. `worldPlaneNormal` is used only
 * for `world-plane` and need not be unit length. The returned frame is fresh and unfrozen and
 * keeps `eye` and `anchor` as given.
 *
 * @throws RangeError when `anchor` is at `eye`, or when a `world-plane` normal is zero or not
 *   finite.
 */
export declare function dragFrame(mode: DragMode, eye: Vec3, anchor: Vec3, worldPlaneNormal: Vec3, minDistance: number): DragFrame;
/**
 * Where the grabbed point goes for a pointer ray, with `depth` added along the line from the
 * camera; null when the ray cannot reach the drag's surface (it runs parallel to the plane or away
 * from it), in which case the drag holds its last position instead of jumping.
 */
export declare function dragAnchor(frame: DragFrame, ray: Ray, depth: number): Vec3 | null;
/**
 * `point` moved by `depth` along the line from `eye` (positive away from it), never nearer than
 * `minDistance`. A point at `eye` is returned as it is.
 */
export declare function withDepth(eye: Vec3, point: Vec3, depth: number, minDistance: number): Vec3;
/** A node's placement: its local transform and the world it lives in. */
export interface Placement {
    /** The node's transform relative to its parent, as the scene holds it. */
    readonly local: Transform3D;
    /** The world matrix of the node's parent (identity for a root). */
    readonly parentWorld: Mat4;
    /** The node's world matrix. */
    readonly world: Mat4;
}
/** The node's placement in `scene`; throws {@link SwfFailure} (`UNKNOWN_ENTITY`) if absent. */
export declare function placementOf(scene: SceneState, nodeId: Id): Placement;
/** The node's world origin: the translation of its world matrix. */
export declare function worldOrigin(placement: Placement): Vec3;
/** The local transform that moves the node by `delta` in the world; null if the parent is singular. */
export declare function translatedBy(placement: Placement, delta: Vec3): Transform3D | null;
/**
 * The local transform that turns the node by `yaw` radians about the world vertical through
 * `pivot`; positive turns to the right (clockwise seen from above). Null when the parent's
 * placement cannot be decomposed or inverted.
 */
export declare function turnedAbout(placement: Placement, pivot: Vec3, yaw: number): Transform3D | null;
/**
 * The node's local transform after its grabbed point moved from the frame's anchor to `anchor`.
 * Planar modes translate it; the angular shell also turns it about the vertical through the
 * grabbed point by the change in heading, so it keeps facing the camera the same way. Null when
 * the parent's placement cannot be inverted.
 */
export declare function movedTransform(placement: Placement, frame: DragFrame, anchor: Vec3): Transform3D | null;
/**
 * The heading of `direction`: radians right of -Z about +Y, in [-π, π]; 0 for a vertical
 * direction.
 */
export declare function headingOf(direction: Vec3): number;
//# sourceMappingURL=drag.d.ts.map