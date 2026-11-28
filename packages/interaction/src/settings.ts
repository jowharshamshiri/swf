import type { JsonValue } from '@swf/core';
import { jsonValue, makeError, SwfFailure } from '@swf/core';
import type { ModifierKey } from './intents.js';

/**
 * A key binding: a key with the modifiers it needs, and the command it runs. Bindings run only
 * while keyboard focus is in the workspace's own controls, and only on key down.
 */
export interface KeyBinding {
  /**
   * The key's value as the platform names it (`ArrowLeft`, `z`, `+`), not empty; single
   * characters match case-insensitively, named keys exactly.
   */
  readonly key: string;
  /**
   * Modifiers that must be held, each at most once; any modifier not listed must not be held,
   * except that Shift does not count against a binding of a sign or punctuation character that
   * does not list it (many layouts type `+` with Shift). Kept sorted.
   */
  readonly modifiers: readonly ModifierKey[];
  /** The ID of the command it runs; a router refuses a binding to a command it does not have. */
  readonly command: string;
  /**
   * The command's arguments. A key intent's viewport is added as `viewportId` for commands that
   * take one.
   */
  readonly args: JsonValue;
}

/**
 * Step sizes of keyboard operations, each positive and finite. Distances in world units, angles in
 * radians. They are what {@link defaultKeymap} builds its bindings from: a binding holds the
 * resulting amount, so a router takes other steps as a keymap built from them, configured as
 * `keymap`.
 */
export interface KeyboardSteps {
  /**
   * How far the left and right arrows turn the selected window round the room, in radians; Shift
   * turns it five times as far. Default π/72 (2.5°).
   */
  readonly heading: number;
  /**
   * How far the up and down arrows raise and lower the selected window, in world units; Shift moves
   * it five times as far. Default 0.1.
   */
  readonly height: number;
  /** How far Page Up and Page Down move it along the floor, out and in. Default 0.25. */
  readonly floor: number;
  /** How much `+` and `-` change its width and height. Default 0.05. */
  readonly resize: number;
  /** How far Alt with an arrow key turns the camera, or orbits it with Shift. Default π/36 (5°). */
  readonly turn: number;
}

/** The step sizes {@link defaultKeymap} uses for those it is not given; frozen. */
export const DEFAULT_KEYBOARD_STEPS: KeyboardSteps = Object.freeze({
  heading: Math.PI / 72,
  height: 0.1,
  floor: 0.25,
  resize: 0.05,
  turn: Math.PI / 36,
});

/**
 * Interaction settings. Every field is validated by {@link mergeSettings}; an invalid update
 * changes nothing. Settings objects are frozen.
 */
export interface InteractionSettings {
  /**
   * How far (CSS px) a pressed pointer may move and still be a press; moving farther makes it a
   * drag. Non-negative. Default 4.
   */
  readonly slopPx: number;
  /**
   * Depths closer than this count as a tie when picking, in world units: positive. Default 1e-6.
   */
  readonly depthTolerance: number;
  /**
   * Held during a press on content, it starts a takeover gesture instead of native input. Must
   * differ from `depthModifier`. Default `alt`.
   */
  readonly takeoverModifier: ModifierKey;
  /**
   * Held during a wheel over a window, it moves the window along the room's floor instead of
   * scrolling (`ROOM_PACE`: turning down moves it farther). Must differ from `takeoverModifier`.
   * Default `shift`.
   */
  readonly depthModifier: ModifierKey;
  /** Smallest window width or height a resize may make, in world units: positive. Default 0.05. */
  readonly minSize: number;
  /**
   * The key bindings, each key and modifier combination at most once. A patch replaces the whole
   * keymap; other step sizes come as `defaultKeymap(steps)`. Default: {@link defaultKeymap} with
   * the default steps.
   */
  readonly keymap: readonly KeyBinding[];
}

