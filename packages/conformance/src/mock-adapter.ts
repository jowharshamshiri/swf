import type {
  BindingContext,
  PresentationHint,
  PresentationTarget,
  SurfaceAdapter,
  SurfaceCapabilities,
} from '@swf/surfaces';

/**
 * A capable native endpoint that cannot be shared between viewports: native DOM, fully
 * interactive, transparent, safely detachable and rebindable. Frozen.
 */
export const NATIVE_CAPABILITIES: SurfaceCapabilities = Object.freeze({
  attachStrategy: 'native-dom',
  nativeInteraction: 'full',
  uvAddressing: true,
  transformFidelity: 'approximate',
  transparency: true,
  clipping: true,
  cursorMapping: true,
  resize: 'intrinsic',
  viewportSharing: 'single-owner',
  safeDetach: true,
  rebinding: true,
  placeholder: false,
  snapshotHooks: false,
  takeover: true,
});

/** {@link NATIVE_CAPABILITIES} with some fields changed: a new frozen object, not validated. */
export function mockCapabilities(over: Partial<SurfaceCapabilities> = {}): SurfaceCapabilities {
  return Object.freeze({ ...NATIVE_CAPABILITIES, ...over });
}

/** An opaque handle the mock hands out: the framework must treat it as a black box. Frozen. */
export interface MockHandle {
  /** The binding key it was resolved from. */
  readonly key: string;
  /** Which handle of the adapter it is, from 1: each resolution makes a fresh one. */
  readonly serial: number;
}

/** One call the framework made to a {@link MockOpaqueAdapter}, as it recorded it. */
export interface MockCall {
  /** The adapter method called. */
  readonly method: 'resolve' | 'capabilities' | 'attach' | 'update' | 'detach';
  /** The binding key, for `resolve`. */
  readonly key?: string;
  /** The handle, for `capabilities`, `attach`, `update` and `detach`. */
  readonly handle?: MockHandle;
  /** The target's viewport, for `attach` and `detach`. */
  readonly viewportId?: string;
  /** The presentation target, for `attach` and `detach`. */
  readonly target?: PresentationTarget;
  /** The presentation hint, for `update`. */
  readonly hint?: PresentationHint;
}

/** A resolution a {@link MockOpaqueAdapter} holds back until the test settles it. */
export interface Deferred {
  /** Settles the resolution with a handle, or with null for an unknown key. */
  resolve(handle: MockHandle | null): void;
  /** Fails the resolution with `error`. */
  reject(error: Error): void;
}

/**
 * A reference adapter for opaque endpoints, for testing hosts, runtimes and backends without any
 * real content. Keys resolve at once to a fresh handle unless they are held (`holding`), unknown
 * (`unknown`) or failing (`failing`). Held resolutions settle when `release` is called, or reject
 * when their abort signal fires, as a well-behaved adapter must. Every call is recorded. It also
 * carries a producer control, `stopProducer`, that the framework must never call.
 */
export class MockOpaqueAdapter implements SurfaceAdapter<MockHandle> {
  /** The adapter type ID it registers as. */
  readonly id: string;
  /** The adapter API version it implements. */
  readonly apiVersion = 1;
  /** The capabilities it declares at registration. */
  readonly declaredCapabilities: SurfaceCapabilities;
  /** When true, the runtime does not time its bindings out. */
  readonly untimedBinding: boolean;
  /**
   * When true, held resolutions keep waiting after their abort signal fires: an ill-behaved
   * adapter, for checking that late answers are still discarded.
   */
  readonly ignoresAbort: boolean;
  /** Every call the framework made, oldest first; a test may read and clear it. */
  readonly calls: MockCall[] = [];
  /** The held resolutions of each key, oldest first; {@link MockOpaqueAdapter.release} settles. */
  readonly held = new Map<string, Deferred[]>();
  /** Keys whose resolutions are held until released or aborted; the test adds and removes them. */
  readonly holding = new Set<string>();
  /** Keys that resolve to null: endpoints the adapter does not know. */
  readonly unknown = new Set<string>();
  /** Keys whose resolutions reject with `Error`. */
  readonly failing = new Set<string>();
  /** Keys whose handles' `attach` rejects with `Error`. */
  readonly attachFailing = new Set<string>();
  /**
   * The held attachments of each key, oldest first: calling one completes that `attach`. They
   * are never removed by the adapter.
   */
  readonly attachHeld = new Map<string, (() => void)[]>();
  /** Keys whose handles' `attach` waits until the test completes it from {@link attachHeld}. */
  readonly holdingAttach = new Set<string>();
  /** The abort signal of every resolution, in call order. */
  readonly signals: AbortSignal[] = [];
  /** The binding context of every resolution, in call order. */
  readonly contexts: BindingContext[] = [];
  /** What `capabilities` answers for a handle; default the declared capabilities. Replaceable. */
  handleCapabilities: (handle: MockHandle) => SurfaceCapabilities;
  /** When true, `update` throws `Error`. Default false. */
  updateThrows = false;
  /** How many times {@link MockOpaqueAdapter.stopProducer} was called: it must stay 0. */
  producerTouched = 0;
  #serial = 0;

