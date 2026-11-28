import type { CancelReason, Constraint, Workspace } from '@swf/core';
import { SwfFailure } from '@swf/core';
import { headingPitchOf } from '@swf/projections';
import { describe, expect, it } from 'vitest';
import type { InteractionEvent, InteractionPolicy, PointerType } from '../src/index.js';
import {
  createSyntheticInput,
  INTERACTION_API_VERSION,
  ROOM_LIMITS,
  roomPlaceOf,
} from '../src/index.js';
import type { World } from './fixtures.js';
import { cardOf, contentOf, H, onCard, titleBar, W, world } from './fixtures.js';

const ahead = { id: 'a', heading: 0, distance: 3 } as const;

/** Which gestures started and how each ended, in order. */
function story(events: readonly InteractionEvent[]): string[] {
  return events.flatMap((e) => {
    switch (e.type) {
      case 'gesture.started':
        return [`start ${e.operation}`];
      case 'gesture.ended':
        return [
          `end ${e.finish.outcome}${e.finish.outcome === 'cancelled' ? ` ${e.finish.reason}` : ''}`,
        ];
      case 'content.pressed':
      case 'pointer.hovered':
      case 'pointer.doublePressed':
      case 'capture.released':
      case 'settings.changed':
        return [];
    }
  });
}

const transformOf = (ws: Workspace, id: string) => ws.getState().nodes.get(id)?.transform;
/** Where a window stands in the room, seen from the camera at the centre. */
const placeOf = (ws: Workspace, id: string) => roomPlaceOf(ws.getState(), id, [0, 0, 0]);
/** Radians of heading a pointer moves a window by for each pixel across the 360° view. */
const PER_PIXEL = (2 * Math.PI) / W;

/** Starts dragging window `a` by its title bar and moves it by (dx, dy). */
function drag(w: World, dx: number, dy: number, modifiers: { shift?: boolean } = {}) {
  const [x, y] = titleBar(w.ws, 'a');
  expect(w.input.pointer('down', 'v', x, y, { modifiers })).toMatchObject({
    consumed: true,
    route: 'gesture',
    gestureId: null,
    region: 'title-bar',
  });
  const moved = w.input.pointer('move', 'v', x + dx, y + dy, { modifiers });
  expect(moved.gestureId).not.toBeNull();
  return { x, y, gestureId: moved.gestureId ?? '' };
}

