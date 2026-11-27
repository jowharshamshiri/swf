import type { Id, JsonValue } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type {
  InputIntent,
  KeyIntent,
  Modifiers,
  PointerIntent,
  PointerPhase,
  PointerType,
} from './intents.js';
import { NO_MODIFIERS } from './intents.js';
import { INTERACTION_API_VERSION } from './policies.js';
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
  /**
   * The motion since the previous sample, in CSS pixels, as a locked pointer reports it; absent
   * from the intent when not given.
   */
  readonly movement?: {
    /** Horizontal motion, positive to the right. */
    readonly x: number;
    /** Vertical motion, positive downwards. */
    readonly y: number;
  };
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
  pointer(
    phase: PointerPhase,
    viewportId: Id,
    x: number,
    y: number,
    options?: SyntheticPointerOptions,
  ): DispatchResult;
  /**
   * Sends a scroll of `deltaY` CSS pixels (positive downwards) at `(x, y)` in the viewport's CSS
   * pixels.
   */
  wheel(
    viewportId: Id,
    x: number,
    y: number,
    deltaY: number,
    options?: {
      /** Horizontal scroll in CSS pixels, positive to the right. Default 0. */
      readonly deltaX?: number;
      /** The modifiers held; those left out are not held. */
      readonly modifiers?: Partial<Modifiers>;
    },
  ): DispatchResult;
  /** Sends a key press or release of `key`, as the platform names it (`ArrowLeft`, `z`). */
  key(
    key: string,
    options?: {
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
    },
  ): DispatchResult;
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
export function createSyntheticInput(
  options: { readonly id?: string; readonly deviceId?: string; readonly now?: () => number } = {},
): SyntheticInput {
  let tick = 0;
  const now = options.now ?? (() => (tick += 1));
  const deviceId = options.deviceId ?? 'synthetic';
  let dispatch: ((intent: InputIntent) => DispatchResult) | null = null;
  const send = (intent: InputIntent): DispatchResult => {
    if (dispatch === null) {
      throw new SwfFailure(
        makeError('INVALID_TRANSITION', `synthetic input "${deviceId}" is not connected`),
      );
    }
    return dispatch(intent);
  };
  const modifiers = (partial: Partial<Modifiers> | undefined): Modifiers => ({
    ...NO_MODIFIERS,
    ...partial,
  });
  return {
    id: options.id ?? 'swf.synthetic-input/1',
    apiVersion: INTERACTION_API_VERSION,
    connect(next) {
      if (dispatch !== null) {
        throw new SwfFailure(
          makeError('INVALID_TRANSITION', `synthetic input "${deviceId}" is already connected`),
        );
      }
      dispatch = next;
      return () => {
        dispatch = null;
      };
    },
    pointer(phase, viewportId, x, y, o = {}) {
      const intent: PointerIntent = {
        kind: 'pointer',
        viewportId,
        deviceId,
        pointerId: o.pointerId ?? 1,
        pointerType: o.pointerType ?? 'virtual',
        phase,
        x,
        y,
        buttons: o.buttons ?? (phase === 'down' || phase === 'move' ? 1 : 0),
        modifiers: modifiers(o.modifiers),
        timestamp: now(),
        ...(o.pressure === undefined ? {} : { pressure: o.pressure }),
        ...(o.tilt === undefined ? {} : { tilt: o.tilt }),
        ...(o.twist === undefined ? {} : { twist: o.twist }),
        ...(o.movement === undefined ? {} : { movement: o.movement }),
      };
      return send(intent);
    },
    wheel(viewportId, x, y, deltaY, o = {}) {
      return send({
        kind: 'wheel',
        viewportId,
        deviceId,
        x,
        y,
        deltaX: o.deltaX ?? 0,
        deltaY,
        modifiers: modifiers(o.modifiers),
        timestamp: now(),
      });
    },
    key(key, o = {}) {
      return send({
        kind: 'key',
        viewportId: o.viewportId ?? null,
        deviceId,
        phase: o.phase ?? 'down',
        key,
        repeat: o.repeat ?? false,
        modifiers: modifiers(o.modifiers),
        focus: o.focus ?? 'workspace',
        timestamp: now(),
      });
    },
    command(command, args) {
      return send({ kind: 'command', command, args, deviceId, timestamp: now() });
    },
  };
}
