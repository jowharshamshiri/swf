import type { SceneState } from '@swf/core';
import { worldMatrix } from '@swf/core';
import { createMemoryStore } from '@swf/persistence';
import { describe, expect, it } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import type { ReferenceApp } from '../../src/app.js';
import { ENGLISH } from '../../src/messages.js';
import { CAMERA_ID, poseOf } from '@swf/navigation';
import type { Mounted } from './shell-harness.js';
import { cardPoint, titleBarPoint } from './cards.js';
import { same, start } from './shell-harness.js';

declare module 'vitest/browser' {
  interface BrowserCommands {
    wheel: (
      x: number,
      y: number,
      deltaX: number,
      deltaY: number,
      modifiers?: readonly string[],
    ) => Promise<void>;
    mouse: (
      action: 'move' | 'down' | 'up' | 'double' | 'release',
      x: number,
      y: number,
      modifiers?: readonly string[],
    ) => Promise<void>;
  }
}

/**
 * Windows handled directly in the panorama and set from the inspector's sliders: every gesture
 * shows where the window would be as it goes, commits once when it ends (one undo puts it back),
 * and the scene's transform is what every control reads.
 */

/** The sparse scene, seen through a 120° panorama so its windows are large enough to take. */
async function visit(): Promise<Mounted & { readonly app: ReferenceApp }> {
  const m = await start('?preset=sparse', { store: createMemoryStore() });
  const app = m.model.app;
  if (app === null) {
    throw new Error('no application');
  }
  // The inspector open on the right, whatever an earlier visit left there.
  if (!m.driver.has('page.inspector')) {
    m.driver.act('worktree.view#inspector', 'press');
    await m.settle();
  }
  expect(m.driver.has('page.inspector')).toBe(true);
  // Each gesture's place exactly as the pointer takes it, with no snap at release.
  app.policies.configure({ enabled: { snap: false } });
  expect(await m.model.run('swf.view.fov', { degrees: 120 })).toBe(true);
  await m.settle();
  return { ...m, app };
}

/** Where a point of a window's card, in its own units from its centre, is on the page. */
function onPage(app: ReferenceApp, id: string, local: readonly [number, number]): [number, number] {
  const at = cardPoint(app, id, local);
  if (at === null) {
    throw new Error(`${id} is not in view`);
  }
  // The element the viewport fills, whichever backend presents it.
  const box = app.root.getBoundingClientRect();
  return [Math.round(box.left + at[0]), Math.round(box.top + at[1])];
}

/** A point on a window's frame, in its title band, on the page. */
function onFrame(app: ReferenceApp, id: string): [number, number] {
  const [x, y] = titleBarPoint(app, id);
  const box = app.root.getBoundingClientRect();
  return [Math.round(box.left + x), Math.round(box.top + y)];
}

/** A window's pose in a scene, seen from the camera. */
function poseIn(state: SceneState, id: string) {
  const eye = state.cameras.get(CAMERA_ID)?.position;
  const pose = eye === undefined ? null : poseOf(state, id, eye);
  if (pose === null) {
    throw new Error(`no ${id}`);
  }
  return pose;
}

/** What a slider of the inspector shows now. */
function slider(m: Mounted, field: string): number {
  const rail = m.root.querySelector(`[data-wsb="page.inspector.pose#${field}"]`);
  const value = rail?.getAttribute('aria-valuenow');
  if (value === null || value === undefined) {
    throw new Error(`no ${field} slider`);
  }
  return Number(value);
}

/** What the gesture bar says. */
const bar = (m: Mounted) =>
  m.root.querySelector(`[aria-label="${ENGLISH['gesture.label']}"]`)?.textContent ?? '';

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/**
 * Drags from a point by steps, with modifiers held throughout, sampling after each step what
 * `read` reads; released at the end.
 */
