import { add, isFiniteVec3, normalize, scale } from './vec3.js';
const AXES = [0, 1, 2];
/**
 * A ray with its direction normalized. The origin is kept, not copied. Throws a RangeError for a
 * non-finite origin, or for a zero-length or non-finite direction.
 */
export function ray(origin, direction) {
    if (!isFiniteVec3(origin)) {
        throw new RangeError(`ray origin [${origin.join(', ')}] is not finite`);
    }
    return { origin, direction: normalize(direction) };
}
/** The point at parameter `t` along the ray: `origin + t * direction`, `t` world units out. */
export function rayAt(r, t) {
    return add(r.origin, scale(r.direction, t));
}
/**
 * The parameter range where the ray is inside the box, clipped to `t >= 0`, or null when the ray
 * misses it. A ray starting inside the box has `near` 0. A ray that only grazes the box gives
 * `near` equal to `far`.
 */
export function rayIntersectAabb(r, box) {
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
//# sourceMappingURL=ray.js.map