/**
 * The default keyboard bindings for the given steps: the left and right arrows turn the selected
 * window round the room and the up and down arrows raise and lower it (Shift coarser), Page Up/Down
 * move it out and in along the floor, `+`/`-` resize it, Alt with the left and right arrows turns
 * the camera, N and P select the next and previous window, Enter focuses, Space picks the selected
 * window up, and Ctrl or Cmd with Z/Y undo and redo. Tab is left to the page, so keyboard focus can
 * always leave the view. While a window is held its moves and resizes preview, and Enter or
 * Space puts it down as one change; Escape cancels gestures and holds. Those need no binding.
 * Returns a fresh, unfrozen array of fresh bindings.
 *
 * @param given Step sizes to use; each one left out is {@link DEFAULT_KEYBOARD_STEPS}'. Throws
 *   {@link SwfFailure} (`INVALID_INPUT`) naming the first that is not a step (`steps.<name> is not a
 *   step`) or not a positive finite number.
 */
export function defaultKeymap(given: Partial<KeyboardSteps> = {}): KeyBinding[] {
  const steps = stepsOf(given);
  const b = (
    key: string,
    modifiers: ModifierKey[],
    command: string,
    args: JsonValue,
  ): KeyBinding => ({ key, modifiers, command, args });
  const moves: KeyBinding[] = [];
  for (const [modifiers, factor] of [
    [[], 1],
    [['shift'], 5],
  ] as const) {
    const turn = steps.heading * factor;
    const rise = steps.height * factor;
    moves.push(
      b('ArrowLeft', [...modifiers], 'node.move', { heading: -turn }),
      b('ArrowRight', [...modifiers], 'node.move', { heading: turn }),
      b('ArrowUp', [...modifiers], 'node.move', { height: rise }),
      b('ArrowDown', [...modifiers], 'node.move', { height: -rise }),
    );
  }
  return [
    ...moves,
    b('PageUp', [], 'node.move', { floor: steps.floor }),
    b('PageDown', [], 'node.move', { floor: -steps.floor }),
    b('+', [], 'node.resize', { width: steps.resize, height: steps.resize }),
    b('=', [], 'node.resize', { width: steps.resize, height: steps.resize }),
    b('-', [], 'node.resize', { width: -steps.resize, height: -steps.resize }),
    b('ArrowLeft', ['alt'], 'camera.turn', { heading: -steps.turn }),
    b('ArrowRight', ['alt'], 'camera.turn', { heading: steps.turn }),
    b('ArrowLeft', ['alt', 'shift'], 'orbit.turn', { angle: steps.turn }),
    b('ArrowRight', ['alt', 'shift'], 'orbit.turn', { angle: -steps.turn }),
    b('n', [], 'selection.next', {}),
    b('p', [], 'selection.previous', {}),
    b('Enter', [], 'focus.selected', {}),
    b(' ', [], 'gesture.grab', {}),
    b('z', ['ctrl'], 'history.undo', {}),
    b('z', ['meta'], 'history.undo', {}),
    b('z', ['ctrl', 'shift'], 'history.redo', {}),
    b('z', ['meta', 'shift'], 'history.redo', {}),
    b('y', ['ctrl'], 'history.redo', {}),
  ];
}

/**
 * The settings a router starts from: each field's default as {@link InteractionSettings} states
 * it. Frozen.
 */
export const DEFAULT_SETTINGS: InteractionSettings = Object.freeze({
  slopPx: 4,
  depthTolerance: 1e-6,
  takeoverModifier: 'alt',
  depthModifier: 'shift',
  minSize: 0.05,
  keymap: Object.freeze(defaultKeymap()),
});

const MODIFIER_KEYS: readonly string[] = ['shift', 'ctrl', 'alt', 'meta'];

/**
 * `current` with `patch` applied, validated. Throws {@link SwfFailure} (`INVALID_INPUT`) naming
 * the first invalid field as the path `settings.<field>` (such as `settings.keymap[2].modifiers`);
 * `current` is never changed. An unknown field is rejected. The result is a fresh frozen settings
 * object; the fields the patch leaves out are shared with `current`. Key bindings are checked for
 * their shape only, not for whether their commands exist.
 */
