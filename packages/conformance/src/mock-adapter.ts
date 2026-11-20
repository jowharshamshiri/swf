import type {
  BindingContext,
  PresentationHint,
  PresentationTarget,
  SurfaceAdapter,
  SurfaceCapabilities,
} from '@swf/surfaces';

/** A capable native endpoint that cannot be shared between viewports. */
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
});

/** {@link NATIVE_CAPABILITIES} with some fields changed. */
export function mockCapabilities(over: Partial<SurfaceCapabilities> = {}): SurfaceCapabilities {
  return Object.freeze({ ...NATIVE_CAPABILITIES, ...over });
}

/** An opaque handle the mock hands out: the framework must treat it as a black box. */
export interface MockHandle {
  readonly key: string;
  readonly serial: number;
}

export interface MockCall {
  readonly method: 'resolve' | 'capabilities' | 'attach' | 'update' | 'detach';
  readonly key?: string;
  readonly handle?: MockHandle;
  readonly viewportId?: string;
  readonly target?: PresentationTarget;
  readonly hint?: PresentationHint;
}

interface Deferred {
  resolve(handle: MockHandle | null): void;
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
  readonly id: string;
  readonly apiVersion = 1;
  readonly declaredCapabilities: SurfaceCapabilities;
  readonly untimedBinding: boolean;
  /**
   * When true, held resolutions keep waiting after their abort signal fires: an ill-behaved
   * adapter, for checking that late answers are still discarded.
   */
  readonly ignoresAbort: boolean;
  readonly calls: MockCall[] = [];
  readonly held = new Map<string, Deferred[]>();
  readonly holding = new Set<string>();
  readonly unknown = new Set<string>();
  readonly failing = new Set<string>();
  readonly attachFailing = new Set<string>();
  readonly attachHeld = new Map<string, (() => void)[]>();
  readonly holdingAttach = new Set<string>();
  readonly signals: AbortSignal[] = [];
  readonly contexts: BindingContext[] = [];
  handleCapabilities: (handle: MockHandle) => SurfaceCapabilities;
  updateThrows = false;
  producerTouched = 0;
  #serial = 0;

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

  /** Completes the oldest held resolution of `key` with a fresh handle, null, or an error. */
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

  capabilities(handle: MockHandle): SurfaceCapabilities {
    this.calls.push({ method: 'capabilities', handle });
    return this.handleCapabilities(handle);
  }

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

  update(handle: MockHandle, hint: PresentationHint): void {
    this.calls.push({ method: 'update', handle, hint });
    if (this.updateThrows) {
      throw new Error('cannot take hints');
    }
  }

  detach(handle: MockHandle, target: PresentationTarget): Promise<void> {
    this.calls.push({ method: 'detach', handle, viewportId: target.viewportId, target });
    return Promise.resolve();
  }

  /** What a producer control looks like. The framework must never call it. */
  stopProducer(): void {
    this.producerTouched += 1;
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  #handle(key: string): MockHandle {
    this.#serial += 1;
    return Object.freeze({ key, serial: this.#serial });
  }
}
