import type { Mat4 } from './mat4.js';
import type { Vec3 } from './vec3.js';
/**
 * An axis-aligned bounding box in world units; `min` is component-wise no greater than `max`. The
 * functions here assume that ordering and never check it. Every function returns a fresh, unfrozen
 * box and leaves its arguments unchanged.
 */
export interface Aabb {
    /** The corner with the least x, y and z. */
    readonly min: Vec3;
    /** The corner with the greatest x, y and z. */
    readonly max: Vec3;
}
/**
 * The box centred on `center` that extends `size` along each axis, half on either side. The size is
 * not checked: a negative component gives a box whose `min` exceeds its `max` on that axis.
 */
export declare function aabbFromCenterSize(center: Vec3, size: Vec3): Aabb;
/**
 * The world-aligned box enclosing a box of `size` centred on the local origin and placed by the
 * affine matrix `m`.
 */
export declare function aabbOfBox(m: Mat4, size: Vec3): Aabb;
/** The point midway between the box's corners. */
export declare function aabbCenter(box: Aabb): Vec3;
/** The box's extent along each axis: `max - min`, component-wise. */
export declare function aabbSize(box: Aabb): Vec3;
/** The smallest box that encloses both `a` and `b`. */
export declare function aabbUnion(a: Aabb, b: Aabb): Aabb;
/**
 * The box grown by `padding` world units on every side; a negative padding shrinks it, and is not
 * checked against the box's size.
 */
export declare function aabbExpand(box: Aabb, padding: number): Aabb;
/** True when the boxes overlap with positive volume; boxes that only touch do not intersect. */
export declare function aabbIntersects(a: Aabb, b: Aabb): boolean;
/** True when `p` lies inside the box or on its boundary; false when a component of `p` is NaN. */
export declare function aabbContainsPoint(box: Aabb, p: Vec3): boolean;
//# sourceMappingURL=aabb.d.ts.map