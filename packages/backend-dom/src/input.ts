import type { Id } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type {
  DispatchResult,
  InputAdapter,
  InputIntent,
  InteractionEvent,
  Modifiers,
  PointerIntent,
  PointerPhase,
  PointerType,
  ResizeEdge,
} from '@swf/interaction';
import { INTERACTION_API_VERSION } from '@swf/interaction';
import { DOM_ATTRIBUTES } from './renderer.js';

/** Which view's DOM to take input from, and for which viewport. */
export interface DomInputOptions {
  /** A versioned adapter ID. Default `swf.dom-input/1`; give each viewport's adapter its own. */
  readonly id?: string;
  /**
   * The view's root element: input over it is offered to the framework. Pointer positions are
   * measured from its top left, in CSS pixels. It stays the host's.
   */
  readonly root: HTMLElement;
  /** The viewport every intent names. */
  readonly viewportId: Id;
  /**
   * Router notifications, so captured pointers are released when their gesture ends and the
   * root's cursor says what a press would do: a function that subscribes a listener and returns
   * what unsubscribes it, such as the router's `subscribe`.
   */
  readonly events: (listener: (event: InteractionEvent) => void) => () => void;
}

/** What the platform says of its pointer lock on a view's root. */
export type PointerLockChange =
  /** It locked the pointer to the root. */
  | 'locked'
  /** It refused to lock the pointer, or failed to. */
  | 'refused'
  /** Its lock on the root ended: let go, or taken away (Escape, the page losing focus). */
  | 'unlocked';

/**
 * The platform's pointer lock on a view's root. While the pointer is locked, the platform hides
 * its own pointer, keeps reporting the pointer's samples to the root at the place the lock took
 * it, and reports the pointer's motion with each, which the DOM input passes on as the intent's
 * `movement`. A page cannot take the lock outside a short while after the person pressed
 * something, and the platform may refuse it at any time.
 */
export interface DomPointerLock {
  /** Whether the platform offers pointer lock on the root. */
  readonly available: boolean;
  /**
   * Asks the platform to lock the pointer to the root. Its answer, `locked` or `refused`,
   * arrives through {@link DomPointerLock.subscribe}, never during this call.
   *
   * @throws {@link @swf/core!SwfFailure} `INVALID_TRANSITION` while the input is not connected, while a
   *   request is unanswered or a lock is held, and `UNSUPPORTED_CAPABILITY` where the platform
   *   offers no lock.
   */
  request(): void;
  /**
   * Lets the lock go: `unlocked` follows. A request still unanswered cannot be withdrawn; its
   * answer arrives as usual. Does nothing while no lock is held.
   */
  exit(): void;
  /** Listens for what the platform says of the lock; returns what stops listening. */
  subscribe(listener: (change: PointerLockChange) => void): () => void;
}

/** A view's DOM input, with the platform's pointer lock on its root. */
export interface DomInput extends InputAdapter {
  /** The platform's pointer lock on the view's root. */
  readonly pointerLock: DomPointerLock;
}

/** The keys that are modifiers, as the platform names them. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'Meta']);

/** The gestures that carry what they act on (a window, the view), shown as grabbed while they run. */
const CARRIED: ReadonlySet<string> = new Set(['node.move', 'camera.turn', 'orbit.turn']);

/**
 * The cursor that says what a press would do where a pointer hovers (`pointer.hovered`): a grab
 * where a press would take a window or turn the view, the edge's resize cursor on a resize band, a
 * move where the takeover would take content's window, and nothing of its own (the content's or
 * the page's) where the content would keep the press, or nothing would act.
 */
function cursorOf(
  shows: Extract<InteractionEvent, { type: 'pointer.hovered' }>['shows'],
  edge: ResizeEdge | null,
): string {
  switch (shows) {
    case 'grab':
      return 'grab';
    case 'takeover':
      return 'move';
    case 'resize':
      if (edge === null) {
        throw new Error('a resize band was hovered with no edge');
      }
      return RESIZE_CURSORS[edge];
    case 'content':
    case 'nothing':
    case 'blocked':
    case 'busy':
    case null:
      return '';
  }
}

