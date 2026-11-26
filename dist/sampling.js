import { mat4TransformPoint, sub } from '@swf/math';
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
export function imageNear(projection, view, point, near) {
    const eye = [view.camera[12], view.camera[13], view.camera[14]];
    const direction = sub(point, eye);
    if (Math.hypot(...direction) === 0) {
        return null;
    }
    const domain = projection.describeDomain();
    const wraps = domain.fullCircle && domain.seamWrapping;
    const images = projection
        .projectDirection(direction, view)
        .images.flatMap((i) => wraps ? [i, [i[0] - view.width, i[1]], [i[0] + view.width, i[1]]] : [i]);
    let best = null;
    let bestDistance = Infinity;
    for (const image of images) {
        const d = Math.hypot(image[0] - near[0], image[1] - near[1]);
        if (d < bestDistance) {
            best = image;
            bestDistance = d;
        }
    }
    return best;
}
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
export function planeMesh(projection, view, world, rect, columns, rows, start) {
    const points = [];
    let rowStart = start;
    for (let r = 0; r <= rows; r++) {
        const row = [];
        let previous = rowStart;
        for (let c = 0; c <= columns; c++) {
            const local = [
                rect.x0 + ((rect.x1 - rect.x0) * c) / columns,
                rect.y1 - ((rect.y1 - rect.y0) * r) / rows,
                0,
            ];
            const image = imageNear(projection, view, mat4TransformPoint(world, local), previous);
            row.push(image);
            if (image !== null) {
                previous = image;
                if (c === 0) {
                    rowStart = image;
                }
            }
        }
        points.push(row);
    }
    return { columns, rows, points };
}
/**
 * The outline of a plane rectangle in the world as a polyline of `perEdge` points per edge,
 * clockwise from its top-left corner, projected continuously from `start`. Points the view does
 * not show are left out.
 *
 * @param perEdge - Points per edge, each edge's start included and its end left to the next: a
 *   whole number of at least 1, not checked.
 * @returns A new array of points in viewport CSS pixels.
 */
export function planeOutline(projection, view, world, rect, perEdge, start) {
    const tl = [rect.x0, rect.y1, 0];
    const tr = [rect.x1, rect.y1, 0];
    const br = [rect.x1, rect.y0, 0];
    const bl = [rect.x0, rect.y0, 0];
    const out = [];
    let previous = start;
    for (const [a, b] of [
        [tl, tr],
        [tr, br],
        [br, bl],
        [bl, tl],
    ]) {
        for (let i = 0; i < perEdge; i++) {
            const t = i / perEdge;
            const local = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 0];
            const image = imageNear(projection, view, mat4TransformPoint(world, local), previous);
            if (image !== null) {
                out.push(image);
                previous = image;
            }
        }
    }
    return out;
}
//# sourceMappingURL=sampling.js.map