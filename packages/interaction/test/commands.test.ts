import type { JsonValue, Workspace } from '@swf/core';
import { SwfFailure } from '@swf/core';
import { cameraRotation, headingPitchOf } from '@swf/projections';
import { describe, expect, it } from 'vitest';
import type { InputAdapter, InteractionCommand, InteractionPolicy } from '../src/index.js';
import {
  BUILT_IN_POLICIES,
  createInteractionRouter,
  createSyntheticInput,
  DEFAULT_KEYBOARD_STEPS,
  DEFAULT_SETTINGS,
  defaultKeymap,
  INTERACTION_API_VERSION,
  ROOM_LIMITS,
  roomPlaceOf,
} from '../src/index.js';
import { titleBar, world } from './fixtures.js';

/** Where a window stands in the room, seen from the camera at the centre. */
const placeOf = (ws: Workspace, id: string) => roomPlaceOf(ws.getState(), id, [0, 0, 0]);

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

  it('move a window round the room: in heading, height and along the floor, kept inside it', () => {
    const { ws, input } = world(two, {
      // Where the camera looks does not change where the room's places are.
      extra: [{ type: 'camera.patch', id: 'cam', rotation: cameraRotation(0.7, 0) }],
    });
    const rotation = ws.getState().nodes.get('a')?.transform.rotation;
    input.command('node.move', { nodeId: 'a', viewportId: 'v', heading: 0.3, height: -0.2 });
    expect(placeOf(ws, 'a').heading).toBeCloseTo(0.3, 12);
    expect(placeOf(ws, 'a').height).toBeCloseTo(-0.2, 12);
    expect(placeOf(ws, 'a').floor).toBeCloseTo(3, 12);
    input.command('node.move', { nodeId: 'a', viewportId: 'v', floor: 1 });
    expect(placeOf(ws, 'a').floor).toBeCloseTo(4, 12);
    expect(placeOf(ws, 'a').heading).toBeCloseTo(0.3, 12);
    // Upright as it stood: a move changes only where it stands.
    expect(ws.getState().nodes.get('a')?.transform.rotation).toEqual(rotation);
    // Never nearer than the room's nearest, nor higher than its highest.
    input.command('node.move', { nodeId: 'a', viewportId: 'v', floor: -100, height: 100 });
    expect(placeOf(ws, 'a')).toMatchObject({
      floor: ROOM_LIMITS.nearest,
      height: ROOM_LIMITS.highest,
    });
  });

  it('resize, select, focus, undo and redo without a pointer', () => {
    const { ws, input } = world(two);
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
    input.command('camera.turn', { viewportId: 'v', heading: 0.4 });
    const turned = headingPitchOf(ws.getState().cameras.get('cam')?.rotation ?? [0, 0, 0, 1]);
    expect(turned.heading).toBeCloseTo(0.4, 9);
    // The camera stays level.
    expect(turned.pitch).toBe(0);
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
    expect(input.command('node.move', { viewportId: 'v', heading: 1 }).operation?.outcome).toEqual({
      status: 'unchanged',
      reason: 'no node is named or selected',
    });
    const bad = (command: string, args: JsonValue) => codeOf(() => input.command(command, args));
    expect(bad('node.move', { viewportId: 'v', heading: 'far' })).toMatch(
      /^INVALID_INPUT: .*heading must be a finite number/,
    );
    expect(bad('node.move', { heading: 1, nodeId: 'a' })).toMatch(/viewportId is required/);
    // A window no longer turns on its own, nor does the camera look up or down.
    expect(bad('node.move', { nodeId: 'a', viewportId: 'v', right: 1 })).toMatch(
      /right is not an argument/,
    );
    expect(bad('node.rotate', { nodeId: 'a', yaw: 1 })).toMatch(/no command "node.rotate"/);
    expect(bad('camera.turn', { viewportId: 'v', pitch: 1 })).toMatch(/pitch is not an argument/);
    expect(bad('node.move', { nodeId: 'a', viewportId: 'v', speed: 1 })).toMatch(
      /speed is not an argument/,
    );
    expect(bad('node.move', [])).toMatch(/args must be an object/);
    expect(bad('selection.set', { ids: [1] })).toMatch(/ids must be an array of IDs/);
    expect(bad('node.fly', {})).toMatch(/^INVALID_INPUT: no command "node.fly"/);
    expect(bad('node.move', { nodeId: 'zz', viewportId: 'v' })).toMatch(/^UNKNOWN_ENTITY/);
    expect(bad('camera.turn', { viewportId: 'nope' })).toMatch(/^UNKNOWN_ENTITY/);
    // Arguments are checked even when there is nothing to act on.
    expect(bad('node.move', { viewportId: 'v', floor: 'out' })).toMatch(
      /floor must be a finite number/,
    );
    expect(bad('node.resize', { width: null })).toMatch(/width must be a finite number/);
    expect(bad('orbit.turn', { viewportId: 'v', angle: Infinity })).toMatch(/angle must be/);
  });
});

