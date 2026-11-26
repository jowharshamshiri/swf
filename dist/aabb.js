/**
 * The box centred on `center` that extends `size` along each axis, half on either side. The size is
 * not checked: a negative component gives a box whose `min` exceeds its `max` on that axis.
 */
export function aabbFromCenterSize(center, size) {
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
export function aabbOfBox(m, size) {
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
/** The point midway between the box's corners. */
export function aabbCenter(box) {
    return [
        (box.min[0] + box.max[0]) / 2,
        (box.min[1] + box.max[1]) / 2,
        (box.min[2] + box.max[2]) / 2,
    ];
}
/** The box's extent along each axis: `max - min`, component-wise. */
export function aabbSize(box) {
    return [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
}
/** The smallest box that encloses both `a` and `b`. */
export function aabbUnion(a, b) {
    return {
        min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
        max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
    };
}
/**
 * The box grown by `padding` world units on every side; a negative padding shrinks it, and is not
 * checked against the box's size.
 */
export function aabbExpand(box, padding) {
    return {
        min: [box.min[0] - padding, box.min[1] - padding, box.min[2] - padding],
        max: [box.max[0] + padding, box.max[1] + padding, box.max[2] + padding],
    };
}
/** True when the boxes overlap with positive volume; boxes that only touch do not intersect. */
export function aabbIntersects(a, b) {
    return (a.min[0] < b.max[0] &&
        b.min[0] < a.max[0] &&
        a.min[1] < b.max[1] &&
        b.min[1] < a.max[1] &&
        a.min[2] < b.max[2] &&
        b.min[2] < a.max[2]);
}
/** True when `p` lies inside the box or on its boundary; false when a component of `p` is NaN. */
export function aabbContainsPoint(box, p) {
    return (p[0] >= box.min[0] &&
        p[0] <= box.max[0] &&
        p[1] >= box.min[1] &&
        p[1] <= box.max[1] &&
        p[2] >= box.min[2] &&
        p[2] <= box.max[2]);
}
//# sourceMappingURL=aabb.js.map