import type { CancelReason, Constraint, Workspace } from '@swf/core';
import { SwfFailure } from '@swf/core';
import type { Vec3 } from '@swf/math';
import { length, quatSameRotation, sub } from '@swf/math';
import { headingPitchOf } from '@swf/projections';
import { describe, expect, it } from 'vitest';
import type { InteractionEvent, InteractionPolicy } from '../src/index.js';
import { INTERACTION_API_VERSION } from '../src/index.js';
import type { World } from './fixtures.js';
import { contentOf, H, onWindow, screenOf, titleBar, W, world } from './fixtures.js';

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
      case 'capture.released':
        return [];
    }
  });
}

const transformOf = (ws: Workspace, id: string) => ws.getState().nodes.get(id)?.transform;
const anchorOf = (ws: Workspace) => onWindow(ws, 'a', [0, 0.45, 0]);

function expectUnder(ws: Workspace, point: Vec3, x: number, y: number) {
  const [px, py] = screenOf(ws, point);
  expect(Math.hypot(px - x, py - y)).toBeLessThan(1e-6);
}

/** Starts dragging window `a` by its title bar and moves it by (dx, dy). */
function drag(w: World, dx: number, dy: number) {
  const [x, y] = titleBar(w.ws, 'a');
  expect(w.input.pointer('down', 'v', x, y)).toMatchObject({
    consumed: true,
    route: 'gesture',
    gestureId: null,
    region: 'chrome',
  });
  const moved = w.input.pointer('move', 'v', x + dx, y + dy);
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
    expect(router.captures()).toEqual([{ deviceId: 'synthetic', pointerId: 1, gestureId: null }]);
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
    // The grabbed point ends under the pointer, on the plane facing the camera.
    expectUnder(ws, anchorOf(ws), x + 60, y + 15);
    expect(story(events)).toEqual(['start node.move', 'end committed']);
    expect(events.filter((e) => e.type === 'capture.released')).toHaveLength(1);
    expect(router.captures()).toEqual([]);
    // A late release from the same pointer is ignored.
    expect(input.pointer('up', 'v', x, y)).toMatchObject({ consumed: false, route: 'ignored' });
    expect(ws.history()).toHaveLength(history + 1);
  });

  it('keep the grabbed point on the camera-facing plane through it', () => {
    const w = world([{ id: 'a', heading: 0.4, distance: 3 }]);
    const anchor = anchorOf(w.ws);
    const rotation = transformOf(w.ws, 'a')?.rotation;
    const { x, y } = drag(w, -70, 30);
    w.input.pointer('up', 'v', x - 70, y + 30);
    const moved = anchorOf(w.ws);
    expectUnder(w.ws, moved, x - 70, y + 30);
    const normal = sub(anchor, [0, 0, 0]);
    const along = sub(moved, anchor);
    expect(
      Math.abs(along[0] * normal[0] + along[1] * normal[1] + along[2] * normal[2]),
    ).toBeLessThan(1e-9);
    // A planar drag only translates (the scene renormalizes rotations, so compare as rotations).
    expect(
      quatSameRotation(
        transformOf(w.ws, 'a')?.rotation ?? [0, 0, 0, 1],
        rotation ?? [1, 0, 0, 0],
        1e-12,
      ),
    ).toBe(true);
  });

  it('hold the last position when the pointer points away from the drag plane', () => {
    const w = world([ahead]);
    const { x, y, gestureId } = drag(w, 30, 0);
    const held = w.ws.getPreview(`interaction:${gestureId}`)?.nodes.get('a')?.transform;
    // 120° to the right the ray runs away from the plane facing the camera through the window.
    w.input.pointer('move', 'v', W / 2 + (120 / 360) * W, y);
    expect(w.ws.getPreview(`interaction:${gestureId}`)?.nodes.get('a')?.transform).toBe(held);
    w.input.pointer('move', 'v', x + 50, y);
    w.input.pointer('up', 'v', x + 50, y);
    expectUnder(w.ws, anchorOf(w.ws), x + 50, y);
  });

  it('move on a world plane when configured, keeping the height', () => {
    const w = world([ahead], { router: { settings: { dragMode: 'world-plane' } } });
    const anchor = anchorOf(w.ws);
    const { x, y } = drag(w, 50, 4);
    w.input.pointer('up', 'v', x + 50, y + 4);
    const moved = anchorOf(w.ws);
    expect(moved[1]).toBeCloseTo(anchor[1], 9);
    expectUnder(w.ws, moved, x + 50, y + 4);
  });

  it('move around the camera on an angular shell, turning the window with its heading', () => {
    const w = world([ahead], { router: { settings: { dragMode: 'angular-shell' } } });
    const anchor = anchorOf(w.ws);
    const { x, y } = drag(w, 120, -20);
    w.input.pointer('up', 'v', x + 120, y - 20);
    const moved = anchorOf(w.ws);
    expect(length(moved)).toBeCloseTo(length(anchor), 9);
    expectUnder(w.ws, moved, x + 120, y - 20);
    // The window turned by the change in heading, so it still faces the camera's vertical axis.
    const rotation = transformOf(w.ws, 'a')?.rotation ?? [0, 0, 0, 1];
    const turned = headingPitchOf(rotation).heading;
    const heading = Math.atan2(moved[0], -moved[2]);
    expect(turned).toBeCloseTo(heading, 9);
  });

  it('change depth only through the separate depth control, keeping the direction', () => {
    const w = world([ahead]);
    const anchor = anchorOf(w.ws);
    const { x, y } = drag(w, 30, 0);
    // A wheel during the drag moves the window away along the line from the camera.
    expect(w.input.wheel('v', x + 30, y, -100)).toMatchObject({ consumed: true, route: 'gesture' });
    w.input.pointer('up', 'v', x + 30, y);
    const moved = anchorOf(w.ws);
    expectUnder(w.ws, moved, x + 30, y);
    const lateral = length(sub([anchor[0], anchor[1], anchor[2]], [0, 0, 0]));
    // Moved on the camera plane first, then 0.2 farther along its own line of sight.
    expect(length(moved)).toBeGreaterThan(lateral + 0.19);
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
  it('holds the window while the pointer is outside the viewport, and resumes after', () => {
    const w = world([ahead]);
    const { x, y } = drag(w, 20, 0);
    const preview = () =>
      w.ws.getPreview(
        `interaction:${w.events[0]?.type === 'gesture.started' ? w.events[0].gestureId : ''}`,
      );
    const held = preview()?.nodes.get('a')?.transform;
    expect(w.input.pointer('move', 'v', W + 50, y)).toMatchObject({
      consumed: true,
      route: 'gesture',
    });
    expect(preview()?.nodes.get('a')?.transform).toBe(held);
    w.input.pointer('move', 'v', x + 70, y);
    w.input.pointer('up', 'v', x + 70, y);
    expectUnder(w.ws, anchorOf(w.ws), x + 70, y);
  });

  it('keeps its target over other windows and across a viewport resize', () => {
    const w = world([ahead, { id: 'b', heading: 0.5, distance: 2.5 }]);
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
    // Positions are now in the smaller viewport.
    const [nx, ny] = [(x + 60) / 2, y / 2];
    w.input.pointer('move', 'v', nx, ny);
    w.input.pointer('up', 'v', nx, ny);
    expect(story(w.events)).toEqual(['start node.move', 'end committed']);
    expectUnder(w.ws, anchorOf(w.ws), nx, ny);
    expect(w.ws.getState().nodes.get('b')?.transform.position).toEqual([
      2.5 * Math.sin(0.5),
      0,
      -2.5 * Math.cos(0.5),
    ]);
  });

  it('drags a surface across the seam continuously, as one Surface ID (AC-003)', () => {
    const w = world([{ id: 'a', heading: Math.PI - 0.2, distance: 3 }], {
      router: { settings: { dragMode: 'angular-shell' } },
    });
    // Grab the left end of the title bar, so the window's centre lies right of the pointer.
    const [x, y] = screenOf(w.ws, onWindow(w.ws, 'a', [-0.85, 0.45, 0]));
    expect(x).toBeGreaterThan(W - 80);
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
    // Both fragments now pick as the same surface.
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
        context.region === 'chrome'
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

  it('leaves the wheel with content, adjusting depth only with the depth modifier', () => {
    const w = world([ahead]);
    const [x, y] = contentOf(w.ws, 'a');
    const before = transformOf(w.ws, 'a');
    expect(w.input.wheel('v', x, y, 120)).toMatchObject({ consumed: false, route: 'native' });
    expect(transformOf(w.ws, 'a')).toBe(before);
    expect(w.input.wheel('v', 2, H / 2, 120)).toMatchObject({ consumed: false, route: 'ignored' });
    const deep = w.input.wheel('v', x, y, -100, { modifiers: { shift: true } });
    expect(deep).toMatchObject({
      consumed: true,
      route: 'command',
      operation: { name: 'node.move' },
    });
    // 100 px of wheel at 0.002 per px: 0.2 farther, straight back from the camera.
    expect(transformOf(w.ws, 'a')?.position[2]).toBeCloseTo(-3.2, 9);
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
    const w = world([ahead]);
    const [x, y] = titleBar(w.ws, 'a');
    const grabbed = w.router.pick('v', x - 10, y);
    const hitPoint = grabbed.kind === 'hit' ? grabbed.target.worldPoint : [0, 0, 0];
    const before = transformOf(w.ws, 'a')?.position ?? [0, 0, 0];
    w.input.pointer('down', 'v', x - 10, y, { pointerId: 1, pointerType: 'touch' });
    w.input.pointer('down', 'v', x + 10, y, { pointerId: 2, pointerType: 'touch' });
    // Spreading the fingers to twice the distance brings the window to half its distance.
    w.input.pointer('move', 'v', x - 20, y, { pointerId: 1, pointerType: 'touch' });
    w.input.pointer('move', 'v', x + 20, y, { pointerId: 2, pointerType: 'touch' });
    const up = w.input.pointer('up', 'v', x + 20, y, { pointerId: 2, pointerType: 'touch' });
    expect(up.operation).toMatchObject({ name: 'node.move', outcome: { outcome: 'committed' } });
    expect(story(w.events)).toEqual(['start node.move', 'end committed']);
    expect(w.events.filter((e) => e.type === 'capture.released')).toHaveLength(2);
    const started = w.events.find((e) => e.type === 'gesture.started');
    expect(started?.type === 'gesture.started' && started.policyId).toBe('swf.pinch-depth/1');
    // The grabbed point came halfway to the camera (at the origin); the window moved with it.
    const after = transformOf(w.ws, 'a')?.position ?? [0, 0, 0];
    after.forEach((v, i) => {
      expect(v).toBeCloseTo((before[i] ?? 0) - (hitPoint[i] ?? 0) / 2, 9);
    });
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

  it('resizes from an edge, keeping the opposite edge in place', () => {
    const w = world([ahead]);
    const west = onWindow(w.ws, 'a', [-1, 0, 0]);
    const [x, y] = screenOf(w.ws, onWindow(w.ws, 'a', [0.99, 0, 0]));
    expect(w.input.pointer('down', 'v', x, y).region).toBe('resize-handle');
    w.input.pointer('move', 'v', x + 40, y);
    const up = w.input.pointer('up', 'v', x + 40, y);
    expect(up.operation?.name).toBe('node.resize');
    const node = w.ws.getState().nodes.get('a');
    expect(node?.bounds[0]).toBeGreaterThan(2.3);
    expect(node?.bounds[1]).toBe(1.2);
    const westAfter = onWindow(w.ws, 'a', [-(node?.bounds[0] ?? 0) / 2, 0, 0]);
    expect(length(sub(westAfter, west))).toBeLessThan(1e-9);
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
