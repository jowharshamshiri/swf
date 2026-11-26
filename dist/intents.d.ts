import type { Id, JsonValue } from '@swf/core';
/** Modifier keys held during an intent. All four are required; no other field is allowed. */
export interface Modifiers {
    /** Shift is held. */
    readonly shift: boolean;
    /** Control is held. */
    readonly ctrl: boolean;
    /** Alt (Option on macOS) is held. */
    readonly alt: boolean;
    /** Meta (Command on macOS, the Windows key elsewhere) is held. */
    readonly meta: boolean;
}
/** One modifier key, by its field in {@link Modifiers}. */
export type ModifierKey = keyof Modifiers;
/** No modifier held; frozen. */
export declare const NO_MODIFIERS: Modifiers;
/** What kind of device produced a pointer. `virtual` is a pointer driven by software. */
export type PointerType = 'mouse' | 'touch' | 'pen' | 'virtual';
/**
 * Where a pointer is in its stroke. `cancel` means the platform took the pointer away (its capture
 * was lost); it ends any gesture the pointer drives without committing it.
 */
export type PointerPhase = 'down' | 'move' | 'up' | 'cancel';
/**
 * A pointer sample in a viewport. Positions are in the viewport's CSS pixels; they may lie outside
 * the viewport while a captured pointer travels beyond it.
 *
 * Every intent is checked as {@link intentIssue} checks it before it is routed: every field listed
 * here is required unless marked optional, and no other field is allowed.
 */
export interface PointerIntent {
    /** Says this is a pointer sample. */
    readonly kind: 'pointer';
    /** The viewport the pointer is over, or was pressed in: a non-blank ID. */
    readonly viewportId: Id;
    /** The input device, stable for as long as it is connected: a non-blank string. */
    readonly deviceId: string;
    /** The pointer, stable from its `down` to its `up` or `cancel`: a non-negative integer. */
    readonly pointerId: number;
    /** The kind of device that produced it. */
    readonly pointerType: PointerType;
    /** Where the pointer is in its stroke. */
    readonly phase: PointerPhase;
    /** Horizontal position in the viewport's CSS pixels, from its left edge: finite. */
    readonly x: number;
    /** Vertical position in the viewport's CSS pixels, from its top edge: finite. */
    readonly y: number;
    /**
     * Pressed buttons as a bit mask (1 primary, 2 secondary, 4 auxiliary): a non-negative integer.
     */
    readonly buttons: number;
    /** The modifier keys held. */
    readonly modifiers: Modifiers;
    /** Milliseconds on the host's monotonic clock: non-negative and finite. */
    readonly timestamp: number;
    /** Normalized pressure in [0, 1], when the device reports it. */
    readonly pressure?: number;
    /** Pen tilt in degrees, each in [-90, 90], when the device reports it. */
    readonly tilt?: {
        /** Tilt in the plane of the x axis, in degrees, as the platform reports it. */
        readonly x: number;
        /** Tilt in the plane of the y axis, in degrees, as the platform reports it. */
        readonly y: number;
    };
    /** Pen rotation about its axis in degrees, in [0, 360), when the device reports it. */
    readonly twist?: number;
}
/**
 * A wheel or trackpad scroll over a viewport point. Every field is required and checked; no other
 * field is allowed.
 */
export interface WheelIntent {
    /** Says this is a scroll. */
    readonly kind: 'wheel';
    /** The viewport scrolled over: a non-blank ID. */
    readonly viewportId: Id;
    /** The input device: a non-blank string. */
    readonly deviceId: string;
    /** Horizontal position in the viewport's CSS pixels, from its left edge: finite. */
    readonly x: number;
    /** Vertical position in the viewport's CSS pixels, from its top edge: finite. */
    readonly y: number;
    /** Horizontal scroll amount in CSS pixels, positive to the right: finite. */
    readonly deltaX: number;
    /** Vertical scroll amount in CSS pixels, positive downwards: finite. */
    readonly deltaY: number;
    /** The modifier keys held. */
    readonly modifiers: Modifiers;
    /** Milliseconds on the host's monotonic clock: non-negative and finite. */
    readonly timestamp: number;
}
/**
 * A key press or release. `focus` says where keyboard focus is: in the workspace's own controls,
 * or in a surface's content, whose keys stay with the content. Every field is required and
 * checked; no other field is allowed.
 */
export interface KeyIntent {
    /** Says this is a key press or release. */
    readonly kind: 'key';
    /**
     * The viewport the key applies to, or null when it applies to none in particular. A key
     * binding's command that acts in a viewport is given this one when its arguments name none.
     */
    readonly viewportId: Id | null;
    /** The input device: a non-blank string. */
    readonly deviceId: string;
    /** Whether the key went down or up; only presses run bindings. */
    readonly phase: 'down' | 'up';
    /**
     * The key's value, as the platform names it (for example `ArrowLeft`, `Escape`, `z`): not
     * empty.
     */
    readonly key: string;
    /** True for a press the platform repeats while the key is held. */
    readonly repeat: boolean;
    /** The modifier keys held. */
    readonly modifiers: Modifiers;
    /**
     * Where keyboard focus is: `workspace` for the workspace's own controls, whose keys run
     * bindings, or `content` for a surface's content, whose keys stay native (except Escape while a
     * gesture runs).
     */
    readonly focus: 'workspace' | 'content';
    /** Milliseconds on the host's monotonic clock: non-negative and finite. */
    readonly timestamp: number;
}
/**
 * A spatial operation requested by name, from a keyboard binding, a control or a program. Every
 * field is required and checked; no other field is allowed.
 */
export interface CommandIntent {
    /** Says this is a command request. */
    readonly kind: 'command';
    /**
     * The command's ID, such as `node.move`: non-blank. A router throws `INVALID_INPUT` for one it
     * does not have.
     */
    readonly command: string;
    /** The command's arguments: a JSON value, checked by the command itself. */
    readonly args: JsonValue;
    /** Where the request came from: a non-blank string. */
    readonly deviceId: string;
    /** Milliseconds on the host's monotonic clock: non-negative and finite. */
    readonly timestamp: number;
}
/** Every input reaches the router as one of these; devices differ only in their adapters. */
export type InputIntent = PointerIntent | WheelIntent | KeyIntent | CommandIntent;
/**
 * Why a value is not a valid intent, naming the field, or null when it is valid. Intents come from
 * adapters that may be plain JavaScript, so nothing is assumed: the kind, then the required and
 * allowed fields, then each field's value are checked, and the first problem is reported.
 */
export declare function intentIssue(value: unknown): string | null;
//# sourceMappingURL=intents.d.ts.map