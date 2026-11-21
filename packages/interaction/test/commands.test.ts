import type { JsonValue } from '@swf/core';
import { SwfFailure } from '@swf/core';
import { length, quatRotate, sub } from '@swf/math';
import { cameraRotation, headingPitchOf } from '@swf/projections';
import { describe, expect, it } from 'vitest';
import type { InputAdapter, InteractionCommand, InteractionPolicy } from '../src/index.js';
import {
  BUILT_IN_POLICIES,
  createSyntheticInput,
  DEFAULT_SETTINGS,
  INTERACTION_API_VERSION,
} from '../src/index.js';
import { titleBar, world } from './fixtures.js';

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return error instanceof SwfFailure
      ? `${error.error.code}: ${error.message}`
      : `not a SwfFailure: ${String(error)}`;
  }
  return 'accepted';
};

const two = [
  { id: 'a', heading: 0, distance: 3 },
  { id: 'b', heading: 1, distance: 3 },
] as const;

describe('command equivalents (FR-109)', () => {
  it('exist for every operation a pointer gesture performs', () => {
    const { router } = world([]);
    const operations = BUILT_IN_POLICIES.flatMap((p) => p.operations);
    expect(operations.length).toBeGreaterThan(0);
    for (const operation of operations) {
      expect(router.commandIds()).toContain(operation);
    }
    // The wheel's depth step is the same command.
    expect(router.commandIds()).toContain('node.move');
  });

  it('refuse a policy whose operation has no command, and keep a used command registered', () => {
    const { router } = world([]);
    const policy: InteractionPolicy = {
      id: 'test.spin/1',
      apiVersion: INTERACTION_API_VERSION,
      priority: 1,
      operations: ['node.spin'],
      claim: () => null,
    };
    expect(codeOf(() => router.registerPolicy(policy))).toMatch(
      /^UNSUPPORTED_CAPABILITY: .*"node.spin".*no command equivalent/,
    );
    const spin: InteractionCommand = {
      id: 'node.spin',
      run: () => ({ status: 'unchanged', reason: 'test' }),
    };
    const removeCommand = router.registerCommand(spin);
    const removePolicy = router.registerPolicy(policy);
    expect(codeOf(removeCommand)).toMatch(/^INVALID_TRANSITION: .*policy "test.spin\/1"/);
    removePolicy();
    expect(codeOf(removeCommand)).toBe('accepted');
    expect(router.commandIds()).not.toContain('node.spin');
  });

  it('move a window along the camera’s axes and in depth along its line of sight', () => {
    const { ws, input } = world(two, {
      extra: [{ type: 'camera.patch', id: 'cam', rotation: cameraRotation(0.7, 0.2) }],
    });
    const before = ws.getState().nodes.get('a')?.transform.position ?? [0, 0, 0];
    const camera = ws.getState().cameras.get('cam')?.rotation ?? [0, 0, 0, 1];
    const right = quatRotate(camera, [1, 0, 0]);
    const up = quatRotate(camera, [0, 1, 0]);
    input.command('node.move', { nodeId: 'a', viewportId: 'v', right: 0.3, up: -0.2 });
    const moved = ws.getState().nodes.get('a')?.transform.position ?? [0, 0, 0];
    const delta = sub(moved, before);
    expect(delta[0]).toBeCloseTo(0.3 * right[0] - 0.2 * up[0], 12);
    expect(delta[1]).toBeCloseTo(0.3 * right[1] - 0.2 * up[1], 12);
    expect(delta[2]).toBeCloseTo(0.3 * right[2] - 0.2 * up[2], 12);
    input.command('node.move', { nodeId: 'a', viewportId: 'v', depth: 1 });
    const farther = ws.getState().nodes.get('a')?.transform.position ?? [0, 0, 0];
    expect(length(farther)).toBeCloseTo(length(moved) + 1, 12);
    // Same direction from the camera.
    expect(
      length(
        sub(
          farther.map((v) => v / length(farther)) as never,
          moved.map((v) => v / length(moved)) as never,
        ),
      ),
    ).toBeLessThan(1e-12);
    // Depth never brings a window nearer than the minimum distance.
    input.command('node.move', { nodeId: 'a', viewportId: 'v', depth: -100 });
    expect(length(ws.getState().nodes.get('a')?.transform.position ?? [0, 0, 0])).toBeCloseTo(
      DEFAULT_SETTINGS.minDistance,
      12,
    );
  });

  it('rotate, resize, select, focus, undo and redo without a pointer', () => {
    const { ws, input } = world(two);
    const position = ws.getState().nodes.get('a')?.transform.position;
    input.command('node.rotate', { nodeId: 'a', yaw: 0.5 });
    expect(
      headingPitchOf(ws.getState().nodes.get('a')?.transform.rotation ?? [0, 0, 0, 1]).heading,
    ).toBeCloseTo(0.5, 12);
    expect(ws.getState().nodes.get('a')?.transform.position).toEqual(position);
    input.command('node.resize', { nodeId: 'a', width: 0.5, height: -10 });
    expect(ws.getState().nodes.get('a')?.bounds).toEqual([2.5, DEFAULT_SETTINGS.minSize, 0.01]);
    expect(input.command('selection.next', {}).operation?.outcome).toMatchObject({
      status: 'committed',
    });
    expect(ws.getState().selection).toEqual(['a']);
    input.command('selection.next', {});
    expect(ws.getState().selection).toEqual(['b']);
    input.command('selection.next', {});
    expect(ws.getState().selection).toEqual(['a']);
    input.command('selection.previous', {});
    expect(ws.getState().selection).toEqual(['b']);
    input.command('focus.selected', {});
    expect(ws.getState().focusedId).toBe('b');
    // Commands act on the selection when no node is named.
    input.command('node.resize', { width: 1 });
    expect(ws.getState().nodes.get('b')?.bounds[0]).toBe(3);
    input.command('history.undo', {});
    expect(ws.getState().nodes.get('b')?.bounds[0]).toBe(2);
    input.command('history.redo', {});
    expect(ws.getState().nodes.get('b')?.bounds[0]).toBe(3);
  });

  it('turn the camera as view state and the orbit root as an undoable change', () => {
    const { ws, input } = world([], {
      extra: [{ type: 'node.create', node: { id: 'root', kind: 'group', bounds: [1, 1, 1] } }],
    });
    const history = ws.history().length;
    input.command('camera.turn', { viewportId: 'v', heading: 0.4, pitch: 3 });
    const turned = headingPitchOf(ws.getState().cameras.get('cam')?.rotation ?? [0, 0, 0, 1]);
    expect(turned.heading).toBeCloseTo(0.4, 9);
    // Pitch stops at straight up.
    expect(turned.pitch).toBeCloseTo(Math.PI / 2, 9);
    expect(ws.history()).toHaveLength(history);
    expect(input.command('orbit.turn', { viewportId: 'v', angle: 0.3 }).operation?.outcome).toEqual(
      {
        status: 'unchanged',
        reason: 'the workspace has no orbit root',
      },
    );
    expect(ws.dispatch({ type: 'orbitRoot.set', nodeId: 'root' }).status).toBe('committed');
    input.command('orbit.turn', { viewportId: 'v', angle: 0.3 });
    expect(
      headingPitchOf(ws.getState().nodes.get('root')?.transform.rotation ?? [0, 0, 0, 1]).heading,
    ).toBeCloseTo(0.3, 12);
    expect(ws.history()).toHaveLength(history + 1);
  });

  it('cancel a running gesture by command', () => {
    const { ws, input, router } = world(two);
    const [x, y] = titleBar(ws, 'a');
    input.pointer('down', 'v', x, y);
    input.pointer('move', 'v', x + 40, y);
    expect(input.command('gesture.cancel', {}).operation?.outcome).toEqual({
      status: 'cancelled',
      count: 1,
    });
    expect(router.captures()).toEqual([]);
  });

  it('report nothing to do without a selection, and name bad arguments', () => {
    const { input } = world(two);
    expect(input.command('node.move', { viewportId: 'v', right: 1 }).operation?.outcome).toEqual({
      status: 'unchanged',
      reason: 'no node is named or selected',
    });
    const bad = (command: string, args: JsonValue) => codeOf(() => input.command(command, args));
    expect(bad('node.move', { viewportId: 'v', right: 'far' })).toMatch(
      /^INVALID_INPUT: .*right must be a finite number/,
    );
    expect(bad('node.move', { right: 1, nodeId: 'a' })).toMatch(/viewportId is required/);
    expect(bad('node.move', { nodeId: 'a', viewportId: 'v', speed: 1 })).toMatch(
      /speed is not an argument/,
    );
    expect(bad('node.move', [])).toMatch(/args must be an object/);
    expect(bad('selection.set', { ids: [1] })).toMatch(/ids must be an array of IDs/);
    expect(bad('node.fly', {})).toMatch(/^INVALID_INPUT: no command "node.fly"/);
    expect(bad('node.move', { nodeId: 'zz', viewportId: 'v' })).toMatch(/^UNKNOWN_ENTITY/);
    expect(bad('camera.turn', { viewportId: 'nope' })).toMatch(/^UNKNOWN_ENTITY/);
    // Arguments are checked even when there is nothing to act on.
    expect(bad('node.rotate', { yaw: 'left' })).toMatch(/yaw must be a finite number/);
    expect(bad('node.resize', { width: null })).toMatch(/width must be a finite number/);
    expect(bad('orbit.turn', { viewportId: 'v', angle: Infinity })).toMatch(/angle must be/);
  });
});