describe('window drags (§13.3, FR-105, BR-004)', () => {
  it('wait for the slop, preview each move, and commit once on release', () => {
    const w = world([ahead]);
    const { ws, input, router, events } = w;
    const before = transformOf(ws, 'a');
    const [x, y] = titleBar(ws, 'a');
    input.pointer('down', 'v', x, y);
    expect(router.captures()).toEqual([
      { deviceId: 'synthetic', pointerId: 1, viewportId: 'v', gestureId: null },
    ]);
    // Within the slop: still pending, nothing previewed.
    expect(input.pointer('move', 'v', x + 3, y).gestureId).toBeNull();
    const moved = input.pointer('move', 'v', x + 40, y + 10);
    const gestureId = moved.gestureId ?? '';
    expect(story(events)).toEqual(['start node.move']);
    const preview = ws.getPreview(`interaction:${gestureId}`);
    expect(preview?.nodes.get('a')?.transform).not.toEqual(before);
    // The committed scene is untouched until release.
    expect(transformOf(ws, 'a')).toBe(before);
    input.pointer('move', 'v', x + 60, y + 15);
    const history = ws.history().length;
    const up = input.pointer('up', 'v', x + 60, y + 15);
    expect(up.operation).toMatchObject({ name: 'node.move', outcome: { outcome: 'committed' } });
    expect(ws.history()).toHaveLength(history + 1);
    expect(ws.getPreview(`interaction:${gestureId}`)).toBeUndefined();
    // Across in heading by the view's angle a pixel, down in height by a 68th of a unit a pixel,
    // as far out along the floor as it was.
    const place = placeOf(ws, 'a');
    expect(place.heading).toBeCloseTo(60 * PER_PIXEL, 12);
    expect(place.height).toBeCloseTo(-15 / 68, 12);
    expect(place.floor).toBeCloseTo(3, 12);
    expect(story(events)).toEqual(['start node.move', 'end committed']);
    expect(events.filter((e) => e.type === 'capture.released')).toHaveLength(1);
    expect(router.captures()).toEqual([]);
    // A late release from the same pointer is ignored.
    expect(input.pointer('up', 'v', x, y)).toMatchObject({ consumed: false, route: 'ignored' });
    expect(ws.history()).toHaveLength(history + 1);
  });

  it('raise a window as far for a pixel whatever its distance, keeping it upright', () => {
    const raised = (distance: number) => {
      const w = world([{ id: 'a', heading: 0.4, distance }]);
      const rotation = transformOf(w.ws, 'a')?.rotation;
      const { x, y } = drag(w, -20, -34);
      w.input.pointer('up', 'v', x - 20, y - 34);
      expect(transformOf(w.ws, 'a')?.rotation).toEqual(rotation);
      return placeOf(w.ws, 'a');
    };
    for (const place of [raised(2.5), raised(9)]) {
      expect(place.height).toBeCloseTo(0.5, 12);
      expect(place.heading).toBeCloseTo(0.4 - 20 * PER_PIXEL, 12);
    }
    expect(raised(2.5).floor).toBeCloseTo(2.5, 12);
    expect(raised(9).floor).toBeCloseTo(9, 12);
  });

  it('move a window along the floor with Shift, keeping its height, from where it stands when Shift changes', () => {
    const w = world([ahead]);
    const { x, y } = drag(w, 0, 27, { shift: true });
    // Down with Shift held: a 27th of a unit farther a pixel, the height kept.
    w.input.pointer('move', 'v', x, y + 54, { modifiers: { shift: true } });
    // Shift let go: the motion from here on raises and lowers it again.
    w.input.pointer('move', 'v', x, y + 20);
    w.input.pointer('up', 'v', x, y + 20);
    const place = placeOf(w.ws, 'a');
    expect(place.floor).toBeCloseTo(5, 12);
    expect(place.height).toBeCloseTo(34 / 68, 12);
    expect(place.heading).toBeCloseTo(0, 12);
  });

  it('keep a window inside the room however far it is dragged', () => {
    const w = world([ahead]);
    const { x, y } = drag(w, 0, 1000);
    w.input.pointer('up', 'v', x, y + 1000);
    expect(placeOf(w.ws, 'a')).toMatchObject({ height: ROOM_LIMITS.lowest });
    const near = world([ahead]);
    const at = drag(near, 0, -1000, { shift: true });
    near.input.pointer('up', 'v', at.x, at.y - 1000, { modifiers: { shift: true } });
    expect(placeOf(near.ws, 'a')).toMatchObject({ floor: ROOM_LIMITS.nearest, height: 0 });
  });

  it('move a window along the floor by the wheel mid-drag, the drag carrying on from there', () => {
    const w = world([ahead]);
    const { x, y } = drag(w, 30, 0);
    // A wheel during the drag: down is farther, by e^(0.0012 a pixel); up nearer.
    expect(w.input.wheel('v', x + 30, y, -100)).toMatchObject({ consumed: true, route: 'gesture' });
    w.input.pointer('move', 'v', x + 40, y);
    w.input.pointer('up', 'v', x + 40, y);
    const place = placeOf(w.ws, 'a');
    expect(place.floor).toBeCloseTo(3 * Math.exp(-0.12), 12);
    expect(place.heading).toBeCloseTo(40 * PER_PIXEL, 12);
    expect(place.height).toBeCloseTo(0, 12);
  });

  it('move a window as far by a wheel turned sideways as by one turned upright', () => {
    /** How far out a drag 30 px across leaves the window after one wheel scroll with Shift held. */
    const after = (deltaX: number, deltaY: number) => {
      const w = world([ahead]);
      const { x, y } = drag(w, 30, 0);
      expect(
        w.input.wheel('v', x + 30, y, deltaY, { deltaX, modifiers: { shift: true } }),
      ).toMatchObject({ consumed: true, route: 'gesture' });
      w.input.pointer('up', 'v', x + 30, y);
      return placeOf(w.ws, 'a').floor;
    };
    const upright = after(0, 100);
    // 100 px turned down: farther, whether in deltaY or, as browsers on Windows and Linux turn
    // a wheel with Shift held, in deltaX with deltaY zero (or minus zero).
    expect(upright).toBeCloseTo(3 * Math.exp(0.12), 12);
    expect(after(100, 0)).toBeCloseTo(upright, 12);
    expect(after(100, -0)).toBeCloseTo(upright, 12);
    // A scroll with a vertical part is read by that part alone.
    expect(after(-40, 100)).toBeCloseTo(upright, 12);
  });

  it('commit only what constraints allow, and cancel when the commit is refused', () => {
    let allowed = true;
    const gate: Constraint = {
      id: 'test.gate',
      order: 0,
      required: true,
      resolve: (input) =>
        allowed
          ? { kind: 'accept', transform: input.transform }
          : { kind: 'reject', reason: 'closed' },
    };
    const w = world([ahead]);
    w.ws.registerConstraint(gate);
    const before = transformOf(w.ws, 'a');
    const { x, y } = drag(w, 40, 0);
    allowed = false;
    const up = w.input.pointer('up', 'v', x + 40, y);
    expect(up.operation?.outcome).toMatchObject({
      outcome: 'cancelled',
      reason: 'constraint-rejected',
      error: { code: 'CONSTRAINT_REJECTED' },
    });
    expect(transformOf(w.ws, 'a')).toBe(before);
    expect(story(w.events)).toEqual(['start node.move', 'end cancelled constraint-rejected']);
    expect(w.router.captures()).toEqual([]);
  });
});

