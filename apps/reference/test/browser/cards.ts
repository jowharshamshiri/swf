import type { Workspace } from '@swf/core';
import type { PresentedViewport } from '@swf/presentation';
import { viewGeometryOf } from '@swf/presentation';
import { equirectangular, projectorOf } from '@swf/projections';

/**
 * Where a point of a window's card lies in the application's view, in the view's own pixels:
 * `local` in the window's own units from its centre (x right, y up), on the card the view draws for
 * it with the representation policy it draws by. Where the view shows the whole circle and a card
 * is drawn at both edges, the copy nearest `nearX` when it is given, else the copy that shows the
 * point. With `presented`, as every view presents the scene now, a preview included. Null when the
 * view draws no card for the window.
 */
export function cardPoint(
  app: { readonly workspace: Workspace; readonly viewport: PresentedViewport },
  id: string,
  [lx, ly]: readonly [number, number],
  presented = false,
  nearX?: number,
): [number, number] | null {
  const state = presented ? app.workspace.getPresented() : app.workspace.getState();
  const node = state.nodes.get(id);
  const view = viewGeometryOf(state, app.viewport.viewportId);
  const own = projectorOf(equirectangular)
    .project(
      state,
      view,
      (surfaceId) => app.workspace.surfaceGeometry(surfaceId),
      app.viewport.representation(),
    )
    .find((f) => f.nativeOwner && state.surfaces.get(f.surfaceId)?.ownerNodeId === id);
  if (node === undefined || own === undefined) {
    return null;
  }
  const [x, y, w, h] = own.card;
  const px = x + w / 2 + (lx * w) / node.bounds[0];
  const py = y + h / 2 - (ly * h) / node.bounds[1];
  const config = view.projectionConfig as { readonly horizontal?: number } | null;
  const copies = config?.horizontal === 360 ? [px, px - view.width, px + view.width] : [px];
  if (nearX !== undefined) {
    const nearest = [...copies].sort((a, b) => Math.abs(a - nearX) - Math.abs(b - nearX))[0];
    return [nearest ?? px, py];
  }
  return [copies.find((c) => c >= 0 && c < view.width) ?? px, py];
}

/**
 * A point of a window's frame in the application's view, in its title band: `x` across in the
 * window's own units from its centre, midway down between the band along its top edge that a resize
 * takes (`handlePx`) and the top of its first surface, in the card's pixels; on the copy nearest
 * `nearX` when it is given.
 */
export function framePoint(
  app: {
    readonly workspace: Workspace;
    readonly viewport: PresentedViewport;
    readonly router: { settings(): { readonly handlePx: number } };
  },
  id: string,
  x = 0,
  nearX?: number,
): [number, number] {
  const state = app.workspace.getState();
  const node = state.nodes.get(id);
  const surface = state.surfaces.get(node?.surfaceIds[0] ?? '');
  const top = cardPoint(app, id, [x, (node?.bounds[1] ?? 0) / 2], false, nearX);
  const bottom = cardPoint(app, id, [x, -(node?.bounds[1] ?? 0) / 2], false, nearX);
  if (node === undefined || surface === undefined || top === null || bottom === null) {
    throw new Error(`${id} has no card with a surface in view`);
  }
  const perUnit = (bottom[1] - top[1]) / node.bounds[1];
  const surfaceTop =
    (node.bounds[1] / 2 - (surface.transform.position[1] + surface.bounds[1] / 2)) * perUnit;
  const band = app.router.settings().handlePx;
  if (!(surfaceTop > band + 2)) {
    throw new Error(`${id}'s card has no title band outside its resize band`);
  }
  return [top[0], top[1] + (band + surfaceTop) / 2];
}
