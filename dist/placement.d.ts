import type { Homography, Quad2, Vec2 } from '@swf/math';
/**
 * A CSS `matrix3d` in column-major order (the order CSS lists its 16 values), acting on points
 * `(x, y, 0, 1)` of an element whose `transform-origin` is its top-left corner.
 */
export type CssMatrix = readonly [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number
];
/**
 * The projective map of the plane as the CSS matrix that applies it to an element.
 *
 * @param m - A 3×3 homography in row-major order, acting on `(x, y, 1)`.
 * @returns A new array.
 */
export declare function cssMatrixOf(m: Homography): CssMatrix;
/**
 * The CSS matrix that maps a `width` × `height` element (origin at its top-left) onto `quad`:
 * its corners land exactly on the quad's. Null when no rectangle in front of the viewer projects
 * to the quad.
 */
export declare function quadMatrix(width: number, height: number, quad: Quad2): CssMatrix | null;
/**
 * Where `matrix` takes the point (x, y) of the element, in the element's CSS pixels. A point the
 * matrix sends to infinity gives non-finite coordinates.
 */
export declare function applyMatrix(matrix: CssMatrix, x: number, y: number): Vec2;
/** The matrix as a CSS `transform` value: `matrix3d(…)` with its 16 values in order. */
export declare function cssTransform(matrix: CssMatrix): string;
//# sourceMappingURL=placement.d.ts.map