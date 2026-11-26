import type { BindingRef, EventSource, Id, SwfError, Workspace } from '@swf/core';
import type { PresentationHint, SurfaceAdapter } from './adapter.js';
import type { SurfaceCapabilities } from './capabilities.js';
import type { PresentationState, RuntimeEvent, UnboundReason } from './events.js';
/**
 * How to make a surface runtime. The options are checked at run time: an unknown option or an
 * invalid value throws {@link SwfFailure} (`INVALID_INPUT`) with the path `options.<field>`.
 */
export interface SurfaceRuntimeOptions {
    /**
     * How long resolving a binding may take before it fails as retryable (`BIND_FAILED`, with
     * `details.reason` `timeout`) and its signal aborts: a positive, finite number of milliseconds.
     * Adapters that declare `untimedBinding` are never timed out. Default 15000.
     */
    readonly bindingTimeoutMs?: number;
    /**
     * Whether surfaces start binding as soon as they appear, their binding changes or their
     * adapter is registered. Default true. Failed bindings are never retried automatically.
     */
    readonly autoBind?: boolean;
    /** The clock for timestamps, in milliseconds. Default `Date.now`. */
    readonly now?: () => number;
    /** How many diagnostics `getDiagnostics` keeps: at least 1. Default 100. */
    readonly diagnosticsCapacity?: number;
    /** Receives every diagnostic as it is recorded. A sink that throws is ignored. */
    readonly onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void;
}
/** A surface's presence in one viewport: an attachment, shown or hidden. Frozen. */
export interface ViewportAttachment {
    /** The viewport the surface is attached in. */
    readonly viewportId: Id;
    /** True when it is shown there; false when it is attached but hidden. */
    readonly visible: boolean;
}
/**
 * What the runtime knows of one surface's presentation: a frozen snapshot, taken when it is
 * returned, that does not follow later changes.
 */
export interface SurfacePresentation {
    /** The surface. */
    readonly surfaceId: Id;
    /** Where it is in the presentation lifecycle. */
    readonly state: PresentationState;
    /**
     * Increases with every binding attempt, every committed replacement, every failure and every
     * release; completions of an older generation are discarded.
     */
    readonly generation: number;
    /** The binding it presents, or is to bind, as the scene names it; frozen. */
    readonly binding: BindingRef;
    /** The negotiated capabilities of the bound handle, or null when none is bound; frozen. */
    readonly capabilities: SurfaceCapabilities | null;
    /** Why it is unbound while `state` is `unbound`; null in every other state. */
    readonly unboundReason: UnboundReason | null;
    /** Why it failed while `state` is `error`; null in every other state. */
    readonly error: SwfError | null;
    /** Its attachment in each viewport it is attached in, in the order they were made. */
    readonly viewports: readonly ViewportAttachment[];
    /** A binding replacement is in progress. */
    readonly replacing: boolean;
}
/**
 * What a presentation operation of {@link SurfaceRuntime} came to. A refusal is returned, never
 * thrown, and the promise is never rejected for one. The outcome is frozen.
 */
export type PresentationOutcome = {
    /** The operation did what was asked, or there was nothing to do. */
    readonly status: 'ok';
    /** The surface's presentation after the operation. */
    readonly presentation: SurfacePresentation;
} | {
    /** The operation was refused or failed. */
    readonly status: 'rejected';
    /**
     * Why: `UNKNOWN_ENTITY` for a surface the runtime does not track, `INVALID_TRANSITION` for
     * an operation its state does not allow, `WORKSPACE_DISPOSED` once the runtime is disposed,
     * `CANCELLED` when the surface changed while the operation waited, or the operation's own
     * failure as each method states.
     */
    readonly error: SwfError;
};
/** What delivering a presentation hint came to. Returned, never thrown. */
export type HintOutcome = {
    /** The hint was taken. */
    readonly status: 'ok';
    /** False when the hint repeated the last one for that viewport and was coalesced away. */
    readonly delivered: boolean;
} | {
    /** The hint was refused; the adapter did not see it. */
    readonly status: 'rejected';
    /**
     * Why: `UNKNOWN_ENTITY` for a surface the runtime does not track, `INVALID_TRANSITION` for
     * one not attached in the hint's viewport.
     */
    readonly error: SwfError;
};
/**
 * Something the runtime noticed and dealt with that no operation reports: a failure it absorbed or
 * a late completion it discarded. Diagnostics are frozen.
 */