async function dragFrom<T>(
  m: Mounted,
  [x, y]: [number, number],
  step: [number, number],
  steps: number,
  modifiers: readonly string[],
  read: () => T,
): Promise<T[]> {
  const seen: T[] = [];
  await commands.mouse('move', x, y);
  await commands.mouse('down', x, y, modifiers);
  for (let i = 1; i <= steps; i += 1) {
    await commands.mouse('move', x + step[0] * i, y + step[1] * i, modifiers);
    await nextFrame();
    await m.settle();
    seen.push(read());
  }
  await commands.mouse('up', x + step[0] * steps, y + step[1] * steps, modifiers);
  await m.settle();
  return seen;
}

/** Each value differs from the one before: the reading followed the pointer all the way. */
const everyStepMoved = (values: readonly number[]) =>
  values.slice(1).every((value, i) => Math.abs(value - (values[i] ?? value)) > 1e-9);

describe('a window handled directly in the panorama', () => {
  it('moves round the camera as it is dragged, shown all the way, and is one undo step when let go', async () => {
    const m = await visit();
    const { app } = m;
    const before = app.workspace.getState();
    const history = app.workspace.history().length;
    const seen = await dragFrom(m, onFrame(app, 'window-01'), [12, 0], 6, [], () => ({
      bar: bar(m),
      shown: app.poseOf('window-01')?.heading ?? NaN,
      slider: slider(m, 'heading'),
      committed: app.workspace.history().length,
      scene: poseIn(app.workspace.getState(), 'window-01').heading,
    }));
    // Selected by the drag, followed by the gesture bar and the inspector's slider at every step,
    // and nothing committed until it was let go.
    expect(seen.every((s) => s.bar.includes('Moving Tile 01'))).toBe(true);
    expect(new Set(seen.map((s) => s.bar)).size).toBe(seen.length);
    expect(everyStepMoved(seen.map((s) => s.shown))).toBe(true);
    expect(seen.map((s) => s.slider)).toEqual(seen.map((s) => Math.round(s.shown)));
    expect(seen.every((s) => s.committed === history)).toBe(true);
    expect(seen.every((s) => s.scene === poseIn(before, 'window-01').heading)).toBe(true);
    expect(m.model.selected?.id).toBe('window-01');
    // One change, the last place shown, and the inspector reads the scene.
    expect(app.workspace.history()).toHaveLength(history + 1);
    const moved = poseIn(app.workspace.getState(), 'window-01').heading;
    expect(moved).toBeCloseTo(seen.at(-1)?.shown ?? NaN, 9);
    expect(slider(m, 'heading')).toBe(Math.round(moved));
    expect(bar(m)).toContain('Moved Tile 01');
    m.driver.act('page.gesture.undo', 'press');
    await m.settle();
    expect(app.workspace.getState().nodes.get('window-01')?.transform).toEqual(
      before.nodes.get('window-01')?.transform,
    );
    expect(slider(m, 'heading')).toBe(Math.round(poseIn(before, 'window-01').heading));
  });

  it('goes farther or comes nearer along the floor with Shift held, down pushing it away and up pulling it in, as one change', async () => {
    const m = await visit();
    const { app } = m;
    const before = app.workspace.getState();
    const history = app.workspace.history().length;
    const reach = () => app.poseOf('window-01')?.reach ?? NaN;
    const start = reach();
    const away = await dragFrom(m, onFrame(app, 'window-01'), [0, 10], 6, ['Shift'], () => ({
      reach: reach(),
      slider: slider(m, 'reach'),
      bar: bar(m),
    }));
    expect(everyStepMoved(away.map((s) => s.reach))).toBe(true);
    expect(away.every((s, i) => s.reach > (away[i - 1]?.reach ?? start))).toBe(true);
    expect(away.map((s) => s.slider)).toEqual(away.map((s) => Number(s.reach.toFixed(1))));
    expect(away.every((s) => s.bar.includes('units away'))).toBe(true);
    // With magnetic positioning off it never snaps: the bar says it previews, not that nothing
    // snapped.
    expect(away.every((s) => s.bar.includes(ENGLISH['gesture.preview']))).toBe(true);
    expect(away.some((s) => s.bar.includes(ENGLISH['gesture.free']))).toBe(false);
    expect(app.workspace.history()).toHaveLength(history + 1);
    const farther = poseIn(app.workspace.getState(), 'window-01');
    expect(farther.reach).toBeGreaterThan(start * 1.3);
    // Its heading and height kept: the pointer went straight down, along the floor.
    expect(farther.heading).toBeCloseTo(poseIn(before, 'window-01').heading, 9);
    expect(farther.above).toBeCloseTo(poseIn(before, 'window-01').above, 9);
    // And back: up brings it nearer.
    await dragFrom(m, onFrame(app, 'window-01'), [0, -10], 6, ['Shift'], reach);
    expect(poseIn(app.workspace.getState(), 'window-01').reach).toBeLessThan(farther.reach);
    expect(app.workspace.history()).toHaveLength(history + 2);
    expect(await m.model.run('swf.history.undo', {})).toBe(true);
    expect(await m.model.run('swf.history.undo', {})).toBe(true);
    expect(app.workspace.getState().nodes.get('window-01')?.transform).toEqual(
      before.nodes.get('window-01')?.transform,
    );
  });

  it('goes as far with Shift and the wheel in the middle of a drag whether the browser delivers the turn upright or sideways', async () => {
    const m = await visit();
    const { app } = m;
    const before = app.workspace.getState();
    const history = app.workspace.history().length;
    const reach = () => app.poseOf('window-01')?.reach ?? NaN;
    const [x, y] = onFrame(app, 'window-01');
    const delivered: [number, number][] = [];
    app.root.addEventListener('wheel', (e) => delivered.push([e.deltaX, e.deltaY]), {
      capture: true,
    });
    /** How much farther one Shift+wheel turn takes the window in the middle of a drag. */
    const farther = async (deltaX: number, deltaY: number) => {
      await commands.mouse('move', x, y);
      await commands.mouse('down', x, y);
      await commands.mouse('move', x + 12, y);
      await nextFrame();
      await m.settle();
      expect(bar(m)).toContain('Moving Tile 01');
      const start = reach();
      await commands.wheel(x + 12, y, deltaX, deltaY, ['Shift']);
      await expect.poll(() => delivered.length).toBe(1);
      await nextFrame();
      await m.settle();
      const change = reach() - start;
      expect(await m.model.run('swf.gesture.cancel', {})).toBe(true);
      await commands.mouse('up', x + 12, y);
      await m.settle();
      return { delivered: delivered.splice(0), change };
    };
    // The plain move, and the magnetic one that snaps each place it proposes.
    for (const snap of [false, true]) {
      app.policies.configure({ enabled: { snap } });
      // Turned down (toward the user) once as the turn comes upright, in deltaY, and once as
      // browsers on Windows and Linux deliver a turn with Shift held: sideways, in deltaX, with
      // deltaY zero and the same sign.
      const upright = await farther(0, 100);
      const sideways = await farther(100, 0);
      expect(upright.delivered).toEqual([[0, 100]]);
      expect(sideways.delivered).toEqual([[100, 0]]);
      expect(upright.change).toBeGreaterThan(0.1);
      expect(sideways.change).toBeCloseTo(upright.change, 6);
    }
    // Every drag cancelled: nothing changed.
    expect(app.workspace.history()).toHaveLength(history);
    expect(app.workspace.getState().nodes.get('window-01')?.transform).toEqual(
      before.nodes.get('window-01')?.transform,
    );
  });

  it('goes farther with Shift and the wheel, shown as it goes, the burst one change once the wheel rests', async () => {
    const m = await visit();
    const { app } = m;
    const before = app.workspace.getState();
    const history = app.workspace.history().length;
    const [x, y] = onFrame(app, 'window-01');
    const reach = () => app.poseOf('window-01')?.reach ?? NaN;
    const start = reach();
    const seen: { reach: number; committed: number; bar: string }[] = [];
    for (let i = 0; i < 5; i += 1) {
      await commands.wheel(x, y, 0, 100, ['Shift']);
      await nextFrame();
      seen.push({ reach: reach(), committed: app.workspace.history().length, bar: bar(m) });
    }
    // Farther at every tick, nothing committed while the wheel turns, and said in the bar.
    expect(seen.every((s, i) => s.reach > (seen[i - 1]?.reach ?? start))).toBe(true);
    expect(seen.every((s) => s.committed === history)).toBe(true);
    expect(seen.at(-1)?.bar).toContain('Moving Tile 01');
    expect(seen.at(-1)?.bar).toContain(ENGLISH['gesture.preview.wheel']);
    // The wheel rests: one change.
    await expect.poll(() => app.workspace.history().length).toBe(history + 1);
    expect(poseIn(app.workspace.getState(), 'window-01').reach).toBeCloseTo(
      seen.at(-1)?.reach ?? NaN,
      9,
    );
    await m.settle();
    expect(bar(m)).toContain('Moved Tile 01');
    m.driver.act('page.gesture.undo', 'press');
    await m.settle();
    expect(app.workspace.getState().nodes.get('window-01')?.transform).toEqual(
      before.nodes.get('window-01')?.transform,
    );
    // A burst cancelled leaves the window where it was, with nothing to undo.
    await commands.wheel(x, y, 0, 100, ['Shift']);
    await commands.wheel(x, y, 0, 100, ['Shift']);
    expect(reach()).toBeGreaterThan(start);
    expect(await m.model.run('swf.gesture.cancel', {})).toBe(true);
    await m.settle();
    expect(reach()).toBeCloseTo(start, 9);
    expect(app.workspace.getState().nodes.get('window-01')?.transform).toEqual(
      before.nodes.get('window-01')?.transform,
    );
    expect(bar(m)).toContain(ENGLISH['gesture.cancelled']);
  });

  it('resizes from its edge, shown as it grows, as one change', async () => {
    const m = await visit();
    const { app } = m;
    const before = app.workspace.getState().nodes.get('window-01');
    const history = app.workspace.history().length;
    const width = before?.bounds[0] ?? 0;
    // On its right edge, within the band that resizes.
    const edge = onPage(app, 'window-01', [width / 2 - 0.01, 0]);
    const seen = await dragFrom(m, edge, [8, 0], 5, [], () => ({
      width: app.workspace.getPresented().nodes.get('window-01')?.bounds[0] ?? NaN,
      bar: bar(m),
    }));
    expect(seen.every((s) => s.bar.includes('Resizing Tile 01'))).toBe(true);
    expect(everyStepMoved(seen.map((s) => s.width))).toBe(true);
    expect(seen.every((s) => s.width > width)).toBe(true);
    expect(app.workspace.history()).toHaveLength(history + 1);
    expect(slider(m, 'width')).toBe(
      Number(app.workspace.getState().nodes.get('window-01')?.bounds[0].toFixed(2)),
    );
    expect(await m.model.run('swf.history.undo', {})).toBe(true);
    expect(app.workspace.getState().nodes.get('window-01')?.bounds).toEqual(before?.bounds);
  });

  it('takes Shift and the wheel during a resize as nothing: the scene stays as it was until the resize is let go, one undo step', async () => {
    const m = await visit();
    const { app } = m;
    const before = app.workspace.getState();
    const history = app.workspace.history().length;
    const width = before.nodes.get('window-01')?.bounds[0] ?? 0;
    const [x, y] = onPage(app, 'window-01', [width / 2 - 0.01, 0]);
    const delivered: [number, number][] = [];
    app.root.addEventListener('wheel', (e) => delivered.push([e.deltaX, e.deltaY]), {
      capture: true,
    });
    /**
     * Shift+wheel where the pointer is, turned down as it comes upright and as browsers on
     * Windows and Linux turn it sideways; then longer than a wheel burst waits to commit.
     */
    const turnWheel = async (at: number) => {
      await commands.wheel(at, y, 0, 100, ['Shift']);
      await commands.wheel(at, y, 100, 0, ['Shift']);
      await expect.poll(() => delivered.length).toBe(2);
      delivered.splice(0);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await nextFrame();
      await m.settle();
    };
    /** Every node of the committed scene is as it was, and nothing is in its history. */
    const unchanged = () => {
      expect(app.workspace.history()).toHaveLength(history);
      for (const node of before.nodes.values()) {
        expect(app.workspace.getState().nodes.get(node.id)).toBe(node);
      }
    };
    /** Where the presented window stands and how large. */
    const presented = () => {
      const node = app.workspace.getPresented().nodes.get('window-01');
      return { bounds: node?.bounds, transform: node?.transform };
    };
    await commands.mouse('move', x, y);
    await commands.mouse('down', x, y);
    // Pressed on the edge, before the drag begins.
    await turnWheel(x);
    unchanged();
    expect(app.workspace.getPresented().nodes.get('window-01')).toBe(before.nodes.get('window-01'));
    // Narrowed, so the pointer stays over the window as the scene holds it: a Shift+wheel there is
    // one that would move it in depth with no press held.
    await commands.mouse('move', x - 24, y);
    await nextFrame();
    await m.settle();
    expect(bar(m)).toContain('Resizing Tile 01');
    const shown = presented();
    expect(shown.bounds?.[0]).toBeLessThan(width);
    // In the middle of the resize: the resize goes on as shown, nothing else moves.
    await turnWheel(x - 24);
    unchanged();
    expect(bar(m)).toContain('Resizing Tile 01');
    expect(presented()).toEqual(shown);
    await commands.mouse('up', x - 24, y);
    await m.settle();
    // Let go: the resize alone, one change.
    expect(app.workspace.history()).toHaveLength(history + 1);
    expect(app.workspace.getState().nodes.get('window-01')?.bounds).toEqual(shown.bounds);
    for (const node of before.nodes.values()) {
      if (node.id !== 'window-01') {
        expect(app.workspace.getState().nodes.get(node.id)).toBe(node);
      }
    }
    expect(bar(m)).toContain('Resized Tile 01');
    expect(await m.model.run('swf.history.undo', {})).toBe(true);
    expect(app.workspace.getState().nodes.get('window-01')?.bounds).toEqual(
      before.nodes.get('window-01')?.bounds,
    );
    expect(app.workspace.getState().nodes.get('window-01')?.transform).toEqual(
      before.nodes.get('window-01')?.transform,
    );
  });

  it('selects with a click, selects more with Ctrl and click, and groups the selected in one change', async () => {
    const m = await visit();
    const { app, driver, settle } = m;
    // Both windows in view: Tile 01 at 15° left, Note 02 at 67° right.
    expect(await m.model.run('swf.view.heading', { degrees: 25 })).toBe(true);
    await settle();
    const tap = async (id: string, modifiers: readonly string[] = []) => {
      const [x, y] = onFrame(app, id);
      await commands.mouse('move', x, y);
      await commands.mouse('down', x, y, modifiers);
      await commands.mouse('up', x, y, modifiers);
      await settle();
    };
    await tap('window-01');
    expect(app.workspace.getState().selection).toEqual(['window-01']);
    await tap('window-02', ['Control']);
    expect(app.workspace.getState().selection).toEqual(['window-02', 'window-01']);
    // The inspector shows the one added last, and offers to group them.
    expect(m.model.selected?.id).toBe('window-02');
    expect(driver.has('page.inspector.together')).toBe(true);
    // Ctrl and click again takes one out; a plain click selects one alone.
    await tap('window-01', ['Control']);
    expect(app.workspace.getState().selection).toEqual(['window-02']);
    expect(driver.has('page.inspector.together')).toBe(false);
    await tap('window-01', ['Control']);
    const was = {
      a: worldMatrix(app.workspace.getState().nodes, 'window-01'),
      b: worldMatrix(app.workspace.getState().nodes, 'window-02'),
    };
    const history = app.workspace.history().length;
    driver.act('page.inspector.together.name', 'type', 'Pair');
    await settle();
    driver.act('page.inspector.together.group', 'press');
    await settle();
    const state = app.workspace.getState();
    const groupId = state.nodes.get('window-01')?.parentId ?? '';
    expect(state.nodes.get(groupId)).toMatchObject({ kind: 'group', label: 'Pair' });
    expect(state.nodes.get('window-02')?.parentId).toBe(groupId);
    expect(app.workspace.history()).toHaveLength(history + 1);
    // Each stays where it stood.
    expect(same(worldMatrix(state.nodes, 'window-01'), was.a)).toBe(true);
    expect(same(worldMatrix(state.nodes, 'window-02'), was.b)).toBe(true);
    // Grouped, each window still takes its own presses: the group takes none.
    await tap('window-01');
    expect(app.workspace.getState().selection).toEqual(['window-01']);
    await tap('window-02');
    expect(app.workspace.getState().selection).toEqual(['window-02']);
    expect(await m.model.run('swf.history.undo', {})).toBe(true);
    expect(app.workspace.getState().nodes.has(groupId)).toBe(false);
  });

  it('focuses the selected window from its actions, and removes the selected with Delete, offering undo', async () => {
    const m = await visit();
    const { app, driver, settle } = m;
    await m.model.select('window-01');
    await settle();
    driver.act('page.inspector.window.focus#window-01', 'press');
    await settle();
    expect(app.workspace.getState().focusedId).toBe('window-01');
    expect(await m.model.run('swf.focus.exit', {})).toBe(true);
    expect(await m.model.run('swf.selection.toggle', { id: 'window-02' })).toBe(true);
    await settle();
    // Ctrl and click on one of them in the panorama gives the panorama the keyboard, as a click in
    // a list does: Delete then removes both.
    expect(await m.model.run('swf.view.heading', { degrees: 25 })).toBe(true);
    await settle();
    const [x, y] = onFrame(app, 'window-01');
    await commands.mouse('move', x, y);
    await commands.mouse('down', x, y, ['Control']);
    await commands.mouse('up', x, y, ['Control']);
    await settle();
    expect(app.workspace.getState().selection).toEqual(['window-02']);
    await commands.mouse('down', x, y, ['Control']);
    await commands.mouse('up', x, y, ['Control']);
    await settle();
    expect(app.workspace.getState().selection).toEqual(['window-01', 'window-02']);
    expect(document.activeElement).toBe(app.root);
    const history = app.workspace.history().length;
    await userEvent.keyboard('{Delete}');
    await settle();
    expect(app.workspace.getState().nodes.has('window-01')).toBe(false);
    expect(app.workspace.getState().nodes.has('window-02')).toBe(false);
    expect(app.workspace.history()).toHaveLength(history + 1);
    driver.act('page.removed.undo', 'press');
    await settle();
    expect(app.workspace.getState().nodes.has('window-01')).toBe(true);
    expect(app.workspace.getState().nodes.has('window-02')).toBe(true);
  });

  for (const backend of ['geometry', 'dom']) {
    it(`leaves the keyboard with a window’s live content pressed in the panorama, on the ${backend} backend`, async () => {
      const m = await start(`?preset=sparse&backend=${backend}`, { store: createMemoryStore() });
      const app = m.model.app;
      if (app === null) {
        throw new Error('no application');
      }
      expect(app.status().backend).toBe(backend);
      const view = app.root.getBoundingClientRect();
      // A note's text, in sight: inside the view and on top at its centre (not under another
      // window's card or title bar, nor clipped off at the seam), where a press is its content's.
      const text = [
        ...m.root.querySelectorAll<HTMLElement>('[data-reference-content] [contenteditable]'),
      ].find((element) => {
        const box = element.getBoundingClientRect();
        const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
        const inView =
          box.width > 0 && x > view.left && x < view.right && y > view.top && y < view.bottom;
        if (!inView || !element.contains(document.elementFromPoint(x, y))) {
          return false;
        }
        const hit = app.router.pick(app.viewport.viewportId, x - view.left, y - view.top);
        return hit.kind === 'hit' && hit.region === 'content';
      });
      if (text === undefined) {
        throw new Error('no note in sight');
      }
      let taken = 0;
      const take = () => {
        taken += 1;
      };
      app.root.addEventListener('focus', take);
      const box = text.getBoundingClientRect();
      const [x, y] = [Math.round(box.left + box.width / 2), Math.round(box.top + box.height / 2)];
      await commands.mouse('move', x, y);
      await commands.mouse('down', x, y);
      await commands.mouse('up', x, y);
      await m.settle();
      app.root.removeEventListener('focus', take);
      expect(taken).toBe(0);
      expect(document.activeElement).toBe(text);
      // What is typed there is the note's, not the panorama's keys.
      const windows = app.workspace.getState().nodes.size;
      const before = text.textContent;
      await userEvent.keyboard('nd');
      await m.settle();
      expect(text.textContent).not.toBe(before);
      expect(app.workspace.getState().nodes.size).toBe(windows);
    });

    it(`leaves the application’s keys to whatever has the keyboard in a window’s live content, on the ${backend} backend`, async () => {
      const m = await start(`?preset=sparse&backend=${backend}`, { store: createMemoryStore() });
      const app = m.model.app;
      if (app === null) {
        throw new Error('no application');
      }
      expect(app.status().backend).toBe(backend);
      expect(await m.model.run('swf.window.sendBehind', { id: 'window-01' })).toBe(true);
      await m.settle();
      const history = app.workspace.history().length;
      // Host content may hold any control: a button in a note, with the keyboard.
      const note = m.root.querySelector<HTMLElement>('[data-reference-content]');
      if (note === null) {
        throw new Error('no live content');
      }
      const control = document.createElement('button');
      control.textContent = 'Host control';
      note.append(control);
      control.focus();
      expect(document.activeElement).toBe(control);
      await userEvent.keyboard('{Control>}z{/Control}');
      await m.settle();
      expect(app.workspace.history()).toHaveLength(history);
      expect(app.workspace.canUndo()).toBe(true);
      control.remove();
    });
  }
});

