import type { DispatchResult, InputAdapter, InputIntent, PointerIntent } from '@swf/interaction';
import { INTERACTION_API_VERSION } from '@swf/interaction';

/**
 * The wrapped cursor: an input policy, on its own between the device and the framework. In a
 * panorama that shows the whole circle, the view's left and right edges are the same place, the
 * seam behind the camera. A pointer the framework took (a window being moved, the view being
 * turned) that is carried past one edge comes back in at the other: what the framework is told is
 * the wrapped place, and a virtual cursor shows it, since the platform's own pointer cannot be
 * moved by a page and stays where it is (stopping at the screen's edge). Pointers the framework did
 * not take, and every pointer while the view does not show the whole circle, pass unchanged; the
 * policy can be turned on and off without touching ordinary pointer input.
 *
 * The state is plain data with explicit transitions; nothing here touches the page.
 */

/** The pointers the framework took, by device and pointer: the ones that wrap. */
export interface WrapState {
  readonly taken: ReadonlySet<string>;
}

export const NO_POINTERS: WrapState = Object.freeze({ taken: Object.freeze(new Set<string>()) });

/** What the view allows: its width in CSS pixels, and whether its edges meet at a seam. */
export interface WrapFrame {
  readonly width: number;
  /** The view shows the whole circle with its seam at the edges (full 360°, seam wrapping). */
  readonly wraps: boolean;
}

/** The intent to pass on, and where to draw the virtual cursor (null: draw none). */
export interface Wrapped {
  readonly intent: PointerIntent;
  readonly cursor: { readonly x: number; readonly y: number } | null;
}

const keyOf = (p: PointerIntent) => `${p.deviceId}\u0000${String(p.pointerId)}`;

/** A pointer sample, wrapped across the seam when the framework took the pointer and the view wraps. */
export function wrapPointer(state: WrapState, intent: PointerIntent, frame: WrapFrame): Wrapped {
  if (!(frame.width > 0) || !Number.isFinite(frame.width)) {
    throw new RangeError(`a view's width is finite and above zero (got ${String(frame.width)})`);
  }
  if (!frame.wraps || intent.phase === 'down' || !state.taken.has(keyOf(intent))) {
    return { intent, cursor: null };
  }
  const x = intent.x - frame.width * Math.floor(intent.x / frame.width);
  if (x === intent.x) {
    return { intent, cursor: null };
  }
  const wrapped: PointerIntent = Object.freeze({ ...intent, x });
  // The cursor is drawn while the pointer is held; a release or cancellation ends it.
  return {
    intent: wrapped,
    cursor: intent.phase === 'move' ? Object.freeze({ x, y: intent.y }) : null,
  };
}

/** The state once the framework answered a pointer sample. */
export function afterDispatch(
  state: WrapState,
  intent: PointerIntent,
  result: DispatchResult,
): WrapState {
  const key = keyOf(intent);
  if (intent.phase === 'down') {
    if (!result.consumed || state.taken.has(key)) {
      return state;
    }
    return Object.freeze({ taken: Object.freeze(new Set([...state.taken, key])) });
  }
  if ((intent.phase === 'up' || intent.phase === 'cancel') && state.taken.has(key)) {
    const taken = new Set(state.taken);
    taken.delete(key);
    return Object.freeze({ taken: Object.freeze(taken) });
  }
  return state;
}

export interface WrappedInputOptions {
  /** The device's own adapter. */
  readonly device: InputAdapter;
  /** Whether the policy is on now: read at every sample. */
  readonly enabled: () => boolean;
  /** The view now. */
  readonly frame: () => WrapFrame;
  /** Draws the virtual cursor at a point of the view, or takes it away. */
  readonly cursor: (at: { readonly x: number; readonly y: number } | null) => void;
}

/**
 * A device's adapter with the wrapped cursor between it and the framework. Off, it passes every
 * intent through untouched.
 */
export function wrappedInput(options: WrappedInputOptions): InputAdapter {
  const { device } = options;
  return Object.freeze({
    id: 'reference.wrapped-cursor/1',
    apiVersion: INTERACTION_API_VERSION,
    connect(dispatch: (intent: InputIntent) => DispatchResult): () => void {
      let state = NO_POINTERS;
      let drawn = false;
      const draw = (at: { readonly x: number; readonly y: number } | null) => {
        if (at !== null || drawn) {
          options.cursor(at);
        }
        drawn = at !== null;
      };
      const disconnect = device.connect((intent) => {
        if (intent.kind !== 'pointer') {
          return dispatch(intent);
        }
        const wrapped = options.enabled()
          ? wrapPointer(state, intent, options.frame())
          : { intent, cursor: null };
        const result = dispatch(wrapped.intent);
        state = afterDispatch(state, intent, result);
        draw(wrapped.cursor);
        return result;
      });
      return () => {
        disconnect();
        draw(null);
      };
    },
  });
}
