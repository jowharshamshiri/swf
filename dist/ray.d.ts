import type { Aabb } from './aabb.js';
import type { Vec3 } from './vec3.js';
/**
 * A half-line from `origin` along the unit vector `direction`, in world units. {@link ray} makes
 * one with its direction normalized; a ray built otherwise is used as given.
 */
export interface Ray {
    /** Where the ray starts: the point at parameter 0. */
    readonly origin: Vec3;
    /** The unit vector the ray points along. */
    readonly direction: Vec3;
}
/**
 * A ray with its direction normalized. The origin is kept, not copied. Throws a RangeError for a
 * non-finite origin, or for a zero-length or non-finite direction.
 */
export declare function ray(origin: Vec3, direction: Vec3): Ray;
/** The point at parameter `t` along the ray: `origin + t * direction`, `t` world units out. */
export declare function rayAt(r: Ray, t: number): Vec3;
/**
 * The parameter range where the ray is inside the box, clipped to `t >= 0`, or null when the ray
 * misses it. A ray starting inside the box has `near` 0. A ray that only grazes the box gives
 * `near` equal to `far`.
 */
export declare function rayIntersectAabb(r: Ray, box: Aabb): {
    /** The parameter where the ray enters the box, or 0 when it starts inside. */
    near: number;
    /** The parameter where the ray leaves the box. */
    far: number;
} | null;
//# sourceMappingURL=ray.d.ts.map