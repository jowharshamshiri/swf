import type { Mat4, Vec2, Vec3 } from '@swf/math';
import type { ViewGeometry } from '@swf/presentation';
import type { Projection } from '@swf/projections';
import type { Mesh } from './drawing.js';
/**
 * Where a world point appears in the view, choosing among its images the one nearest `near`, so
 * neighbouring points stay on one branch; null where the view does not show the point. A
 * projection that covers the full circle and wraps at its seam repeats every view width, so its
 * images one width to either side (beyond the image's edges) count too: a surface crossing the
 * seam is then followed continuously past the edge, where clipping cuts it off.
 *
 * @param point - The world point, in world units.
 * @param near - A point of the view, in CSS pixels, the chosen image is to be nearest.
 * @returns The image in viewport CSS pixels; null also for the camera's own position.
 */
export declare function imageNear(projection: Projection, view: ViewGeometry, point: Vec3, near: Vec2): Vec2 | null;
/**
 * A mesh over a plane rectangle in the world: local x from `x0` to `x1` (left to right) and local
 * y from `y1` down to `y0` (top to bottom), placed by `world`, each point projected onto the
 * branch continuing its neighbour's, starting near `start`. Its rows run top to bottom, so the
 * mesh lines up with an image drawn top-down. Points the view does not show are null.
 *
 * @param world - The rectangle's world matrix (its local plane to world units).
 * @param columns - Cells across: a whole number of at least 1, not checked.
 * @param rows - Cells down: a whole number of at least 1, not checked.
 * @param start - Where in the view, in CSS pixels, the first point's branch is sought.
 */
export declare function planeMesh(projection: Projection, view: ViewGeometry, world: Mat4, rect: {
    readonly x0: number;
    readonly x1: number;
    readonly y0: number;
    readonly y1: number;
}, columns: number, rows: number, start: Vec2): Mesh;
/**
 * The outline of a plane rectangle in the world as a polyline of `perEdge` points per edge,
 * clockwise from its top-left corner, projected continuously from `start`. Points the view does
 * not show are left out.
 *
 * @param perEdge - Points per edge, each edge's start included and its end left to the next: a
 *   whole number of at least 1, not checked.
 * @returns A new array of points in viewport CSS pixels.
 */
export declare function planeOutline(projection: Projection, view: ViewGeometry, world: Mat4, rect: {
    readonly x0: number;
    readonly x1: number;
    readonly y0: number;
    readonly y1: number;
}, perEdge: number, start: Vec2): Vec2[];
//# sourceMappingURL=sampling.d.ts.map