describe('pointer capture (FR-104, BR-009, AC-003)', () => {
  it('keeps the window moving with the pointer outside the viewport', () => {
    const w = world([ahead]);
    const { x, y } = drag(w, 20, 0);
    expect(w.input.pointer('move', 'v', W + 50, y)).toMatchObject({
      consumed: true,
      route: 'gesture',
    });
    w.input.pointer('move', 'v', x + 70, y);
    w.input.pointer('up', 'v', x + 70, y);
    expect(placeOf(w.ws, 'a').heading).toBeCloseTo(70 * PER_PIXEL, 12);
  });

  it('keeps its target over other windows and across a viewport resize', () => {
    const w = world([ahead, { id: 'b', heading: 1.2, distance: 2.5 }]);
    const { x, y } = drag(w, 10, 0);
    const [bx, by] = contentOf(w.ws, 'b');
    expect(w.input.pointer('move', 'v', bx, by).gestureId).not.toBeNull();
    expect(
      w.ws.dispatch({
        type: 'viewport.patch',
        id: 'v',
        size: { width: W / 2, height: H / 2, devicePixelRatio: 1 },
      }).status,
    ).toBe('committed');
    w.input.pointer('move', 'v', (x + 60) / 2, y / 2);
    w.input.pointer('up', 'v', (x + 60) / 2, y / 2);
    expect(story(w.events)).toEqual(['start node.move', 'end committed']);
    expect(placeOf(w.ws, 'a').heading).not.toBeCloseTo(0, 3);
    expect(w.ws.getState().nodes.get('b')?.transform.position).toEqual([
      2.5 * Math.sin(1.2),
      0,
      -2.5 * Math.cos(1.2),
    ]);
  });

  it('drags a surface across the seam continuously, as one Surface ID (AC-003)', () => {
    const w = world([{ id: 'a', heading: Math.PI - 0.05, distance: 3 }]);
    // Grab the left end of the title bar, so the window's centre lies right of the pointer.
    const [x, y] = onCard(w.ws, 'a', [-0.85, 0.5]);
    w.input.pointer('down', 'v', x, y);
    const headings: number[] = [];
    for (let px = x + 5; px <= W - 1; px += 5) {
      w.input.pointer('move', 'v', px, y);
      const id = w.events.find((e) => e.type === 'gesture.started');
      const preview = w.ws.getPreview(
        `interaction:${id?.type === 'gesture.started' ? id.gestureId : ''}`,
      );
      const p = preview?.nodes.get('a')?.transform.position ?? [0, 0, 0];
      headings.push(Math.atan2(p[0], -p[2]));
    }
    w.input.pointer('up', 'v', W - 1, y);
    // The window's centre crossed the seam (heading through ±π) with no jump in between.
    const unwrapped = headings.map((h) => (h < 0 ? h + 2 * Math.PI : h));
    expect(unwrapped.at(-1)).toBeGreaterThan(Math.PI);
    for (let i = 1; i < unwrapped.length; i++) {
      const step = (unwrapped[i] ?? 0) - (unwrapped[i - 1] ?? 0);
      expect(step).toBeGreaterThan(0);
      expect(step).toBeLessThan(0.05);
    }
    // Both copies of its card now pick as the same window.
    const left = w.router.pick('v', 2, y);
    const right = w.router.pick('v', W - 2, y);
    expect(left.kind === 'hit' && left.target.nodeId).toBe('a');
    expect(right.kind === 'hit' && right.target.nodeId).toBe('a');
  });
});

describe('cancellation (FR-112)', () => {
  const triggers: [CancelReason, (w: World, x: number, y: number) => void][] = [
    ['escape', (w) => void w.input.key('Escape')],
    ['capture-lost', (w, x, y) => void w.input.pointer('cancel', 'v', x, y)],
    ['view-disposed', (w) => void w.ws.dispatch({ type: 'viewport.delete', id: 'v' })],
    [
      'target-detached',
      (w) => void w.ws.dispatch({ type: 'node.delete', id: 'a', mode: 'subtree' }),
    ],
    ['host', (w) => void w.router.cancel()],
    [
      'view-disposed',
      (w) => {
        w.router.dispose();
      },
    ],
  ];

  for (const [reason, trigger] of triggers) {
    it(`ends a drag on ${reason}, restoring the pre-drag state and releasing the pointer`, () => {
      const w = world([ahead]);
      const before = transformOf(w.ws, 'a');
      const history = w.ws.history().length;
      const { x, y, gestureId } = drag(w, 40, 0);
      trigger(w, x + 40, y);
      expect(story(w.events)).toEqual(['start node.move', `end cancelled ${reason}`]);
      expect(w.events.filter((e) => e.type === 'capture.released')).toHaveLength(1);
      expect(w.ws.getPreview(`interaction:${gestureId}`)).toBeUndefined();
      expect(w.ws.history()).toHaveLength(reason === 'target-detached' ? history + 1 : history);
      if (reason !== 'target-detached') {
        expect(transformOf(w.ws, 'a')).toBe(before);
      }
      if (reason !== 'view-disposed') {
        expect(w.router.captures()).toEqual([]);
        // The pointer's later release belongs to no gesture.
        expect(w.input.pointer('up', 'v', x + 40, y).route).toBe('ignored');
      }
    });
  }

  it('ends a drag when the workspace is disposed', async () => {
    const w = world([ahead]);
    drag(w, 40, 0);
    await w.ws.dispose();
    expect(story(w.events)).toEqual(['start node.move', 'end cancelled workspace-disposed']);
  });

  it('drops a pending press whose window is deleted before it moves', () => {
    const w = world([ahead]);
    const [x, y] = titleBar(w.ws, 'a');
    w.input.pointer('down', 'v', x, y);
    expect(w.ws.dispatch({ type: 'node.delete', id: 'a', mode: 'subtree' }).status).toBe(
      'committed',
    );
    expect(w.router.captures()).toEqual([]);
    expect(w.events.map((e) => e.type)).toEqual(['capture.released']);
    expect(w.input.pointer('move', 'v', x + 40, y).route).toBe('ignored');
  });

  it('treats a second press of a held pointer as a lost capture', () => {
    const w = world([ahead]);
    const { x, y } = drag(w, 40, 0);
    w.input.pointer('down', 'v', x, y);
    expect(story(w.events)).toEqual(['start node.move', 'end cancelled capture-lost']);
    expect(w.router.captures()).toHaveLength(1);
  });

  it('cancels when another commit makes the preview impossible', () => {
    const w = world([ahead]);
    drag(w, 40, 0);
    // Locking the window makes the operator's preview of it invalid.
    expect(w.ws.dispatch({ type: 'node.patch', id: 'a', flags: { locked: true } }).status).toBe(
      'committed',
    );
    expect(story(w.events)).toEqual(['start node.move', 'end cancelled invalidated']);
    expect(w.router.captures()).toEqual([]);
  });

  it('turns a cancelled camera drag back', () => {
    const w = world([]);
    const before = w.ws.getState().cameras.get('cam')?.rotation;
    w.input.pointer('down', 'v', W / 2, H / 2);
    w.input.pointer('move', 'v', W / 2 + 80, H / 2 + 20);
    expect(w.ws.getState().cameras.get('cam')?.rotation).not.toEqual(before);
    w.input.key('Escape');
    expect(w.ws.getState().cameras.get('cam')?.rotation).toEqual(before);
    expect(story(w.events)).toEqual(['start camera.turn', 'end cancelled escape']);
  });

  it('cancels a gesture whose policy fails, and reports the failure', () => {
    const failing: InteractionPolicy = {
      id: 'test.failing/1',
      apiVersion: INTERACTION_API_VERSION,
      priority: 1000,
      operations: ['node.move'],
      claim: (context) =>
        context.region === 'title-bar'
          ? {
              kind: 'drag',
              pointers: 1,
              operation: 'node.move',
              nodeId: 'a',
              begin: (session) => ({
                update: () => {
                  session.preview([{ type: 'node.patch', id: 'a', bounds: [3, 3, 0.01] }]);
                  throw new Error('broken policy');
                },
                finish: () => ({ outcome: 'unchanged' }),
                cancel: () => undefined,
              }),
            }
          : null,
    };
    const w = world([ahead]);
    w.router.registerPolicy(failing);
    const [x, y] = titleBar(w.ws, 'a');
    w.input.pointer('down', 'v', x, y);
    expect(() => w.input.pointer('move', 'v', x + 30, y)).toThrow('broken policy');
    expect(story(w.events)).toEqual(['start node.move', 'end cancelled host']);
    expect(w.router.captures()).toEqual([]);
    expect(w.ws.getState().nodes.get('a')?.bounds).toEqual([2, 1.2, 0.01]);
  });
});

