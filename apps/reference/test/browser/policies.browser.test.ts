import { worldMatrix } from '@swf/core';
import type { ViewportFrame } from '@swf/presentation';
import { afterEach, describe, expect, it } from 'vitest';
import { commands, server, userEvent } from 'vitest/browser';
import type { ReferenceApp } from '../../src/app.js';
import { createReferenceApp } from '../../src/app.js';
import type { AppConfig } from '../../src/config.js';
import { VIEWPORT_ID, orbitHeading } from '@swf/navigation';
import { planPreset, WORKSPACE_GROUP_ID } from '../../src/presets.js';
import { cardPoint, titleBarPoint } from './cards.js';

declare module 'vitest/browser' {
  interface BrowserCommands {
    mouse: (
      action: 'move' | 'down' | 'up' | 'double' | 'release',
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

/** The view's root of the test running: there is one from its start. */
function viewRoot(): HTMLElement {
  if (root === null) {
    throw new Error('no view is mounted');
  }
  return root;
}
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

/**
 * Where a point of a window's card, in its own units from its centre, appears in the view: on the
 * copy of its card nearest `nearX`.
 */
function screenOf(
  a: ReferenceApp,
  nodeId: string,
  local: readonly [number, number],
  nearX = W / 2,
  presented = false,
): [number, number] {
  const at = cardPoint(a, nodeId, local, presented, nearX);
  if (at === null) {
    throw new Error(`${nodeId} is not in view`);
  }
  return at;
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

/**
 * Whether the browser locks a pointer to the view for a drag. Playwright's Chromium and Firefox
 * do; its WebKit refuses a lock asked for outside a press ("requires a user gesture"), so there a
 * drag wraps only as far as the platform's pointer goes.
 */
const LOCKS = server.browser !== 'webkit';

/**
 * Makes the platform refuse to lock the pointer to `element`, as a browser does that will not take
 * it (its promise rejected with `NotAllowedError`, and `pointerlockerror` on the document), where
 * this browser would otherwise grant it. Returns what puts the platform's own lock back.
 */
function refusingLocks(element: HTMLElement): () => void {
  if (!LOCKS) {
    return () => undefined;
  }
  Object.defineProperty(element, 'requestPointerLock', {
    configurable: true,
    value: () => {
      queueMicrotask(() => document.dispatchEvent(new Event('pointerlockerror')));
      return Promise.reject(new DOMException('The pointer lock was refused', 'NotAllowedError'));
    },
  });
  return () => {
    delete (element as { requestPointerLock?: unknown }).requestPointerLock;
  };
}

/** How many samples the platform has sent of a locked pointer since the test began. */
let platformLockedMoves = 0;
document.addEventListener(
  'pointermove',
  (e) => {
    if (e.isTrusted && document.pointerLockElement !== null) {
      platformLockedMoves += 1;
    }
  },
  { capture: true },
);
afterEach(() => {
  platformLockedMoves = 0;
});

/**
 * Waits until the view holds the pointer lock and the platform has sent its first sample under
 * it, whose motion is the platform's own (Chromium's to the page's corner), so that motion made
 * after it is the mouse's; then lets the frames it moves be shown.
 */
async function lockedAndWarped(element: HTMLElement | null): Promise<void> {
  await lockedTo(element, true);
  await expect.poll(() => platformLockedMoves, { timeout: 3000 }).toBeGreaterThan(0);
  await nextFrame();
  await nextFrame();
}

/** Waits until the view holds the pointer lock, or no longer does. */
async function lockedTo(element: HTMLElement | null, held: boolean): Promise<void> {
  await expect.poll(() => document.pointerLockElement === element, { timeout: 3000 }).toBe(held);
}

/**
 * Motion of the locked pointer, as the platform reports it: a sample at the place the lock froze,
 * carrying `movementX`/`movementY`. Browser automation moves a pointer only to places on the
 * page, which a locked pointer no longer has (Chromium's headless shell answers each such move
 * with its opposite, Firefox measures it from a centre it warps to), so the motion alone is made
 * here; the press, the lock, the release and the keys stay the browser's own.
 */
function lockedMotion(target: HTMLElement, pointerId: number, dx: number, dy: number): void {
  const box = target.getBoundingClientRect();
  target.dispatchEvent(
    new PointerEvent('pointermove', {
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      buttons: 1,
      clientX: box.left + box.width - 1,
      clientY: box.top + box.height / 2,
      movementX: dx,
      movementY: dy,
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );
}

/** The ID the browser gives the mouse's pointer, from its next press in the view. */
function pointerIdOfNextPress(element: HTMLElement): () => number {
  let id = -1;
  element.addEventListener(
    'pointerdown',
    (e) => {
      id = e.pointerId;
    },
    { capture: true, once: true },
  );
  return () => id;
}

describe('the wrapped cursor across the seam (§33.2 scenario 2, FR-107, FR-123)', () => {
  /**
   * Presses window-01 left of the seam (the right edge) on its frame's title band, Alt held, and
   * drags it to the edge.
   */
  async function toTheEdge(a: ReferenceApp, grabbedX = -0.7) {
    const [sx, sy] = titleBarPoint(a, 'window-01', grabbedX, W);
    const x = Math.round(sx);
    const y = Math.round(sy);
    expect(x).toBeGreaterThan(W - 60);
    const pick = a.router.pick(VIEWPORT_ID, x, y);
    if (pick.kind !== 'hit' || pick.target.nodeId !== 'window-01') {
      throw new Error('the press does not land on window-01');
    }
    // The point of its card pressed, in its own units.
    const perUnit =
      (screenOf(a, 'window-01', [0, 1], W)[1] - screenOf(a, 'window-01', [0, 0], W)[1]) * -1;
    const grabbed = [grabbedX, (screenOf(a, 'window-01', [0, 0], W)[1] - sy) / perUnit] as const;
    const pointerId = pointerIdOfNextPress(viewRoot());
    await commands.mouse('move', x, y);
    await commands.mouse('down', x, y, ['Alt']);
    for (let px = x + 4; px < W - 2; px += 4) {
      await commands.mouse('move', px, y);
      await nextFrame();
    }
    await commands.mouse('move', W - 2, y);
    await nextFrame();
    return { grabbed, y, pointerId: pointerId() };
  }

  it.runIf(LOCKS)(
    'locks the pointer at the edge and carries the window on across the seam by the mouse’s motion, as one change',
    async () => {
      const a = await start({ preset: 'seam' });
      // Snapping would turn the window a little at release; this checks the anchor exactly.
      a.policies.configure({ enabled: { snap: false } });
      await frame(a);
      const gestures = gesturesOf(a);
      const before = a.workspace.getState();
      const { grabbed, pointerId } = await toTheEdge(a);
      await lockedAndWarped(root);
      // The platform's pointer is hidden: the virtual cursor shows where the drag acts.
      const locked = virtualCursor();
      expect(locked).not.toBeNull();
      expect(gestures).toEqual(['start node.move window-01']);
      // The virtual cursor starts where the drag reached the edge, whatever motion the platform
      // reports as the lock takes hold.
      expect(locked?.x).toBeCloseTo(W - 2, 0);
      // Past the seam and on, in steps: the window turns round the room by the pointer's motion.
      let at = { x: locked?.x ?? 0, y: locked?.y ?? 0 };
      for (let i = 0; i < 5; i++) {
        lockedMotion(viewRoot(), pointerId, 30, 0);
        // The drag's preview is announced on the next frame, and shown on the one after.
        await nextFrame();
        await nextFrame();
        at = { x: (at.x + 30) % W, y: at.y };
        const drawn = virtualCursor();
        expect(drawn?.x).toBeCloseTo(at.x, 0);
        // The grabbed point of the window, as the drag shows it, stays under the virtual cursor,
        // across the seam too.
        const [gx, gy] = screenOf(a, 'window-01', grabbed, at.x, true);
        expect(gx).toBeCloseTo(at.x, 0);
        expect(gy).toBeCloseTo(at.y, 0);
      }
      await commands.mouse('release', 0, 0);
      await lockedTo(root, false);
      expect(virtualCursor()).toBeNull();
      expect(gestures).toEqual(['start node.move window-01', 'end committed']);
      // The window taken is selected (not an undo step), then the move is committed once.
      expect(a.workspace.getState().revision).toBe(before.revision + 2);
      const [ax, ay] = screenOf(a, 'window-01', grabbed, at.x);
      expect(ax).toBeCloseTo(at.x, 0);
      expect(ay).toBeCloseTo(at.y, 0);
      for (const node of before.nodes.values()) {
        if (node.id !== 'window-01') {
          expect(a.workspace.getState().nodes.get(node.id)).toBe(node);
        }
      }
      expect((await a.commands.run('swf.history.undo', {})).status).toBe('done');
      expect(a.workspace.getState().nodes.get('window-01')?.transform).toEqual(
        before.nodes.get('window-01')?.transform,
      );
    },
  );

  it('where the browser refuses the lock, carries a window past the edge only as far as the pointer goes', async () => {
    const a = await start({ preset: 'seam' });
    const restore = refusingLocks(viewRoot());
    a.policies.configure({ enabled: { snap: false } });
    await frame(a);
    const gestures = gesturesOf(a);
    const { grabbed, y } = await toTheEdge(a);
    const last = W + 60;
    for (let px = W + 4; px <= last; px += 4) {
      await commands.mouse('move', px, y);
      await nextFrame();
    }
    // Past the edge, the captured pointer the page cannot move is out beyond W: a cursor is
    // drawn wrapped, and the lock was refused.
    const drawn = virtualCursor();
    expect(document.pointerLockElement).toBeNull();
    await commands.mouse('up', last, y);
    expect(drawn?.x).toBeCloseTo(last - W, 0);
    expect(drawn?.y).toBeCloseTo(y, 0);
    expect(virtualCursor()).toBeNull();
    expect(gestures).toEqual(['start node.move window-01', 'end committed']);
    // The grabbed point of the same window is under where the pointer wrapped to: the drag got
    // as far as the pointer went, and stops where it stops.
    const [ax, ay] = screenOf(a, 'window-01', grabbed, last - W);
    expect(ax).toBeCloseTo(last - W, 0);
    expect(ay).toBeCloseTo(y, 0);
    restore();
  });

  it('lets the pointer go and cancels the drag on Escape', async () => {
    const a = await start({ preset: 'seam' });
    a.policies.configure({ enabled: { snap: false } });
    await frame(a);
    const gestures = gesturesOf(a);
    const before = a.workspace.getState().nodes.get('window-01')?.transform;
    const { pointerId } = await toTheEdge(a);
    if (LOCKS) {
      await lockedAndWarped(root);
      lockedMotion(viewRoot(), pointerId, 120, 0);
      await nextFrame();
    }
    await userEvent.keyboard('{Escape}');
    await lockedTo(root, false);
    await expect.poll(() => gestures.at(-1)).toBe('end cancelled');
    expect(virtualCursor()).toBeNull();
    await commands.mouse('release', 0, 0);
    expect(a.workspace.getState().nodes.get('window-01')?.transform).toEqual(before);
  });

  it('turns the view round past its edge with the pointer locked, and lets it go at release', async () => {
    const a = await start({ preset: 'seam' });
    await frame(a);
    const gestures = gesturesOf(a);
    const pointerId = pointerIdOfNextPress(viewRoot());
    // High above the scene's windows: the background, whose drag turns the camera.
    await commands.mouse('move', 400, 20);
    await commands.mouse('down', 400, 20);
    for (let px = 404; px < W - 2; px += 8) {
      await commands.mouse('move', px, 20);
      await nextFrame();
    }
    await commands.mouse('move', W - 2, 20);
    await nextFrame();
    if (LOCKS) {
      await lockedAndWarped(root);
      const camera = a.workspace.getState().cameras.get('camera')?.rotation;
      // 560 px of 800: most of the way round, not the whole of it, which would turn it back.
      for (let i = 0; i < 7; i++) {
        lockedMotion(viewRoot(), pointerId(), 80, 0);
        await nextFrame();
      }
      // The view kept turning past the edge, by the motion alone.
      expect(a.workspace.getState().cameras.get('camera')?.rotation).not.toEqual(camera);
    } else {
      expect(document.pointerLockElement).toBeNull();
    }
    await commands.mouse('release', 0, 0);
    await lockedTo(root, false);
    expect(gestures).toEqual(['start camera.turn ', 'end committed']);
    expect(virtualCursor()).toBeNull();
  });

  it('stops at the edge with the wrapped cursor off, standard pointer input unchanged', async () => {
    const a = await start({ preset: 'seam' });
    a.policies.configure({ enabled: { snap: false, cursor: false } });
    await frame(a);
    // Low on its card, clear of the title bars of the windows standing in front of it.
    const grabbed = [-0.7, -0.35] as const;
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
    // Off, the wrapped cursor never asks for the lock.
    expect(document.pointerLockElement).toBeNull();
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
        Math.abs(w.reach - full) > 1e-6 &&
        Math.abs(w.reach - compact) > 1e-6
      ) {
        expect(chosen, w.id).toBe(bandOf(w.reach));
      }
    }
    const far = planned.find((w) => w.content === 'note' && w.reach > compact + 0.05);
    const near = planned.find((w) => w.content === 'note' && w.reach < full - 0.05);
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
    // window-07 stands straight ahead on the horizon: raise it to look 1.5° up (inside the 2°
    // line-up angle), a 68th of a unit of height a pixel.
    const id = 'window-07';
    const gestures = gesturesOf(a);
    const before = a.workspace.getState();
    const historyBefore = a.workspace.history().length;
    const [x, y] = screenOf(a, id, [0, 0]);
    const reach = a.poseOf(id)?.reach ?? NaN;
    const lift = reach * Math.tan((1.5 * Math.PI) / 180) * 68;
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