export interface RuntimeDiagnostic {
    /**
     * What happened: an adapter's `detach` threw (`ADAPTER_THREW`), a listener threw
     * (`LISTENER_THREW`), a resolve or attach completed after the surface changed and was discarded
     * or released (`STALE_COMPLETION`), a bound handle's capabilities changed
     * (`CAPABILITIES_CHANGED`), or an adapter threw on a hint (`HINT_IGNORED`).
     */
    readonly code: 'ADAPTER_THREW' | 'LISTENER_THREW' | 'STALE_COMPLETION' | 'CAPABILITIES_CHANGED' | 'HINT_IGNORED';
    /** A readable account, for logs; not meant to be parsed. */
    readonly message: string;
    /** When it was recorded, in milliseconds by the runtime's clock. */
    readonly timestamp: number;
    /** The surface concerned, or null when there is none (a listener that threw). */
    readonly surfaceId: Id | null;
    /**
     * Particulars by code, all strings: `phase` (`resolve`, `attach` or `detach`) and `reason` (what
     * was thrown, as text), `adapterId`, or `eventId`.
     */
    readonly details: Readonly<Record<string, string>>;
}
/**
 * Receives every runtime event, in order. An exception it throws is recorded as a
 * `LISTENER_THREW` diagnostic; other listeners still receive the event.
 */
export type RuntimeListener = (event: RuntimeEvent) => void;
/**
 * Binds a workspace's surface associations to live endpoints through registered adapters and
 * drives each surface through the presentation lifecycle. It changes no scene state except when
 * asked to replace a binding, and it never manages the endpoints' producers.
 *
 * The runtime follows the workspace's events: it tracks every surface association in the scene
 * (from creation), binds a new or rebound one when `autoBind` is on, releases a removed one, and
 * passes changed bounds on to the adapter as hints. The host owns the runtime and disposes it
 * with {@link SurfaceRuntime.dispose}; disposing the workspace disposes it too.
 *
 * Presentation operations return a {@link PresentationOutcome} and never throw for a refusal;
 * operations run while another on the same surface is in flight are refused or superseded as each
 * method states.
 */