  /**
   * @param id - The adapter type ID. Default `host.view/1`.
   * @param declared - The capabilities declared, and answered for every handle unless
   *   `options.handleCapabilities` says otherwise. Default {@link NATIVE_CAPABILITIES}.
   * @param options - `untimedBinding` and `ignoresAbort` (default false), and
   *   `handleCapabilities`.
   */
  constructor(
    id = 'host.view/1',
    declared: SurfaceCapabilities = NATIVE_CAPABILITIES,
    options: {
      untimedBinding?: boolean;
      ignoresAbort?: boolean;
      handleCapabilities?: (handle: MockHandle) => SurfaceCapabilities;
    } = {},
  ) {
    this.id = id;
    this.declaredCapabilities = declared;
    this.untimedBinding = options.untimedBinding ?? false;
    this.ignoresAbort = options.ignoresAbort ?? false;
    this.handleCapabilities = options.handleCapabilities ?? (() => declared);
  }

  /**
   * Resolves `key`, recording the call, its signal and its context: rejects when `signal` is
   * already aborted (unless the adapter ignores aborts) or the key is failing, answers null for an
   * unknown key, waits for a held one, and otherwise answers a fresh handle at once.
   */
  resolve(key: string, signal: AbortSignal, context: BindingContext): Promise<MockHandle | null> {
    this.calls.push({ method: 'resolve', key });
    this.signals.push(signal);
    this.contexts.push(context);
    if (signal.aborted && !this.ignoresAbort) {
      return Promise.reject(new Error('aborted before it started'));
    }
    if (this.failing.has(key)) {
      return Promise.reject(new Error(`cannot open ${key}`));
    }
    if (this.unknown.has(key)) {
      return Promise.resolve(null);
    }
    if (this.holding.has(key)) {
      return new Promise((resolve, reject) => {
        const list = this.held.get(key) ?? [];
        const deferred: Deferred = { resolve, reject };
        list.push(deferred);
        this.held.set(key, list);
        if (this.ignoresAbort) {
          return;
        }
        // A well-behaved adapter stops waiting once its binding is cancelled.
        signal.addEventListener(
          'abort',
          () => {
            const index = list.indexOf(deferred);
            if (index >= 0) {
              list.splice(index, 1);
              reject(new Error('aborted'));
            }
          },
          { once: true },
        );
      });
    }
    return Promise.resolve(this.#handle(key));
  }

  /**
   * Completes the oldest held resolution of `key` with a fresh handle, null, or an error, and
   * returns the handle given (null for `null` and `error`).
   *
   * @throws `Error` when no resolution of `key` is held.
   */
  release(key: string, outcome: 'handle' | 'null' | 'error' = 'handle'): MockHandle | null {
    const deferred = this.held.get(key)?.shift();
    if (deferred === undefined) {
      throw new Error(`no held resolution for ${key}`);
    }
    if (outcome === 'error') {
      deferred.reject(new Error('late failure'));
      return null;
    }
    const handle = outcome === 'null' ? null : this.#handle(key);
    deferred.resolve(handle);
    return handle;
  }

  /** Records the call and answers {@link MockOpaqueAdapter.handleCapabilities} for the handle. */
  capabilities(handle: MockHandle): SurfaceCapabilities {
    this.calls.push({ method: 'capabilities', handle });
    return this.handleCapabilities(handle);
  }

  /**
   * Records the call; rejects for a key in {@link attachFailing}, waits for one in
   * {@link holdingAttach}, and otherwise resolves at once. It mounts nothing.
   */
  attach(handle: MockHandle, target: PresentationTarget): Promise<void> {
    this.calls.push({ method: 'attach', handle, viewportId: target.viewportId, target });
    if (this.attachFailing.has(handle.key)) {
      return Promise.reject(new Error('mount failed'));
    }
    if (this.holdingAttach.has(handle.key)) {
      return new Promise((resolve) => {
        const list = this.attachHeld.get(handle.key) ?? [];
        list.push(resolve);
        this.attachHeld.set(handle.key, list);
      });
    }
    return Promise.resolve();
  }

  /** Records the hint; throws `Error` while {@link updateThrows} is set. */
  update(handle: MockHandle, hint: PresentationHint): void {
    this.calls.push({ method: 'update', handle, hint });
    if (this.updateThrows) {
      throw new Error('cannot take hints');
    }
  }

  /** Records the call and resolves at once. */
  detach(handle: MockHandle, target: PresentationTarget): Promise<void> {
    this.calls.push({ method: 'detach', handle, viewportId: target.viewportId, target });
    return Promise.resolve();
  }

  /** What a producer control looks like. The framework must never call it. */
  stopProducer(): void {
    this.producerTouched += 1;
  }

  /** The method of every recorded call, oldest first: a new array. */
  methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  #handle(key: string): MockHandle {
    this.#serial += 1;
    return Object.freeze({ key, serial: this.#serial });
  }
}
