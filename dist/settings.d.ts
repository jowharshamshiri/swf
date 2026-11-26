import type { JsonValue } from '@swf/core';
import type { Vec3 } from '@swf/math';
import type { DragMode } from './drag.js';
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
     * How far an arrow key moves the selected window; Shift moves it five times as far. Default
     * 0.05.
     */
    readonly move: number;
    /** How far Page Up and Page Down change its depth. Default 0.1. */
    readonly depth: number;
    /** How much `+` and `-` change its width and height. Default 0.05. */
    readonly resize: number;
    /** How far `[` and `]` turn it about the world vertical through its origin. Default π/36 (5°). */
    readonly rotate: number;
    /** How far Alt with an arrow key turns the camera, or orbits it with Shift. Default π/36 (5°). */
    readonly turn: number;
}
/** The step sizes {@link defaultKeymap} uses for those it is not given; frozen. */
export declare const DEFAULT_KEYBOARD_STEPS: KeyboardSteps;
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
    /** Width of the resize band along window edges, in CSS px: positive. Default 12. */
    readonly handlePx: number;
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
     * Held during a wheel over a window, it adjusts the window's depth instead of scrolling. Must
     * differ from `takeoverModifier`. Default `shift`.
     */
    readonly depthModifier: ModifierKey;
    /** How window drags map pointer movement to the world. Default `camera-plane`. */
    readonly dragMode: DragMode;
    /**
     * The plane normal for `world-plane` drags: finite and non-zero, any length. Default +Y (the
     * floor).
     */
    readonly worldPlaneNormal: Vec3;
    /**
     * Depth change per CSS px of wheel scroll, in world units: positive. Scrolling up (negative
     * `deltaY`) moves the window away from the camera, scrolling down brings it nearer. Default
     * 0.002.
     */
    readonly wheelDepthPerPixel: number;
    /**
     * Nearest distance from the camera a drag may bring a window to, in world units: positive.
     * Default 0.1.
     */
    readonly minDistance: number;
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
export declare function defaultKeymap(given?: Partial<KeyboardSteps>): KeyBinding[];
/**
 * The settings a router starts from: each field's default as {@link InteractionSettings} states
 * it. Frozen.
 */
export declare const DEFAULT_SETTINGS: InteractionSettings;
/**
 * `current` with `patch` applied, validated. Throws {@link SwfFailure} (`INVALID_INPUT`) naming
 * the first invalid field as the path `settings.<field>` (such as `settings.keymap[2].modifiers`);
 * `current` is never changed. An unknown field is rejected. The result is a fresh frozen settings
 * object; the fields the patch leaves out are shared with `current`. Key bindings are checked for
 * their shape only, not for whether their commands exist.
 */
export declare function mergeSettings(current: InteractionSettings, patch: unknown): InteractionSettings;
/** Single characters match regardless of case; named keys exactly. */
export declare function keyName(key: string): string;
//# sourceMappingURL=settings.d.ts.map