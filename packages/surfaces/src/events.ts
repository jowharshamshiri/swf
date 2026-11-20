import type { BindingRef, Id, SwfError } from '@swf/core';
import type { SurfaceCapabilities } from './capabilities.js';

/**
 * A surface's presentation state in the framework. These are presentation states only: they say
 * nothing about whether the endpoint's producer runs.
 */
export type PresentationState =
  'unbound' | 'binding' | 'ready' | 'presented' | 'hidden' | 'error' | 'detaching' | 'detached';

/** Why a surface is unbound: it shows a placeholder that keeps its identity and geometry. */
export type UnboundReason =
  /** The association names no endpoint yet. */
  | 'no-binding-key'
  /** No adapter is registered for its adapter type. */
  | 'adapter-unavailable'
  /** The adapter does not know the binding key. */
  | 'unknown-binding-key'
  /** The host unbound it, or it is between two bindings. */
  | 'released';

interface RuntimeEventPayloads {
  /** The surface moved from one presentation state to another. */
  'presentation.stateChanged': {
    readonly surfaceId: Id;
    readonly from: PresentationState | null;
    readonly to: PresentationState;
    readonly generation: number;
    readonly binding: BindingRef;
    readonly unboundReason: UnboundReason | null;
    readonly error: SwfError | null;
  };
  /** The surface was attached to, revealed in, hidden in or released from one viewport. */
  'presentation.viewportChanged': {
    readonly surfaceId: Id;
    readonly viewportId: Id;
    readonly attached: boolean;
    readonly visible: boolean;
  };
  'presentation.capabilitiesChanged': {
    readonly surfaceId: Id;
    readonly previous: SurfaceCapabilities;
    readonly capabilities: SurfaceCapabilities;
  };
  /** A binding was replaced in place with a safe handoff. */
  'presentation.replaced': {
    readonly surfaceId: Id;
    readonly previous: BindingRef;
    readonly binding: BindingRef;
  };
  'adapter.registered': { readonly adapterId: string };
  'adapter.unregistered': { readonly adapterId: string };
}

export type RuntimeEventType = keyof RuntimeEventPayloads;

/** A typed notification from a surface runtime. It describes; it commands nothing. */
export type RuntimeEvent = {
  [T in RuntimeEventType]: {
    /** Unique within the runtime, in delivery order. */
    readonly id: string;
    readonly type: T;
    readonly workspaceId: Id;
    /** The scene revision when the event was emitted. */
    readonly revision: number;
    readonly timestamp: number;
    readonly payload: RuntimeEventPayloads[T];
  };
}[RuntimeEventType];

export type RuntimeEventPayload<T extends RuntimeEventType> = RuntimeEventPayloads[T];
