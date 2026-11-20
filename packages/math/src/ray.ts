import type { Aabb } from './aabb.js';
import type { Vec3 } from './vec3.js';
import { add, isFiniteVec3, normalize, scale } from './vec3.js';

const AXES = [0, 1, 2] as const;

/** A half-line from `origin` along the unit vector `direction`. */
export interface Ray {
  readonly origin: Vec3;
  readonly direction: Vec3;
}

/** A ray with its direction normalized. Throws a RangeError for a non-finite origin or zero direction. */
export function ray(origin: Vec3, direction: Vec3): Ray {
  if (!isFiniteVec3(origin)) {
    throw new RangeError(`ray origin [${origin.join(', ')}] is not finite`);
  }
  return { origin, direction: normalize(direction) };
}

export function rayAt(r: Ray, t: number): Vec3 {
  return add(r.origin, scale(r.direction, t));
}

/**
 * The parameter range where the ray is inside the box, clipped to `t >= 0`, or null when the ray
 * misses it. A ray starting inside the box has `near` 0.
 */
export function rayIntersectAabb(r: Ray, box: Aabb): { near: number; far: number } | null {
  let near = 0;
  let far = Infinity;
  for (const axis of AXES) {
    const o = r.origin[axis];
    const d = r.direction[axis];
    const lo = box.min[axis];
    const hi = box.max[axis];
    if (d === 0) {
      if (o < lo || o > hi) {
        return null;
      }
      continue;
    }
    let t0 = (lo - o) / d;
    let t1 = (hi - o) / d;
    if (t0 > t1) {
      [t0, t1] = [t1, t0];
    }
    near = Math.max(near, t0);
    far = Math.min(far, t1);
    if (near > far) {
      return null;
    }
  }
  return { near, far };
}