/** Each edge's resize cursor: both ways along the axis it resizes. */
const RESIZE_CURSORS: Readonly<Record<ResizeEdge, string>> = Object.freeze({
  n: 'ns-resize',
  s: 'ns-resize',
  e: 'ew-resize',
  w: 'ew-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  nw: 'nwse-resize',
  se: 'nwse-resize',
});

/** CSS pixels one wheel "line" scrolls when the platform reports lines. */
const LINE_PX = 16;

/**
 * Connects a view's DOM to the interaction router. It listens on the view's root in the capture
 * phase and offers every pointer, wheel and key event as an intent. When the framework consumes
 * one, the event stops there (so content does not act on it too) and a pressed pointer is
 * captured on the root until its gesture ends. When it does not, the event is left untouched and
 * the browser delivers it to the content as the genuine event it is: nothing is synthesized or
 * re-dispatched, and content in a cross-origin frame receives its input from the browser alone.
 *
 * Wheel deltas are given in CSS pixels: a line is 16 px and a page the root's height. Keys
 * pressed inside a live slot are offered with focus `content`, others with focus `workspace`.
 * Pen and touch pointers carry pressure (clamped to 0 to 1), tilt and twist.
 *
 * It offers the platform's pointer lock on the root ({@link DomInput.pointerLock}), for an input
 * policy that carries a pointer beyond where the platform's pointer can go. While the root holds
 * the lock, every pointer sample carries the pointer's `movement`. Taking the lock takes the
 * platform's capture of a pressed pointer with it; that is no loss of the pointer, whose samples
 * reach the locked root as captured ones do, and its gesture goes on. A capture lost while a
 * request is unanswered counts as lost if the platform then refuses the lock.
 *
 * The adapter connects to one router at a time: `connect` adds its listeners to the root and
 * subscribes to `events`, and the function it returns removes and unsubscribes them again and
 * lets any lock on the root go. A second `connect` before that throws {@link SwfFailure}
 * (`INVALID_TRANSITION`).
 */
