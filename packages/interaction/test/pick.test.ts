import { SwfFailure } from '@swf/core';
import { describe, expect, it } from 'vitest';
import type { PickResult } from '../src/index.js';
import { intentIssue, NO_MODIFIERS, wheelTurn } from '../src/index.js';
import { contentOf, H, onWindow, screenOf, titleBar, W, world } from './fixtures.js';

function hit(result: PickResult) {
  if (result.kind !== 'hit') {
    throw new Error(`expected a hit, got ${result.kind}`);
  }
  return result;
}

describe('input regions (FR-103)', () => {
  it('tells content, chrome, resize handles, background and modal overlays apart', () => {
    const { ws, router } = world([
      { id: 'a', heading: 0, distance: 3 },
      { id: 'b', heading: 1.2, distance: 3 },
    ]);
    const [cx, cy] = contentOf(ws, 'a');
    const content = hit(router.pick('v', cx, cy));
    expect(content).toMatchObject({
      region: 'content',
      target: { nodeId: 'a', surfaceId: 'a-view' },
    });
    expect(content.target.uv?.[0]).toBeCloseTo(0.5, 9);
    expect(content.target.uv?.[1]).toBeCloseTo(0.5, 9);
    expect(content.target.localPoint[0]).toBeCloseTo(0, 9);
    expect(content.target.distance).toBeCloseTo(3, 9);
    expect(content.confidence).toBe('exact');

    const [tx, ty] = titleBar(ws, 'a');
    expect(hit(router.pick('v', tx, ty))).toMatchObject({
      region: 'chrome',
      target: { nodeId: 'a', surfaceId: null, edge: null },
    });
    const [ex, ey] = screenOf(ws, onWindow(ws, 'a', [0.99, 0, 0]));
    expect(hit(router.pick('v', ex, ey))).toMatchObject({
      region: 'resize-handle',
      target: { nodeId: 'a', edge: 'e' },
    });
    const [nx, ny] = screenOf(ws, onWindow(ws, 'a', [-0.99, 0.59, 0]));
    expect(hit(router.pick('v', nx, ny)).target.edge).toBe('nw');
    // Behind the camera there is nothing.
    expect(router.pick('v', 2, H / 2)).toMatchObject({ kind: 'background', region: 'background' });

    router.setModal(['b']);
    expect(hit(router.pick('v', cx, cy)).region).toBe('modal-overlay');
    const [bx, by] = contentOf(ws, 'b');
    expect(hit(router.pick('v', bx, by)).region).toBe('content');
    expect(router.pick('v', 2, H / 2)).toMatchObject({
      kind: 'background',
      region: 'modal-overlay',
    });
    router.setModal(null);
    expect(hit(router.pick('v', cx, cy)).region).toBe('content');
    expect(() => {
      router.setModal(['none']);
    }).toThrow(SwfFailure);
  });

  it('treats a surface that only shows something as part of the window frame', () => {
    const { ws, router } = world([{ id: 'a', heading: 0, distance: 3, interaction: 'none' }]);
    const [cx, cy] = contentOf(ws, 'a');
    expect(hit(router.pick('v', cx, cy))).toMatchObject({
      region: 'chrome',
      target: { surfaceId: 'a-view' },
    });
  });

  it('keeps the resize band along the frame even where a surface fills it', () => {
    const { ws, router } = world([{ id: 'a', heading: 0, distance: 3, inset: 0 }]);
    const [ex, ey] = screenOf(ws, onWindow(ws, 'a', [0.99, 0, 0]));
    const edge = hit(router.pick('v', ex, ey));
    expect(edge).toMatchObject({
      region: 'resize-handle',
      target: { nodeId: 'a', surfaceId: null, edge: 'e' },
    });
    // The band belongs to the frame: the surface under it is not a candidate there.
    expect(edge.candidates.map((c) => c.region)).toEqual(['resize-handle']);
    const [cx, cy] = contentOf(ws, 'a');
    expect(hit(router.pick('v', cx, cy)).region).toBe('content');
  });

  it('keeps resize bands off windows that cannot be resized', () => {
    const { ws, router } = world([{ id: 'a', heading: 0, distance: 3 }]);
    expect(ws.dispatch({ type: 'node.patch', id: 'a', flags: { resizable: false } }).status).toBe(
      'committed',
    );
    const [ex, ey] = screenOf(ws, onWindow(ws, 'a', [0.99, 0, 0]));
    expect(hit(router.pick('v', ex, ey))).toMatchObject({
      region: 'chrome',
      target: { edge: null },
    });
  });
});

