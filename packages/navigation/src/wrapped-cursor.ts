import type { DomPointerLock, PointerLockChange } from '@swf/backend-dom';
import type { Id } from '@swf/core';
import type {
  DispatchResult,
  InputAdapter,
  InputIntent,
  InteractionEvent,
  PointerIntent,
} from '@swf/interaction';
import { INTERACTION_API_VERSION } from '@swf/interaction';
import type { CursorAction, CursorEvent, CursorNext, CursorState } from '@swf/models';
import { models } from '@swf/models';

/**
 * The wrapped cursor: an input policy, on its own between the device and the framework. In a
 * panorama that shows the whole circle, the view's left and right edges are the same place, the
 * seam behind the camera. A pointer the framework took (a window being moved, the view being
 * turned) that is carried past one edge comes back in at the other: what the framework is told is
 * the wrapped place, and a virtual cursor shows it.
 *
 * A page cannot move the platform's pointer, which stops at the screen's edge. So a mouse drag
 * that reaches the view's edge asks the platform to lock the pointer to the view: the drag then
 * carries on by the mouse's motion alone, round the circle as far as the mouse goes, under the
 * virtual cursor, the platform's own pointer hidden. The first motion the platform reports under
 * the lock is its own, moving its pointer to where it holds it, and moves nothing (the model's
 * `fresh_lock_takes_no_motion`). The lock lives exactly as long as the drag:
 * it is let go when the drag ends, when the framework ends its gesture, and on Escape, which ends
 * the drag too; a lock the platform takes away ends the drag as a lost pointer does. Where the
 * platform offers no lock, or refuses it, the drag wraps for as far as the platform's pointer
 * goes, and stops at the screen's edge with it.
 *
 * Pointers the framework did not take, and every pointer while the view does not show the whole
 * circle, pass unchanged; the policy can be turned on and off without touching ordinary pointer
 * input.
 *
 * Every decision is the Lean model `Swf.AppCursor` (models/Swf/AppCursor.lean), where its
 * invariants are proved; this carries the samples and does what the model says.
 */

/** What the view allows: its size in CSS pixels, and whether its edges meet at a seam. */
export interface WrapFrame {
  /** The view's width, in CSS pixels. */
  readonly width: number;
  /** The view's height, in CSS pixels. */
  readonly height: number;
  /** The view shows the whole circle with its seam at the edges (full 360°, seam wrapping). */
  readonly wraps: boolean;
}

/** What the wrapped cursor takes input from, follows and draws with. */
export interface WrappedInputOptions {
  /** The device's own adapter. */
  readonly device: InputAdapter;
  /** The platform's pointer lock on the view, or null where the device offers none. */
  readonly lock: DomPointerLock | null;
  /** The viewport the device's samples land in. */
  readonly viewportId: Id;
  /** Whether the policy is on now: read at every sample. */
  readonly enabled: () => boolean;
  /** The view now. */
  readonly frame: () => WrapFrame;
  /** Draws the virtual cursor at a point of the view, or takes it away. */
  readonly cursor: (at: { readonly x: number; readonly y: number } | null) => void;
  /**
   * Router notifications, so a pointer the framework lets go lets its lock go: a function that
   * subscribes a listener and returns what unsubscribes it, such as the router's `subscribe`.
   */
  readonly events: (listener: (event: InteractionEvent) => void) => () => void;
}

const keyOf = (p: { readonly deviceId: string; readonly pointerId: number }) =>
  `${p.deviceId}\u0000${String(p.pointerId)}`;

const LOCK_EVENTS: Readonly<Record<PointerLockChange, CursorEvent>> = Object.freeze({
  locked: { kind: 'locked' },
  refused: { kind: 'refusedLock' },
  unlocked: { kind: 'unlocked' },
});

/**
 * A device's adapter with the wrapped cursor between it and the framework. Off, it passes every
 * intent through untouched.
 *
 * A sample in a view whose width or height is not finite and above zero, or whose place or motion
 * is not finite, throws `RangeError` naming the field, from the device's dispatch.
 */
