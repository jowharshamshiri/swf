import { IDENTITY_QUAT, isUnitQuat, quatRotate, quatSameRotation } from './quat.js';
import { add, isFiniteVec3, isPositiveVec3, mul, ONE_VEC3, vec3ApproxEquals, ZERO_VEC3, } from './vec3.js';
/**
 * The transform that leaves every point where it is: no offset, no rotation, unit scale; frozen.
 */
export const IDENTITY_TRANSFORM = Object.freeze({
    position: ZERO_VEC3,
    rotation: IDENTITY_QUAT,
    scale: ONE_VEC3,
});
/** Maps a local point into the parent frame. The transform is not checked. */
export function transformPoint(t, p) {
    return add(t.position, quatRotate(t.rotation, mul(t.scale, p)));
}
/**
 * Why a transform is invalid, naming the field (`position`, `rotation` or `scale`, checked in that
 * order), or null when it is valid. The rotation counts as unit when its length is within
 * `quatTolerance` (default `1e-6`) of 1.
 */
export function transformIssue(t, quatTolerance = 1e-6) {
    if (!isFiniteVec3(t.position)) {
        return 'position must be three finite numbers';
    }
    if (!isUnitQuat(t.rotation, quatTolerance)) {
        return `rotation must be a finite unit quaternion (length within ${quatTolerance} of 1)`;
    }
    if (!isPositiveVec3(t.scale)) {
        return 'scale must be three finite positive numbers';
    }
    return null;
}
/**
 * True when `a` and `b` match within `epsilon` (default `1e-9`): positions and scales component by
 * component, and rotations as {@link quatSameRotation} compares them, so `q` and `-q` match.
 */
export function transformApproxEquals(a, b, epsilon = 1e-9) {
    return (vec3ApproxEquals(a.position, b.position, epsilon) &&
        quatSameRotation(a.rotation, b.rotation, epsilon) &&
        vec3ApproxEquals(a.scale, b.scale, epsilon));
}
//# sourceMappingURL=transform.js.map