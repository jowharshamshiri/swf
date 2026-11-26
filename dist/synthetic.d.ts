import type { Id, JsonValue } from '@swf/core';
import type { KeyIntent, Modifiers, PointerPhase, PointerType } from './intents.js';
import type { DispatchResult, InputAdapter } from './router.js';
/**
 * The optional fields of a synthetic pointer sample. Values are passed into the intent as given
 * and checked there, as {@link PointerIntent} states.
 */
export interface SyntheticPointerOptions {
    /** The pointer's ID on the synthetic device. Default 1. */
    readonly pointerId?: number;
    /** The kind of device it stands for. Default `virtual`. */
    readonly pointerType?: PointerType;
    /** Pressed buttons as a bit mask. Default 1 (primary) for `down` and `move`, 0 otherwise. */
    readonly buttons?: number;
    /** The modifiers held; those left out are not held. */
    readonly modifiers?: Partial<Modifiers>;
    /** Normalized pressure in [0, 1]; absent from the intent when not given. */
    readonly pressure?: number;
    /** Pen tilt in degrees, each in [-90, 90]; absent from the intent when not given. */
    readonly tilt?: {
        /** Tilt in the plane of the x axis, in degrees. */
        readonly x: number;
        /** Tilt in the plane of the y axis, in degrees. */
        readonly y: number;
    };
    /** Pen rotation in degrees, in [0, 360); absent from the intent when not given. */
    readonly twist?: number;
}
/**
 * An input device driven by a program: automation, tests, or a host control that acts like a
 * pointer or a keyboard. It produces the same intents as any other device.
 *
 * Each method builds one intent, timestamps it, dispatches it through the router it is connected
 * to and returns the router's answer; it throws what {@link InteractionRouter.dispatch} throws.
 * Calling one while the device is not connected throws {@link SwfFailure}
 * (`INVALID_TRANSITION`). The device connects to one router at a time.
 */
export interface SyntheticInput extends InputAdapter {
    /**
     * Sends a pointer sample at `(x, y)` in the viewport's CSS pixels, from its top-left corner.
     */
    pointer(phase: PointerPhase, viewportId: Id, x: number, y: number, options?: SyntheticPointerOptions): DispatchResult;
    /**
     * Sends a scroll of `deltaY` CSS pixels (positive downwards) at `(x, y)` in the viewport's CSS
     * pixels.
     */
    wheel(viewportId: Id, x: number, y: number, deltaY: number, options?: {
        /** Horizontal scroll in CSS pixels, positive to the right. Default 0. */
        readonly deltaX?: number;
        /** The modifiers held; those left out are not held. */
        readonly modifiers?: Partial<Modifiers>;
    }): DispatchResult;
    /** Sends a key press or release of `key`, as the platform names it (`ArrowLeft`, `z`). */
    key(key: string, options?: {
        /** The viewport the key applies to. Default null. */
        readonly viewportId?: Id | null;
        /** Default `down`. */
        readonly phase?: KeyIntent['phase'];
        /** The modifiers held; those left out are not held. */
        readonly modifiers?: Partial<Modifiers>;
        /** Where keyboard focus is. Default `workspace`. */
        readonly focus?: KeyIntent['focus'];
        /** Whether the press is a platform repeat. Default false. */
        readonly repeat?: boolean;
    }): DispatchResult;
    /** Requests the command `command` with `args`, as a control or a program would. */
    command(command: string, args: JsonValue): DispatchResult;
}
/**
 * A synthetic input device. Register it with a router to connect it; timestamps come from `now`
 * (by default a counter, so runs are reproducible). Unregistering it from the router disconnects
 * it; it can then be registered again.
 *
 * @param options `id` is the adapter's versioned ID (default `swf.synthetic-input/1`), unique
 *   among a router's input adapters; `deviceId` the device every intent names (default
 *   `synthetic`); `now` the clock, in milliseconds, which must return non-negative finite numbers.
 */
export declare function createSyntheticInput(options?: {
    readonly id?: string;
    readonly deviceId?: string;
    readonly now?: () => number;
}): SyntheticInput;
//# sourceMappingURL=synthetic.d.ts.map