export function wrappedInput(options: WrappedInputOptions): InputAdapter {
  const { device, lock } = options;
  return Object.freeze({
    id: 'swf.navigation.wrapped-cursor/1',
    apiVersion: INTERACTION_API_VERSION,
    connect(dispatch: (intent: InputIntent) => DispatchResult): () => void {
      let state: CursorState = models.cursorInitial();
      /** Each held pointer's last sample, from which a cancellation of it is made. */
      const last = new Map<string, PointerIntent>();
      /** What the model said to do, in order: done once no dispatch is running. */
      const pending: CursorAction[] = [];
      let dispatching = false;

      const apply = (next: CursorNext) => {
        state = next.state;
        pending.push(...next.actions);
      };
      const flush = () => {
        while (!dispatching) {
          const action = pending.shift();
          if (action === undefined) {
            return;
          }
          switch (action.kind) {
            case 'request':
              lock?.request();
              break;
            case 'exit':
              lock?.exit();
              break;
            case 'show':
              options.cursor({ x: action.x, y: action.y });
              break;
            case 'hide':
              options.cursor(null);
              break;
            case 'cancel': {
              const held = last.get(action.key);
              // As the platform cancels a pointer it lost: where it was, nothing pressed.
              if (held !== undefined) {
                sample(
                  Object.freeze({
                    kind: 'pointer',
                    viewportId: held.viewportId,
                    deviceId: held.deviceId,
                    pointerId: held.pointerId,
                    pointerType: held.pointerType,
                    phase: 'cancel',
                    x: action.x,
                    y: action.y,
                    buttons: 0,
                    modifiers: held.modifiers,
                    timestamp: held.timestamp,
                  }),
                );
              }
              break;
            }
          }
        }
      };
      const happen = (event: CursorEvent) => {
        apply(models.cursorEvent(state, event));
        flush();
      };
      /** Dispatches an intent; what the model says meanwhile is done once it returns. */
      const run = (intent: InputIntent): DispatchResult => {
        dispatching = true;
        try {
          return dispatch(intent);
        } finally {
          dispatching = false;
        }
      };

      const sample = (intent: PointerIntent): DispatchResult => {
        // A pointer leaving the view is one no gesture holds (a held pointer is captured, or
        // locked, and never leaves): nothing it wraps, it goes on as it is.
        if (intent.phase === 'leave') {
          return run(intent);
        }
        const frame = options.frame();
        const key = keyOf(intent);
        const step = models.sampleStep(
          state,
          {
            key,
            phase: { kind: intent.phase },
            x: intent.x,
            y: intent.y,
            dx: intent.movement?.x ?? 0,
            dy: intent.movement?.y ?? 0,
            mouse: intent.pointerType === 'mouse',
          },
          {
            width: frame.width,
            height: frame.height,
            wraps: options.enabled() && frame.wraps,
            lockable: lock?.available ?? false,
          },
        );
        if (step.kind === 'invalid') {
          throw new RangeError(
            `${step.reason} (${step.field}: ${valueOf(step.field, intent, frame)})`,
          );
        }
        if (intent.phase === 'up' || intent.phase === 'cancel') {
          last.delete(key);
        } else {
          last.set(key, intent);
        }
        apply({ state: step.state, actions: step.actions });
        const passed =
          step.x === intent.x && step.y === intent.y
            ? intent
            : Object.freeze({ ...intent, x: step.x, y: step.y });
        const result = run(passed);
        happen({
          kind: 'dispatched',
          key,
          phase: { kind: intent.phase },
          consumed: result.consumed,
        });
        return result;
      };

      const stopLock = lock?.subscribe((change) => {
        happen(LOCK_EVENTS[change]);
      });
      const stopEvents = options.events((event) => {
        if (event.type === 'capture.released' && event.viewportId === options.viewportId) {
          happen({ kind: 'released', key: keyOf(event) });
        }
      });
      const disconnect = device.connect((intent) => {
        if (intent.kind === 'pointer') {
          return sample(intent);
        }
        const result = run(intent);
        if (intent.kind === 'key' && intent.phase === 'down' && intent.key === 'Escape') {
          happen({ kind: 'escape' });
        } else {
          flush();
        }
        return result;
      });
      // Taken off the device, the cursor lets its lock go and takes its cursor away before the
      // device stops, so nothing the device says as it stops reaches a policy no longer there.
      return () => {
        stopEvents();
        stopLock?.();
        happen({ kind: 'closed' });
        last.clear();
        disconnect();
      };
    },
  });
}

/** The value a refusal names, as the sample or the view gave it. */
function valueOf(field: string, intent: PointerIntent, frame: WrapFrame): string {
  switch (field) {
    case 'width':
      return String(frame.width);
    case 'height':
      return String(frame.height);
    case 'x':
      return String(intent.x);
    case 'y':
      return String(intent.y);
    default:
      return `${String(intent.movement?.x)}, ${String(intent.movement?.y)}`;
  }
}