describe('picking order and reporting (FR-102)', () => {
  const pair = (extra: { far?: number; priority?: number } = {}) =>
    world([
      { id: 'near', heading: 0, distance: 3 },
      {
        id: 'far',
        heading: 0,
        distance: extra.far ?? 6,
        size: [4, 3],
        ...(extra.priority === undefined ? {} : { priority: extra.priority }),
      },
    ]);

  it('orders candidates by depth, marking what the nearer one hides', () => {
    const { ws, router } = pair();
    const [x, y] = contentOf(ws, 'near');
    const result = hit(router.pick('v', x, y));
    expect(result.target.nodeId).toBe('near');
    expect(result.candidates.map((c) => [c.nodeId, c.region, c.occluded])).toEqual([
      ['near', 'content', false],
      ['far', 'content', true],
    ]);
    expect(result.ambiguous).toBe(false);
  });

  it('puts presentation priority before depth', () => {
    const { ws, router } = pair({ priority: 5 });
    const [x, y] = contentOf(ws, 'near');
    const result = hit(router.pick('v', x, y));
    expect(result.target).toMatchObject({ nodeId: 'far', occluded: true, priority: 5 });
  });

  it('lets a transparent hit leave what lies behind it unoccluded', () => {
    const { ws, router } = world(
      [
        { id: 'near', heading: 0, distance: 3 },
        { id: 'far', heading: 0, distance: 6, size: [4, 3] },
      ],
      {
        router: {
          occlusion: ({ nodeId }) => (nodeId === 'near' ? 'transparent' : 'occluding'),
        },
      },
    );
    const [x, y] = contentOf(ws, 'near');
    expect(hit(router.pick('v', x, y)).candidates.map((c) => c.occluded)).toEqual([false, false]);
  });

  it('skips hidden, pointer-disabled and out-of-range entities', () => {
    const { ws, router } = pair();
    const [x, y] = contentOf(ws, 'near');
    expect(ws.dispatch({ type: 'node.patch', id: 'near', flags: { visible: false } }).status).toBe(
      'committed',
    );
    expect(hit(router.pick('v', x, y)).target.nodeId).toBe('far');
    expect(
      ws.dispatch({ type: 'node.patch', id: 'far', flags: { pointerEnabled: false } }).status,
    ).toBe('committed');
    expect(router.pick('v', x, y).kind).toBe('background');
    expect(
      ws.transaction([
        { type: 'node.patch', id: 'near', flags: { visible: true } },
        { type: 'node.patch', id: 'far', flags: { pointerEnabled: true } },
        { type: 'camera.patch', id: 'cam', far: 4 },
      ]).status,
    ).toBe('committed');
    expect(hit(router.pick('v', x, y)).candidates.map((c) => c.nodeId)).toEqual(['near']);
  });

  it('passes over a surface that takes no pointer input, to its window frame', () => {
    const { ws, router } = world([{ id: 'a', heading: 0, distance: 3 }]);
    expect(
      ws.dispatch({ type: 'surface.patch', id: 'a-view', flags: { pointerEnabled: false } }).status,
    ).toBe('committed');
    const [x, y] = contentOf(ws, 'a');
    expect(hit(router.pick('v', x, y))).toMatchObject({
      region: 'chrome',
      target: { nodeId: 'a', surfaceId: null },
    });
  });

  it('reports a tie between distinct windows as ambiguous, choosing by ID', () => {
    const { ws, router } = world([
      { id: 'b', heading: 0, distance: 3 },
      { id: 'a', heading: 0, distance: 3 },
    ]);
    const [x, y] = contentOf(ws, 'a');
    const result = hit(router.pick('v', x, y));
    expect(result.ambiguous).toBe(true);
    expect(result.target.nodeId).toBe('a');
  });

  it('reports the hit query of each dispatch: its ambiguity and duration (AN-004)', () => {
    let clock = 0;
    // Every reading of the timer advances it by 3 ms: a hit query reads it as it starts and ends.
    const timer = () => (clock += 3);
    const { ws, input } = world(
      [
        { id: 'b', heading: 0, distance: 3 },
        { id: 'a', heading: 0, distance: 3 },
        { id: 'c', heading: Math.PI / 2, distance: 3 },
      ],
      { router: { timer } },
    );
    const [x, y] = contentOf(ws, 'a');
    expect(input.pointer('down', 'v', x, y).pick).toEqual({ ambiguous: true, ms: 3 });
    input.pointer('up', 'v', x, y);
    const [cx, cy] = contentOf(ws, 'c');
    expect(input.pointer('down', 'v', cx, cy).pick).toEqual({ ambiguous: false, ms: 3 });
    // A move of a captured pointer and a command make no hit query.
    expect(input.pointer('move', 'v', cx + 1, cy).pick).toBeNull();
    expect(input.command('selection.next', {}).pick).toBeNull();
  });

  it('refuses a timer that is not a function', () => {
    expect(() => world([], { router: { timer: 1 as unknown as () => number } })).toThrow(
      /timer must be a function/,
    );
  });

  it('gives one Surface ID wherever a seam splits the surface (FR-111)', () => {
    const { router } = world([{ id: 's', heading: Math.PI, distance: 3, size: [3, 1.2] }]);
    const left = hit(router.pick('v', 1, H / 2));
    const right = hit(router.pick('v', W - 1, H / 2));
    expect(left.target.surfaceId).toBe('s-view');
    expect(right.target.surfaceId).toBe('s-view');
    expect(left.candidates.filter((c) => c.surfaceId !== null)).toHaveLength(1);
    expect(right.candidates.filter((c) => c.surfaceId !== null)).toHaveLength(1);
  });

  it('marks a proxy surface and offers focus or activation instead (FR-111)', () => {
    const { ws, router } = world([{ id: 'a', heading: 0, distance: 3 }], {
      router: { presentation: (surfaceId) => (surfaceId === 'a-view' ? 'proxy' : 'live') },
    });
    const [x, y] = contentOf(ws, 'a');
    expect(hit(router.pick('v', x, y))).toMatchObject({
      region: 'content',
      target: { proxy: true },
      actions: ['focus', 'activate'],
    });
  });

  it('reports points outside the image instead of guessing', () => {
    const { router } = world([]);
    expect(router.pick('v', -1, 10)).toMatchObject({ kind: 'outside' });
    expect(() => router.pick('nope', 1, 1)).toThrow(SwfFailure);
  });
});

