import type { Homography, Vec2 } from '@swf/math';
/**
 * Content an adapter supplies for drawing: an image source a canvas can draw, with its size in
 * pixels. The geometry backend draws it; it never reads its pixels back.
 */
export interface Drawable {
    /**
     * What is drawn: an image, a canvas, a video frame or a bitmap. It stays the adapter's; the
     * renderer draws from it each time the layer is drawn.
     */
    readonly source: CanvasImageSource;
    /** The source's width, in its own pixels: positive and finite. */
    readonly width: number;
    /** The source's height, in its own pixels: positive and finite. */
    readonly height: number;
    /**
     * Changes whenever the drawable's pixels change, so the renderer redraws it only then. A
     * drawable without one (live media, say) is redrawn every frame.
     */
    readonly revision?: number;
}
/**
 * Why a value is not a drawable, in words, or null when it is: an object with an object
 * `source`, a positive finite `width` and `height`, and a finite `revision` when it has one.
 */
export declare function drawableIssue(value: unknown): string | null;
/**
 * A mesh over a drawable: `points[row][column]` is where the drawable's point
 * (column / columns × width, row / rows × height) lands, or null where it does not land on the
 * view (outside what the projection covers).
 */
export interface Mesh {
    /** Cells across: a whole number of at least 1. */
    readonly columns: number;
    /** Cells down: a whole number of at least 1. */
    readonly rows: number;
    /** `rows + 1` rows of `columns + 1` points each, in viewport CSS pixels. */
    readonly points: readonly (readonly (Vec2 | null)[])[];
}
/**
 * A mesh that follows a homography: the projective map of the drawable's rectangle. Every point
 * is given, none null; a point the map sends to infinity has non-finite coordinates.
 *
 * @param width - The drawable's width, in its pixels.
 * @param height - The drawable's height, in its pixels.
 * @param columns - Cells across: a whole number of at least 1, not checked.
 * @param rows - Cells down: a whole number of at least 1, not checked.
 */
export declare function homographyMesh(m: Homography, width: number, height: number, columns: number, rows: number): Mesh;
/**
 * Draws the drawable over the mesh, two triangles per cell, each mapped affinely. Within a cell
 * the result is exact to the mesh's resolution: the finer the mesh, the closer it follows a
 * curved projection. Cells with a point off the view are skipped. Each triangle saves and
 * restores the context's state, so the context is left as it was given.
 */
export declare function drawMesh(ctx: CanvasRenderingContext2D, drawable: Drawable, mesh: Mesh): void;
/**
 * The affine map (a, b, c, d, e, f), as canvas `transform` takes it, that sends s0, s1, s2 to
 * d0, d1, d2; null for a degenerate source triangle (its three points on one line).
 */
export declare function affine(s0: Vec2, s1: Vec2, s2: Vec2, d0: Vec2, d1: Vec2, d2: Vec2): readonly [number, number, number, number, number, number] | null;
/** Traces a closed outline through the points. */
export declare function outline(ctx: CanvasRenderingContext2D, points: readonly Vec2[]): void;
//# sourceMappingURL=drawing.d.ts.map