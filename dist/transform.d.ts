import type { Quat } from './quat.js';
import type { Vec3 } from './vec3.js';
/**
 * A rigid placement with positive scale: a point `p` in the local frame maps to
 * `position + rotate(rotation, scale * p)` in the parent frame. The type does not enforce the rules
 * on its fields; {@link transformIssue} checks them.
 */
export interface Transform3D {
    /** Where the local origin sits in the parent frame: three finite numbers, in world units. */
    readonly position: Vec3;
    /** The local frame's orientation in the parent frame: a finite unit quaternion. */
    readonly rotation: Quat;
    /**
     * The local frame's scale along its own x, y and z axes, applied before the rotation: three
     * finite, strictly positive numbers.
     */
    readonly scale: Vec3;
}
/**
 * The transform that leaves every point where it is: no offset, no rotation, unit scale; frozen.
 */
export declare const IDENTITY_TRANSFORM: Transform3D;
/** Maps a local point into the parent frame. The transform is not checked. */
export declare function transformPoint(t: Transform3D, p: Vec3): Vec3;
/**
 * Why a transform is invalid, naming the field (`position`, `rotation` or `scale`, checked in that
 * order), or null when it is valid. The rotation counts as unit when its length is within
 * `quatTolerance` (default `1e-6`) of 1.
 */
export declare function transformIssue(t: Transform3D, quatTolerance?: number): string | null;
/**
 * True when `a` and `b` match within `epsilon` (default `1e-9`): positions and scales component by
 * component, and rotations as {@link quatSameRotation} compares them, so `q` and `-q` match.
 */
export declare function transformApproxEquals(a: Transform3D, b: Transform3D, epsilon?: number): boolean;
//# sourceMappingURL=transform.d.ts.map