describe('native content and takeover (FR-103, FR-108, FR-110)', () => {
  it('leaves presses on content native unless a takeover is active', () => {
    const w = world([ahead]);
    const [x, y] = contentOf(w.ws, 'a');
    expect(w.input.pointer('down', 'v', x, y)).toMatchObject({
      consumed: false,
      route: 'native',
      region: 'content',
    });
    expect(w.router.captures()).toEqual([]);
    expect(w.input.pointer('move', 'v', x + 40, y).route).toBe('ignored');
    w.input.pointer('up', 'v', x + 40, y);
    // The takeover modifier turns the same press into a window drag.
    expect(w.input.pointer('down', 'v', x, y, { modifiers: { alt: true } }).route).toBe('gesture');
    w.input.pointer('move', 'v', x + 40, y, { modifiers: { alt: true } });
    expect(w.input.pointer('up', 'v', x + 40, y).operation?.name).toBe('node.move');
    // So does the named takeover control.
    w.router.setTakeover(true);
    const [cx, cy] = contentOf(w.ws, 'a');
    expect(w.input.pointer('down', 'v', cx, cy).route).toBe('gesture');
    w.input.pointer('up', 'v', cx, cy);
    w.router.setTakeover(false);
    expect(w.input.pointer('down', 'v', cx, cy).route).toBe('native');
  });

  it('says a press was left to a window’s content, once, taking nothing of it', () => {
    const w = world([ahead]);
    const [x, y] = contentOf(w.ws, 'a');
    const before = w.ws.getState();
    expect(w.input.pointer('down', 'v', x, y)).toMatchObject({ consumed: false, route: 'native' });
    expect(w.events).toEqual([
      { type: 'content.pressed', viewportId: 'v', nodeId: 'a', surfaceId: 'a-view' },
    ]);
    // The router changes nothing of the scene: what the press means is the host's.
    expect(w.ws.getState()).toBe(before);
    w.input.pointer('up', 'v', x, y);
    expect(w.events).toHaveLength(1);
    // A press the router takes is no press on content.
    const [tx, ty] = titleBar(w.ws, 'a');
    w.input.pointer('down', 'v', tx, ty);
    w.input.pointer('up', 'v', tx, ty);
    expect(w.events.filter((e) => e.type === 'content.pressed')).toHaveLength(1);
  });

  it('activates a proxy surface on a tap instead of passing input to content', () => {
    const w = world([ahead], {
      router: { presentation: () => 'proxy' },
    });
    const [x, y] = contentOf(w.ws, 'a');
    expect(w.input.pointer('down', 'v', x, y).route).toBe('gesture');
    w.input.pointer('up', 'v', x, y);
    expect(w.ws.getState().selection).toEqual(['a']);
    expect(w.ws.getState().focusedId).toBe('a');
  });

  it('leaves every wheel over live content to it, and moves a window along the floor by the wheel over its title bar', () => {
    const w = world([ahead]);
    const [x, y] = contentOf(w.ws, 'a');
    const before = transformOf(w.ws, 'a');
    // Content keeps the wheel, whatever is held: it scrolls, sideways too, or the page zooms.
    for (const modifiers of [{}, { shift: true }, { ctrl: true }, { alt: true }]) {
      expect(w.input.wheel('v', x, y, 120, { modifiers })).toMatchObject({
        consumed: false,
        route: 'native',
      });
    }
    expect(transformOf(w.ws, 'a')).toBe(before);
    // The resize band takes no wheel.
    const [ex, ey] = onCard(w.ws, 'a', [0.99, 0]);
    expect(w.input.wheel('v', ex, ey, 120)).toMatchObject({ consumed: false, route: 'ignored' });
    // Over its title bar the plain wheel moves it along the floor; with Ctrl, the page zooms.
    const [tx, ty] = titleBar(w.ws, 'a');
    expect(w.input.wheel('v', tx, ty, 120, { modifiers: { ctrl: true } })).toMatchObject({
      consumed: false,
      route: 'native',
    });
    expect(w.input.wheel('v', tx, ty, -100)).toMatchObject({
      consumed: true,
      route: 'command',
      operation: { name: 'node.move' },
    });
    // 100 px of wheel turned up: nearer along the floor by e^(−0.12), its heading and height kept.
    expect(placeOf(w.ws, 'a')).toMatchObject({ heading: 0, height: 0 });
    expect(placeOf(w.ws, 'a').floor).toBeCloseTo(3 * Math.exp(-0.12), 12);
  });

  it('moves a window as far by the wheel turned sideways over its title bar as upright', () => {
    const w = world([ahead]);
    const [x, y] = titleBar(w.ws, 'a');
    // Browsers on Windows and Linux deliver a wheel turned with Shift held sideways: deltaX, with
    // deltaY zero. 100 px up, then 100 px down: nearer, then back.
    expect(w.input.wheel('v', x, y, 0, { deltaX: -100, modifiers: { shift: true } })).toMatchObject(
      { consumed: true, route: 'command', operation: { name: 'node.move' } },
    );
    expect(placeOf(w.ws, 'a').floor).toBeCloseTo(3 * Math.exp(-0.12), 12);
    w.input.wheel('v', x, y, 0, { deltaX: 100, modifiers: { shift: true } });
    expect(placeOf(w.ws, 'a').floor).toBeCloseTo(3, 12);
  });

  it('turns the camera by a scroll sideways over the background, by the angle it crosses, and leaves Ctrl to the host', () => {
    const w = world([ahead]);
    const history = w.ws.history().length;
    const heading = () => {
      const rotation = w.ws.getState().cameras.get('cam')?.rotation ?? [0, 0, 0, 1];
      return headingPitchOf(rotation).heading;
    };
    // 80 px across in an 800 px view of the whole circle: 36°, to the right.
    expect(w.input.wheel('v', 2, H / 2, 0, { deltaX: 80 })).toMatchObject({
      consumed: true,
      route: 'command',
      operation: { name: 'camera.turn' },
    });
    expect(heading()).toBeCloseTo((80 / W) * 2 * Math.PI, 9);
    // View state: no undo step.
    expect(w.ws.history()).toHaveLength(history);
    // An upright scroll over the background does nothing; Ctrl is the host's (its field of view).
    expect(w.input.wheel('v', 2, H / 2, 120)).toMatchObject({ consumed: false });
    expect(w.input.wheel('v', 2, H / 2, 120, { modifiers: { ctrl: true } })).toMatchObject({
      consumed: false,
    });
    expect(heading()).toBeCloseTo((80 / W) * 2 * Math.PI, 9);
  });

  it('stops presses outside an active modal', () => {
    const w = world([ahead, { id: 'b', heading: 1, distance: 3 }]);
    w.router.setModal(['b']);
    const [x, y] = titleBar(w.ws, 'a');
    expect(w.input.pointer('down', 'v', x, y)).toMatchObject({ consumed: true, route: 'blocked' });
    expect(w.router.captures()).toEqual([]);
  });
});

