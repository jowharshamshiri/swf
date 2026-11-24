import type { JsonValue } from '@swf/core';
import { jsonValue, makeError, SwfFailure } from '@swf/core';
import type { Vec3 } from '@swf/math';
import type { DragMode } from './drag.js';
import { DRAG_MODES } from './drag.js';
import type { ModifierKey } from './intents.js';

/** A key binding: a key with the modifiers it needs, and the command it runs. */
export interface KeyBinding {
  /** The key's value, matched case-insensitively for single characters. */
  readonly key: string;
  /** Modifiers that must be held; any modifier not listed must not be held. */
  readonly modifiers: readonly ModifierKey[];
  readonly command: string;
  /**
   * The command's arguments. A key intent's viewport is added as `viewportId` for commands that
   * take one.
   */
  readonly args: JsonValue;
}

/** Step sizes of keyboard operations. Distances in world units, angles in radians. */
export interface KeyboardSteps {
  readonly move: number;
  readonly depth: number;
  readonly resize: number;
  readonly rotate: number;
  readonly turn: number;
}

/** Interaction settings. Every field is validated; an invalid update changes nothing. */
export interface InteractionSettings {
  /** How far (CSS px) a pointer moves before a press becomes a drag. Default 4. */
  readonly slopPx: number;
  /** Width of the resize band along window edges, in CSS px. Default 12. */
  readonly handlePx: number;
  /** Depths closer than this count as a tie when picking, in world units. Default 1e-6. */
  readonly depthTolerance: number;
  /** Held during a press on content, it starts a takeover gesture instead of native input. */
  readonly takeoverModifier: ModifierKey;
  /** Held during a wheel over a window, it adjusts the window's depth instead of scrolling. */
  readonly depthModifier: ModifierKey;
  /** How window drags map pointer movement to the world. Default `camera-plane`. */
  readonly dragMode: DragMode;
  /** The plane normal for `world-plane` drags. Default +Y (the floor). */
  readonly worldPlaneNormal: Vec3;
  /** Depth change per CSS px of wheel scroll, in world units. Default 0.002. */
  readonly wheelDepthPerPixel: number;
  /** Nearest distance from the camera a drag may bring a window to. Default 0.1. */
  readonly minDistance: number;
  /** Smallest window width or height a resize may make, in world units. Default 0.05. */
  readonly minSize: number;
  readonly steps: KeyboardSteps;
  readonly keymap: readonly KeyBinding[];
}

const DEFAULT_STEPS: KeyboardSteps = Object.freeze({
  move: 0.05,
  depth: 0.1,
  resize: 0.05,
  rotate: Math.PI / 36,
  turn: Math.PI / 36,
});

/**
 * The default keyboard bindings for the given steps: arrows move the selected window (Shift
 * coarser), Page Up/Down change its depth, `[`/`]` rotate it, `+`/`-` resize it, Alt+arrows turn
 * the camera, N and P select the next and previous window, Enter focuses, Space picks the selected
 * window up, and Ctrl or Cmd with Z/Y undo and redo. Tab is left to the page, so keyboard focus can
 * always leave the view. While a window is held its moves, turns and resizes preview, and Enter or
 * Space puts it down as one change; Escape cancels gestures and holds. Those need no binding.
 */
export function defaultKeymap(steps: KeyboardSteps = DEFAULT_STEPS): KeyBinding[] {
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
    const m = steps.move * factor;
    moves.push(
      b('ArrowLeft', [...modifiers], 'node.move', { right: -m }),
      b('ArrowRight', [...modifiers], 'node.move', { right: m }),
      b('ArrowUp', [...modifiers], 'node.move', { up: m }),
      b('ArrowDown', [...modifiers], 'node.move', { up: -m }),
    );
  }
  return [
    ...moves,
    b('PageUp', [], 'node.move', { depth: steps.depth }),
    b('PageDown', [], 'node.move', { depth: -steps.depth }),
    b('[', [], 'node.rotate', { yaw: -steps.rotate }),
    b(']', [], 'node.rotate', { yaw: steps.rotate }),
    b('+', [], 'node.resize', { width: steps.resize, height: steps.resize }),
    b('=', [], 'node.resize', { width: steps.resize, height: steps.resize }),
    b('-', [], 'node.resize', { width: -steps.resize, height: -steps.resize }),
    b('ArrowLeft', ['alt'], 'camera.turn', { heading: -steps.turn }),
    b('ArrowRight', ['alt'], 'camera.turn', { heading: steps.turn }),
    b('ArrowUp', ['alt'], 'camera.turn', { pitch: steps.turn }),
    b('ArrowDown', ['alt'], 'camera.turn', { pitch: -steps.turn }),
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

export const DEFAULT_SETTINGS: InteractionSettings = Object.freeze({
  slopPx: 4,
  handlePx: 12,
  depthTolerance: 1e-6,
  takeoverModifier: 'alt',
  depthModifier: 'shift',
  dragMode: 'camera-plane',
  worldPlaneNormal: Object.freeze([0, 1, 0] as const),
  wheelDepthPerPixel: 0.002,
  minDistance: 0.1,
  minSize: 0.05,
  steps: DEFAULT_STEPS,
  keymap: Object.freeze(defaultKeymap()),
});

const MODIFIER_KEYS: readonly string[] = ['shift', 'ctrl', 'alt', 'meta'];

/**
 * `current` with `patch` applied, validated. Throws {@link SwfFailure} (`INVALID_INPUT`) naming
 * the first invalid field; `current` is never changed.
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
      case 'handlePx':
      case 'wheelDepthPerPixel':
        next[key] = positive(key, value, key === 'slopPx');
        break;
      case 'depthTolerance':
      case 'minDistance':
      case 'minSize':
        next[key] = positive(key, value);
        break;
      case 'takeoverModifier':
      case 'depthModifier':
        next[key] = modifier(key, value);
        break;
      case 'dragMode':
        if (!DRAG_MODES.includes(value as DragMode)) {
          fail(key, `must be one of ${DRAG_MODES.join(', ')}`);
        }
        next[key] = value;
        break;
      case 'worldPlaneNormal': {
        const v = value as unknown[];
        if (
          !Array.isArray(v) ||
          v.length !== 3 ||
          !v.every((c) => typeof c === 'number' && Number.isFinite(c)) ||
          Math.hypot(...(v as number[])) === 0
        ) {
          fail(key, 'must be a finite non-zero vector [x, y, z]');
        }
        next[key] = Object.freeze([...(v as number[])]);
        break;
      }
      case 'steps': {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
          fail(key, 'must be an object');
        }
        const steps = value as Record<string, unknown>;
        const extra = Object.keys(steps).find((k) => !(k in DEFAULT_STEPS));
        if (extra !== undefined) {
          fail(`steps.${extra}`, 'is not a step');
        }
        const merged: Record<string, number> = { ...current.steps };
        for (const [name, step] of Object.entries(steps)) {
          merged[name] = positive(`steps.${name}`, step);
        }
        next[key] = Object.freeze(merged);
        break;
      }
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
