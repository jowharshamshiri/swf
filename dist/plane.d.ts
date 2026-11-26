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
export type Homography = readonly [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    1
];
/**
 * The rectangle `[x, y, width, height]` as a quad, with `(x, y)` its top-left corner when +y points
 * down. The values are not checked.
 */
export declare function rectQuad(rect: readonly [number, number, number, number]): Quad2;
/** The quad moved by (-dx, -dy): into the frame of a box whose top-left is at (dx, dy). */
export declare function offsetQuad(quad: Quad2, dx: number, dy: number): Quad2;
/**
 * Whether the quad is a non-degenerate convex quadrilateral: every turn along its edges goes the
 * same way, with no three corners in a line. Only such a quad is the image of a rectangle under a
 * projective map that keeps the rectangle's inside in front of the viewer. Either winding is
 * accepted. A turn whose cross product is within `tolerance` (default `1e-9`, in squared units of
 * the plane) of zero counts as a straight line; a non-finite corner makes the quad not convex.
 */
export declare function isConvexQuad(quad: Quad2, tolerance?: number): boolean;
/**
 * The projective map that takes a `width` × `height` rectangle (origin at its top-left) onto
 * `quad`: the corners land exactly on the quad's, and straight lines stay straight. Null when the
 * quad is not convex (no such map keeps the rectangle in front) or the rectangle is empty.
 */
export declare function rectToQuad(width: number, height: number, quad: Quad2): Homography | null;
/**
 * Where the homography takes the point (x, y). A point on the map's line at infinity (where `w` is
 * 0) gives infinite or NaN coordinates; it is not checked.
 */
export declare function applyHomography(m: Homography, x: number, y: number): Vec2;
//# sourceMappingURL=plane.d.ts.map