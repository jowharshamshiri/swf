import type { Workspace } from '@swf/core';
import type { PresentedViewport } from '@swf/presentation';
import { TITLE_BAR_HEIGHT, viewGeometryOf } from '@swf/presentation';
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
 * A point of a window's title bar in the application's view: `x` across in the window's own units
 * from its centre, halfway down the bar, which runs across the top of its card; on the copy nearest
 * `nearX` when it is given.
 */
export function titleBarPoint(
  app: { readonly workspace: Workspace; readonly viewport: PresentedViewport },
  id: string,
  x = 0,
  nearX?: number,
): [number, number] {
  const node = app.workspace.getState().nodes.get(id);
  const top = cardPoint(app, id, [x, (node?.bounds[1] ?? 0) / 2], false, nearX);
  if (node === undefined || top === null) {
    throw new Error(`${id} has no card in view`);
  }
  return [top[0], top[1] - TITLE_BAR_HEIGHT / 2];
}