describe('keyboard (FR-109, UX-012)', () => {
  it('runs bound commands on the selection in the key’s viewport', () => {
    const { ws, input } = world(two);
    input.key('n', { viewportId: 'v' });
    expect(ws.getState().selection).toEqual(['a']);
    const step = DEFAULT_KEYBOARD_STEPS.heading;
    expect(input.key('ArrowRight', { viewportId: 'v' }).operation?.name).toBe('node.move');
    expect(placeOf(ws, 'a').heading).toBeCloseTo(step, 12);
    input.key('ArrowRight', { viewportId: 'v', modifiers: { shift: true }, repeat: true });
    expect(placeOf(ws, 'a').heading).toBeCloseTo(6 * step, 12);
    input.key('ArrowUp', { viewportId: 'v' });
    expect(placeOf(ws, 'a').height).toBeCloseTo(DEFAULT_KEYBOARD_STEPS.height, 12);
    input.key('PageUp', { viewportId: 'v' });
    expect(placeOf(ws, 'a').floor).toBeCloseTo(3 + DEFAULT_KEYBOARD_STEPS.floor, 12);
    input.key('z', { modifiers: { ctrl: true } });
    input.key('z', { modifiers: { ctrl: true } });
    input.key('z', { modifiers: { ctrl: true } });
    expect(placeOf(ws, 'a').heading).toBeCloseTo(step, 12);
    // Shift turns z into Z; letters match either way.
    input.key('Z', { modifiers: { ctrl: true, shift: true } });
    expect(placeOf(ws, 'a').heading).toBeCloseTo(6 * step, 12);
  });

  it('leaves keys in content, releases and unbound keys alone', () => {
    const { ws, input } = world(two);
    input.key('n', { viewportId: 'v' });
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

  it('leaves Tab to the page, so focus can always leave the view (WCAG 2.1.2)', () => {
    const { ws, input } = world(two);
    expect(input.key('Tab', { viewportId: 'v' }).consumed).toBe(false);
    expect(input.key('Tab', { viewportId: 'v', modifiers: { shift: true } }).consumed).toBe(false);
    expect(DEFAULT_SETTINGS.keymap.some((b) => b.key === 'Tab')).toBe(false);
    // N and P step through the windows instead.
    input.key('n', { viewportId: 'v' });
    expect(ws.getState().selection).toEqual(['a']);
    input.key('n', { viewportId: 'v' });
    expect(ws.getState().selection).toEqual(['b']);
    input.key('p', { viewportId: 'v' });
    expect(ws.getState().selection).toEqual(['a']);
  });

  it('takes a bound sign however it is typed: Shift makes + on most layouts', () => {
    const { ws, input } = world(two);
    input.command('selection.set', { ids: ['a'] });
    const width = ws.getState().nodes.get('a')?.bounds[0] ?? 0;
    expect(input.key('+', { viewportId: 'v', modifiers: { shift: true } }).operation?.name).toBe(
      'node.resize',
    );
    expect(ws.getState().nodes.get('a')?.bounds[0]).toBeCloseTo(
      width + DEFAULT_KEYBOARD_STEPS.resize,
      12,
    );
    // A letter is another matter: Shift+N is not N.
    expect(input.key('N', { viewportId: 'v', modifiers: { shift: true } }).consumed).toBe(false);
    // Nor is any other modifier ignored.
    expect(input.key('+', { viewportId: 'v', modifiers: { ctrl: true } }).consumed).toBe(false);
  });

  it('honours the flags a pointer gesture honours', () => {
    const { ws, input } = world(two);
    expect(
      ws.dispatch({
        type: 'node.patch',
        id: 'a',
        flags: { draggable: false, resizable: false },
      }).status,
    ).toBe('committed');
    const before = ws.getState().nodes.get('a');
    expect(
      input.command('node.move', { nodeId: 'a', viewportId: 'v', heading: 1 }).operation?.outcome,
    ).toEqual({ status: 'unchanged', reason: 'node "a" cannot be moved' });
    expect(input.command('node.resize', { nodeId: 'a', width: 1 }).operation?.outcome).toEqual({
      status: 'unchanged',
      reason: 'node "a" cannot be resized',
    });
    expect(ws.getState().nodes.get('a')).toBe(before);
  });
});

describe('holding a window from the keyboard (UX-012, UX-007, FR-112)', () => {
  it('previews every key while held and commits once when put down', () => {
    const { ws, input, events } = world(two);
    input.command('selection.set', { ids: ['a'] });
    const start = ws.getState().nodes.get('a');
    const history = ws.history().length;
    const picked = input.key(' ', { viewportId: 'v' });
    expect(picked).toMatchObject({ consumed: true, operation: { name: 'gesture.grab' } });
    const started = events.find((e) => e.type === 'gesture.started');
    expect(started).toMatchObject({
      operation: 'gesture.grab',
      nodeId: 'a',
      viewportId: 'v',
      pointerIds: [],
    });
    input.key('ArrowRight', { viewportId: 'v' });
    input.key('ArrowUp', { viewportId: 'v' });
    input.key('PageUp', { viewportId: 'v' });
    input.key('+', { viewportId: 'v' });
    // Nothing is committed while it is held; the view shows the preview.
    expect(ws.getState().nodes.get('a')).toBe(start);
    expect(ws.history()).toHaveLength(history);
    const shown = ws.getPresented().nodes.get('a');
    const [sx, sy, sz] = shown?.transform.position ?? [0, 0, 0];
    expect(Math.atan2(sx, -sz)).toBeCloseTo(DEFAULT_KEYBOARD_STEPS.heading, 12);
    expect(sy).toBeCloseTo(DEFAULT_KEYBOARD_STEPS.height, 12);
    expect(Math.hypot(sx, sz)).toBeCloseTo(3 + DEFAULT_KEYBOARD_STEPS.floor, 12);
    expect(shown?.bounds[0]).toBeCloseTo((start?.bounds[0] ?? 0) + DEFAULT_KEYBOARD_STEPS.resize);
    // Enter puts it down: one commit, exactly the previewed placement.
    const dropped = input.key('Enter', { viewportId: 'v' });
    expect(dropped.operation).toMatchObject({
      name: 'gesture.drop',
      outcome: { status: 'committed' },
    });
    expect(ws.history()).toHaveLength(history + 1);
    expect(ws.getState().nodes.get('a')?.transform).toEqual(shown?.transform);
    expect(ws.getState().nodes.get('a')?.bounds).toEqual(shown?.bounds);
    expect(events.at(-1)).toMatchObject({
      type: 'gesture.ended',
      finish: { outcome: 'committed' },
    });
    // One undo puts every step back.
    input.command('history.undo', {});
    expect(ws.getState().nodes.get('a')?.transform).toEqual(start?.transform);
    expect(ws.getState().nodes.get('a')?.bounds).toEqual(start?.bounds);
    // Enter, with nothing held, focuses as it always does.
    expect(input.key('Enter', { viewportId: 'v' }).operation?.name).toBe('focus.selected');
  });

  it('puts down with Space too, and commits nothing when nothing changed', () => {
    const { ws, input, events } = world(two);
    input.command('selection.set', { ids: ['b'] });
    const history = ws.history().length;
    input.key(' ', { viewportId: 'v' });
    expect(input.key(' ', { viewportId: 'v' }).operation).toEqual({
      name: 'gesture.drop',
      outcome: { status: 'unchanged', reason: 'the window was put down where it was' },
    });
    expect(ws.history()).toHaveLength(history);
    expect(events.at(-1)).toMatchObject({
      type: 'gesture.ended',
      finish: { outcome: 'unchanged' },
    });
    expect(input.command('gesture.drop', {}).operation?.outcome).toEqual({
      status: 'unchanged',
      reason: 'no window is held',
    });
  });

  it('cancels with Escape, by command, and when the window goes, leaving nothing behind', () => {
    const { ws, input, events, router } = world(two);
    input.command('selection.set', { ids: ['a'] });
    const start = ws.getState().nodes.get('a');
    input.key(' ', { viewportId: 'v' });
    input.key('ArrowLeft', { viewportId: 'v' });
    expect(input.key('Escape', { viewportId: 'v' }).operation).toEqual({
      name: 'gesture.cancel',
      outcome: { status: 'cancelled', count: 1 },
    });
    expect(events.at(-1)).toMatchObject({
      type: 'gesture.ended',
      finish: { outcome: 'cancelled', reason: 'escape' },
    });
    expect(ws.getPresented().nodes.get('a')).toBe(start);
    expect(ws.getState().nodes.get('a')).toBe(start);

    input.key(' ', { viewportId: 'v' });
    expect(input.command('gesture.cancel', {}).operation?.outcome).toEqual({
      status: 'cancelled',
      count: 1,
    });
    expect(events.at(-1)).toMatchObject({ finish: { outcome: 'cancelled', reason: 'host' } });

    input.key(' ', { viewportId: 'v' });
    input.key('ArrowDown', { viewportId: 'v' });
    expect(ws.dispatch({ type: 'node.delete', id: 'a', mode: 'subtree' }).status).toBe('committed');
    expect(events.at(-1)).toMatchObject({
      finish: { outcome: 'cancelled', reason: 'target-detached' },
    });
    expect(router.captures()).toEqual([]);
    // Arrows move the selection again, at once, once nothing is held.
    input.command('selection.set', { ids: ['b'] });
    input.key('ArrowRight', { viewportId: 'v' });
    expect(placeOf(ws, 'b').heading).toBeCloseTo(1 + DEFAULT_KEYBOARD_STEPS.heading, 12);
  });

  it('refuses a locked window, a second hold, and a pointer on the held window', () => {
    const { ws, input, events } = world(two);
    expect(ws.dispatch({ type: 'node.patch', id: 'a', flags: { locked: true } }).status).toBe(
      'committed',
    );
    input.command('selection.set', { ids: ['a'] });
    expect(input.key(' ', { viewportId: 'v' }).operation?.outcome).toMatchObject({
      status: 'rejected',
      error: { code: 'LOCKED' },
    });
    expect(events.some((e) => e.type === 'gesture.started')).toBe(false);
    expect(input.command('gesture.grab', { viewportId: 'v' }).operation?.outcome).toMatchObject({
      status: 'rejected',
    });

    input.command('selection.set', { ids: ['b'] });
    expect(input.key(' ', { viewportId: 'v' }).operation?.outcome).toMatchObject({
      status: 'previewed',
    });
    expect(
      input.command('gesture.grab', { viewportId: 'v', nodeId: 'a' }).operation?.outcome,
    ).toEqual({ status: 'unchanged', reason: 'window "b" is already held' });
    const [x, y] = titleBar(ws, 'b');
    expect(input.pointer('down', 'v', x, y)).toMatchObject({
      consumed: true,
      reason: 'the target is already in a gesture',
    });
    // Nothing selected, nothing to hold.
    input.key('Escape', { viewportId: 'v' });
    input.command('selection.set', { ids: [] });
    expect(input.key(' ', { viewportId: 'v' }).operation?.outcome).toEqual({
      status: 'unchanged',
      reason: 'no node is named or selected',
    });
  });

  it('moves a named window at once while another is held', () => {
    const { ws, input } = world(two);
    input.command('gesture.grab', { viewportId: 'v', nodeId: 'a' });
    expect(
      input.command('node.move', { nodeId: 'b', viewportId: 'v', height: 0.5 }).operation?.outcome,
    ).toMatchObject({ status: 'committed' });
    expect(placeOf(ws, 'b').height).toBeCloseTo(0.5, 12);
    expect(
      input.command('node.move', { nodeId: 'a', viewportId: 'v', height: 0.5 }).operation?.outcome,
    ).toMatchObject({ status: 'previewed' });
  });
});

describe('settings (FR-004, CFG-001)', () => {
  it('validate every change, naming the field, and keep the previous settings on failure', () => {
    const { router } = world([]);
    const before = router.settings();
    const bad = (patch: Record<string, unknown>) => codeOf(() => router.configure(patch));
    expect(bad({ slopPx: -1 })).toMatch(/^INVALID_INPUT: settings.slopPx/);
    // The windows' handles are sized by the card rules (`WINDOW_HANDLES`), not a setting.
    expect(bad({ handlePx: 12 })).toMatch(/settings.handlePx is not a setting/);
    // A drag moves a window round the room: there is no other way to choose.
    expect(bad({ dragMode: 'world-plane' })).toMatch(/settings.dragMode is not a setting/);
    expect(bad({ takeoverModifier: 'hyper' })).toMatch(/settings.takeoverModifier/);
    // The wheel moves a window by its title bar or its picture, with no modifier to hold.
    expect(bad({ depthModifier: 'shift' })).toMatch(/settings.depthModifier is not a setting/);
    // Steps build a keymap (defaultKeymap); they are not a setting that would change none.
    expect(bad({ steps: { heading: 0.2 } })).toMatch(
      /^INVALID_INPUT: settings.steps is not a setting/,
    );
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

  it('come with a default keymap built from step sizes, each checked by name', () => {
    const coarse = defaultKeymap({ heading: 0.2 });
    const left = (
      keymap: readonly { key: string; modifiers: readonly string[]; args: unknown }[],
    ) => keymap.find((b) => b.key === 'ArrowLeft' && b.modifiers.length === 0)?.args;
    expect(left(coarse)).toEqual({ heading: -0.2 });
    expect(coarse.find((b) => b.key === 'PageUp')?.args).toEqual({
      floor: DEFAULT_KEYBOARD_STEPS.floor,
    });
    expect(left(DEFAULT_SETTINGS.keymap)).toEqual({ heading: -DEFAULT_KEYBOARD_STEPS.heading });
    const refused = (steps: Record<string, unknown>) => codeOf(() => defaultKeymap(steps));
    expect(refused({ heading: 0 })).toMatch(
      /^INVALID_INPUT: steps.heading must be a positive finite number/,
    );
    expect(refused({ move: 0.1 })).toMatch(/^INVALID_INPUT: steps.move is not a step/);
    expect(refused({ turn: Number.NaN })).toMatch(/^INVALID_INPUT: steps.turn/);
    expect(refused({ jump: 1 })).toMatch(/^INVALID_INPUT: steps.jump is not a step/);
    // A keymap built from steps takes effect once configured.
    const { ws, input, router } = world(two);
    router.configure({ keymap: coarse });
    input.key('n', { viewportId: 'v' });
    input.key('ArrowRight', { viewportId: 'v' });
    expect(placeOf(ws, 'a').heading).toBeCloseTo(0.2, 12);
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
      keymap: [{ key: 'm', modifiers: [], command: 'node.move', args: { height: 1 } }],
    });
    const [x, y] = titleBar(ws, 'a');
    input.pointer('down', 'v', x, y);
    // With no slop, the first movement drags.
    expect(input.pointer('move', 'v', x + 1, y).gestureId).not.toBeNull();
    input.pointer('up', 'v', x + 1, y);
    // The keymap given replaces the default one.
    expect(input.key('n', { viewportId: 'v' }).consumed).toBe(false);
    input.command('selection.set', { ids: ['b'] });
    input.key('m', { viewportId: 'v' });
    expect(placeOf(ws, 'b').height).toBeCloseTo(1, 12);
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

  it('leaves a device whose registration failed, or that was disconnected, unable to reach the router', () => {
    const { router } = world([]);
    let runs = 0;
    router.registerCommand({
      id: 'test.count',
      run: () => {
        runs += 1;
        return { status: 'unchanged', reason: 'counted' };
      },
    });
    const intent = {
      kind: 'command',
      command: 'test.count',
      args: {},
      deviceId: 'device',
      timestamp: 0,
    } as const;
    const device = (id: string, disconnect: unknown) => {
      const held: { dispatch: ((i: typeof intent) => unknown) | null } = { dispatch: null };
      const adapter = {
        id,
        apiVersion: INTERACTION_API_VERSION,
        connect: (dispatch: (i: typeof intent) => unknown) => {
          held.dispatch = dispatch;
          // A device may send input while it connects.
          dispatch(intent);
          return disconnect;
        },
      } as unknown as InputAdapter;
      return { adapter, send: () => codeOf(() => held.dispatch?.(intent)) };
    };
    const broken = device('test.broken/1', 'not a function');
    expect(codeOf(() => router.registerInputAdapter(broken.adapter))).toMatch(
      /^INVALID_INPUT: input adapter "test.broken\/1" must return a disconnect function/,
    );
    expect(runs).toBe(1);
    expect(broken.send()).toMatch(
      /^INVALID_TRANSITION: input adapter "test.broken\/1" is not connected/,
    );
    expect(runs).toBe(1);
    // Its ID stays free: the device can connect again, properly this time.
    const fixed = device('test.broken/1', () => undefined);
    const remove = router.registerInputAdapter(fixed.adapter);
    expect(fixed.send()).toBe('accepted');
    expect(runs).toBe(3);
    remove();
    expect(fixed.send()).toMatch(/^INVALID_TRANSITION: input adapter "test.broken\/1" is not/);
    expect(runs).toBe(3);
    // One whose connect throws is not connected either.
    const failing = device('test.failing/1', null);
    const throwing = {
      ...failing.adapter,
      connect: (dispatch: never) => {
        failing.adapter.connect(dispatch);
        throw new Error('no device');
      },
    } as InputAdapter;
    expect(codeOf(() => router.registerInputAdapter(throwing))).toMatch(/no device/);
    expect(failing.send()).toMatch(/^INVALID_TRANSITION: input adapter "test.failing\/1" is not/);
    expect(runs).toBe(4);
  });

  it('refuses a listener once disposed', () => {
    const { router } = world([]);
    router.dispose();
    expect(codeOf(() => router.subscribe(() => undefined))).toMatch(
      /^INVALID_TRANSITION: the interaction router is disposed/,
    );
  });

  it('checks the keymap it is created with against its commands, as configure does', () => {
    const { ws, projections } = world([]);
    const keymap = [{ key: 'x', modifiers: [], command: 'node.fly', args: {} }];
    expect(
      codeOf(() => createInteractionRouter({ workspace: ws, projections, settings: { keymap } })),
    ).toMatch(/^INVALID_INPUT: settings.keymap binds unknown command "node.fly"/);
    const fly: InteractionCommand = {
      id: 'node.fly',
      run: () => ({ status: 'unchanged', reason: 'flown' }),
    };
    const router = createInteractionRouter({
      workspace: ws,
      projections,
      commands: [fly],
      settings: { keymap },
    });
    expect(router.settings().keymap.map((b) => b.command)).toEqual(['node.fly']);
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
