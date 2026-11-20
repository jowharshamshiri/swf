/** A 3-component vector of finite doubles: a point, direction or size in world units. */
export type Vec3 = readonly [number, number, number];

export const ZERO_VEC3: Vec3 = Object.freeze([0, 0, 0] as const);
export const ONE_VEC3: Vec3 = Object.freeze([1, 1, 1] as const);

export function vec3(x: number, y: number, z: number): Vec3 {
  return [x, y, z];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(v: Vec3, s: number): Vec3 {
  return [v[0] * s, v[1] * s, v[2] * s];
}

/** Component-wise product. */
export function mul(a: Vec3, b: Vec3): Vec3 {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

/** The unit vector along `v`. Throws a RangeError for a zero-length or non-finite vector. */
export function normalize(v: Vec3): Vec3 {
  const len = length(v);
  if (!(len > 0) || !Number.isFinite(len)) {
    throw new RangeError(`cannot normalize vector [${v.join(', ')}]: length is ${len}`);
  }
  return [v[0] / len, v[1] / len, v[2] / len];
}

export function isFiniteVec3(v: Vec3): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}

/** True when every component is finite and strictly positive. */
export function isPositiveVec3(v: Vec3): boolean {
  return isFiniteVec3(v) && v[0] > 0 && v[1] > 0 && v[2] > 0;
}

export function vec3ApproxEquals(a: Vec3, b: Vec3, epsilon = 1e-9): boolean {
  return (
    Math.abs(a[0] - b[0]) <= epsilon &&
    Math.abs(a[1] - b[1]) <= epsilon &&
    Math.abs(a[2] - b[2]) <= epsilon
  );
}
