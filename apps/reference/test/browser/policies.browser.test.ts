import { worldMatrix } from '@swf/core';
import type { Vec3 } from '@swf/math';
import { IDENTITY_MAT4, mat4InvertAffine, mat4TransformPoint } from '@swf/math';
import type { ViewportFrame } from '@swf/presentation';
import { viewGeometryOf } from '@swf/presentation';
import { equirectangular } from '@swf/projections';
import { afterEach, describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import type { ReferenceApp } from '../../src/app.js';
import { createReferenceApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import { VIEWPORT_ID, orbitHeading } from '@swf/navigation';
import { planPreset, WORKSPACE_GROUP_ID } from '../../src/presets.js';

declare module 'vitest/browser' {
  interface BrowserCommands {
    mouse: (
      action: 'move' | 'down' | 'up' | 'double',
      x: number,
      y: number,
      modifiers?: readonly string[],
    ) => Promise<void>;
  }
}

/** The view, with room to its right on the page for a pointer carried past its edge. */
const W = 800;
const H = 400;

let app: ReferenceApp | null = null;
let root: HTMLElement | null = null;
afterEach(async () => {
  await app?.dispose();
  root?.remove();
  app = null;
  root = null;
});

async function start(config: Partial<AppConfig> = {}): Promise<ReferenceApp> {
  root = document.createElement('div');
  root.style.setProperty('position', 'absolute');
  root.style.setProperty('left', '0');
  root.style.setProperty('top', '0');
  root.style.setProperty('width', `${String(W)}px`);
  root.style.setProperty('height', `${String(H)}px`);
  document.body.append(root);
  app = await createReferenceApp({
    root,
    config: { preset: 'sparse', seed: 1, backend: 'dom', restore: false, ...config },
  });
  return app;
}

/** Waits until every surface has settled its binding, then presents a frame. */
async function frame(a: ReferenceApp): Promise<ViewportFrame> {
  for (let i = 0; i < 50; i++) {
    if (a.runtime.list().every((s) => s.state !== 'binding')) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const update = await a.viewport.update();
  if (update.status !== 'presented') {
    throw new Error(`the viewport is degraded: ${update.error.message}`);
  }
  return update;
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** Where a point of a window, in its local frame, appears in the view: the image nearest `nearX`. */
function screenOf(a: ReferenceApp, nodeId: string, local: Vec3, nearX = W / 2): [number, number] {
  const state = a.workspace.getState();
  const m = worldMatrix(state.nodes, nodeId);
  if (m === undefined) {
    throw new Error(`no ${nodeId}`);
  }
  const view = viewGeometryOf(state, VIEWPORT_ID);
  const images = equirectangular
    .create(view.projectionConfig)
    .projectDirection(mat4TransformPoint(m, local), view).images;
  const image = [...images].sort((p, q) => Math.abs(p[0] - nearX) - Math.abs(q[0] - nearX))[0];
  if (image === undefined) {
    throw new Error(`${nodeId} is not in view`);
  }
  return [image[0], image[1]];
}

/** The gestures the router ran, as `start <operation> <node>` and `end <outcome>`. */
function gesturesOf(a: ReferenceApp): string[] {
  const seen: string[] = [];
  a.router.subscribe((event) => {
    if (event.type === 'gesture.started') {
      seen.push(`start ${event.operation} ${event.nodeId ?? ''}`);
    } else if (event.type === 'gesture.ended') {
      seen.push(`end ${event.finish.outcome}`);
    }
  });
  return seen;
}

/** The virtual cursor's drawn arrow, and where its tip is in the view (null while hidden). */
function virtualCursor(): { x: number; y: number } | null {
  const arrow = root?.querySelector<SVGElement>('[data-swf-layer="virtual-cursor"] svg');
  if (arrow === null || arrow === undefined || getComputedStyle(arrow).display === 'none') {
    return null;
  }
  const box = arrow.getBoundingClientRect();
  const view = root?.getBoundingClientRect();
  return { x: box.left - (view?.left ?? 0), y: box.top - (view?.top ?? 0) };
}

describe('the wrapped cursor across the seam (§33.2 scenario 2, FR-107, FR-123)', () => {
  it('carries a window past the view’s edge and back in at the other, under a virtual cursor, as one change', async () => {
    const a = await start({ preset: 'seam' });
    // Snapping would turn the window a little at release; this checks the anchor exactly.
    a.policies.configure({ enabled: { snap: false } });
    await frame(a);
    const gestures = gesturesOf(a);
    const before = a.workspace.getState();
    // Pressed on whole pixels, as every browser reports them, left of the seam (the right edge).
    const [sx, sy] = screenOf(a, 'window-01', [-0.7, 0, 0], W);
    const x = Math.round(sx);
    const y = Math.round(sy);
    expect(x).toBeGreaterThan(W - 60);
    const pick = a.router.pick(VIEWPORT_ID, x, y);
    if (pick.kind !== 'hit' || pick.target.nodeId !== 'window-01') {
      throw new Error('the press does not land on window-01');
    }
    // The grabbed point, in the window's own frame.
    const toLocal = mat4InvertAffine(
      worldMatrix(a.workspace.getState().nodes, 'window-01') ?? IDENTITY_MAT4,
    );
    if (toLocal === null) {
      throw new Error('window-01 has no placement');
    }
    const grabbed = mat4TransformPoint(toLocal, pick.target.worldPoint);
    const last = x + Math.floor((W + 60 - x) / 4) * 4;
    await commands.mouse('move', x, y);
    await commands.mouse('down', x, y, ['Alt']);
    for (let px = x + 4; px <= last; px += 4) {
      await commands.mouse('move', px, y);
      await nextFrame();
    }
    // Past the edge, the pointer the page cannot move is out beyond W: a cursor is drawn wrapped.
    const drawn = virtualCursor();
    await commands.mouse('up', last, y);
    expect(drawn?.x).toBeCloseTo(last - W, 0);
    expect(drawn?.y).toBeCloseTo(y, 0);
    expect(virtualCursor()).toBeNull();
    expect(gestures).toEqual(['start node.move window-01', 'end committed']);
    // The window taken is selected (not an undo step), then the move is committed once.
    expect(a.workspace.getState().revision).toBe(before.revision + 2);
    // The grabbed point of the same window is under where the pointer wrapped to.
    const [ax, ay] = screenOf(a, 'window-01', grabbed, last - W);
    expect(ax).toBeCloseTo(last - W, 0);
    expect(ay).toBeCloseTo(y, 0);
    for (const node of before.nodes.values()) {
      if (node.id !== 'window-01') {
        expect(a.workspace.getState().nodes.get(node.id)).toBe(node);
      }
    }
    // One undo puts back exactly the one change.
    expect((await a.commands.run('swf.history.undo', {})).status).toBe('done');
    expect(a.workspace.getState().nodes.get('window-01')?.transform).toEqual(
      before.nodes.get('window-01')?.transform,
    );
  });

  it('stops at the edge with the wrapped cursor off, standard pointer input unchanged', async () => {
    const a = await start({ preset: 'seam' });
    a.policies.configure({ enabled: { snap: false, cursor: false } });
    await frame(a);
    const grabbed: Vec3 = [-0.7, 0, 0];
    const [sx, sy] = screenOf(a, 'window-01', grabbed, W);
    const x = Math.round(sx);
    const y = Math.round(sy);
    await commands.mouse('move', x, y);
    await commands.mouse('down', x, y, ['Alt']);
    for (let px = x + 4; px <= W + 60; px += 4) {
      await commands.mouse('move', px, y);
      await nextFrame();
    }
    const drawn = virtualCursor();
    await commands.mouse('up', W + 60, y);
    expect(drawn).toBeNull();
    const [ax] = screenOf(a, 'window-01', grabbed, W);
    expect(ax).toBeGreaterThan(W - 8);
  });
});

describe('workspace orbit beside camera navigation (FR-068, FR-106, FR-121)', () => {
  /** Drags the background, high above the sparse scene's windows, 80 px to the right. */
  async function dragSky(): Promise<void> {
    await commands.mouse('move', 400, 30);
    await commands.mouse('down', 400, 30);
    for (let px = 404; px <= 480; px += 4) {
      await commands.mouse('move', px, 30);
      await nextFrame();
    }
    await commands.mouse('up', 480, 30);
  }

  it('turns the camera, or the workspace group as one undoable change, as the switch says', async () => {
    const a = await start({ preset: 'sparse' });
    await frame(a);
    const gestures = gesturesOf(a);
    const group = a.workspace.getState().nodes.get(WORKSPACE_GROUP_ID)?.transform;
    const camera = () => a.workspace.getState().cameras.get('camera')?.rotation;
    const history = a.workspace.history().length;
    const start0 = camera();
    await dragSky();
    expect(gestures.slice(-2)).toEqual(['start camera.turn ', 'end committed']);
    expect(camera()).not.toEqual(start0);
    expect(a.workspace.getState().nodes.get(WORKSPACE_GROUP_ID)?.transform).toEqual(group);
    // A camera turn is view state: nothing was added to undo.
    expect(a.workspace.history()).toHaveLength(history);

    expect((await a.commands.run('swf.navigation.set', { target: 'orbit' })).status).toBe('done');
    const turned = camera();
    await dragSky();
    expect(gestures.slice(-2)).toEqual(['start orbit.turn workspace', 'end committed']);
    expect(camera()).toEqual(turned);
    expect(Math.abs(orbitHeading(a.workspace.getState()) ?? 0)).toBeGreaterThan(0.3);
    // The live note moved with its group on screen.
    const f = await frame(a);
    expect(f.frame.sceneRevision).toBe(a.workspace.getState().revision);
    expect((await a.commands.run('swf.history.undo', {})).status).toBe('done');
    expect(a.workspace.getState().nodes.get(WORKSPACE_GROUP_ID)?.transform).toEqual(group);
    expect(camera()).toEqual(turned);
  });
});

describe('semantic depth on the DOM backend (FR-122, ARCH-025)', () => {
  it('shows near windows live, farther ones as compact proxies and the farthest as labels, their content kept', async () => {
    const a = await start({ preset: 'dense' });
    const f = await frame(a);
    const { full, compact } = a.policies.status().features.depth;
    const planned = planPreset('dense', 1);
    const bandOf = (distance: number) =>
      distance < full ? 'full' : distance < compact ? 'compact' : 'label';
    const shown = new Map(
      f.frame.planned.map((p) => [p.fragment.surfaceId, p.representation] as const),
    );
    for (const w of planned) {
      const chosen = shown.get(`${w.id}-surface`);
      if (
        chosen !== undefined &&
        Math.abs(w.distance - full) > 1e-6 &&
        Math.abs(w.distance - compact) > 1e-6
      ) {
        expect(chosen, w.id).toBe(bandOf(w.distance));
      }
    }
    const far = planned.find((w) => w.content === 'note' && w.distance > compact + 0.05);
    const near = planned.find((w) => w.content === 'note' && w.distance < full - 0.05);
    if (far === undefined || near === undefined) {
      throw new Error('the dense scene has no far or near note');
    }
    expect(a.viewport.presentation(`${near.id}-surface`)).toBe('live');
    expect(a.viewport.presentation(`${far.id}-surface`)).toBe('proxy');
    const label = root?.querySelector(
      `[data-swf-layer="proxy"][data-swf-surface="${far.id}-surface"]`,
    );
    expect(label?.getAttribute('data-swf-representation')).toBe('label');
    // Marked where it is; its name, where there is room for it, beside the mark.
    const mark = label?.querySelector<HTMLElement>('[data-swf-mark]');
    expect(mark === null || mark === undefined ? '' : getComputedStyle(mark).display).toBe('block');
    const name = root?.querySelector(`[data-swf-layer="names"] [data-swf-node="${far.id}"]`);
    if (name !== null && name !== undefined) {
      expect(name.textContent).toBe(far.label);
    }
    expect(root?.querySelector(`[data-swf-layer="chrome"][data-swf-node="${far.id}"]`)).toBeNull();
    // Represented from the first frame, its content is bound but was never shown here.
    expect(a.runtime.get(`${far.id}-surface`)?.state).toBe('ready');

    // Off, every window shows its content.
    const surface = `${far.id}-surface`;
    const selector = `[data-reference-content="${far.bindingKey}"]`;
    a.policies.configure({ enabled: { depth: false } });
    await frame(a);
    expect(a.viewport.presentation(surface)).toBe('live');
    const content = root?.querySelector(selector);
    expect(content?.isConnected).toBe(true);
    // On again: its label stands for it, and its content stays attached, hidden, the same element.
    a.policies.configure({ enabled: { depth: true } });
    await frame(a);
    expect(a.viewport.presentation(surface)).toBe('proxy');
    expect(a.runtime.get(surface)?.state).toBe('hidden');
    expect(content?.isConnected).toBe(true);
    a.policies.configure({ enabled: { depth: false } });
    await frame(a);
    expect(root?.querySelector(selector)).toBe(content);
  });
});

describe('magnetic positioning in the panorama (FR-125, UX-007)', () => {
  it('previews a move snapped level with the horizon, and commits the snapped place once', async () => {
    const a = await start({ preset: 'seam' });
    await frame(a);
    // window-07 stands straight ahead on the horizon: lift it 1.5° (inside the 2° line-up angle).
    const id = 'window-07';
    const gestures = gesturesOf(a);
    const before = a.workspace.getState();
    const historyBefore = a.workspace.history().length;
    const [x, y] = screenOf(a, id, [0, 0, 0]);
    const lift = 1.5 / (120 / H);
    await commands.mouse('move', x, y);
    await commands.mouse('down', x, y, ['Alt']);
    for (let dy = 1; dy <= Math.ceil(lift) + 6; dy += 1) {
      await commands.mouse('move', x, y - dy);
      await nextFrame();
    }
    await commands.mouse('move', x, y - lift);
    await nextFrame();
    // While it moves, the snap is previewed and said: level, with the horizon or with Note 01
    // (on the horizon too, behind the camera), whichever lines up first.
    const level = (a.policies.status().gesture?.snap?.constraints ?? []).filter(
      (c) => c.kind === 'horizon' || (c.kind === 'align' && c.axis === 'elevation'),
    );
    expect(level).toHaveLength(1);
    expect(worldMatrix(a.workspace.getPresented().nodes, id)?.[13]).toBeCloseTo(0, 9);
    // Nothing is committed while it moves but its selection, which undo does not count.
    expect(a.workspace.getState().nodes).toStrictEqual(before.nodes);
    expect(a.workspace.getState().selection).toEqual([id]);
    await commands.mouse('up', x, y - lift);
    expect(gestures).toEqual([`start node.move ${id}`, 'end committed']);
    const m = worldMatrix(a.workspace.getState().nodes, id);
    expect(m?.[13]).toBeCloseTo(0, 9);
    expect(a.policies.status().ended).toMatchObject({ outcome: 'committed', nodeId: id });
    expect(a.workspace.getState().revision).toBe(before.revision + 2);
    expect(a.workspace.history()).toHaveLength(historyBefore + 1);
  });
});