describe('the inspector’s sliders', () => {
  it('moves the window as a slider is dragged, commits once when let go, and reads the scene', async () => {
    const m = await visit();
    const { app } = m;
    await m.model.select('window-01');
    await m.settle();
    const before = app.workspace.getState();
    const history = app.workspace.history().length;
    const rail = m.root.querySelector('[data-wsb="page.inspector.pose#heading"]');
    const box = rail?.getBoundingClientRect();
    if (box === undefined) {
      throw new Error('no angle slider');
    }
    // The thumb stands at the window's angle, from −180° to 180° along the rail.
    const at = (degrees: number) => Math.round(box.left + ((degrees + 180) / 360) * box.width);
    const y = Math.round(box.top + box.height / 2);
    const from = poseIn(before, 'window-01').heading;
    const seen = await dragFrom(m, [at(from), y], [6, 0], 6, [], () => ({
      shown: app.poseOf('window-01')?.heading ?? NaN,
      slider: slider(m, 'heading'),
      committed: app.workspace.history().length,
      scene: poseIn(app.workspace.getState(), 'window-01').heading,
    }));
    // The window moves in the panorama with the thumb; nothing is committed while it moves.
    expect(everyStepMoved(seen.map((s) => s.shown))).toBe(true);
    for (const s of seen) {
      expect(s.shown).toBeCloseTo(s.slider, 6);
      expect(s.committed).toBe(history);
      expect(s.scene).toBe(from);
    }
    expect(app.workspace.history()).toHaveLength(history + 1);
    expect(poseIn(app.workspace.getState(), 'window-01').heading).toBeCloseTo(
      seen.at(-1)?.slider ?? NaN,
      6,
    );
    // A key is a step, a typed number an exact place: one change each.
    m.driver.act('page.inspector.pose#reach', 'key', 'ArrowRight');
    await m.settle();
    expect(app.workspace.history()).toHaveLength(history + 2);
    m.driver.act('page.inspector.pose.number#y', 'set', '1.5');
    await m.settle();
    expect(poseIn(app.workspace.getState(), 'window-01').position[1]).toBeCloseTo(1.5, 9);
    expect(app.workspace.history()).toHaveLength(history + 3);
    // Changed by another route, the sliders show the scene; undone, they show it again.
    expect(await m.model.run('swf.window.sendBehind', { id: 'window-01' })).toBe(true);
    await m.settle();
    expect(slider(m, 'heading')).toBe(
      Math.round(poseIn(app.workspace.getState(), 'window-01').heading),
    );
    for (let i = 0; i < 4; i += 1) {
      expect(await m.model.run('swf.history.undo', {})).toBe(true);
    }
    await m.settle();
    expect(app.workspace.getState().nodes.get('window-01')?.transform).toEqual(
      before.nodes.get('window-01')?.transform,
    );
    expect(slider(m, 'heading')).toBe(Math.round(from));
    expect(slider(m, 'y')).toBe(Number(poseIn(before, 'window-01').position[1].toFixed(1)));
  });

  it('shows in front or behind, and offers no slider a window’s host or its lock forbids', async () => {
    const m = await visit();
    const { app, driver } = m;
    await m.model.select('window-01');
    await m.settle();
    const facts = () => m.root.querySelector('[aria-label="Selected window"]')?.textContent ?? '';
    expect(facts()).toContain(ENGLISH['inspector.side.front']);
    expect(await m.model.run('swf.window.sendBehind', { id: 'window-01' })).toBe(true);
    await m.settle();
    expect(facts()).toContain(ENGLISH['inspector.side.behind']);
    driver.act('page.inspector.lock', 'toggle');
    await m.settle();
    for (const field of ['heading', 'reach', 'y', 'width', 'height']) {
      expect(
        m.root
          .querySelector(`[data-wsb="page.inspector.pose#${field}"]`)
          ?.getAttribute('aria-disabled'),
        field,
      ).toBe('true');
    }
    expect(app.workspace.getState().nodes.get('window-01')?.flags.locked).toBe(true);
  });
});