describe('gesture arena (FR-113)', () => {
  it('gives two pointers pressed on one window to the two-pointer gesture', () => {
    const w = world([{ id: 'a', heading: 0.3, distance: 6, y: 0.5 }]);
    const [x, y] = titleBar(w.ws, 'a');
    w.input.pointer('down', 'v', x - 12, y, { pointerId: 1, pointerType: 'touch' });
    w.input.pointer('down', 'v', x + 12, y, { pointerId: 2, pointerType: 'touch' });
    // Spreading the fingers to twice the distance (each past a finger's slop) brings the window to
    // half its distance along the floor.
    w.input.pointer('move', 'v', x - 24, y, { pointerId: 1, pointerType: 'touch' });
    w.input.pointer('move', 'v', x + 24, y, { pointerId: 2, pointerType: 'touch' });
    const up = w.input.pointer('up', 'v', x + 24, y, { pointerId: 2, pointerType: 'touch' });
    expect(up.operation).toMatchObject({ name: 'node.move', outcome: { outcome: 'committed' } });
    expect(story(w.events)).toEqual(['start node.move', 'end committed']);
    expect(w.events.filter((e) => e.type === 'capture.released')).toHaveLength(2);
    const started = w.events.find((e) => e.type === 'gesture.started');
    expect(started?.type === 'gesture.started' && started.policyId).toBe('swf.pinch-depth/1');
    const place = placeOf(w.ws, 'a');
    expect(place.floor).toBeCloseTo(3, 12);
    expect(place.heading).toBeCloseTo(0.3, 12);
    expect(place.height).toBeCloseTo(0.5, 12);
    // The other finger's release belongs to no gesture now.
    expect(
      w.input.pointer('up', 'v', x - 20, y, { pointerId: 1, pointerType: 'touch' }).route,
    ).toBe('ignored');
  });

  it('keeps a running drag when another pointer presses its window', () => {
    const w = world([ahead]);
    const { x, y } = drag(w, 30, 0);
    const second = w.input.pointer('down', 'v', x, y, { pointerId: 2 });
    expect(second).toMatchObject({ consumed: true, route: 'ignored' });
    w.input.pointer('move', 'v', x + 50, y);
    w.input.pointer('up', 'v', x + 50, y);
    expect(story(w.events)).toEqual(['start node.move', 'end committed']);
    expect(w.input.pointer('up', 'v', x, y, { pointerId: 2 }).route).toBe('ignored');
  });

  it('runs independent gestures on different windows side by side', () => {
    const w = world([ahead, { id: 'b', heading: 1, distance: 3 }]);
    const [ax, ay] = titleBar(w.ws, 'a');
    const [bx, by] = titleBar(w.ws, 'b');
    w.input.pointer('down', 'v', ax, ay, { pointerId: 1 });
    w.input.pointer('down', 'v', bx, by, { pointerId: 2 });
    w.input.pointer('move', 'v', ax + 30, ay, { pointerId: 1 });
    w.input.pointer('move', 'v', bx - 30, by, { pointerId: 2 });
    w.input.pointer('up', 'v', ax + 30, ay, { pointerId: 1 });
    w.input.pointer('up', 'v', bx - 30, by, { pointerId: 2 });
    expect(story(w.events)).toEqual([
      'start node.move',
      'start node.move',
      'end committed',
      'end committed',
    ]);
  });

  it('resolves a press that does not move as a tap, and one that moves as a drag', () => {
    const w = world([ahead]);
    const [x, y] = titleBar(w.ws, 'a');
    w.input.pointer('down', 'v', x, y);
    w.input.pointer('move', 'v', x + 2, y);
    expect(w.input.pointer('up', 'v', x + 2, y).operation?.name).toBe('selection.set');
    expect(w.ws.getState().selection).toEqual(['a']);
    w.input.pointer('down', 'v', 2, H / 2);
    expect(w.input.pointer('up', 'v', 2, H / 2).operation?.name).toBe('selection.set');
    expect(w.ws.getState().selection).toEqual([]);
  });

  it('lets a finger or a pen wobble farther than a mouse and still press', () => {
    const w = world([ahead]);
    const [x, y] = titleBar(w.ws, 'a');
    const before = transformOf(w.ws, 'a');
    // 7 px: past a mouse's 4 px slop, within a finger's 10.
    for (const pointerType of ['touch', 'pen'] as const) {
      w.input.pointer('down', 'v', x, y, { pointerType });
      expect(w.input.pointer('move', 'v', x + 7, y, { pointerType }).gestureId).toBeNull();
      expect(w.input.pointer('up', 'v', x + 7, y, { pointerType }).operation?.name).toBe(
        'selection.set',
      );
      expect(transformOf(w.ws, 'a')).toBe(before);
    }
    w.input.pointer('down', 'v', x, y, { pointerType: 'mouse' });
    expect(
      w.input.pointer('move', 'v', x + 7, y, { pointerType: 'mouse' }).gestureId,
    ).not.toBeNull();
    expect(w.input.pointer('up', 'v', x + 7, y, { pointerType: 'mouse' }).operation?.name).toBe(
      'node.move',
    );
    // A finger moved past its own slop drags.
    w.input.pointer('down', 'v', x, y, { pointerType: 'touch' });
    expect(
      w.input.pointer('move', 'v', x + 11, y, { pointerType: 'touch' }).gestureId,
    ).not.toBeNull();
    w.input.pointer('up', 'v', x + 11, y, { pointerType: 'touch' });
  });

  it('says a window was pressed twice when two presses lift on it near each other in time and place', () => {
    const w = world([ahead, { id: 'b', heading: 1.2, distance: 3 }]);
    let clock = 1000;
    const input = createSyntheticInput({ id: 'test.clocked/1', now: () => clock });
    w.router.registerInputAdapter(input);
    const twice = () =>
      w.events.flatMap((e) => (e.type === 'pointer.doublePressed' ? [[e.nodeId, e.x, e.y]] : []));
    const [x, y] = titleBar(w.ws, 'a');
    const tap = (px: number, py: number, after: number, pointerType: PointerType = 'mouse') => {
      clock += after;
      input.pointer('down', 'v', px, py, { pointerType });
      input.pointer('up', 'v', px, py, { pointerType });
    };
    // Two presses 400 ms and 7 px apart on the title bar: one double press, at the second.
    tap(x, y, 0);
    expect(twice()).toEqual([]);
    tap(x + 7, y, 400);
    expect(twice()).toEqual([['a', x + 7, y]]);
    // A third press soon after starts afresh: it is a first press, not a second double.
    tap(x + 7, y, 100);
    expect(twice()).toHaveLength(1);
    // Too late (over 500 ms), too far (over 8 px for a mouse), or on another window: no double.
    tap(x, y, 1000);
    tap(x, y, 501);
    tap(x, y, 1000);
    tap(x + 9, y, 100);
    const [bx, by] = titleBar(w.ws, 'b');
    tap(bx, by, 100);
    expect(twice()).toHaveLength(1);
    // A drag between two presses breaks them apart.
    tap(x, y, 1000);
    clock += 50;
    input.pointer('down', 'v', x, y, { pointerType: 'mouse' });
    input.pointer('move', 'v', x + 30, y, { pointerType: 'mouse' });
    input.pointer('up', 'v', x + 30, y, { pointerType: 'mouse' });
    const [ax, ay] = titleBar(w.ws, 'a');
    tap(ax, ay, 50);
    expect(twice()).toHaveLength(1);
    // A finger's two taps may land farther apart: 20 px.
    tap(ax, ay, 1000, 'touch');
    tap(ax + 20, ay, 300, 'touch');
    expect(twice()).toEqual([
      ['a', x + 7, y],
      ['a', ax + 20, ay],
    ]);
    // Pressing the background, or a window's live content, never pairs with a press before it.
    tap(ax, ay, 1000);
    tap(2, H / 2, 100);
    tap(ax, ay, 100);
    const [cx, cy] = contentOf(w.ws, 'a');
    tap(cx, cy, 100);
    tap(ax, ay, 100);
    expect(twice()).toHaveLength(2);
    // Both presses are settings: a host may ask for them nearer in place and time.
    w.router.configure({ doublePressPx: { fine: 4 }, doublePressMs: 200 });
    tap(ax, ay, 1000);
    tap(ax + 6, ay, 100);
    tap(ax + 6, ay, 300);
    expect(twice()).toHaveLength(2);
    tap(ax + 3, ay, 100);
    expect(twice()).toHaveLength(3);
  });

  it('does not move a locked window', () => {
    const w = world([ahead]);
    expect(w.ws.dispatch({ type: 'node.patch', id: 'a', flags: { locked: true } }).status).toBe(
      'committed',
    );
    const before = transformOf(w.ws, 'a');
    const [x, y] = titleBar(w.ws, 'a');
    w.input.pointer('down', 'v', x, y);
    expect(w.input.pointer('move', 'v', x + 40, y)).toMatchObject({ gestureId: null });
    expect(w.input.pointer('up', 'v', x + 40, y).route).toBe('ignored');
    expect(transformOf(w.ws, 'a')).toBe(before);
  });

  it('resizes from an edge by the pointer’s motion on both sides, keeping the centre in place', () => {
    const w = world([ahead]);
    const before = transformOf(w.ws, 'a');
    const [, , cardWidth] = cardOf(w.ws, 'a');
    const [x, y] = onCard(w.ws, 'a', [0.99, 0]);
    expect(w.input.pointer('down', 'v', x, y).region).toBe('resize-handle');
    w.input.pointer('move', 'v', x + 40, y);
    const up = w.input.pointer('up', 'v', x + 40, y);
    expect(up.operation?.name).toBe('node.resize');
    const node = w.ws.getState().nodes.get('a');
    // The card's pixels a unit: 40 px is so many units on each side.
    expect(node?.bounds[0]).toBeCloseTo(2 + (2 * 40) / (cardWidth / 2), 9);
    expect(node?.bounds[1]).toBe(1.2);
    expect(node?.transform).toEqual(before);
  });

  it('keeps every wheel in a viewport for the press held there: a resize commits nothing else mid-gesture', () => {
    const w = world([ahead, { id: 'b', heading: 1, distance: 3 }]);
    const before = w.ws.getState();
    const history = w.ws.history().length;
    const [x, y] = onCard(w.ws, 'a', [0.99, 0]);
    const [bx, by] = contentOf(w.ws, 'b');
    const [cx, cy] = contentOf(w.ws, 'a');
    const [tbx, tby] = titleBar(w.ws, 'b');
    /** The wheel over the resized window, over another's title bar, and over content. */
    const wheels = (px: number) => [
      w.input.wheel('v', px, y, -100),
      w.input.wheel('v', px, y, 0, { deltaX: -100, modifiers: { shift: true } }),
      w.input.wheel('v', tbx, tby, -100),
      w.input.wheel('v', bx, by, -100, { modifiers: { shift: true } }),
      w.input.wheel('v', cx, cy, 120),
    ];
    const unchanged = () => {
      expect(w.ws.history()).toHaveLength(history);
      for (const id of ['a', 'b']) {
        expect(w.ws.getState().nodes.get(id)).toBe(before.nodes.get(id));
      }
    };
    expect(w.input.pointer('down', 'v', x, y).region).toBe('resize-handle');
    // Pressed, not yet a drag: the press holds the wheel, which does nothing.
    for (const result of wheels(x)) {
      expect(result).toMatchObject({ consumed: true, route: 'gesture', operation: null });
    }
    unchanged();
    const moved = w.input.pointer('move', 'v', x - 40, y);
    expect(moved.gestureId).not.toBeNull();
    const shown = w.ws.getPresented().nodes.get('a');
    // The resize runs and has no use for the wheel: consumed, nothing changed, the resize as shown.
    for (const result of wheels(x - 40)) {
      expect(result).toMatchObject({
        consumed: true,
        route: 'gesture',
        gestureId: moved.gestureId,
        operation: null,
      });
    }
    unchanged();
    expect(w.ws.getPresented().nodes.get('a')).toEqual(shown);
    const up = w.input.pointer('up', 'v', x - 40, y);
    expect(up.operation?.name).toBe('node.resize');
    // One change, the resize alone; one undo puts the window back.
    expect(w.ws.history()).toHaveLength(history + 1);
    expect(w.ws.getState().nodes.get('a')?.bounds).toEqual(shown?.bounds);
    expect(w.ws.getState().nodes.get('b')).toBe(before.nodes.get('b'));
    expect(w.ws.undo().status).toBe('committed');
    expect(w.ws.getState().nodes.get('a')?.bounds).toEqual(before.nodes.get('a')?.bounds);
    expect(w.ws.getState().nodes.get('a')?.transform).toEqual(before.nodes.get('a')?.transform);
    // With no press held, the wheel is routed as before.
    expect(w.input.wheel('v', tbx, tby, -100)).toMatchObject({
      route: 'command',
      operation: { name: 'node.move' },
    });
  });
});

