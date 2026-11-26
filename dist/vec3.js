/** The origin `[0, 0, 0]`; frozen. */
export const ZERO_VEC3 = Object.freeze([0, 0, 0]);
/** The unit scale `[1, 1, 1]`; frozen. */
export const ONE_VEC3 = Object.freeze([1, 1, 1]);
/** The vector `[x, y, z]`. The components are not checked. */
export function vec3(x, y, z) {
    return [x, y, z];
}
/** The sum `a + b`, component-wise. */
export function add(a, b) {
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
/** The difference `a - b`, component-wise: the vector from `b` to `a`. */
export function sub(a, b) {
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
/** The vector `v` with every component multiplied by `s`. */
export function scale(v, s) {
    return [v[0] * s, v[1] * s, v[2] * s];
}
/** Component-wise product. */
export function mul(a, b) {
    return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}
/** The dot product of `a` and `b`. */
export function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
/**
 * The cross product `a × b`, by the right-hand rule: `cross([1, 0, 0], [0, 1, 0])` is
 * `[0, 0, 1]`.
 */
export function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
/** The Euclidean length of `v`, computed without intermediate overflow. */
export function length(v) {
    return Math.hypot(v[0], v[1], v[2]);
}
/** The Euclidean distance between the points `a` and `b`. */
export function distance(a, b) {
    return length(sub(a, b));
}
/** The unit vector along `v`. Throws a RangeError for a zero-length or non-finite vector. */
export function normalize(v) {
    const len = length(v);
    if (!(len > 0) || !Number.isFinite(len)) {
        throw new RangeError(`cannot normalize vector [${v.join(', ')}]: length is ${len}`);
    }
    return [v[0] / len, v[1] / len, v[2] / len];
}
/** True when no component of `v` is NaN or infinite. */
export function isFiniteVec3(v) {
    return Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
}
/** True when every component is finite and strictly positive. */
export function isPositiveVec3(v) {
    return isFiniteVec3(v) && v[0] > 0 && v[1] > 0 && v[2] > 0;
}
/**
 * True when every component of `a` is within `epsilon` (an absolute difference, default `1e-9`) of
 * the same component of `b`. False when either holds NaN.
 */
export function vec3ApproxEquals(a, b, epsilon = 1e-9) {
    return (Math.abs(a[0] - b[0]) <= epsilon &&
        Math.abs(a[1] - b[1]) <= epsilon &&
        Math.abs(a[2] - b[2]) <= epsilon);
}
//# sourceMappingURL=vec3.js.map