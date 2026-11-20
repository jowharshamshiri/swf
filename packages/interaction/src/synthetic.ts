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

export interface SyntheticPointerOptions {
  readonly pointerId?: number;
  readonly pointerType?: PointerType;
  readonly buttons?: number;
  readonly modifiers?: Partial<Modifiers>;
  readonly pressure?: number;
  readonly tilt?: { readonly x: number; readonly y: number };
  readonly twist?: number;
}

/**
 * An input device driven by a program: automation, tests, or a host control that acts like a
 * pointer or a keyboard. It produces the same intents as any other device.
 */
export interface SyntheticInput extends InputAdapter {
  pointer(
    phase: PointerPhase,
    viewportId: Id,
    x: number,
    y: number,
    options?: SyntheticPointerOptions,
  ): DispatchResult;
  wheel(
    viewportId: Id,
    x: number,
    y: number,
    deltaY: number,
    options?: { readonly deltaX?: number; readonly modifiers?: Partial<Modifiers> },
  ): DispatchResult;
  key(
    key: string,
    options?: {
      readonly viewportId?: Id | null;
      readonly phase?: KeyIntent['phase'];
      readonly modifiers?: Partial<Modifiers>;
      readonly focus?: KeyIntent['focus'];
      readonly repeat?: boolean;
    },
  ): DispatchResult;
  command(command: string, args: JsonValue): DispatchResult;
}

/**
 * A synthetic input device. Register it with a router to connect it; timestamps come from `now`
 * (by default a counter, so runs are reproducible).
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
