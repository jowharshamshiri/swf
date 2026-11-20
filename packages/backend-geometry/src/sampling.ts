import type { Mat4, Vec2, Vec3 } from '@swf/math';
import { mat4TransformPoint, sub } from '@swf/math';
import type { ViewGeometry } from '@swf/presentation';
import type { Projection } from '@swf/projections';
import type { Mesh } from './drawing.js';

/**
 * Where a world point appears in the view, choosing among its images the one nearest `near`, so
 * neighbouring points stay on one branch; null where the view does not show the point. A
 * projection that covers the full circle and wraps at its seam repeats every view width, so its
 * images one width to either side (beyond the image's edges) count too: a surface crossing the
 * seam is then followed continuously past the edge, where clipping cuts it off.
 */
export function imageNear(
  projection: Projection,
  view: ViewGeometry,
  point: Vec3,
  near: Vec2,
): Vec2 | null {
  const eye: Vec3 = [view.camera[12], view.camera[13], view.camera[14]];
  const direction = sub(point, eye);
  if (Math.hypot(...direction) === 0) {
    return null;
  }
  const domain = projection.describeDomain();
  const wraps = domain.fullCircle && domain.seamWrapping;
  const images = projection
    .projectDirection(direction, view)
    .images.flatMap((i): Vec2[] =>
      wraps ? [i, [i[0] - view.width, i[1]], [i[0] + view.width, i[1]]] : [i],
    );
  let best: Vec2 | null = null;
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
 * mesh lines up with an image drawn top-down.
 */
export function planeMesh(
  projection: Projection,
  view: ViewGeometry,
  world: Mat4,
  rect: { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number },
  columns: number,
  rows: number,
  start: Vec2,
): Mesh {
  const points: (Vec2 | null)[][] = [];
  let rowStart: Vec2 = start;
  for (let r = 0; r <= rows; r++) {
    const row: (Vec2 | null)[] = [];
    let previous: Vec2 = rowStart;
    for (let c = 0; c <= columns; c++) {
      const local: Vec3 = [
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
 */
export function planeOutline(
  projection: Projection,
  view: ViewGeometry,
  world: Mat4,
  rect: { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number },
  perEdge: number,
  start: Vec2,
): Vec2[] {
  const tl: Vec3 = [rect.x0, rect.y1, 0];
  const tr: Vec3 = [rect.x1, rect.y1, 0];
  const br: Vec3 = [rect.x1, rect.y0, 0];
  const bl: Vec3 = [rect.x0, rect.y0, 0];
  const out: Vec2[] = [];
  let previous = start;
  for (const [a, b] of [
    [tl, tr],
    [tr, br],
    [br, bl],
    [bl, tl],
  ] as const) {
    for (let i = 0; i < perEdge; i++) {
      const t = i / perEdge;
      const local: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 0];
      const image = imageNear(projection, view, mat4TransformPoint(world, local), previous);
      if (image !== null) {
        out.push(image);
        previous = image;
      }
    }
  }
  return out;
}