export interface SurfaceRuntime {
    /** The workspace whose surfaces the runtime presents. */
    readonly workspaceId: Id;
    /** True once {@link SurfaceRuntime.dispose} has been called, while it runs as well as after. */
    readonly disposed: boolean;
    /**
     * Registers an adapter. Throws {@link SwfFailure}: `INVALID_INPUT` for a malformed adapter or a
     * taken ID, `UNSUPPORTED_CAPABILITY` for an incompatible contract version or contradictory
     * capabilities, `WORKSPACE_DISPOSED` once the runtime is disposed. Registering sends
     * `adapter.registered`, and with `autoBind` starts binding every surface that was waiting for
     * an adapter of this type.
     *
     * @returns A function that unregisters the adapter: every surface holding or acquiring a binding
     *   through it releases its attachments (through the adapter's `detach`) and its handle, and
     *   becomes `unbound` (`adapter-unavailable`). `adapter.unregistered` is sent without waiting
     *   for those releases to finish. The endpoints are left as they are. Calling it again, or
     *   after the runtime is disposed, does nothing.
     */
    registerAdapter<THandle>(adapter: SurfaceAdapter<THandle>): () => void;
    /** The surface's presentation now, or undefined when the runtime does not track it. */
    get(surfaceId: Id): SurfacePresentation | undefined;
    /** Every tracked surface's presentation now, in the order the runtime began tracking them. */
    list(): SurfacePresentation[];
    /**
     * The bound handle, for a presentation backend; undefined when the surface is unknown or has no
     * bound handle. The handle is the adapter's, opaque to the framework: the caller must not
     * dispose it, and must not keep it past the surface's next release.
     */
    handleOf(surfaceId: Id): unknown;
    /**
     * Starts binding an unbound or failed surface; the promise settles when the attempt does. A
     * surface with no binding key or no registered adapter stays `unbound`, with that reason, and
     * the outcome is `ok`; so is one whose key the adapter does not know (`unknown-binding-key`).
     * A failed resolve leaves the surface in `error`, and the outcome is still `ok`, its
     * presentation carrying the error. Refused with `INVALID_TRANSITION` in any other state.
     */
    bind(surfaceId: Id): Promise<PresentationOutcome>;
    /**
     * Releases the surface's presentation attachments and handle, keeping the association: it ends
     * `unbound` (`released`). A binding in flight is aborted. The endpoint is left as it is. An
     * unbound surface is left as it is; one that is detaching or replacing its binding is refused
     * with `INVALID_TRANSITION`.
     */
    unbind(surfaceId: Id): Promise<PresentationOutcome>;
    /**
     * Attaches a bound surface to a viewport (or reveals it there again), handing the adapter a
     * {@link PresentationTarget} with `container`, which stays the caller's. A surface whose handle
     * has a single owner cannot be presented in a second viewport, nor can two surfaces present the
     * same single-owner endpoint: such requests are rejected with `UNSUPPORTED_CAPABILITY`, so the
     * caller shows a proxy instead.
     *
     * Refused with `INVALID_INPUT` for a blank viewport ID, and with `INVALID_TRANSITION` when the
     * surface is not bound, is replacing its binding, or is already shown or attaching there. When
     * the adapter's `attach` fails, the surface goes to `error` (every attachment released) and
     * `BIND_FAILED` is returned; when the surface changes while attaching, the late attachment is
     * released and `CANCELLED` is returned.
     */
    present(surfaceId: Id, viewportId: Id, container: unknown): Promise<PresentationOutcome>;
    /**
     * Hides a surface in a viewport. With `release`, the attachment is released, but only when the
     * handle declares safe detachment; otherwise it stays attached and hidden. When the surface was
     * shown there, the adapter first receives a hint that it is hidden. Refused with
     * `INVALID_TRANSITION` when the surface is not attached there or is replacing its binding.
     * Hiding a hidden attachment without releasing it does nothing.
     */
    hide(surfaceId: Id, viewportId: Id, options?: {
        /** Release the attachment too, when the handle declares safe detachment. Default false. */
        release?: boolean;
    }): Promise<PresentationOutcome>;
    /**
     * Moves a surface's attachment in a viewport to another container, as when the viewport's
     * presentation resources are replaced: it is released from the old container and attached to
     * the new one, shown or hidden as it was. Only a handle that declares safe detachment moves
     * (`UNSUPPORTED_CAPABILITY` otherwise). When the new attachment fails, the attachment goes back
     * where it was and `BIND_FAILED` is returned; when even that fails, the surface is in error.
     * Moving to the container it is already in does nothing. Refused with `INVALID_TRANSITION` when
     * the surface is not attached there (or is still attaching) or is replacing its binding.
     */
    move(surfaceId: Id, viewportId: Id, container: unknown): Promise<PresentationOutcome>;
    /**
     * Passes an advisory hint to the adapter of the surface it names, for the viewport it names;
     * a hint equal to the last one for that viewport is coalesced away. The hint is passed as given,
     * not copied: the caller must not change it afterwards. An adapter that throws on it leaves the
     * outcome `ok` and records `HINT_IGNORED`.
     */
    deliverHint(hint: PresentationHint): HintOutcome;
    /**
     * Replaces the surface's binding in place: the new endpoint is resolved and attached to every
     * viewport first, then the change commits as one transaction, then the old attachment is
     * released. Any failure before the commit leaves the old binding presented and the scene
     * unchanged.
     *
     * Only a bound surface with no replacement or attachment in flight hands over
     * (`INVALID_TRANSITION` otherwise). A blank `bindingKey` is refused with `INVALID_INPUT`, an
     * adapter type with no registered adapter with `ADAPTER_UNAVAILABLE`, a key the adapter does not
     * know or an endpoint that fails to resolve or attach with `BIND_FAILED`, capabilities that are
     * malformed or exceed the adapter's declaration, or a single-owner endpoint for a surface
     * attached in several viewports or that another surface presents (single ownership as
     * {@link SurfaceRuntime.present} checks it), with `UNSUPPORTED_CAPABILITY`, and a transaction
     * the workspace rejects (such as `LOCKED`) with that rejection's error. The commit sends
     * `presentation.replaced`.
     *
     * @param binding The endpoint to present: a non-blank binding key, and the adapter type that
     *   resolves it, by default the surface's own.
     * @param options `source` is the event source the committed transaction carries; default
     *   `host`.
     */
    replaceBinding(surfaceId: Id, binding: {
        readonly bindingKey: string;
        readonly adapterTypeId?: string;
    }, options?: {
        readonly source?: EventSource;
    }): Promise<PresentationOutcome>;
    /**
     * Calls `listener` with every runtime event from now on, in order, until the returned function
     * is called; that function is safe to call more than once. Disposing the runtime drops every
     * listener. Throws {@link SwfFailure}: `INVALID_INPUT` when `listener` is not a function,
     * `WORKSPACE_DISPOSED` once the runtime is disposed.
     */
    subscribe(listener: RuntimeListener): () => void;
    /**
     * The diagnostics recorded so far, oldest first: the most recent `diagnosticsCapacity`. Returns
     * a fresh array of frozen diagnostics.
     */
    getDiagnostics(): readonly RuntimeDiagnostic[];
    /**
     * The binding-management scope: adapters, binding and rebinding, but no presentation. Each
     * call returns a fresh frozen object that calls this runtime.
     */
    binder(): SurfaceBinder;
    /**
     * Releases every attachment and stops listening: each surface releases its attachments through
     * its adapter and ends `detached`, bindings in flight are aborted, and then every adapter is
     * forgotten (without `adapter.unregistered`) and every listener dropped. The endpoints and the
     * workspace are left as they are. Every call returns the same promise, which settles once the
     * release is done. From the first call on, binding, presenting, moving, replacing, registering
     * and subscribing are refused with `WORKSPACE_DISPOSED`, and a surface already released is
     * unknown to the runtime.
     */
    dispose(): Promise<void>;
}
/**
 * What a module that manages surface binding may do: register adapters, bind, unbind and replace
 * bindings, and observe their state. Presenting in viewports is left to presentation backends.
 * Like every scope, it makes a module's reach explicit; it is not a security boundary. Its members
 * behave as the runtime's own.
 */
