/**
 * Counts what code running in a window holds of the browser: event listeners, observations by
 * resize, mutation and intersection observers, requested animation frames and pending timers. It
 * wraps the window's own registration functions, so it sees every registration made after it is
 * installed, by any code, and the counts compare a moment before a workspace is created with a
 * moment after it is disposed (NFR-010, AN-008).
 *
 * A listener counts while its target is the window, the document, or an element in the document:
 * one on an element that was removed and dropped goes with the element, and holds nothing.
 */

/** What the window's code holds, at one moment. */
export interface ResourceCounts {
  /** Event listeners added and not removed, on live targets. */
  readonly listeners: number;
  /** Targets observed by observers that are not disconnected, on live targets. */
  readonly observations: number;
  /** Animation frames requested and neither run nor cancelled. */
  readonly frames: number;
  /** Timeouts set and neither run nor cleared, and intervals not cleared. */
  readonly timers: number;
}

/**
 * A probe installed in a window, counting what the window's code holds. The caller owns it and
 * must call {@link ResourceProbe.dispose} to give the window its own functions back.
 */
export interface ResourceProbe {
  /**
   * What the window's code holds now, counting only what was registered since the probe was
   * installed. A new frozen object on every call.
   */
  counts(): ResourceCounts;
  /**
   * Puts the window's own functions back and lets another probe be installed. Registrations made
   * meanwhile keep working; they are no longer followed, so counts read afterwards are stale.
   * Safe to call twice.
   */
  dispose(): void;
}

/**
 * The window a probe is installed in: a browser window with its globals, whose
 * `EventTarget.prototype`, observers, animation frames and timers the probe wraps.
 */
export type ProbedWindow = Window & typeof globalThis;

interface Registration {
  readonly target: WeakRef<EventTarget>;
  readonly type: string;
  readonly listener: EventListenerOrEventListenerObject;
  readonly capture: boolean;
}

/** Whether a target still holds what is registered on it: it is reachable from the page. */
function live(view: ProbedWindow, target: EventTarget | undefined): boolean {
  if (target === undefined) {
    return false;
  }
  if (target === view || target === view.document) {
    return true;
  }
  return target instanceof view.Node ? target.isConnected : true;
}

const captureOf = (options: boolean | EventListenerOptions | undefined): boolean =>
  typeof options === 'boolean' ? options : options?.capture === true;

/**
 * Installs a probe in a window: it replaces the window's `addEventListener` and
 * `removeEventListener` (on `EventTarget.prototype`), its `ResizeObserver`, `MutationObserver`
 * and `IntersectionObserver` (those it has), `requestAnimationFrame`, `cancelAnimationFrame`,
 * `setTimeout`, `clearTimeout`, `setInterval` and `clearInterval` with versions that count
 * and then call the originals. While installed, `setTimeout` takes only a function and throws
 * `TypeError` for code given as text. The caller owns the probe and disposes it.
 *
 * @throws `Error` when one is installed there already: two would count each registration twice.
 */