describe('normalized intents (FR-100, FR-101)', () => {
  it('reads how far the wheel turned from deltaY, or from deltaX when the platform turned it sideways', () => {
    const turn = (deltaX: number, deltaY: number) =>
      wheelTurn({
        kind: 'wheel',
        viewportId: 'v',
        deviceId: 'wheel',
        x: 0,
        y: 0,
        deltaX,
        deltaY,
        modifiers: { ...NO_MODIFIERS, shift: true },
        timestamp: 0,
      });
    expect(turn(0, -120)).toBe(-120);
    expect(turn(-120, 0)).toBe(-120);
    expect(turn(120, -0)).toBe(120);
    expect(turn(37, 5)).toBe(5);
    expect(turn(37, -1e-300)).toBe(-1e-300);
    expect(turn(0, 0)).toBe(0);
  });

  const pointer = {
    kind: 'pointer',
    viewportId: 'v',
    deviceId: 'pen-1',
    pointerId: 3,
    pointerType: 'pen',
    phase: 'down',
    x: 10,
    y: 20,
    buttons: 1,
    modifiers: NO_MODIFIERS,
    timestamp: 12.5,
    pressure: 0.4,
    tilt: { x: -30, y: 10 },
    twist: 90,
  };

  it('accepts a complete pointer sample with pen metadata', () => {
    expect(intentIssue(pointer)).toBeNull();
  });

  it('accepts the motion a locked pointer reports', () => {
    expect(intentIssue({ ...pointer, movement: { x: -12.5, y: 3 } })).toBeNull();
  });

  it('names the field at fault', () => {
    const issue = (patch: Record<string, unknown>) => intentIssue({ ...pointer, ...patch });
    expect(issue({ pressure: 1.5 })).toMatch(/^pressure/);
    expect(issue({ tilt: { x: 100, y: 0 } })).toMatch(/^tilt/);
    expect(issue({ twist: 360 })).toMatch(/^twist/);
    expect(issue({ movement: { x: Infinity, y: 0 } })).toMatch(/^movement/);
    expect(issue({ movement: { x: 1 } })).toMatch(/^movement/);
    expect(issue({ movement: { x: 1, y: 2, z: 3 } })).toMatch(/^movement/);
    expect(issue({ pointerId: -1 })).toMatch(/^pointerId/);
    expect(issue({ pointerType: 'glove' })).toMatch(/^pointerType/);
    expect(issue({ phase: 'hover' })).toMatch(/^phase/);
    expect(issue({ x: NaN })).toMatch(/^x and y/);
    expect(issue({ viewportId: ' ' })).toMatch(/^viewportId/);
    expect(issue({ deviceId: '' })).toMatch(/^deviceId/);
    expect(issue({ timestamp: -1 })).toMatch(/^timestamp/);
    expect(issue({ modifiers: { ...NO_MODIFIERS, hyper: true } })).toMatch(/^modifiers\.hyper/);
    expect(issue({ modifiers: { shift: true } })).toMatch(/^modifiers\.ctrl/);
    expect(issue({ extra: 1 })).toMatch(/^extra is not a field/);
    expect(intentIssue({ kind: 'gaze' })).toMatch(/^kind/);
    expect(
      intentIssue({
        kind: 'wheel',
        viewportId: 'v',
        deviceId: 'd',
        x: 0,
        y: 0,
        deltaX: 0,
        deltaY: Infinity,
        modifiers: NO_MODIFIERS,
        timestamp: 0,
      }),
    ).toMatch(/^deltaY/);
    expect(
      intentIssue({
        kind: 'key',
        viewportId: null,
        deviceId: 'k',
        phase: 'down',
        key: '',
        repeat: false,
        modifiers: NO_MODIFIERS,
        focus: 'workspace',
        timestamp: 0,
      }),
    ).toMatch(/^key/);
    expect(
      intentIssue({
        kind: 'key',
        viewportId: null,
        deviceId: 'k',
        phase: 'down',
        key: 'a',
        repeat: false,
        modifiers: NO_MODIFIERS,
        focus: 'elsewhere',
        timestamp: 0,
      }),
    ).toMatch(/^focus/);
    expect(
      intentIssue({ kind: 'command', command: ' ', args: null, deviceId: 'p', timestamp: 0 }),
    ).toMatch(/^command/);
    expect(
      intentIssue({
        kind: 'command',
        command: 'node.move',
        args: { right: () => 1 },
        deviceId: 'p',
        timestamp: 0,
      }),
    ).toMatch(/^args.right must be JSON data/);
  });

  it('are refused by the router with the reason', () => {
    const { router } = world([]);
    let error: unknown;
    try {
      router.dispatch({ ...pointer, pressure: 2 } as never);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SwfFailure);
    expect((error as SwfFailure).error).toMatchObject({ code: 'INVALID_INPUT' });
    expect((error as SwfFailure).message).toMatch(/pressure/);
  });

  it('let any device drive the same operations without touching the scene model', () => {
    // A pen and a touch pointer select the same window through the same path a mouse would.
    const { ws, router, input } = world([{ id: 'a', heading: 0, distance: 3 }]);
    const [x, y] = titleBar(ws, 'a');
    for (const pointerType of ['mouse', 'pen', 'touch', 'virtual'] as const) {
      expect(ws.dispatch({ type: 'selection.set', ids: [] }).status).toBe('committed');
      input.pointer('down', 'v', x, y, { pointerType, pressure: 0.5 });
      const up = input.pointer('up', 'v', x, y, { pointerType });
      expect(up.operation?.name).toBe('selection.set');
      expect(ws.getState().selection).toEqual(['a']);
    }
    expect(router.captures()).toEqual([]);
  });
});