describe('background navigation (FR-106)', () => {
  it('turns the camera in camera navigation, as view state', () => {
    const w = world([]);
    const history = w.ws.history().length;
    w.input.pointer('down', 'v', W / 2, H / 2);
    w.input.pointer('move', 'v', W / 2 + 100, H / 2);
    w.input.pointer('up', 'v', W / 2 + 100, H / 2);
    const { heading } = headingPitchOf(
      w.ws.getState().cameras.get('cam')?.rotation ?? [0, 0, 0, 1],
    );
    // Dragging right by 100 of 800 px pulls the view left by 45°.
    expect(heading).toBeCloseTo(-Math.PI / 4, 9);
    expect(w.ws.history()).toHaveLength(history);
  });

  it('turns the orbit root in orbit navigation, previewed and committed once', () => {
    const w = world([ahead], {
      extra: [
        { type: 'node.create', node: { id: 'root', kind: 'group', bounds: [1, 1, 1] } },
        { type: 'orbitRoot.set', nodeId: 'root' },
        { type: 'viewport.patch', id: 'v', navigation: 'orbit' },
      ],
    });
    const history = w.ws.history().length;
    w.input.pointer('down', 'v', 2, H / 2);
    w.input.pointer('move', 'v', 2 + 100, H / 2);
    expect(w.ws.history()).toHaveLength(history);
    w.input.pointer('up', 'v', 2 + 100, H / 2);
    expect(w.ws.history()).toHaveLength(history + 1);
    const { heading } = headingPitchOf(
      w.ws.getState().nodes.get('root')?.transform.rotation ?? [0, 0, 0, 1],
    );
    expect(heading).toBeCloseTo(Math.PI / 4, 9);
    expect(w.ws.getState().cameras.get('cam')?.rotation).toEqual([0, 0, 0, 1]);
  });

  it('does not turn anything in orbit navigation without an orbit root', () => {
    const w = world([], { extra: [{ type: 'viewport.patch', id: 'v', navigation: 'orbit' }] });
    w.input.pointer('down', 'v', W / 2, H / 2);
    const moved = w.input.pointer('move', 'v', W / 2 + 100, H / 2);
    expect(moved.gestureId).toBeNull();
    expect(w.ws.getState().cameras.get('cam')?.rotation).toEqual([0, 0, 0, 1]);
  });

  it('refuses input for an unknown viewport', () => {
    const w = world([]);
    expect(() => w.input.pointer('down', 'nope', 1, 1)).toThrow(SwfFailure);
  });
});