describe('keyboard (FR-109, UX-012)', () => {
  it('runs bound commands on the selection in the key’s viewport', () => {
    const { ws, input } = world(two);
    input.key('Tab', { viewportId: 'v' });
    expect(ws.getState().selection).toEqual(['a']);
    const x = ws.getState().nodes.get('a')?.transform.position[0] ?? 0;
    expect(input.key('ArrowRight', { viewportId: 'v' }).operation?.name).toBe('node.move');
    expect(ws.getState().nodes.get('a')?.transform.position[0]).toBeCloseTo(
      x + DEFAULT_SETTINGS.steps.move,
      12,
    );
    input.key('ArrowRight', { viewportId: 'v', modifiers: { shift: true }, repeat: true });
    expect(ws.getState().nodes.get('a')?.transform.position[0]).toBeCloseTo(
      x + 6 * DEFAULT_SETTINGS.steps.move,
      12,
    );
    input.key('z', { modifiers: { ctrl: true } });
    expect(ws.getState().nodes.get('a')?.transform.position[0]).toBeCloseTo(
      x + DEFAULT_SETTINGS.steps.move,
      12,
    );
    // Shift turns z into Z; letters match either way.
    input.key('Z', { modifiers: { ctrl: true, shift: true } });
    expect(ws.getState().nodes.get('a')?.transform.position[0]).toBeCloseTo(
      x + 6 * DEFAULT_SETTINGS.steps.move,
      12,
    );
  });

  it('leaves keys in content, releases and unbound keys alone', () => {
    const { ws, input } = world(two);
    input.key('Tab', { viewportId: 'v' });
    const before = ws.getState().nodes.get('a')?.transform;
    expect(input.key('ArrowRight', { viewportId: 'v', focus: 'content' })).toMatchObject({
      consumed: false,
      route: 'native',
    });
    expect(input.key('ArrowRight', { viewportId: 'v', phase: 'up' }).consumed).toBe(false);
    expect(input.key('q', { viewportId: 'v' }).consumed).toBe(false);
    // Escape with no gesture running has nothing to cancel.
    expect(input.key('Escape', { viewportId: 'v' }).consumed).toBe(false);
    // A modifier the binding does not list does not match it.
    expect(input.key('ArrowRight', { viewportId: 'v', modifiers: { meta: true } }).consumed).toBe(
      false,
    );
    expect(ws.getState().nodes.get('a')?.transform).toBe(before);
  });

  it('cancels gestures with Escape even from content', () => {
    const { ws, input, router } = world(two);
    const [x, y] = titleBar(ws, 'a');
    input.pointer('down', 'v', x, y);
    input.pointer('move', 'v', x + 40, y);
    expect(input.key('Escape', { focus: 'content' })).toMatchObject({
      consumed: true,
      operation: { name: 'gesture.cancel', outcome: { status: 'cancelled', count: 1 } },
    });
    expect(router.captures()).toEqual([]);
  });
});

