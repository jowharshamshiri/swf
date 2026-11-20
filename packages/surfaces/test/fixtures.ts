import type { SceneCommand, SurfaceSpec, Workspace } from '@swf/core';
import { createWorkspace } from '@swf/core';
import type {
  BindingContext,
  PresentationHint,
  PresentationTarget,
  RuntimeEvent,
  SurfaceAdapter,
  SurfaceCapabilities,
  SurfaceRuntime,
} from '../src/index.js';

/** A capable native endpoint that cannot be shared between viewports. */
export const NATIVE: SurfaceCapabilities = Object.freeze({
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

export function caps(over: Partial<SurfaceCapabilities> = {}): SurfaceCapabilities {
  return { ...NATIVE, ...over };
}

/** An opaque handle: the framework must treat it as a black box. */
export interface Handle {
  readonly key: string;
  readonly serial: number;
}

export interface Call {
  readonly method: 'resolve' | 'capabilities' | 'attach' | 'update' | 'detach';
  readonly key?: string;
  readonly handle?: Handle;
  readonly viewportId?: string;
  readonly hint?: PresentationHint;
}

interface Deferred {
  resolve(handle: Handle | null): void;
  reject(error: Error): void;
}

/**
 * A mock adapter for opaque endpoints. Keys resolve at once to a new handle unless they are held
 * (`hold`), unknown (`unknown`) or failing (`failing`). It records every call, and exposes a
 * producer control that the framework must never call.
 */
export class MockAdapter implements SurfaceAdapter<Handle> {
  readonly id: string;
  readonly apiVersion = 1;
  readonly declaredCapabilities: SurfaceCapabilities;
  readonly untimedBinding: boolean;
  readonly calls: Call[] = [];
  readonly held = new Map<string, Deferred[]>();
  readonly holding = new Set<string>();
  readonly unknown = new Set<string>();
  readonly failing = new Set<string>();
  readonly attachFailing = new Set<string>();
  readonly attachHeld = new Map<string, (() => void)[]>();
  readonly holdingAttach = new Set<string>();
  readonly signals: AbortSignal[] = [];
  readonly contexts: BindingContext[] = [];
  handleCapabilities: (handle: Handle) => SurfaceCapabilities;
  updateThrows = false;
  producerTouched = 0;
  #serial = 0;

  constructor(
    id = 'host.view/1',
    declared: SurfaceCapabilities = NATIVE,
    options: {
      untimedBinding?: boolean;
      handleCapabilities?: (handle: Handle) => SurfaceCapabilities;
    } = {},
  ) {
    this.id = id;
    this.declaredCapabilities = declared;
    this.untimedBinding = options.untimedBinding ?? false;
    this.handleCapabilities = options.handleCapabilities ?? (() => declared);
  }

  resolve(key: string, signal: AbortSignal, context: BindingContext): Promise<Handle | null> {
    this.calls.push({ method: 'resolve', key });
    this.signals.push(signal);
    this.contexts.push(context);
    if (this.failing.has(key)) {
      return Promise.reject(new Error(`cannot open ${key}`));
    }
    if (this.unknown.has(key)) {
      return Promise.resolve(null);
    }
    if (this.holding.has(key)) {
      return new Promise((resolve, reject) => {
        const list = this.held.get(key) ?? [];
        list.push({ resolve, reject });
        this.held.set(key, list);
      });
    }
    return Promise.resolve(this.#handle(key));
  }

  /** Completes the oldest held resolution of `key` with a new handle (or null). */
  release(key: string, outcome: 'handle' | 'null' | 'error' = 'handle'): Handle | null {
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

  capabilities(handle: Handle): SurfaceCapabilities {
    this.calls.push({ method: 'capabilities', handle });
    return this.handleCapabilities(handle);
  }

  attach(handle: Handle, target: PresentationTarget): Promise<void> {
    this.calls.push({ method: 'attach', handle, viewportId: target.viewportId });
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

  update(handle: Handle, hint: PresentationHint): void {
    this.calls.push({ method: 'update', handle, hint });
    if (this.updateThrows) {
      throw new Error('cannot take hints');
    }
  }

  detach(handle: Handle, target: PresentationTarget): Promise<void> {
    this.calls.push({ method: 'detach', handle, viewportId: target.viewportId });
    return Promise.resolve();
  }

  /** What a producer control would look like. The framework must never call it. */
  stopProducer(): void {
    this.producerTouched += 1;
  }

  methods(): string[] {
    return this.calls.map((c) => c.method);
  }

  #handle(key: string): Handle {
    this.#serial += 1;
    return Object.freeze({ key, serial: this.#serial });
  }
}

export function makeWorkspace(): Workspace {
  let tick = 1_000;
  return createWorkspace({ id: 'ws', now: () => (tick += 1) });
}

export function window(id: string): SceneCommand {
  return { type: 'node.create', node: { id, kind: 'window', bounds: [1.6, 0.9, 0.01] } };
}

export function surface(
  id: string,
  ownerNodeId: string,
  bindingKey: string | null,
  extra: Partial<SurfaceSpec> = {},
): SceneCommand {
  return {
    type: 'surface.attach',
    surface: {
      id,
      ownerNodeId,
      bindingKey,
      adapterTypeId: 'host.view/1',
      bounds: [1.6, 0.9, 0.01],
      ...extra,
    },
  };
}

/** Lets pending promise continuations (and the runtime's microtasks) run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

export function record(runtime: SurfaceRuntime): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  runtime.subscribe((event) => events.push(event));
  return events;
}

/** The state transitions of one surface, as `from>to` strings. */
export function transitions(events: readonly RuntimeEvent[], surfaceId: string): string[] {
  return events.flatMap((event) =>
    event.type === 'presentation.stateChanged' && event.payload.surfaceId === surfaceId
      ? [`${event.payload.from ?? 'none'}>${event.payload.to}`]
      : [],
  );
}

export function committed(result: ReturnType<Workspace['dispatch']>): void {
  if (result.status !== 'committed') {
    throw new Error(`expected a commit, got ${JSON.stringify(result)}`);
  }
}
