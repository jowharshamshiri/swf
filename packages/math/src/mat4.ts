import type { Quat } from './quat.js';
import { quatFromBasis } from './quat.js';
import type { Transform3D } from './transform.js';
import type { Vec3 } from './vec3.js';
import { cross, dot, length, scale } from './vec3.js';

/**
 * A 4x4 affine matrix in column-major order: element (row r, column c) is at index `c * 4 + r`.
 * Points are column vectors, so `multiply(a, b)` applies `b` first.
 */
export type Mat4 = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
]; // prettier-ignore

export const IDENTITY_MAT4: Mat4 = Object.freeze([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
] as const);

/** The matrix of a transform: translate * rotate * scale. */
export function mat4FromTransform(t: Transform3D): Mat4 {
  const [x, y, z, w] = t.rotation;
  const [sx, sy, sz] = t.scale;
  const [px, py, pz] = t.position;
  const xx = x * x;
  const yy = y * y;
  const zz = z * z;
  const xy = x * y;
  const xz = x * z;
  const yz = y * z;
  const wx = w * x;
  const wy = w * y;
  const wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    px, py, pz, 1,
  ]; // prettier-ignore
}

/** The product `a * b`, which applies `b` first. */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15] = a;
  const column = (x: number, y: number, z: number, w: number) =>
    [
      a0 * x + a4 * y + a8 * z + a12 * w,
      a1 * x + a5 * y + a9 * z + a13 * w,
      a2 * x + a6 * y + a10 * z + a14 * w,
      a3 * x + a7 * y + a11 * z + a15 * w,
    ] as const;
  return [
    ...column(b[0], b[1], b[2], b[3]),
    ...column(b[4], b[5], b[6], b[7]),
    ...column(b[8], b[9], b[10], b[11]),
    ...column(b[12], b[13], b[14], b[15]),
  ];
}

export function mat4TransformPoint(m: Mat4, p: Vec3): Vec3 {
  const [x, y, z] = p;
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

/** Applies the linear part only (no translation). */
export function mat4TransformDirection(m: Mat4, d: Vec3): Vec3 {
  const [x, y, z] = d;
  return [
    m[0] * x + m[4] * y + m[8] * z,
    m[1] * x + m[5] * y + m[9] * z,
    m[2] * x + m[6] * y + m[10] * z,
  ];
}

/** The inverse of an affine matrix (bottom row 0 0 0 1), or null when it is singular. */
export function mat4InvertAffine(m: Mat4): Mat4 | null {
  const a00 = m[0];
  const a10 = m[1];
  const a20 = m[2];
  const a01 = m[4];
  const a11 = m[5];
  const a21 = m[6];
  const a02 = m[8];
  const a12 = m[9];
  const a22 = m[10];
  const c00 = a11 * a22 - a12 * a21;
  const c01 = a02 * a21 - a01 * a22;
  const c02 = a01 * a12 - a02 * a11;
  const det = a00 * c00 + a10 * c01 + a20 * c02;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) {
    return null;
  }
  const inv = 1 / det;
  const i00 = c00 * inv;
  const i01 = c01 * inv;
  const i02 = c02 * inv;
  const i10 = (a12 * a20 - a10 * a22) * inv;
  const i11 = (a00 * a22 - a02 * a20) * inv;
  const i12 = (a02 * a10 - a00 * a12) * inv;
  const i20 = (a10 * a21 - a11 * a20) * inv;
  const i21 = (a01 * a20 - a00 * a21) * inv;
  const i22 = (a00 * a11 - a01 * a10) * inv;
  const tx = m[12];
  const ty = m[13];
  const tz = m[14];
  return [
    i00, i10, i20, 0,
    i01, i11, i21, 0,
    i02, i12, i22, 0,
    -(i00 * tx + i01 * ty + i02 * tz),
    -(i10 * tx + i11 * ty + i12 * tz),
    -(i20 * tx + i21 * ty + i22 * tz),
    1,
  ]; // prettier-ignore
}

export type DecomposeFailure = 'non-finite' | 'singular' | 'reflection' | 'shear';

export type DecomposeResult =
  | { readonly ok: true; readonly transform: Transform3D }
  | { readonly ok: false; readonly reason: DecomposeFailure };

/**
 * Splits an affine matrix into position, rotation and positive scale. Fails when the matrix is not
 * finite, is singular, mirrors space (negative determinant), or shears: a rotated parent with
 * non-uniform scale composes into a shear that no position/rotation/scale triple represents.
 * `tolerance` bounds the cosine between the normalized basis columns.
 */
export function mat4Decompose(m: Mat4, tolerance = 1e-9): DecomposeResult {
  if (!m.every(Number.isFinite)) {
    return { ok: false, reason: 'non-finite' };
  }
  const c0: Vec3 = [m[0], m[1], m[2]];
  const c1: Vec3 = [m[4], m[5], m[6]];
  const c2: Vec3 = [m[8], m[9], m[10]];
  const sx = length(c0);
  const sy = length(c1);
  const sz = length(c2);
  if (!(sx > 0 && sy > 0 && sz > 0)) {
    return { ok: false, reason: 'singular' };
  }
  const x = scale(c0, 1 / sx);
  const y = scale(c1, 1 / sy);
  const z = scale(c2, 1 / sz);
  if (dot(cross(x, y), z) < 0) {
    return { ok: false, reason: 'reflection' };
  }
  if (
    Math.abs(dot(x, y)) > tolerance ||
    Math.abs(dot(x, z)) > tolerance ||
    Math.abs(dot(y, z)) > tolerance
  ) {
    return { ok: false, reason: 'shear' };
  }
  const rotation: Quat = quatFromBasis(x, y, z);
  return {
    ok: true,
    transform: { position: [m[12], m[13], m[14]], rotation, scale: [sx, sy, sz] },
  };
}

export function mat4ApproxEquals(a: Mat4, b: Mat4, epsilon = 1e-9): boolean {
  return a.every((value, i) => {
    const other = b[i];
    return other !== undefined && Math.abs(value - other) <= epsilon;
  });
}