describe('settings (FR-004, CFG-001)', () => {
  it('validate every change, naming the field, and keep the previous settings on failure', () => {
    const { router } = world([]);
    const before = router.settings();
    const bad = (patch: Record<string, unknown>) => codeOf(() => router.configure(patch));
    expect(bad({ slopPx: -1 })).toMatch(/^INVALID_INPUT: settings.slopPx/);
    expect(bad({ handlePx: 0 })).toMatch(/settings.handlePx/);
    expect(bad({ dragMode: 'orbit' })).toMatch(/settings.dragMode/);
    expect(bad({ takeoverModifier: 'hyper' })).toMatch(/settings.takeoverModifier/);
    expect(bad({ depthModifier: 'alt' })).toMatch(/settings.depthModifier must differ/);
    expect(bad({ worldPlaneNormal: [0, 0, 0] })).toMatch(/settings.worldPlaneNormal/);
    expect(bad({ steps: { move: 0 } })).toMatch(/settings.steps.move/);
    expect(bad({ steps: { jump: 1 } })).toMatch(/settings.steps.jump is not a step/);
    expect(bad({ colour: 'red' })).toMatch(/settings.colour is not a setting/);
    expect(bad({ keymap: [{ key: 'x', modifiers: [], command: 'node.fly', args: {} }] })).toMatch(
      /unknown command "node.fly"/,
    );
    expect(
      bad({
        keymap: [
          { key: 'x', modifiers: ['ctrl'], command: 'history.undo', args: {} },
          { key: 'X', modifiers: ['ctrl'], command: 'history.redo', args: {} },
        ],
      }),
    ).toMatch(/keymap\[1\] binds x\+ctrl a second time/);
    expect(
      bad({
        keymap: [{ key: 'x', modifiers: ['ctrl', 'ctrl'], command: 'history.undo', args: {} }],
      }),
    ).toMatch(/keymap\[0\].modifiers/);
    expect(
      bad({ keymap: [{ key: 'x', modifiers: [], command: 'history.undo', args: { f: () => 1 } }] }),
    ).toMatch(/args.f must be JSON data/);
    expect(router.settings()).toBe(before);
  });

  it('announce every change, so a host can save them (CFG-003), and only changes that hold', () => {
    const { router } = world([]);
    const heard: unknown[] = [];
    router.subscribe((e) => {
      if (e.type === 'settings.changed') {
        heard.push(e.settings);
      }
    });
    codeOf(() => router.configure({ slopPx: -1 }));
    expect(heard).toEqual([]);
    const next = router.configure({ slopPx: 7 });
    expect(heard).toEqual([next]);
    // They are JSON data: a host stores them as they are.
    expect(JSON.parse(JSON.stringify(next))).toEqual(next);
  });

  it('take effect when valid', () => {
    const { ws, input, router } = world(two);
    router.configure({
      slopPx: 0,
      keymap: [{ key: 'm', modifiers: [], command: 'node.move', args: { right: 1 } }],
    });
    const [x, y] = titleBar(ws, 'a');
    input.pointer('down', 'v', x, y);
    // With no slop, the first movement drags.
    expect(input.pointer('move', 'v', x + 1, y).gestureId).not.toBeNull();
    input.pointer('up', 'v', x + 1, y);
    expect(input.key('Tab').consumed).toBe(false);
    input.command('selection.set', { ids: ['b'] });
    const bx = ws.getState().nodes.get('b')?.transform.position[0] ?? 0;
    input.key('m', { viewportId: 'v' });
    expect(ws.getState().nodes.get('b')?.transform.position[0]).toBeCloseTo(bx + 1, 12);
  });
});

