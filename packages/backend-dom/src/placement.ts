import type { Homography, Quad2, Vec2 } from '@swf/math';
import { rectToQuad } from '@swf/math';

/**
 * A CSS `matrix3d` in column-major order (the order CSS lists its 16 values), acting on points
 * `(x, y, 0, 1)` of an element whose `transform-origin` is its top-left corner.
 */
// prettier-ignore
export type CssMatrix = readonly [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
];

/** The projective map of the plane as the CSS matrix that applies it to an element. */
export function cssMatrixOf(m: Homography): CssMatrix {
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
export function quadMatrix(width: number, height: number, quad: Quad2): CssMatrix | null {
  const m = rectToQuad(width, height, quad);
  return m === null ? null : cssMatrixOf(m);
}

/** Where `matrix` takes the point (x, y) of the element. */
export function applyMatrix(matrix: CssMatrix, x: number, y: number): Vec2 {
  const w = matrix[3] * x + matrix[7] * y + matrix[15];
  return [
    (matrix[0] * x + matrix[4] * y + matrix[12]) / w,
    (matrix[1] * x + matrix[5] * y + matrix[13]) / w,
  ];
}

/** The matrix as a CSS `transform` value. */
export function cssTransform(matrix: CssMatrix): string {
  return `matrix3d(${matrix.map((v) => String(v)).join(', ')})`;
}
