import { rectToQuad } from '@swf/math';
/**
 * The projective map of the plane as the CSS matrix that applies it to an element.
 *
 * @param m - A 3×3 homography in row-major order, acting on `(x, y, 1)`.
 * @returns A new array.
 */
export function cssMatrixOf(m) {
    // prettier-ignore
    return [
        m[0], m[3], 0, m[6],
        m[1], m[4], 0, m[7],
        0, 0, 1, 0,
        m[2], m[5], 0, 1,
    ];
}
/**
 * The CSS matrix that maps a `width` × `height` element (origin at its top-left) onto `quad`:
 * its corners land exactly on the quad's. Null when no rectangle in front of the viewer projects
 * to the quad.
 */
export function quadMatrix(width, height, quad) {
    const m = rectToQuad(width, height, quad);
    return m === null ? null : cssMatrixOf(m);
}
/**
 * Where `matrix` takes the point (x, y) of the element, in the element's CSS pixels. A point the
 * matrix sends to infinity gives non-finite coordinates.
 */
export function applyMatrix(matrix, x, y) {
    const w = matrix[3] * x + matrix[7] * y + matrix[15];
    return [
        (matrix[0] * x + matrix[4] * y + matrix[12]) / w,
        (matrix[1] * x + matrix[5] * y + matrix[13]) / w,
    ];
}
/** The matrix as a CSS `transform` value: `matrix3d(…)` with its 16 values in order. */
export function cssTransform(matrix) {
    return `matrix3d(${matrix.map((v) => String(v)).join(', ')})`;
}
//# sourceMappingURL=placement.js.map