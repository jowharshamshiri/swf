import type { BindingRef, Id, SwfError } from '@swf/core';
import type { SurfaceCapabilities } from './capabilities.js';

/**
 * A surface's presentation state in the framework. These are presentation states only: they say
 * nothing about whether the endpoint's producer runs.
 *
 * - `unbound`: no handle; the surface shows a placeholder, with an {@link UnboundReason}.
 * - `binding`: its adapter is resolving the binding key.
 * - `ready`: bound to a handle, attached in no viewport.
 * - `presented`: attached and shown in at least one viewport.
 * - `hidden`: attached in some viewport but shown in none.
 * - `error`: binding or the handle failed; the surface can bind again.
 * - `detaching`: its attachments are being released.
 * - `detached`: the association was removed from the scene; the runtime forgets the surface.
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

/**
 * The payload of each surface runtime event, by event type. A payload is shared with every
 * listener: listeners read it and must not change it.
 */
export interface RuntimeEventPayloads {
  /** The surface moved from one presentation state to another. */
  'presentation.stateChanged': {
    /** The surface whose state changed. */
    readonly surfaceId: Id;
    /** The state it left, or null when the runtime starts tracking the surface. */
    readonly from: PresentationState | null;
    /** The state it is in now. */
    readonly to: PresentationState;
    /** The surface's binding generation after the change. */
    readonly generation: number;
    /** The binding the surface has, as the scene names it. */
    readonly binding: BindingRef;
    /** Why it is unbound when `to` is `unbound`; null otherwise. */
    readonly unboundReason: UnboundReason | null;
    /** Why it failed when `to` is `error`; null otherwise. */
    readonly error: SwfError | null;
  };
  /** The surface was attached to, revealed in, hidden in or released from one viewport. */
  'presentation.viewportChanged': {
    /** The surface. */
    readonly surfaceId: Id;
    /** The viewport whose attachment changed. */
    readonly viewportId: Id;
    /** True while an attachment remains in the viewport; false once it is released. */
    readonly attached: boolean;
    /** True when the surface is shown there. */
    readonly visible: boolean;
  };
  /**
   * The capabilities of a bound surface's handle changed: the adapter announced new ones, or a
   * replaced binding has different ones.
   */
  'presentation.capabilitiesChanged': {
    /** The surface. */
    readonly surfaceId: Id;
    /** The capabilities it had; frozen. */
    readonly previous: SurfaceCapabilities;
    /** The capabilities it has now; frozen. */
    readonly capabilities: SurfaceCapabilities;
  };
  /** A binding was replaced in place with a safe handoff. */
  'presentation.replaced': {
    /** The surface. */
    readonly surfaceId: Id;
    /** The binding released. */
    readonly previous: BindingRef;
    /** The binding presented in its place, committed to the scene. */
    readonly binding: BindingRef;
  };
  /** An adapter was registered with the runtime. */
  'adapter.registered': {
    /** The adapter's versioned type ID. */
    readonly adapterId: string;
  };
  /**
   * An adapter was unregistered, after the surfaces it bound were released. Disposing the runtime
   * sends none.
   */
  'adapter.unregistered': {
    /** The adapter's versioned type ID. */
    readonly adapterId: string;
  };
}

/** The type of a surface runtime event. */
export type RuntimeEventType = keyof RuntimeEventPayloads;

/**
 * A typed notification from a surface runtime. It describes; it commands nothing. The event object
 * is frozen and shared with every listener. Events are delivered in the order they were emitted:
 * one emitted while listeners run is delivered after the event in progress.
 */
export type RuntimeEvent = {
  [T in RuntimeEventType]: {
    /** Unique within the runtime, in delivery order. */
    readonly id: string;
    /** What happened. */
    readonly type: T;
    /** The workspace whose surfaces the runtime presents. */
    readonly workspaceId: Id;
    /** The scene revision when the event was emitted. */
    readonly revision: number;
    /** When the event was emitted, in milliseconds by the runtime's clock. */
    readonly timestamp: number;
    /** What the event says, by its type. */
    readonly payload: RuntimeEventPayloads[T];
  };
}[RuntimeEventType];

/** The payload of the runtime event of type `T`. */
export type RuntimeEventPayload<T extends RuntimeEventType> = RuntimeEventPayloads[T];