export function createResourceProbe(view: ProbedWindow): ResourceProbe {
  const marker = '__swfResourceProbe';
  const flagged = view as unknown as Record<string, unknown>;
  if (flagged[marker] === true) {
    throw new Error('a resource probe is installed in this window already');
  }
  flagged[marker] = true;

  const registrations = new Set<Registration>();
  const find = (
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    capture: boolean,
  ) => {
    for (const r of registrations) {
      if (
        r.type === type &&
        r.listener === listener &&
        r.capture === capture &&
        r.target.deref() === target
      ) {
        return r;
      }
    }
    return undefined;
  };

  const proto = view.EventTarget.prototype;
  // The window's own functions, taken as values to call on their targets and to put back.
  const add = Reflect.get(proto, 'addEventListener');
  const remove = Reflect.get(proto, 'removeEventListener');
  proto.addEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ) {
    add.call(this, type, listener, options);
    if (listener === null) {
      return;
    }
    const capture = captureOf(options);
    if (find(this, type, listener, capture) !== undefined) {
      return; // the browser ignores a second identical registration
    }
    const registration: Registration = { target: new WeakRef(this), type, listener, capture };
    const signal = typeof options === 'object' ? options.signal : undefined;
    if (signal?.aborted === true) {
      return;
    }
    registrations.add(registration);
    if (typeof options === 'object' && options.once === true) {
      // A listener added once is removed by the browser as it runs: wrapped, it is seen to run.
      add.call(this, type, () => registrations.delete(registration), { once: true, capture });
    }
    signal?.addEventListener('abort', () => registrations.delete(registration), { once: true });
  };
  proto.removeEventListener = function (
    this: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions,
  ) {
    remove.call(this, type, listener, options);
    if (listener === null) {
      return;
    }
    const found = find(this, type, listener, captureOf(options));
    if (found !== undefined) {
      registrations.delete(found);
    }
  };

  /** Each observer's observed targets, while it is not disconnected. */
  const observed = new Map<object, Set<WeakRef<Element | Node>>>();
  const restoreObservers: (() => void)[] = [];
  const wrapObserver = (name: 'ResizeObserver' | 'MutationObserver' | 'IntersectionObserver') => {
    const Original = view[name] as unknown as new (...args: unknown[]) => {
      observe(target: Node, options?: unknown): void;
      unobserve?(target: Element): void;
      disconnect(): void;
    };
    if (typeof Original !== 'function') {
      return;
    }
    class Probed extends Original {
      constructor(...args: unknown[]) {
        super(...args);
        observed.set(this, new Set());
      }
      override observe(target: Node, options?: unknown): void {
        super.observe(target, options);
        const set = observed.get(this);
        if (set !== undefined && ![...set].some((t) => t.deref() === target)) {
          set.add(new WeakRef(target));
        }
      }
      override unobserve(target: Element): void {
        super.unobserve?.(target);
        const set = observed.get(this);
        for (const t of set ?? []) {
          if (t.deref() === target) {
            set?.delete(t);
          }
        }
      }
      override disconnect(): void {
        super.disconnect();
        observed.get(this)?.clear();
      }
    }
    Object.defineProperty(view, name, { value: Probed, configurable: true, writable: true });
    restoreObservers.push(() => {
      Object.defineProperty(view, name, { value: Original, configurable: true, writable: true });
    });
  };
  wrapObserver('ResizeObserver');
  wrapObserver('MutationObserver');
  wrapObserver('IntersectionObserver');

  const frames = new Set<number>();
  const request = Reflect.get(view, 'requestAnimationFrame');
  const cancel = Reflect.get(view, 'cancelAnimationFrame');
  view.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const id = request.call(view, (time) => {
      frames.delete(id);
      callback(time);
    });
    frames.add(id);
    return id;
  };
  view.cancelAnimationFrame = (id: number): void => {
    frames.delete(id);
    cancel.call(view, id);
  };

  const timers = new Set<number>();
  const setTimer = Reflect.get(view, 'setTimeout');
  const clearTimer = Reflect.get(view, 'clearTimeout');
  const setRepeat = Reflect.get(view, 'setInterval');
  const clearRepeat = Reflect.get(view, 'clearInterval');
  view.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]): number => {
    if (typeof handler !== 'function') {
      throw new TypeError('the resource probe takes only function timers, never code as text');
    }
    const run = handler as (...x: unknown[]) => void;
    const id = setTimer.call(
      view,
      (...a: unknown[]) => {
        timers.delete(id);
        run(...a);
      },
      timeout,
      ...args,
    );
    timers.add(id);
    return id;
  }) as typeof view.setTimeout;
  view.clearTimeout = (id?: number): void => {
    if (id !== undefined) {
      timers.delete(id);
    }
    clearTimer.call(view, id);
  };
  view.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]): number => {
    const id = setRepeat.call(view, handler, timeout, ...args);
    timers.add(id);
    return id;
  }) as typeof view.setInterval;
  view.clearInterval = (id?: number): void => {
    if (id !== undefined) {
      timers.delete(id);
    }
    clearRepeat.call(view, id);
  };

  let disposed = false;
  return Object.freeze({
    counts(): ResourceCounts {
      let listeners = 0;
      for (const r of registrations) {
        if (live(view, r.target.deref())) {
          listeners += 1;
        }
      }
      let observations = 0;
      for (const set of observed.values()) {
        for (const t of set) {
          if (live(view, t.deref())) {
            observations += 1;
          }
        }
      }
      return Object.freeze({ listeners, observations, frames: frames.size, timers: timers.size });
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      proto.addEventListener = add;
      proto.removeEventListener = remove;
      for (const restore of restoreObservers) {
        restore();
      }
      view.requestAnimationFrame = request;
      view.cancelAnimationFrame = cancel;
      view.setTimeout = setTimer;
      view.clearTimeout = clearTimer;
      view.setInterval = setRepeat;
      view.clearInterval = clearRepeat;
      Reflect.deleteProperty(flagged, marker);
    },
  });
}
