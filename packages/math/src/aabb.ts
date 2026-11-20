import type { Mat4 } from './mat4.js';
import type { Vec3 } from './vec3.js';

/** An axis-aligned bounding box; `min` is component-wise no greater than `max`. */
export interface Aabb {
  readonly min: Vec3;
  readonly max: Vec3;
}

export function aabbFromCenterSize(center: Vec3, size: Vec3): Aabb {
  const hx = size[0] / 2;
  const hy = size[1] / 2;
  const hz = size[2] / 2;
  return {
    min: [center[0] - hx, center[1] - hy, center[2] - hz],
    max: [center[0] + hx, center[1] + hy, center[2] + hz],
  };
}

/**
 * The world-aligned box enclosing a box of `size` centred on the local origin and placed by the
 * affine matrix `m`.
 */
export function aabbOfBox(m: Mat4, size: Vec3): Aabb {
  const hx = size[0] / 2;
  const hy = size[1] / 2;
  const hz = size[2] / 2;
  const ex = Math.abs(m[0]) * hx + Math.abs(m[4]) * hy + Math.abs(m[8]) * hz;
  const ey = Math.abs(m[1]) * hx + Math.abs(m[5]) * hy + Math.abs(m[9]) * hz;
  const ez = Math.abs(m[2]) * hx + Math.abs(m[6]) * hy + Math.abs(m[10]) * hz;
  return {
    min: [m[12] - ex, m[13] - ey, m[14] - ez],
    max: [m[12] + ex, m[13] + ey, m[14] + ez],
  };
}

export function aabbCenter(box: Aabb): Vec3 {
  return [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
}

export function aabbSize(box: Aabb): Vec3 {
  return [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
}

export function aabbUnion(a: Aabb, b: Aabb): Aabb {
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

/** Grows the box by `padding` on every side. */
export function aabbExpand(box: Aabb, padding: number): Aabb {
  return {
    min: [box.min[0] - padding, box.min[1] - padding, box.min[2] - padding],
    max: [box.max[0] + padding, box.max[1] + padding, box.max[2] + padding],
  };
}

/** True when the boxes overlap with positive volume; boxes that only touch do not intersect. */
export function aabbIntersects(a: Aabb, b: Aabb): boolean {
  return (
    a.min[0] < b.max[0] &&
    b.min[0] < a.max[0] &&
    a.min[1] < b.max[1] &&
    b.min[1] < a.max[1] &&
    a.min[2] < b.max[2] &&
    b.min[2] < a.max[2]
  );
}

export function aabbContainsPoint(box: Aabb, p: Vec3): boolean {
  return (
    p[0] >= box.min[0] &&
    p[0] <= box.max[0] &&
    p[1] >= box.min[1] &&
    p[1] <= box.max[1] &&
    p[2] >= box.min[2] &&
    p[2] <= box.max[2]
  );
}
