import type { PointerIntent } from '@swf/interaction';
import { afterEach, describe, expect, it } from 'vitest';
import { commands, server, userEvent } from 'vitest/browser';
import type { Stage } from './fixture.js';
import { onCard, pageOf, stage } from './fixture.js';

declare module 'vitest/browser' {
  interface BrowserCommands {
    wheel: (
      x: number,
      y: number,
      deltaX: number,
      deltaY: number,
      modifiers?: readonly string[],
    ) => Promise<void>;
    touch: (
      phase: 'start' | 'move' | 'end',
      points: readonly { readonly id: number; readonly x: number; readonly y: number }[],
    ) => Promise<void>;
    pen: (action: 'move' | 'down' | 'up', x: number, y: number, pressure?: number) => Promise<void>;
  }
}

let current: Stage | null = null;
afterEach(async () => {
  await current?.dispose();
  current = null;
});

/** A window with a wide frame around its surface: 3 × 2 units, the surface 2 × 1, at 3 units. */
const framed = { id: 'a', heading: 0, distance: 3, size: [3, 2] as const, inset: 1 };

function viewOf(s: Stage) {
  const view = s.views.get('v');
  if (view === undefined) {
    throw new Error('no view');
  }
  return view;
}

/** What the router saw of the gestures, in order. */
const story = (s: Stage) =>
  s.events.flatMap((e) =>
    e.type === 'gesture.started'
      ? [`start ${e.operation}`]
      : e.type === 'gesture.ended'
        ? [`end ${e.finish.outcome}`]
        : [],
  );

/** The device kinds the DOM input reported, for the presses it dispatched. */
function pressesSeen(s: Stage): string[] {
  const seen: string[] = [];
  s.router.subscribe((event) => {
    if (event.type === 'gesture.started') {
      seen.push(event.operation);
    }
  });
  return seen;
}

const distance = (s: Stage) => {
  const p = s.ws.getState().nodes.get('a')?.transform.position;
  return p === undefined ? NaN : Math.hypot(...p);
};

/**
 * Real touch and pen input reaches a page only through a browser's own automation: Playwright
 * makes it over Chromium's DevTools protocol, and has no way to make it in Firefox or WebKit. The
 * framework reads pointer events alike from every device, so those browsers are covered by mouse
 * input; these cases run where the input can be made.
 */
const canTouch = server.browser === 'chromium';