export type SurfaceBinder = Pick<SurfaceRuntime, 'workspaceId' | 'registerAdapter' | 'get' | 'list' | 'bind' | 'unbind' | 'replaceBinding' | 'subscribe'>;
/**
 * Creates the surface runtime of a workspace. It subscribes to the workspace and starts tracking
 * every surface in the scene at once, binding each that can bind when `autoBind` is on (as soon as
 * an adapter of its type is registered).
 *
 * The runtime is the caller's: dispose it with {@link SurfaceRuntime.dispose} to release every
 * attachment and unsubscribe from the workspace; disposing the workspace disposes it too. Neither
 * stops a host's producer or disposes an endpoint.
 *
 * @throws A {@link SwfFailure}: `INVALID_INPUT` for invalid options, naming `options.<field>`, and
 *   `WORKSPACE_DISPOSED` when the workspace is not `ready`.
 *
 * @example
 * ```ts
 * const surfaces = createSurfaceRuntime(workspace, { bindingTimeoutMs: 5000 });
 * const unregister = surfaces.registerAdapter(videoAdapter);
 * const unsubscribe = surfaces.subscribe((event) => {
 *   if (event.type === 'presentation.stateChanged') console.log(event.payload.to);
 * });
 * // ...
 * unsubscribe();
 * unregister();
 * await surfaces.dispose();
 * ```
 */
export declare function createSurfaceRuntime(workspace: Workspace, options?: SurfaceRuntimeOptions): SurfaceRuntime;
//# sourceMappingURL=runtime.d.ts.map