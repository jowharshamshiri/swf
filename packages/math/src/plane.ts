/**
 * A point in a plane, such as a viewport in CSS pixels with +x to the right and +y down. Every
 * function here returns fresh, unfrozen arrays and leaves its arguments unchanged.
 */
export type Vec2 = readonly [number, number];

/** Four points of a plane, in order: top-left, top-right, bottom-right, bottom-left. */
export type Quad2 = readonly [Vec2, Vec2, Vec2, Vec2];

/**
 * A projective map of the plane, as a row-major 3×3 matrix with its last entry 1: a point (x, y)
 * goes to ((h0 x + h1 y + h2) / w, (h3 x + h4 y + h5) / w) with w = h6 x + h7 y + 1.
 */
// prettier-ignore
export type Homography = readonly [
  number, number, number,
  number, number, number,
  number, number, 1,
];

/**
 * The rectangle `[x, y, width, height]` as a quad, with `(x, y)` its top-left corner when +y points
 * down. The values are not checked.
 */
export function rectQuad(rect: readonly [number, number, number, number]): Quad2 {
  const [x, y, w, h] = rect;
  return [
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ];
}

/** The quad moved by (-dx, -dy): into the frame of a box whose top-left is at (dx, dy). */
export function offsetQuad(quad: Quad2, dx: number, dy: number): Quad2 {
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
 * projective map that keeps the rectangle's inside in front of the viewer. Either winding is
 * accepted. A turn whose cross product is within `tolerance` (default `1e-9`, in squared units of
 * the plane) of zero counts as a straight line; a non-finite corner makes the quad not convex.
 */
export function isConvexQuad(quad: Quad2, tolerance = 1e-9): boolean {
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
 * The projective map that takes a `width` × `height` rectangle (origin at its top-left) onto
 * `quad`: the corners land exactly on the quad's, and straight lines stay straight. Null when the
 * quad is not convex (no such map keeps the rectangle in front) or the rectangle is empty.
 */
export function rectToQuad(width: number, height: number, quad: Quad2): Homography | null {
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
  // Then the rectangle onto the unit square: u = x / width, v = y / height.
  // prettier-ignore
  const m: Homography = [
    (x1 - x0 + g * x1) / width, (x3 - x0 + h * x3) / height, x0,
    (y1 - y0 + g * y1) / width, (y3 - y0 + h * y3) / height, y0,
    g / width, h / height, 1,
  ];
  return m.every(Number.isFinite) ? m : null;
}

/**
 * Where the homography takes the point (x, y). A point on the map's line at infinity (where `w` is
 * 0) gives infinite or NaN coordinates; it is not checked.
 */
export function applyHomography(m: Homography, x: number, y: number): Vec2 {
  const w = m[6] * x + m[7] * y + 1;
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}
