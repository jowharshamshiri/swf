import { jsonValue, makeError, SwfFailure } from '@swf/core';
import { DRAG_MODES } from './drag.js';
/** The step sizes {@link defaultKeymap} uses for those it is not given; frozen. */
export const DEFAULT_KEYBOARD_STEPS = Object.freeze({
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
 * Returns a fresh, unfrozen array of fresh bindings.
 *
 * @param given Step sizes to use; each one left out is {@link DEFAULT_KEYBOARD_STEPS}'. Throws
 *   {@link SwfFailure} (`INVALID_INPUT`) naming the first that is not a step (`steps.<name> is not a
 *   step`) or not a positive finite number.
 */
export function defaultKeymap(given = {}) {
    const steps = stepsOf(given);
    const b = (key, modifiers, command, args) => ({ key, modifiers, command, args });
    const moves = [];
    for (const [modifiers, factor] of [
        [[], 1],
        [['shift'], 5],
    ]) {
        const m = steps.move * factor;
        moves.push(b('ArrowLeft', [...modifiers], 'node.move', { right: -m }), b('ArrowRight', [...modifiers], 'node.move', { right: m }), b('ArrowUp', [...modifiers], 'node.move', { up: m }), b('ArrowDown', [...modifiers], 'node.move', { up: -m }));
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
/**
 * The settings a router starts from: each field's default as {@link InteractionSettings} states
 * it. Frozen.
 */
export const DEFAULT_SETTINGS = Object.freeze({
    slopPx: 4,
    handlePx: 12,
    depthTolerance: 1e-6,
    takeoverModifier: 'alt',
    depthModifier: 'shift',
    dragMode: 'camera-plane',
    worldPlaneNormal: Object.freeze([0, 1, 0]),
    wheelDepthPerPixel: 0.002,
    minDistance: 0.1,
    minSize: 0.05,
    keymap: Object.freeze(defaultKeymap()),
});
const MODIFIER_KEYS = ['shift', 'ctrl', 'alt', 'meta'];
/**
 * `current` with `patch` applied, validated. Throws {@link SwfFailure} (`INVALID_INPUT`) naming
 * the first invalid field as the path `settings.<field>` (such as `settings.keymap[2].modifiers`);
 * `current` is never changed. An unknown field is rejected. The result is a fresh frozen settings
 * object; the fields the patch leaves out are shared with `current`. Key bindings are checked for
 * their shape only, not for whether their commands exist.
 */
export function mergeSettings(current, patch) {
    const fail = (path, message) => {
        throw new SwfFailure(makeError('INVALID_INPUT', `settings.${path} ${message}`, { path: `settings.${path}` }));
    };
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
        return fail('', 'must be an object');
    }
    const p = patch;
    const unknown = Object.keys(p).find((k) => !(k in DEFAULT_SETTINGS));
    if (unknown !== undefined) {
        fail(unknown, 'is not a setting');
    }
    const positive = (key, value, allowZero = false) => {
        if (typeof value !== 'number' ||
            !Number.isFinite(value) ||
            value < 0 ||
            (!allowZero && value === 0)) {
            fail(key, `must be a ${allowZero ? 'non-negative' : 'positive'} finite number`);
        }
        return value;
    };
    const modifier = (key, value) => {
        if (typeof value !== 'string' || !MODIFIER_KEYS.includes(value)) {
            fail(key, `must be one of ${MODIFIER_KEYS.join(', ')}`);
        }
        return value;
    };
    const next = { ...current };
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
                if (!DRAG_MODES.includes(value)) {
                    fail(key, `must be one of ${DRAG_MODES.join(', ')}`);
                }
                next[key] = value;
                break;
            case 'worldPlaneNormal': {
                const v = value;
                if (!Array.isArray(v) ||
                    v.length !== 3 ||
                    !v.every((c) => typeof c === 'number' && Number.isFinite(c)) ||
                    Math.hypot(...v) === 0) {
                    fail(key, 'must be a finite non-zero vector [x, y, z]');
                }
                next[key] = Object.freeze([...v]);
                break;
            }
            case 'keymap':
                next[key] = keymapOf(value, fail);
                break;
        }
    }
    if (next['takeoverModifier'] === next['depthModifier']) {
        fail('depthModifier', 'must differ from takeoverModifier');
    }
    return Object.freeze(next);
}
/** The default steps with `given` applied, each checked. */
function stepsOf(given) {
    const fail = (path, message) => {
        throw new SwfFailure(makeError('INVALID_INPUT', `${path} ${message}`, { path }));
    };
    if (typeof given !== 'object' || given === null || Array.isArray(given)) {
        return fail('steps', 'must be an object');
    }
    const steps = { ...DEFAULT_KEYBOARD_STEPS };
    for (const [name, step] of Object.entries(given)) {
        if (!(name in DEFAULT_KEYBOARD_STEPS)) {
            fail(`steps.${name}`, 'is not a step');
        }
        if (typeof step !== 'number' || !Number.isFinite(step) || step <= 0) {
            fail(`steps.${name}`, 'must be a positive finite number');
        }
        steps[name] = step;
    }
    return steps;
}
function keymapOf(value, fail) {
    if (!Array.isArray(value)) {
        return fail('keymap', 'must be an array of bindings');
    }
    const seen = new Set();
    return Object.freeze(value.map((raw, i) => {
        const path = `keymap[${String(i)}]`;
        if (typeof raw !== 'object' || raw === null) {
            return fail(path, 'must be an object { key, modifiers, command, args }');
        }
        const r = raw;
        const extra = Object.keys(r).find((k) => !['key', 'modifiers', 'command', 'args'].includes(k));
        if (extra !== undefined) {
            fail(`${path}.${extra}`, 'is not a field of a binding');
        }
        if (typeof r['key'] !== 'string' || r['key'] === '') {
            fail(`${path}.key`, 'must be a non-empty string');
        }
        const modifiers = r['modifiers'];
        if (!Array.isArray(modifiers) ||
            !modifiers.every((m) => typeof m === 'string' && MODIFIER_KEYS.includes(m)) ||
            new Set(modifiers).size !== modifiers.length) {
            fail(`${path}.modifiers`, `must list distinct modifiers among ${MODIFIER_KEYS.join(', ')}`);
        }
        if (typeof r['command'] !== 'string' || r['command'].trim() === '') {
            fail(`${path}.command`, 'must be a non-blank string');
        }
        if (!('args' in r)) {
            fail(`${path}.args`, 'is required');
        }
        const binding = Object.freeze({
            key: r['key'],
            modifiers: Object.freeze([...modifiers].sort()),
            command: r['command'],
            args: jsonValue(r['args'], `settings.${path}.args`),
        });
        const signature = `${keyName(binding.key)}+${binding.modifiers.join('+')}`;
        if (seen.has(signature)) {
            fail(path, `binds ${signature} a second time`);
        }
        seen.add(signature);
        return binding;
    }));
}
/** Single characters match regardless of case; named keys exactly. */
export function keyName(key) {
    return key.length === 1 ? key.toLowerCase() : key;
}
//# sourceMappingURL=settings.js.map