export function mergeSettings(current: InteractionSettings, patch: unknown): InteractionSettings {
  const fail = (path: string, message: string): never => {
    throw new SwfFailure(
      makeError('INVALID_INPUT', `settings.${path} ${message}`, { path: `settings.${path}` }),
    );
  };
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return fail('', 'must be an object');
  }
  const p = patch as Record<string, unknown>;
  const unknown = Object.keys(p).find((k) => !(k in DEFAULT_SETTINGS));
  if (unknown !== undefined) {
    fail(unknown, 'is not a setting');
  }
  const positive = (key: string, value: unknown, allowZero = false): number => {
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < 0 ||
      (!allowZero && value === 0)
    ) {
      fail(key, `must be a ${allowZero ? 'non-negative' : 'positive'} finite number`);
    }
    return value as number;
  };
  const modifier = (key: string, value: unknown): ModifierKey => {
    if (typeof value !== 'string' || !MODIFIER_KEYS.includes(value)) {
      fail(key, `must be one of ${MODIFIER_KEYS.join(', ')}`);
    }
    return value as ModifierKey;
  };
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(p)) {
    switch (key) {
      case 'slopPx':
        next[key] = positive(key, value, true);
        break;
      case 'depthTolerance':
      case 'minSize':
        next[key] = positive(key, value);
        break;
      case 'takeoverModifier':
      case 'depthModifier':
        next[key] = modifier(key, value);
        break;
      case 'keymap':
        next[key] = keymapOf(value, fail);
        break;
    }
  }
  if ((next['takeoverModifier'] as string) === (next['depthModifier'] as string)) {
    fail('depthModifier', 'must differ from takeoverModifier');
  }
  return Object.freeze(next) as unknown as InteractionSettings;
}

/** The default steps with `given` applied, each checked. */
function stepsOf(given: unknown): KeyboardSteps {
  const fail = (path: string, message: string): never => {
    throw new SwfFailure(makeError('INVALID_INPUT', `${path} ${message}`, { path }));
  };
  if (typeof given !== 'object' || given === null || Array.isArray(given)) {
    return fail('steps', 'must be an object');
  }
  const steps: Record<string, number> = { ...DEFAULT_KEYBOARD_STEPS };
  for (const [name, step] of Object.entries(given)) {
    if (!(name in DEFAULT_KEYBOARD_STEPS)) {
      fail(`steps.${name}`, 'is not a step');
    }
    if (typeof step !== 'number' || !Number.isFinite(step) || step <= 0) {
      fail(`steps.${name}`, 'must be a positive finite number');
    }
    steps[name] = step as number;
  }
  return steps as unknown as KeyboardSteps;
}

function keymapOf(value: unknown, fail: (path: string, message: string) => never): KeyBinding[] {
  if (!Array.isArray(value)) {
    return fail('keymap', 'must be an array of bindings');
  }
  const seen = new Set<string>();
  return Object.freeze(
    value.map((raw: unknown, i): KeyBinding => {
      const path = `keymap[${String(i)}]`;
      if (typeof raw !== 'object' || raw === null) {
        return fail(path, 'must be an object { key, modifiers, command, args }');
      }
      const r = raw as Record<string, unknown>;
      const extra = Object.keys(r).find(
        (k) => !['key', 'modifiers', 'command', 'args'].includes(k),
      );
      if (extra !== undefined) {
        fail(`${path}.${extra}`, 'is not a field of a binding');
      }
      if (typeof r['key'] !== 'string' || r['key'] === '') {
        fail(`${path}.key`, 'must be a non-empty string');
      }
      const modifiers = r['modifiers'];
      if (
        !Array.isArray(modifiers) ||
        !modifiers.every((m) => typeof m === 'string' && MODIFIER_KEYS.includes(m)) ||
        new Set(modifiers).size !== modifiers.length
      ) {
        fail(`${path}.modifiers`, `must list distinct modifiers among ${MODIFIER_KEYS.join(', ')}`);
      }
      if (typeof r['command'] !== 'string' || r['command'].trim() === '') {
        fail(`${path}.command`, 'must be a non-blank string');
      }
      if (!('args' in r)) {
        fail(`${path}.args`, 'is required');
      }
      const binding: KeyBinding = Object.freeze({
        key: r['key'],
        modifiers: Object.freeze([...(modifiers as ModifierKey[])].sort()),
        command: r['command'],
        args: jsonValue(r['args'], `settings.${path}.args`),
      });
      const signature = `${keyName(binding.key)}+${binding.modifiers.join('+')}`;
      if (seen.has(signature)) {
        fail(path, `binds ${signature} a second time`);
      }
      seen.add(signature);
      return binding;
    }),
  ) as KeyBinding[];
}

/** Single characters match regardless of case; named keys exactly. */
export function keyName(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}