export function createDomInput(options: DomInputOptions): DomInput {
  const { root, viewportId } = options;
  const id = options.id ?? 'swf.dom-input/1';
  const document = root.ownerDocument;
  const available = typeof root.requestPointerLock === 'function';
  let connected = false;
  /** Where the lock stands: none, asked for and unanswered, or held by the root. */
  let lock: 'none' | 'asking' | 'held' = 'none';
  const lockListeners = new Set<(change: PointerLockChange) => void>();
  const tell = (change: PointerLockChange) => {
    for (const listener of [...lockListeners]) {
      listener(change);
    }
  };
  /** A capture lost while a request was unanswered: lost if the platform refuses the lock. */
  let lostWhileAsking: (() => void) | null = null;
  const answer = (change: 'locked' | 'refused') => {
    if (lock !== 'asking') {
      return;
    }
    const lost = lostWhileAsking;
    lostWhileAsking = null;
    lock = change === 'locked' ? 'held' : 'none';
    tell(change);
    if (change === 'refused') {
      lost?.();
    }
  };
  const pointerLock: DomPointerLock = Object.freeze({
    available,
    request() {
      if (!available) {
        throw new SwfFailure(
          makeError('UNSUPPORTED_CAPABILITY', 'the platform offers no pointer lock'),
        );
      }
      if (!connected) {
        throw new SwfFailure(makeError('INVALID_TRANSITION', `DOM input "${id}" is not connected`));
      }
      if (lock !== 'none') {
        throw new SwfFailure(
          makeError(
            'INVALID_TRANSITION',
            lock === 'asking'
              ? 'the pointer lock was asked for and is unanswered'
              : 'the pointer lock is held',
          ),
        );
      }
      lock = 'asking';
      let asked: unknown;
      try {
        asked = root.requestPointerLock();
      } catch {
        // Refused at once (some platforms throw): answered after this call, as every answer is.
        queueMicrotask(() => {
          answer('refused');
        });
        return;
      }
      // Some platforms answer with a promise as well as with the document's events.
      if (asked instanceof Promise) {
        asked.catch(() => {
          answer('refused');
        });
      }
    },
    exit() {
      if (document.pointerLockElement === root) {
        document.exitPointerLock();
      }
    },
    subscribe(listener: (change: PointerLockChange) => void) {
      lockListeners.add(listener);
      return () => {
        lockListeners.delete(listener);
      };
    },
  });
  return Object.freeze({
    id,
    apiVersion: INTERACTION_API_VERSION,
    pointerLock,
    connect(dispatch: (intent: InputIntent) => DispatchResult): () => void {
      if (connected) {
        throw new SwfFailure(
          makeError('INVALID_TRANSITION', `DOM input "${id}" is already connected`),
        );
      }
      connected = true;
      const locked = () => document.pointerLockElement === root;
      const deviceOf = (e: PointerEvent) => (e.pointerType === '' ? 'pointer' : e.pointerType);
      const position = (e: MouseEvent) => {
        const box = root.getBoundingClientRect();
        return { x: e.clientX - box.left, y: e.clientY - box.top };
      };
      const settle = (event: Event, result: DispatchResult) => {
        if (result.consumed) {
          event.preventDefault();
          event.stopPropagation();
        }
      };
      /**
       * The last sample of the pointer over the view, while it is over it: a modifier going down
       * or up anywhere on the page is offered as a sample of it where it is, with the modifiers
       * then held, so what a press there would do, or what a drag does, follows the modifier
       * without the pointer moving.
       */
      let over: PointerIntent | null = null;
      const pointer = (phase: PointerPhase) => (event: Event) => {
        const e = event as PointerEvent;
        // The browser may deliver the first sample under a lock (its own motion to where it holds
        // the pointer) before it says the lock took hold: the lock is told first, so that sample
        // is the first under it.
        if (lock === 'asking' && locked()) {
          answer('locked');
        }
        const { x, y } = position(e);
        const intent: PointerIntent = {
          kind: 'pointer',
          viewportId,
          deviceId: deviceOf(e),
          pointerId: e.pointerId,
          pointerType: pointerTypeOf(e.pointerType),
          phase,
          x,
          y,
          buttons: e.buttons,
          modifiers: modifiersOf(e),
          timestamp: e.timeStamp,
          ...penDetails(e),
          ...(locked() ? { movement: { x: e.movementX, y: e.movementY } } : {}),
        };
        over = phase === 'leave' || phase === 'cancel' ? null : intent;
        const result = dispatch(intent);
        // A press the framework takes is captured on the root: the release then targets the root,
        // so the click that follows lands there too and never reaches the content.
        if (phase === 'down' && result.consumed && !root.hasPointerCapture(e.pointerId)) {
          root.setPointerCapture(e.pointerId);
        }
        settle(event, result);
      };
      const lost = (event: Event) => {
        const e = event as PointerEvent;
        const { x, y } = position(e);
        const cancel = () =>
          dispatch({
            kind: 'pointer',
            viewportId,
            deviceId: deviceOf(e),
            pointerId: e.pointerId,
            pointerType: pointerTypeOf(e.pointerType),
            phase: 'cancel',
            x,
            y,
            buttons: 0,
            modifiers: modifiersOf(e),
            timestamp: e.timeStamp,
          });
        // The lock takes the capture with it: the pointer is not lost, and reaches the root still.
        if (locked()) {
          return;
        }
        if (lock === 'asking') {
          lostWhileAsking = () => {
            cancel();
          };
          return;
        }
        cancel();
      };
      const lockChanged = () => {
        if (locked()) {
          answer('locked');
        } else if (lock === 'held') {
          lock = 'none';
          tell('unlocked');
        }
      };
      const lockFailed = () => {
        answer('refused');
      };
      const wheel = (event: Event) => {
        const e = event as WheelEvent;
        const { x, y } = position(e);
        const unit =
          e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? root.getBoundingClientRect().height : 1;
        settle(
          event,
          dispatch({
            kind: 'wheel',
            viewportId,
            deviceId: 'wheel',
            x,
            y,
            deltaX: e.deltaX * unit,
            deltaY: e.deltaY * unit,
            modifiers: modifiersOf(e),
            timestamp: e.timeStamp,
          }),
        );
      };
      const modifier = (event: Event) => {
        const e = event as KeyboardEvent;
        if (over === null || !MODIFIER_KEYS.has(e.key) || e.repeat) {
          return;
        }
        const sample: PointerIntent = {
          ...over,
          phase: 'move',
          modifiers: modifiersOf(e),
          timestamp: e.timeStamp,
        };
        over = sample;
        dispatch(sample);
      };
      const key = (phase: 'down' | 'up') => (event: Event) => {
        const e = event as KeyboardEvent;
        const target = e.target;
        const inContent =
          target instanceof Element && target.closest(`[${DOM_ATTRIBUTES.slot}]`) !== null;
        settle(
          event,
          dispatch({
            kind: 'key',
            viewportId,
            deviceId: 'keyboard',
            phase,
            key: e.key,
            repeat: e.repeat,
            modifiers: modifiersOf(e),
            focus: inContent ? 'content' : 'workspace',
            timestamp: e.timeStamp,
          }),
        );
      };
      const listeners: [string, (event: Event) => void][] = [
        ['pointerdown', pointer('down')],
        ['pointermove', pointer('move')],
        ['pointerup', pointer('up')],
        ['pointercancel', pointer('cancel')],
        ['lostpointercapture', lost],
        ['pointerleave', pointer('leave')],
        ['wheel', wheel],
        ['keydown', key('down')],
        ['keyup', key('up')],
      ];
      for (const [type, listener] of listeners) {
        root.addEventListener(type, listener, { capture: true, passive: false });
      }
      document.addEventListener('pointerlockchange', lockChanged);
      document.addEventListener('pointerlockerror', lockFailed);
      document.addEventListener('keydown', modifier, { capture: true });
      document.addEventListener('keyup', modifier, { capture: true });
      // The root's cursor: what a press where the pointer hovers would do, and while a gesture
      // that carries something runs, that it is carried.
      let hovered = '';
      let carrying = false;
      const cursor = () => {
        root.style.setProperty('cursor', carrying ? 'grabbing' : hovered);
      };
      const unsubscribe = options.events((event) => {
        if (event.type === 'settings.changed' || event.viewportId !== viewportId) {
          return;
        }
        switch (event.type) {
          case 'capture.released':
            if (root.hasPointerCapture(event.pointerId)) {
              root.releasePointerCapture(event.pointerId);
            }
            return;
          case 'pointer.hovered':
            hovered = cursorOf(event.shows, event.edge);
            cursor();
            return;
          case 'gesture.started':
            carrying = CARRIED.has(event.operation);
            cursor();
            return;
          case 'gesture.ended':
            carrying = false;
            cursor();
            return;
          case 'content.pressed':
            return;
        }
      });
      return () => {
        for (const [type, listener] of listeners) {
          root.removeEventListener(type, listener, { capture: true });
        }
        root.style.removeProperty('cursor');
        document.removeEventListener('pointerlockchange', lockChanged);
        document.removeEventListener('pointerlockerror', lockFailed);
        document.removeEventListener('keydown', modifier, { capture: true });
        document.removeEventListener('keyup', modifier, { capture: true });
        unsubscribe();
        connected = false;
        lostWhileAsking = null;
        const held = lock === 'held';
        lock = 'none';
        if (locked()) {
          document.exitPointerLock();
        }
        if (held) {
          tell('unlocked');
        }
      };
    },
  });
}

/**
 * The platform's pointer type. A type the platform does not name (an empty or custom one) is
 * reported as `virtual`: a pointer the framework cannot classify as mouse, pen or touch.
 */
function pointerTypeOf(type: string): PointerType {
  return type === 'mouse' || type === 'pen' || type === 'touch' ? type : 'virtual';
}

function modifiersOf(e: MouseEvent | KeyboardEvent): Modifiers {
  return { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
}

/** Pressure, tilt and twist, for the devices that measure them (pens and touch). */
function penDetails(e: PointerEvent) {
  if (e.pointerType !== 'pen' && e.pointerType !== 'touch') {
    return {};
  }
  return {
    pressure: Math.min(1, Math.max(0, e.pressure)),
    tilt: { x: e.tiltX, y: e.tiltY },
    twist: e.twist % 360,
  };
}
