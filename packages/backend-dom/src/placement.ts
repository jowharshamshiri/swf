import type { ScreenPoint, ScreenRect } from '@swf/presentation';

/** Four screen points: top-left, top-right, bottom-right, bottom-left. */
export type Quad = readonly [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint];

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

/** The rectangle's corners as a quad. */
export function rectQuad(rect: ScreenRect): Quad {
  const [x, y, w, h] = rect;
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

/** The quad moved by (-dx, -dy): into the frame of a box whose top-left is at (dx, dy). */
export function offsetQuad(quad: Quad, dx: number, dy: number): Quad {
  return [
    [quad[0][0] - dx, quad[0][1] - dy],
    [quad[1][0] - dx, quad[1][1] - dy],
    [quad[2][0] - dx, quad[2][1] - dy],
    [quad[3][0] - dx, quad[3][1] - dy],
  ];
}

/**
 * Whether the quad is a non-degenerate convex quadrilateral: every turn along its edges goes the
 * same way, with no three corners in a line. Only such a quad is the image of a rectangle under a
 * projective map that keeps the rectangle's inside in front of the viewer.
 */
export function isConvexQuad(quad: Quad, tolerance = 1e-9): boolean {
  if (!quad.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) {
    return false;
  }
  const [p0, p1, p2, p3] = quad;
  let sign = 0;
  for (const [a, b, c] of [
    [p0, p1, p2],
    [p1, p2, p3],
    [p2, p3, p0],
    [p3, p0, p1],
  ] as const) {
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) <= tolerance) {
      return false;
    }
    const s = Math.sign(cross);
    if (sign !== 0 && s !== sign) {
      return false;
    }
    sign = s;
  }
  return true;
}

/**
 * The projective map that takes a `width` × `height` box (origin at its top-left) onto `quad`,
 * as a CSS matrix: the box's corners land exactly on the quad's, and straight lines stay straight.
 * Null when the quad is not convex (no such map keeps the box in front) or the box is empty.
 */
export function quadMatrix(width: number, height: number, quad: Quad): CssMatrix | null {
  if (!(width > 0 && height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  if (!isConvexQuad(quad)) {
    return null;
  }
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = quad;
  // The unit square onto the quad (Heckbert): (u, v) → ((a u + b v + c) / (g u + h v + 1), …).
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;
  let g = 0;
  let h = 0;
  if (dx3 !== 0 || dy3 !== 0) {
    const det = dx1 * dy2 - dx2 * dy1;
    if (det === 0) {
      return null;
    }
    g = (dx3 * dy2 - dx2 * dy3) / det;
    h = (dx1 * dy3 - dx3 * dy1) / det;
  }
  const a = x1 - x0 + g * x1;
  const b = x3 - x0 + h * x3;
  const c = x0;
  const d = y1 - y0 + g * y1;
  const e = y3 - y0 + h * y3;
  const f = y0;
  // Then the box onto the unit square: u = x / width, v = y / height.
  // prettier-ignore
  const m: CssMatrix = [
    a / width, d / width, 0, g / width,
    b / height, e / height, 0, h / height,
    0, 0, 1, 0,
    c, f, 0, 1,
  ];
  return m.every(Number.isFinite) ? m : null;
}

/** Where `matrix` takes the point (x, y) of the box. */
export function applyMatrix(matrix: CssMatrix, x: number, y: number): ScreenPoint {
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