describe('breaking a window into parts', () => {
  it('breaks the studio’s board into linked parts and recombines them, one undoable change each', async () => {
    const m = await start('', { store: createMemoryStore() });
    const app = m.model.app;
    if (app === null) {
      throw new Error('no application');
    }
    const { driver, settle } = m;
    await m.model.inspect('board');
    await settle();
    const surfaces = app.workspace.getState().nodes.get('board')?.surfaceIds ?? [];
    expect(surfaces.length).toBe(3);
    const history = app.workspace.history().length;
    driver.act('page.inspector.split', 'press');
    await settle();
    const state = app.workspace.getState();
    expect(state.nodes.get('board')?.surfaceIds).toEqual(surfaces.slice(0, 1));
    const parts = surfaces.slice(1).map((id) => state.surfaces.get(id)?.ownerNodeId ?? '');
    expect(parts.every((id) => id !== 'board' && state.nodes.has(id))).toBe(true);
    expect(app.workspace.history()).toHaveLength(history + 1);
    const facts = () => m.root.querySelector('[aria-label="Selected window"]')?.textContent ?? '';
    expect(facts()).toContain('2 linked windows');
    // A part says what it is a part of, and recombines from there too.
    await m.model.inspect(parts[0] ?? '');
    await settle();
    expect(facts()).toContain('Project Board, linked');
    driver.act('page.inspector.recombine', 'press');
    await settle();
    expect(app.workspace.getState().nodes.get('board')?.surfaceIds).toEqual(surfaces);
    expect(parts.some((id) => app.workspace.getState().nodes.has(id))).toBe(false);
    expect(app.workspace.history()).toHaveLength(history + 2);
    // One undo brings the parts back; another puts the board together as it was.
    expect(await m.model.run('swf.history.undo', {})).toBe(true);
    expect(parts.every((id) => app.workspace.getState().nodes.has(id))).toBe(true);
    expect(await m.model.run('swf.history.undo', {})).toBe(true);
    expect(app.workspace.getState().nodes.get('board')?.surfaceIds).toEqual(surfaces);
  });
});
