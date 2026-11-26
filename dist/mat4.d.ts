import type { Transform3D } from './transform.js';
import type { Vec3 } from './vec3.js';
/**
 * A 4x4 affine matrix in column-major order: element (row r, column c) is at index `c * 4 + r`.
 * Points are column vectors, so `mat4Multiply(a, b)` applies `b` first, and the translation is at
 * indices 12, 13 and 14. Every function here returns a fresh, unfrozen array and leaves its
 * arguments unchanged.
 */
export type Mat4 = readonly [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number
];
/** The identity matrix; frozen. */
export declare const IDENTITY_MAT4: Mat4;
/**
 * The matrix of a transform: translate * rotate * scale, so scale applies first. The rotation is
 * used as given: a quaternion that is not unit length gives a matrix that also scales. The
 * transform is not checked; {@link transformIssue} does that.
 */
export declare function mat4FromTransform(t: Transform3D): Mat4;
/** The product `a * b`, which applies `b` first. */
export declare function mat4Multiply(a: Mat4, b: Mat4): Mat4;
/** Maps the point `p` by `m`, translation included. The bottom row of `m` is ignored. */
export declare function mat4TransformPoint(m: Mat4, p: Vec3): Vec3;
/**
 * Maps the direction `d` by the linear part of `m` only, without translation. The result is not
 * normalized: a scaling matrix changes its length.
 */
export declare function mat4TransformDirection(m: Mat4, d: Vec3): Vec3;
/**
 * The inverse of an affine matrix, or null when its linear part is singular or its determinant is
 * not finite. The bottom row is taken to be 0 0 0 1 and is not read.
 */
export declare function mat4InvertAffine(m: Mat4): Mat4 | null;
/**
 * Why {@link mat4Decompose} could not split a matrix: an element is not finite (`non-finite`), a
 * basis column has zero length (`singular`), the matrix mirrors space (`reflection`), or its basis
 * columns are not perpendicular (`shear`).
 */
export type DecomposeFailure = 'non-finite' | 'singular' | 'reflection' | 'shear';
/** What {@link mat4Decompose} gives: the transform, or why there is none. */
export type DecomposeResult = {
    /** The matrix was split. */
    readonly ok: true;
    /** The position, unit rotation and positive scale the matrix composes from. */
    readonly transform: Transform3D;
} | {
    /** The matrix has no position, rotation and positive scale. */
    readonly ok: false;
    /** Why not. */
    readonly reason: DecomposeFailure;
};
/**
 * Splits an affine matrix into position, rotation and positive scale. Fails when the matrix is not
 * finite, is singular, mirrors space (negative determinant), or shears: a rotated parent with
 * non-uniform scale composes into a shear that no position/rotation/scale triple represents.
 * `tolerance` (default `1e-9`) bounds the cosine between the normalized basis columns. The bottom
 * row is not read. A failure is returned, not thrown.
 */
export declare function mat4Decompose(m: Mat4, tolerance?: number): DecomposeResult;
/**
 * True when every element of `a` is within `epsilon` (an absolute difference, default `1e-9`) of
 * the same element of `b`. False when either holds NaN.
 */
export declare function mat4ApproxEquals(a: Mat4, b: Mat4, epsilon?: number): boolean;
//# sourceMappingURL=mat4.d.ts.map