describe('input devices end to end (QA-006, FR-100, FR-101)', () => {
  it('leaves the wheel over live content to the content, and changes depth with Shift and the wheel over a window', async () => {
    current = await stage([framed]);
    const view = viewOf(current);
    const content = current.lives.get('key-a')?.element;
    const wheels: { trusted: boolean; prevented: boolean }[] = [];
    content?.addEventListener('wheel', (e) => {
      // Seen after the framework's own listener, so whether it was taken shows here.
      queueMicrotask(() => wheels.push({ trusted: e.isTrusted, prevented: e.defaultPrevented }));
    });
    const before = current.ws.getState();
    const [cx, cy] = pageOf(view.root, ...onCard(current, 'a', [0, 0]));
    await commands.wheel(cx, cy, 0, 120);
    await expect.poll(() => wheels.length).toBe(1);
    expect(wheels[0]).toEqual({ trusted: true, prevented: false });
    expect(current.ws.getState()).toBe(before);
    // Shift with the wheel over the window's frame moves it along the floor: turned down,
    // farther; turned up, nearer again. One change each.
    const [fx, fy] = pageOf(view.root, ...onCard(current, 'a', [0, 0.75]));
    const near = distance(current);
    const history = current.ws.history().length;
    await commands.wheel(fx, fy, 0, 200, ['Shift']);
    await expect.poll(() => current?.ws.history().length).toBe(history + 1);
    const far = distance(current);
    expect(far).toBeGreaterThan(near + 0.01);
    await commands.wheel(fx, fy, 0, -200, ['Shift']);
    await expect.poll(() => current?.ws.history().length).toBe(history + 2);
    expect(distance(current)).toBeCloseTo(near, 6);
  });

  it('changes a dragged window’s depth by Shift and the wheel as far whether the browser delivers the turn upright or sideways', async () => {
    current = await stage([framed]);
    const s = current;
    const view = viewOf(s);
    view.root.tabIndex = 0;
    const delivered: [number, number][] = [];
    view.root.addEventListener('wheel', (e) => delivered.push([e.deltaX, e.deltaY]), {
      capture: true,
    });
    // On the frame, clear of its resize edges.
    const [x, y] = pageOf(view.root, ...onCard(s, 'a', [0, 0.6]));
    const history = s.ws.history().length;
    /** Where the drag shows the window, from the camera. */
    const shown = () => {
      const p = s.ws.getPresented().nodes.get('a')?.transform.position;
      return p === undefined ? NaN : Math.hypot(...p);
    };
    /** How much farther one Shift+wheel turn takes the window in the middle of a drag. */
    const farther = async (deltaX: number, deltaY: number) => {
      await commands.mouse('move', x, y);
      await commands.mouse('down', x, y);
      await commands.mouse('move', x + 30, y);
      expect(s.router.captures()).toHaveLength(1);
      const before = shown();
      await commands.wheel(x + 30, y, deltaX, deltaY, ['Shift']);
      await expect.poll(() => delivered.length).toBe(1);
      const after = shown();
      view.root.focus();
      await userEvent.keyboard('{Escape}');
      await commands.mouse('up', x + 30, y);
      expect(s.router.captures()).toEqual([]);
      return { delivered: delivered.splice(0), change: after - before };
    };
    // Turned down (toward the user) once as the turn comes upright, in deltaY, and once as
    // browsers on Windows and Linux deliver a turn with Shift held: sideways, in deltaX, with
    // deltaY zero and the same sign.
    const upright = await farther(0, 200);
    const sideways = await farther(200, 0);
    expect(upright.delivered).toEqual([[0, 200]]);
    expect(sideways.delivered).toEqual([[200, 0]]);
    expect(upright.change).toBeGreaterThan(0.1);
    expect(sideways.change).toBeCloseTo(upright.change, 6);
    expect(story(s)).toEqual([
      'start node.move',
      'end cancelled',
      'start node.move',
      'end cancelled',
    ]);
    expect(s.ws.history()).toHaveLength(history);
  });

  it('cancels a drag whose pointer capture the browser takes away, leaving the window where it was', async () => {
    current = await stage([framed]);
    const view = viewOf(current);
    const before = current.ws.getState().nodes.get('a')?.transform;
    const start = onCard(current, 'a', [0, 0.6]);
    const [x, y] = pageOf(view.root, ...start);
    let pointerId = -1;
    view.root.addEventListener('pointerdown', (e) => (pointerId = e.pointerId), { capture: true });
    const lost: boolean[] = [];
    view.root.addEventListener('lostpointercapture', (e) => lost.push(e.isTrusted));
    await commands.mouse('move', x, y);
    await commands.mouse('down', x, y);
    await commands.mouse('move', x + 30, y);
    await commands.mouse('move', x + 50, y);
    expect(view.root.hasPointerCapture(pointerId)).toBe(true);
    // Something else takes the pointer: at its next event, the browser says the capture is lost.
    view.root.releasePointerCapture(pointerId);
    await commands.mouse('move', x + 60, y);
    await expect.poll(() => lost).toEqual([true]);
    expect(story(current)).toEqual(['start node.move', 'end cancelled']);
    await commands.mouse('up', x + 60, y);
    expect(current.ws.getState().nodes.get('a')?.transform).toBe(before);
    expect(current.router.captures()).toEqual([]);
  });

  it.runIf(canTouch)(
    'moves a window dragged by a finger on its frame, reported as touch',
    async () => {
      current = await stage([framed]);
      const s = current;
      const view = viewOf(s);
      const types: PointerIntent['pointerType'][] = [];
      view.root.addEventListener(
        'pointerdown',
        (e) => types.push(e.pointerType as PointerIntent['pointerType']),
        { capture: true },
      );
      const operations = pressesSeen(s);
      const before = s.ws.getState().nodes.get('a')?.transform.position[0] ?? 0;
      const [x, y] = pageOf(view.root, ...onCard(s, 'a', [0, 0.6]));
      await commands.touch('start', [{ id: 1, x, y }]);
      for (let i = 1; i <= 6; i++) {
        await commands.touch('move', [{ id: 1, x: x + i * 10, y }]);
      }
      await commands.touch('end', []);
      expect(types).toEqual(['touch']);
      expect(operations).toEqual(['node.move']);
      expect(story(s)).toEqual(['start node.move', 'end committed']);
      expect(s.ws.getState().nodes.get('a')?.transform.position[0]).toBeGreaterThan(before + 0.1);
    },
  );

  it.runIf(canTouch)(
    'brings a window nearer when two fingers on it spread apart, the one gesture the two pointers make',
    async () => {
      current = await stage([framed]);
      const s = current;
      const view = viewOf(s);
      const far = distance(s);
      const history = s.ws.history().length;
      const left = pageOf(view.root, ...onCard(s, 'a', [-1.25, 0]));
      const right = pageOf(view.root, ...onCard(s, 'a', [1.25, 0]));
      await commands.touch('start', [{ id: 1, x: left[0], y: left[1] }]);
      await commands.touch('start', [
        { id: 1, x: left[0], y: left[1] },
        { id: 2, x: right[0], y: right[1] },
      ]);
      for (let i = 1; i <= 6; i++) {
        await commands.touch('move', [
          { id: 1, x: left[0] - i * 6, y: left[1] },
          { id: 2, x: right[0] + i * 6, y: right[1] },
        ]);
      }
      await commands.touch('end', []);
      // Two pointers, one window: the pinch won the arena, not a move per finger.
      expect(story(s)).toEqual(['start node.move', 'end committed']);
      expect(s.ws.history()).toHaveLength(history + 1);
      expect(distance(s)).toBeLessThan(far - 0.1);
    },
  );

  it.runIf(canTouch)(
    'moves a window dragged by a pen, its pressure passed on with the pointer',
    async () => {
      current = await stage([framed]);
      const s = current;
      const view = viewOf(s);
      const pressures: number[] = [];
      const types: string[] = [];
      view.root.addEventListener(
        'pointerdown',
        (e) => {
          types.push(e.pointerType);
          pressures.push(e.pressure);
        },
        { capture: true },
      );
      const before = s.ws.getState().nodes.get('a')?.transform.position[0] ?? 0;
      const start = onCard(s, 'a', [0, 0.6]);
      const [x, y] = pageOf(view.root, ...start);
      await commands.pen('move', x, y, 0);
      await commands.pen('down', x, y, 0.6);
      for (let i = 1; i <= 6; i++) {
        await commands.pen('move', x + i * 10, y, 0.6);
      }
      await commands.pen('up', x + 60, y);
      expect(types).toEqual(['pen']);
      expect(pressures[0]).toBeCloseTo(0.6, 2);
      expect(story(s)).toEqual(['start node.move', 'end committed']);
      expect(s.ws.getState().nodes.get('a')?.transform.position[0]).toBeGreaterThan(before + 0.1);
    },
  );
});