describe('hovering', () => {
  /** What the router said a hovering pointer is over, in order. */
  const said = (w: World) =>
    w.events.flatMap((e) =>
      e.type === 'pointer.hovered' ? [[e.shows, e.nodeId, e.region, e.edge] as const] : [],
    );

  it('says what a press would do where a pointer no gesture holds hovers, once for each change', () => {
    const w = world([ahead]);
    const [cx, cy, cw, ch] = cardOf(w.ws, 'a');
    const [tx, ty] = titleBar(w.ws, 'a');
    const [kx, ky] = contentOf(w.ws, 'a');
    w.input.pointer('move', 'v', tx, ty);
    w.input.pointer('move', 'v', tx + 2, ty);
    w.input.pointer('move', 'v', kx, ky);
    w.input.pointer('move', 'v', cx + cw + 4, cy + ch / 2);
    w.input.pointer('move', 'v', 2, H / 2);
    w.input.pointer('leave', 'v', 2, H / 2);
    expect(said(w)).toEqual([
      ['grab', 'a', 'title-bar', null],
      ['content', 'a', 'content', null],
      ['resize', 'a', 'resize-handle', 'e'],
      // Behind the camera, the background: a press there turns the view.
      ['grab', null, 'background', null],
      [null, null, null, null],
    ]);
  });

  it('says content would be taken while the takeover modifier is held, sampled where it is', () => {
    const w = world([ahead]);
    const [kx, ky] = contentOf(w.ws, 'a');
    w.input.pointer('move', 'v', kx, ky);
    // An input adapter offers the pointer where it is as the modifier goes down, then up.
    w.input.pointer('move', 'v', kx, ky, { modifiers: { alt: true } });
    w.input.pointer('move', 'v', kx, ky);
    expect(said(w).map(([shows]) => shows)).toEqual(['content', 'takeover', 'content']);
    // So does the named takeover control, for the pointer where it hovers.
    w.router.setTakeover(true);
    expect(said(w).at(-1)?.[0]).toBe('takeover');
  });

  it('says again what lies under a pointer let go where its gesture moved things', () => {
    const w = world([ahead]);
    const [tx, ty] = titleBar(w.ws, 'a');
    w.input.pointer('down', 'v', tx, ty);
    w.input.pointer('move', 'v', tx + 40, ty);
    w.input.pointer('up', 'v', tx + 40, ty);
    // The window moved with the pointer: its title bar is under it still.
    expect(said(w).at(-1)).toEqual(['grab', 'a', 'title-bar', null]);
  });
});
