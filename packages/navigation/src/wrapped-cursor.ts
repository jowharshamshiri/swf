import type { DispatchResult, InputAdapter, InputIntent, PointerIntent } from '@swf/interaction';
import { INTERACTION_API_VERSION } from '@swf/interaction';
import { models } from '@swf/models';

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
 * The state is plain data with explicit transitions, each decided by the Lean model
 * `Swf.AppCursor` (models/Swf/AppCursor.lean), where its invariants are proved; nothing here
 * touches the page.
 */

/** The pointers the framework took, by device and pointer: the ones that wrap. */
export interface WrapState {
  /** Each taken pointer, by its device and pointer ID. */
  readonly taken: ReadonlySet<string>;
}

/** No pointer taken: the state before any. */
export const NO_POINTERS: WrapState = Object.freeze({ taken: Object.freeze(new Set<string>()) });

/** What the view allows: its width in CSS pixels, and whether its edges meet at a seam. */
export interface WrapFrame {
  /** The view's width, in CSS pixels. */
  readonly width: number;
  /** The view shows the whole circle with its seam at the edges (full 360°, seam wrapping). */
  readonly wraps: boolean;
}

/** The intent to pass on, and where to draw the virtual cursor (null: draw none). */
export interface Wrapped {
  /** The intent to pass on, its point wrapped. */
  readonly intent: PointerIntent;
  /** Where to draw the virtual cursor, in CSS pixels of the view, or null for none. */
  readonly cursor: {
    /** CSS pixels from the view's left edge. */
    readonly x: number;
    /** CSS pixels from the view's top edge. */
    readonly y: number;
  } | null;
}

const keyOf = (p: PointerIntent) => `${p.deviceId}\u0000${String(p.pointerId)}`;

/** A pointer sample, wrapped across the seam when the framework took the pointer and the view wraps. */
export function wrapPointer(state: WrapState, intent: PointerIntent, frame: WrapFrame): Wrapped {
  const outcome = models.wrapPointerStep(
    [...state.taken],
    keyOf(intent),
    { kind: intent.phase },
    intent.x,
    frame.width,
    frame.wraps,
  );
  switch (outcome.kind) {
    case 'invalidWidth':
      throw new RangeError(`a view's width is finite and above zero (got ${String(frame.width)})`);
    case 'invalidX':
      throw new RangeError(`a pointer's horizontal place is finite (got ${String(intent.x)})`);
    case 'pass':
      return { intent, cursor: null };
    case 'wrapped': {
      const wrapped: PointerIntent = Object.freeze({ ...intent, x: outcome.x });
      return {
        intent: wrapped,
        cursor: outcome.cursor ? Object.freeze({ x: outcome.x, y: intent.y }) : null,
      };
    }
  }
}

/** The state once the framework answered a pointer sample. */
export function afterDispatch(
  state: WrapState,
  intent: PointerIntent,
  result: DispatchResult,
): WrapState {
  const taken = models.wrapAfterDispatch(
    [...state.taken],
    keyOf(intent),
    { kind: intent.phase },
    result.consumed,
  );
  return taken === null ? state : Object.freeze({ taken: Object.freeze(new Set(taken)) });
}

/** What the wrapped cursor takes input from, follows and draws with. */
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
    id: 'swf.navigation.wrapped-cursor/1',
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
