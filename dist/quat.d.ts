import type { Vec3 } from './vec3.js';
/**
 * A rotation quaternion `x, y, z, w`, with `w` the scalar part. Rotations are unit quaternions; `q`
 * and `-q` are the same rotation. The type does not enforce unit length; {@link isUnitQuat} checks
 * it. Every function here returns a fresh, unfrozen array and leaves its arguments unchanged.
 */
export type Quat = readonly [number, number, number, number];
/** The rotation that turns nothing, `[0, 0, 0, 1]`; frozen. */
export declare const IDENTITY_QUAT: Quat;
/** The Euclidean length of `q` as a 4-vector: 1 for a rotation. */
export declare function quatLength(q: Quat): number;
/** True when no component of `q` is NaN or infinite. */
export declare function isFiniteQuat(q: Quat): boolean;
/** True when `q` is finite and its length is within `tolerance` (default `1e-6`) of 1. */
export declare function isUnitQuat(q: Quat, tolerance?: number): boolean;
/** The unit quaternion along `q`. Throws a RangeError for a zero-length or non-finite quaternion. */
export declare function quatNormalize(q: Quat): Quat;
/** The Hamilton product `a * b`: the rotation that applies `b` first, then `a`. */
export declare function quatMultiply(a: Quat, b: Quat): Quat;
/** The conjugate `[-x, -y, -z, w]`: the inverse rotation when `q` is a unit quaternion. */
export declare function quatConjugate(q: Quat): Quat;
/**
 * The multiplicative inverse of `q`, its conjugate divided by its squared length: for a unit
 * quaternion, the inverse rotation. Throws a RangeError for a zero-length or non-finite quaternion.
 */
export declare function quatInvert(q: Quat): Quat;
/**
 * Rotates vector `v` by unit quaternion `q`. The length of `q` is not checked; a quaternion that is
 * not unit also scales `v`.
 */
export declare function quatRotate(q: Quat, v: Vec3): Vec3;
/**
 * The rotation of `angle` radians about `axis`, counter-clockwise when the axis points at the
 * viewer (right-handed). The axis need not be unit length; a zero-length or non-finite axis
 * throws a RangeError.
 */
export declare function quatFromAxisAngle(axis: Vec3, angle: number): Quat;
/**
 * The rotation whose columns are the given orthonormal basis vectors: local +X maps to `xAxis`,
 * +Y to `yAxis` and +Z to `zAxis`. The basis must be right-handed and orthonormal, which is not
 * checked: any other basis still gives a unit quaternion, but not one that maps the axes so. A
 * non-finite basis throws a RangeError.
 */
export declare function quatFromBasis(xAxis: Vec3, yAxis: Vec3, zAxis: Vec3): Quat;
/**
 * The rotation that points local +Z along `forward` while keeping local +Y as close to `up` as
 * possible. Neither need be unit length. Throws a RangeError when `forward` or `up` is zero or not
 * finite, or when they are parallel.
 */
export declare function quatLookRotation(forward: Vec3, up: Vec3): Quat;
/**
 * True when the unit quaternions `a` and `b` describe the same rotation, treating `q` and `-q` as
 * equal: the absolute value of their 4-D dot product is within `epsilon` (default `1e-9`) of 1.
 */
export declare function quatSameRotation(a: Quat, b: Quat, epsilon?: number): boolean;
//# sourceMappingURL=quat.d.ts.map