import { applyHomography } from '@swf/math';
/**
 * Why a value is not a drawable, in words, or null when it is: an object with an object
 * `source`, a positive finite `width` and `height`, and a finite `revision` when it has one.
 */
export function drawableIssue(value) {
    if (typeof value !== 'object' || value === null) {
        return 'a drawable must be an object { source, width, height }';
    }
    // Drawables come from adapters, which may be plain JavaScript: nothing is assumed.
    const d = value;
    if (typeof d['source'] !== 'object' || d['source'] === null) {
        return 'a drawable needs an image source';
    }
    for (const key of ['width', 'height']) {
        const v = d[key];
        if (typeof v !== 'number' || !(v > 0) || !Number.isFinite(v)) {
            return `a drawable's ${key} must be a positive finite number`;
        }
    }
    const revision = d['revision'];
    if (revision !== undefined && (typeof revision !== 'number' || !Number.isFinite(revision))) {
        return "a drawable's revision must be a finite number when given";
    }
    return null;
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
export function homographyMesh(m, width, height, columns, rows) {
    const points = [];
    for (let r = 0; r <= rows; r++) {
        const row = [];
        for (let c = 0; c <= columns; c++) {
            row.push(applyHomography(m, (c / columns) * width, (r / rows) * height));
        }
        points.push(row);
    }
    return { columns, rows, points };
}
/**
 * Draws the drawable over the mesh, two triangles per cell, each mapped affinely. Within a cell
 * the result is exact to the mesh's resolution: the finer the mesh, the closer it follows a
 * curved projection. Cells with a point off the view are skipped. Each triangle saves and
 * restores the context's state, so the context is left as it was given.
 */
export function drawMesh(ctx, drawable, mesh) {
    const { columns, rows, points } = mesh;
    const sw = drawable.width / columns;
    const sh = drawable.height / rows;
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < columns; c++) {
            const p00 = points[r]?.[c] ?? null;
            const p10 = points[r]?.[c + 1] ?? null;
            const p01 = points[r + 1]?.[c] ?? null;
            const p11 = points[r + 1]?.[c + 1] ?? null;
            if (p00 === null || p10 === null || p01 === null || p11 === null) {
                continue;
            }
            const x0 = c * sw;
            const y0 = r * sh;
            triangle(ctx, drawable, [x0, y0], [x0 + sw, y0], [x0, y0 + sh], p00, p10, p01);
            triangle(ctx, drawable, [x0 + sw, y0], [x0 + sw, y0 + sh], [x0, y0 + sh], p10, p11, p01);
        }
    }
}
/**
 * Draws the source triangle (s0, s1, s2) of the drawable onto the destination triangle
 * (d0, d1, d2): clips to the destination, widened by half a pixel so the antialiased edges of
 * neighbouring triangles overlap and leave no faint seam, and draws the image through the affine map between them.
 */
function triangle(ctx, drawable, s0, s1, s2, d0, d1, d2) {
    const map = affine(s0, s1, s2, d0, d1, d2);
    if (map === null) {
        return;
    }
    const [cx, cy] = [(d0[0] + d1[0] + d2[0]) / 3, (d0[1] + d1[1] + d2[1]) / 3];
    const grow = ([x, y]) => {
        const dx = x - cx;
        const dy = y - cy;
        const d = Math.hypot(dx, dy);
        return d === 0 ? [x, y] : [x + (dx / d) * 0.5, y + (dy / d) * 0.5];
    };
    ctx.save();
    ctx.beginPath();
    const [g0, g1, g2] = [grow(d0), grow(d1), grow(d2)];
    ctx.moveTo(g0[0], g0[1]);
    ctx.lineTo(g1[0], g1[1]);
    ctx.lineTo(g2[0], g2[1]);
    ctx.closePath();
    ctx.clip();
    ctx.transform(map[0], map[1], map[2], map[3], map[4], map[5]);
    ctx.drawImage(drawable.source, 0, 0, drawable.width, drawable.height);
    ctx.restore();
}
/**
 * The affine map (a, b, c, d, e, f), as canvas `transform` takes it, that sends s0, s1, s2 to
 * d0, d1, d2; null for a degenerate source triangle (its three points on one line).
 */
export function affine(s0, s1, s2, d0, d1, d2) {
    const ux = s1[0] - s0[0];
    const uy = s1[1] - s0[1];
    const vx = s2[0] - s0[0];
    const vy = s2[1] - s0[1];
    const det = ux * vy - uy * vx;
    if (det === 0) {
        return null;
    }
    const px = d1[0] - d0[0];
    const py = d1[1] - d0[1];
    const qx = d2[0] - d0[0];
    const qy = d2[1] - d0[1];
    // Solve [a c; b d] · [ux vx; uy vy] = [px qx; py qy].
    const a = (px * vy - qx * uy) / det;
    const c = (qx * ux - px * vx) / det;
    const b = (py * vy - qy * uy) / det;
    const d = (qy * ux - py * vx) / det;
    const e = d0[0] - a * s0[0] - c * s0[1];
    const f = d0[1] - b * s0[0] - d * s0[1];
    return [a, b, c, d, e, f];
}
/** Traces a closed outline through the points. */
export function outline(ctx, points) {
    const [first, ...rest] = points;
    if (first === undefined) {
        return;
    }
    ctx.beginPath();
    ctx.moveTo(first[0], first[1]);
    for (const [x, y] of rest) {
        ctx.lineTo(x, y);
    }
    ctx.closePath();
}
//# sourceMappingURL=drawing.js.map