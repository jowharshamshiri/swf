import { SwfFailure } from '@swf/core';
import { describe, expect, it } from 'vitest';
import type { PickResult } from '../src/index.js';
import { intentIssue, NO_MODIFIERS, wheelTurn } from '../src/index.js';
import { TITLE_BAR_HEIGHT } from '@swf/presentation';
import { cardOf, contentOf, H, onCard, titleBar, W, world } from './fixtures.js';

function hit(result: PickResult) {
  if (result.kind !== 'hit') {
    throw new Error(`expected a hit, got ${result.kind}`);
  }
  return result;
}

describe('input regions (FR-103)', () => {
  it('tells content, chrome, title bars, resize handles, background and modal overlays apart', () => {
    // Two windows clear of each other's handles.
    const { ws, router } = world([
      { id: 'a', heading: 0, distance: 3 },
      { id: 'b', heading: 1.6, distance: 3 },
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

    // The title bar across the top of the card, over its whole height and width but its corners.
    const [x, y, w, h] = cardOf(ws, 'a');
    for (const [px, py] of [
      [x + w / 2, y - TITLE_BAR_HEIGHT / 2],
      [x + w / 2, y - TITLE_BAR_HEIGHT + 0.5],
      [x + w / 2, y - 0.5],
      [x + 24, y - 6],
      [x + w - 24, y - 6],
    ] as const) {
      expect(hit(router.pick('v', px, py))).toMatchObject({
        region: 'title-bar',
        target: { nodeId: 'a', surfaceId: null, edge: null },
      });
    }
    // The card's frame, between its edge's band and the content.
    expect(hit(router.pick('v', x + w / 2, y + 10))).toMatchObject({
      region: 'chrome',
      target: { nodeId: 'a', surfaceId: null, edge: null },
    });
    // The resize band: 8 px outside the outline, 4 px inside it at the sides and bottom, above the
    // bar at the top, and square corners 20 px on a side at the band's outer edge.
    const band = (px: number, py: number) => hit(router.pick('v', px, py)).target.edge;
    expect(band(x + w + 6, y + h / 2)).toBe('e');
    expect(band(x + w - 3, y + h / 2)).toBe('e');
    expect(band(x - 6, y + h / 2)).toBe('w');
    expect(band(x + w / 2, y + h + 6)).toBe('s');
    expect(band(x + w / 2, y + h - 3)).toBe('s');
    expect(band(x + w / 2, y - TITLE_BAR_HEIGHT - 6)).toBe('n');
    expect(band(x - 6, y - TITLE_BAR_HEIGHT - 6)).toBe('nw');
    expect(band(x + w + 6, y + h + 6)).toBe('se');
    expect(hit(router.pick('v', x + w + 6, y + h / 2)).region).toBe('resize-handle');
    // Past the band there is nothing of the window's.
    expect(router.pick('v', x - 10, y + h / 2)).toMatchObject({ kind: 'background' });
    expect(router.pick('v', x + w + 10, y + h / 2)).toMatchObject({ kind: 'background' });
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

  it('picks a window by its title bar over a nearer window’s card, as the bar is drawn over it', () => {
    // A farther window whose bar lies over the middle of a nearer one's content.
    const { ws, router } = world([
      { id: 'near', heading: 0, distance: 3, y: 0.3 },
      { id: 'far', heading: 0.05, distance: 6, y: -0.2 },
    ]);
    const [fx, fy, fw] = cardOf(ws, 'far');
    const [nx, ny, nw, nh] = cardOf(ws, 'near');
    const at: [number, number] = [fx + fw / 2, fy - TITLE_BAR_HEIGHT / 2];
    // The point is on the nearer window's content.
    expect(at[0] > nx && at[0] < nx + nw && at[1] > ny && at[1] < ny + nh).toBe(true);
    const picked = hit(router.pick('v', ...at));
    expect(picked).toMatchObject({ region: 'title-bar', target: { nodeId: 'far' } });
    expect(picked.target.occluded).toBe(false);
    // The nearer window's content is still a candidate, after the bar.
    expect(picked.candidates.map((c) => [c.nodeId, c.region])).toContainEqual(['near', 'content']);
  });

  it('picks a window the view brings in front over every other, a nearer one’s title bar included', () => {
    const front = {
      id: 'test.front/1',
      representationOf: () => 'full' as const,
      frontOf: ({ nodeId }: { nodeId: string }) => nodeId === 'far',
    };
    // A nearer window's title bar lies over the middle of the farther one's content.
    const { ws, router } = world(
      [
        { id: 'near', heading: 0.02, distance: 3, y: -0.6 },
        { id: 'far', heading: 0, distance: 6, y: 0.4, size: [4, 3] },
      ],
      { router: { representation: () => front } },
    );
    const [nx, ny, nw] = cardOf(ws, 'near', 'v', front);
    const at: [number, number] = [nx + nw / 2, ny - TITLE_BAR_HEIGHT / 2];
    const [fx, fy, fw, fh] = cardOf(ws, 'far', 'v', front);
    expect(at[0] > fx && at[0] < fx + fw && at[1] > fy && at[1] < fy + fh).toBe(true);
    const picked = hit(router.pick('v', ...at));
    expect(picked.target).toMatchObject({ nodeId: 'far', front: true });
    expect(picked.candidates.map((c) => [c.nodeId, c.region])).toContainEqual([
      'near',
      'title-bar',
    ]);
  });

  it('counts a press on the handles over larger sizes for a coarse pointer', () => {
    const { ws, router } = world([{ id: 'a', heading: 0, distance: 3 }]);
    const [x, y, w] = cardOf(ws, 'a');
    // 36 px above the card: past a fine pointer's bar and band, on a coarse pointer's bar.
    expect(router.pick('v', x + w / 2, y - 36)).toMatchObject({ kind: 'background' });
    expect(hit(router.pick('v', x + w / 2, y - 36, undefined, 'coarse')).region).toBe('title-bar');
    // 12 px past the right edge: past a fine pointer's band, in a coarse pointer's.
    expect(router.pick('v', x + w + 12, y + 50)).toMatchObject({ kind: 'background' });
    expect(hit(router.pick('v', x + w + 12, y + 50, undefined, 'coarse')).target.edge).toBe('e');
  });

  it('lets a handle reach past what is drawn only where nothing else is: never into another window’s content', () => {
    // A nearer window over the middle of a larger, farther one's content.
    const { ws, router } = world([
      { id: 'near', heading: 0, distance: 3 },
      { id: 'far', heading: 0, distance: 6, size: [6, 8] },
    ]);
    const [x, y, w, h] = cardOf(ws, 'near');
    const [fx, fy, fw, fh] = cardOf(ws, 'far');
    const onFar = (px: number, py: number) => px > fx && px < fx + fw && py > fy && py < fy + fh;
    // 5 px left of the nearer card, on its band outside its outline: the farther window's content
    // shows there, and takes the press, not hidden by a band nothing draws.
    const outside: [number, number] = [x - 5, y + h / 2];
    expect(onFar(...outside)).toBe(true);
    const beside = hit(router.pick('v', ...outside));
    expect(beside).toMatchObject({ region: 'content', target: { nodeId: 'far', occluded: false } });
    expect(beside.candidates.find((c) => c.nodeId === 'near')).toMatchObject({
      region: 'resize-handle',
      edge: 'w',
      reach: true,
    });
    // 3 px inside the nearer card's edge, its band lies on the window as drawn: it takes the press.
    expect(hit(router.pick('v', x + 3, y + h / 2)).target).toMatchObject({
      nodeId: 'near',
      region: 'resize-handle',
      reach: false,
    });
    // A coarse pointer's title bar reaches 20 px above the bar as drawn: over the farther window's
    // content it is that content's.
    const above: [number, number] = [x + w / 2, y - TITLE_BAR_HEIGHT - 10];
    expect(onFar(...above)).toBe(true);
    const coarse = hit(router.pick('v', ...above, undefined, 'coarse'));
    expect(coarse).toMatchObject({ region: 'content', target: { nodeId: 'far' } });
    expect(coarse.candidates.find((c) => c.nodeId === 'near')).toMatchObject({
      region: 'title-bar',
      reach: true,
    });
    // On the bar as drawn, the nearer window's bar is pressed, for either pointer.
    for (const precision of ['fine', 'coarse'] as const) {
      expect(
        hit(router.pick('v', x + w / 2, y - TITLE_BAR_HEIGHT / 2, undefined, precision)).target,
      ).toMatchObject({ nodeId: 'near', region: 'title-bar', reach: false });
    }
  });

  it('makes the whole card of a window shown by its label alone its title bar', () => {
    const label = { id: 'test.label/1', representationOf: () => 'label' as const };
    const { ws, router } = world([{ id: 'a', heading: 0, distance: 3 }], {
      router: { representation: () => label },
    });
    const [x, y, w, h] = cardOf(ws, 'a', 'v', label);
    // Across its middle, top to bottom: the bar, its resize band outside it.
    for (const py of [y + 0.5, y + h / 2, y + h - 0.5]) {
      expect(hit(router.pick('v', x + w / 2, py)).region).toBe('title-bar');
    }
    expect(hit(router.pick('v', x + w / 2, y + h + 4)).target.edge).toBe('s');
  });

  it('handles a copy of a live window’s card across the seam as its card, not as content', () => {
    // Straddling the seam behind the camera: drawn at both edges, live only at its own place.
    const { ws, router } = world([{ id: 'a', heading: Math.PI - 0.05, distance: 3 }], {
      router: { presentation: () => 'live' },
    });
    const own = cardOf(ws, 'a');
    // The copy lies a whole view to the other side.
    const copyX = own[0] + own[2] / 2 > W / 2 ? own[0] - W : own[0] + W;
    const inCopy = copyX < 0 ? copyX + own[2] - 30 : copyX + 30;
    const [, cy] = contentOf(ws, 'a');
    expect(hit(router.pick('v', inCopy, cy))).toMatchObject({
      region: 'chrome',
      target: { nodeId: 'a' },
    });
  });

  it('picks on the cards as the viewport’s representation policy draws them', () => {
    const placed = [{ id: 'a', heading: 0, distance: 3 }] as const;
    const full = world(placed);
    const [ex, ey] = onCard(full.ws, 'a', [0.9, 0]);
    expect(hit(full.router.pick('v', ex, ey)).target.nodeId).toBe('a');
    // Shown by its label alone, the card is smaller: the same point is past its edge.
    const label = { id: 'test.label/1', representationOf: () => 'label' as const };
    const labelled = world(placed, { router: { representation: () => label } });
    expect(labelled.router.pick('v', ex, ey)).toMatchObject({ kind: 'background' });
    const [cx, cy] = contentOf(labelled.ws, 'a');
    expect(hit(labelled.router.pick('v', cx, cy)).target.nodeId).toBe('a');
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
    const [ex, ey] = onCard(ws, 'a', [0.99, 0]);
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
    const [ex, ey] = onCard(ws, 'a', [0.99, 0]);
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
    // Its press left to c's content, the pointer hovers: its move makes a hit query, to say what a
    // press there would do.
    expect(input.pointer('move', 'v', cx + 1, cy).pick).toEqual({ ambiguous: false, ms: 3 });
    input.pointer('up', 'v', cx + 1, cy);
    // A move of a captured pointer and a command make none.
    const [tx, ty] = titleBar(ws, 'c');
    input.pointer('down', 'v', tx, ty);
    expect(input.pointer('move', 'v', tx + 1, ty).pick).toBeNull();
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
