import type { Vec3 } from './vec3.js';
import { cross, dot, length, normalize } from './vec3.js';

/** A rotation quaternion `x, y, z, w`. Rotations are unit quaternions; `q` and `-q` are the same rotation. */
export type Quat = readonly [number, number, number, number];

export const IDENTITY_QUAT: Quat = Object.freeze([0, 0, 0, 1] as const);

export function quatLength(q: Quat): number {
  return Math.hypot(q[0], q[1], q[2], q[3]);
}

export function isFiniteQuat(q: Quat): boolean {
  return (
    Number.isFinite(q[0]) && Number.isFinite(q[1]) && Number.isFinite(q[2]) && Number.isFinite(q[3])
  );
}

/** True when `q` is finite and its length is within `tolerance` of 1. */
export function isUnitQuat(q: Quat, tolerance = 1e-6): boolean {
  return isFiniteQuat(q) && Math.abs(quatLength(q) - 1) <= tolerance;
}

/** The unit quaternion along `q`. Throws a RangeError for a zero-length or non-finite quaternion. */
export function quatNormalize(q: Quat): Quat {
  const len = quatLength(q);
  if (!(len > 0) || !Number.isFinite(len)) {
    throw new RangeError(`cannot normalize quaternion [${q.join(', ')}]: length is ${len}`);
  }
  return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

/** The Hamilton product `a * b`: the rotation that applies `b` first, then `a`. */
export function quatMultiply(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function quatConjugate(q: Quat): Quat {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** The inverse rotation of a unit quaternion. */
export function quatInvert(q: Quat): Quat {
  const lenSq = q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3];
  if (!(lenSq > 0) || !Number.isFinite(lenSq)) {
    throw new RangeError(`cannot invert quaternion [${q.join(', ')}]`);
  }
  return [-q[0] / lenSq, -q[1] / lenSq, -q[2] / lenSq, q[3] / lenSq];
}

/** Rotates vector `v` by unit quaternion `q`. */
export function quatRotate(q: Quat, v: Vec3): Vec3 {
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

/** The rotation of `angle` radians about `axis` (right-handed). */
export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const [x, y, z] = normalize(axis);
  const half = angle / 2;
  const s = Math.sin(half);
  return [x * s, y * s, z * s, Math.cos(half)];
}

/**
 * The rotation whose columns are the given orthonormal basis vectors: local +X maps to `xAxis`,
 * +Y to `yAxis` and +Z to `zAxis`. The basis must be right-handed and orthonormal.
 */
export function quatFromBasis(xAxis: Vec3, yAxis: Vec3, zAxis: Vec3): Quat {
  const [m00, m10, m20] = xAxis;
  const [m01, m11, m21] = yAxis;
  const [m02, m12, m22] = zAxis;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  return quatNormalize(q);
}

/**
 * The rotation that points local +Z along `forward` while keeping local +Y as close to `up` as
 * possible. Throws a RangeError when `forward` is zero or parallel to `up`.
 */
export function quatLookRotation(forward: Vec3, up: Vec3): Quat {
  const z = normalize(forward);
  const side = cross(up, z);
  if (length(side) <= 1e-12) {
    throw new RangeError(`forward [${forward.join(', ')}] is parallel to up [${up.join(', ')}]`);
  }
  const x = normalize(side);
  const y = cross(z, x);
  return quatFromBasis(x, y, z);
}

/** True when `a` and `b` describe the same rotation within `epsilon` (treating `q` and `-q` as equal). */
export function quatSameRotation(a: Quat, b: Quat, epsilon = 1e-9): boolean {
  const d = Math.abs(dot([a[0], a[1], a[2]], [b[0], b[1], b[2]]) + a[3] * b[3]);
  return Math.abs(1 - d) <= epsilon;
}
