/**
 * A 3-component vector of finite doubles: a point, direction or size in world units. The type does
 * not enforce finiteness; {@link isFiniteVec3} checks it. Every function here returns a fresh,
 * unfrozen array and leaves its arguments unchanged.
 */
export type Vec3 = readonly [number, number, number];
/** The origin `[0, 0, 0]`; frozen. */
export declare const ZERO_VEC3: Vec3;
/** The unit scale `[1, 1, 1]`; frozen. */
export declare const ONE_VEC3: Vec3;
/** The vector `[x, y, z]`. The components are not checked. */
export declare function vec3(x: number, y: number, z: number): Vec3;
/** The sum `a + b`, component-wise. */
export declare function add(a: Vec3, b: Vec3): Vec3;
/** The difference `a - b`, component-wise: the vector from `b` to `a`. */
export declare function sub(a: Vec3, b: Vec3): Vec3;
/** The vector `v` with every component multiplied by `s`. */
export declare function scale(v: Vec3, s: number): Vec3;
/** Component-wise product. */
export declare function mul(a: Vec3, b: Vec3): Vec3;
/** The dot product of `a` and `b`. */
export declare function dot(a: Vec3, b: Vec3): number;
/**
 * The cross product `a × b`, by the right-hand rule: `cross([1, 0, 0], [0, 1, 0])` is
 * `[0, 0, 1]`.
 */
export declare function cross(a: Vec3, b: Vec3): Vec3;
/** The Euclidean length of `v`, computed without intermediate overflow. */
export declare function length(v: Vec3): number;
/** The Euclidean distance between the points `a` and `b`. */
export declare function distance(a: Vec3, b: Vec3): number;
/** The unit vector along `v`. Throws a RangeError for a zero-length or non-finite vector. */
export declare function normalize(v: Vec3): Vec3;
/** True when no component of `v` is NaN or infinite. */
export declare function isFiniteVec3(v: Vec3): boolean;
/** True when every component is finite and strictly positive. */
export declare function isPositiveVec3(v: Vec3): boolean;
/**
 * True when every component of `a` is within `epsilon` (an absolute difference, default `1e-9`) of
 * the same component of `b`. False when either holds NaN.
 */
export declare function vec3ApproxEquals(a: Vec3, b: Vec3, epsilon?: number): boolean;
//# sourceMappingURL=vec3.d.ts.map