describe('registration (FR-181)', () => {
  it('validates policies', () => {
    const { router } = world([]);
    const policy = (patch: Record<string, unknown>) =>
      ({
        id: 'test.p/1',
        apiVersion: INTERACTION_API_VERSION,
        priority: 1,
        operations: ['node.move'],
        claim: () => null,
        ...patch,
      }) as InteractionPolicy;
    expect(codeOf(() => router.registerPolicy(policy({ id: 'p' })))).toMatch(
      /^INVALID_INPUT: a policy ID/,
    );
    expect(codeOf(() => router.registerPolicy(policy({ apiVersion: 2 })))).toMatch(
      /^UNSUPPORTED_CAPABILITY: .*contract version 2/,
    );
    expect(codeOf(() => router.registerPolicy(policy({ claim: 1 })))).toMatch(/claim\(\)/);
    expect(codeOf(() => router.registerPolicy(policy({ priority: NaN })))).toMatch(
      /finite priority/,
    );
    expect(codeOf(() => router.registerPolicy(policy({ operations: [] })))).toMatch(
      /list its operations/,
    );
    expect(codeOf(() => router.registerPolicy(policy({ id: 'swf.window-move/1' })))).toMatch(
      /already registered/,
    );
    const remove = router.registerPolicy(policy({}));
    expect(router.policyIds()).toContain('test.p/1');
    remove();
    expect(router.policyIds()).not.toContain('test.p/1');
  });

  it('does not take a press no claim can win', () => {
    const { ws, input, router } = world(two, { router: { policies: [] } });
    router.registerPolicy({
      id: 'test.two-only/1',
      apiVersion: INTERACTION_API_VERSION,
      priority: 1,
      operations: ['node.move'],
      // Bids for two pointers whatever is pressed.
      claim: () => ({
        kind: 'drag',
        pointers: 2,
        operation: 'node.move',
        nodeId: null,
        begin: () => {
          throw new Error('never');
        },
      }),
    });
    const [x, y] = titleBar(ws, 'a');
    expect(input.pointer('down', 'v', x, y)).toMatchObject({
      consumed: false,
      reason: 'no policy takes this press',
    });
    expect(router.captures()).toEqual([]);
  });

  it('refuses a claim for an operation the policy did not declare', () => {
    const { ws, input, router } = world(two, { router: { policies: [] } });
    router.registerPolicy({
      id: 'test.liar/1',
      apiVersion: INTERACTION_API_VERSION,
      priority: 1,
      operations: ['node.move'],
      claim: () => ({
        kind: 'drag',
        pointers: 1,
        operation: 'node.resize',
        nodeId: null,
        begin: () => {
          throw new Error('never');
        },
      }),
    });
    const [x, y] = titleBar(ws, 'a');
    expect(codeOf(() => input.pointer('down', 'v', x, y))).toMatch(/does not declare/);
    expect(router.captures()).toEqual([]);
  });

  it('connects and disconnects input adapters, refusing malformed ones', () => {
    const { router } = world([]);
    let connected = 0;
    const adapter = (patch: Record<string, unknown> = {}) =>
      ({
        id: 'test.device/1',
        apiVersion: INTERACTION_API_VERSION,
        connect: () => {
          connected += 1;
          return () => {
            connected -= 1;
          };
        },
        ...patch,
      }) as InputAdapter;
    expect(codeOf(() => router.registerInputAdapter(adapter({ id: 'device' })))).toMatch(
      /^INVALID_INPUT/,
    );
    expect(codeOf(() => router.registerInputAdapter(adapter({ apiVersion: 9 })))).toMatch(
      /^UNSUPPORTED_CAPABILITY/,
    );
    expect(codeOf(() => router.registerInputAdapter(adapter({ connect: () => 1 })))).toMatch(
      /disconnect function/,
    );
    const remove = router.registerInputAdapter(adapter());
    expect(connected).toBe(1);
    expect(codeOf(() => router.registerInputAdapter(adapter()))).toMatch(/already registered/);
    remove();
    remove();
    expect(connected).toBe(0);
    router.registerInputAdapter(adapter());
    router.dispose();
    expect(connected).toBe(0);
    expect(codeOf(() => router.pick('v', 1, 1))).toMatch(
      /^INVALID_TRANSITION: the interaction router is disposed/,
    );
  });

  it('refuses synthetic input that is not connected', () => {
    const loose = createSyntheticInput({ deviceId: 'loose' });
    expect(codeOf(() => loose.key('a'))).toMatch(/^INVALID_TRANSITION: .*not connected/);
  });

  it('validates commands', () => {
    const { router } = world([]);
    expect(
      codeOf(() =>
        router.registerCommand({ id: 'Move', run: () => ({ status: 'unchanged', reason: '' }) }),
      ),
    ).toMatch(/command ID/);
    expect(
      codeOf(() =>
        router.registerCommand({
          id: 'node.move',
          run: () => ({ status: 'unchanged', reason: '' }),
        }),
      ),
    ).toMatch(/already registered/);
    expect(codeOf(() => router.registerCommand({ id: 'node.tap' } as never))).toMatch(/run\(\)/);
  });
});
