import type { Id, SwfError, WorkspaceReader } from '@swf/core';
import type { PresentationHint, SurfaceRuntime } from '@swf/surfaces';
import type { CompositorCapabilities, RendererCapabilities } from './capabilities.js';
import type { ComposedFrame, RenderedFrame, RenderFrame } from './contracts.js';
import type { FallbackDiagnostic, FallbackPolicy } from './negotiation.js';
import type { PresentationRegistry } from './registry.js';
import type { RepresentationPolicy } from './representation.js';
/** Calls work at the host's frame boundaries: an animation frame, in a browser. */
export interface FrameSource {
    /**
     * Calls `run` once, at the next frame boundary. `run` returns a promise of the frame's work,
     * which a source may wait for. Returns a function that cancels the call.
     */
    request(run: () => unknown): () => void;
}
/** A renderer and a compositor, by their registered IDs, presenting a viewport together. */
export interface BackendChoice {
    /** The renderer's registered ID. */
    readonly renderer: string;
    /** The compositor's registered ID. */
    readonly compositor: string;
}
/**
 * Where a viewport's presentation is. A handoff goes `preparing → validating → swapping →
 * active`; any failure returns to the previous backend, or, when there is none that works, to
 * `presentation-degraded`, where the viewport shows that it presents nothing while the scene stays
 * fully usable. A handoff begins only from `active` or `presentation-degraded`, never while one is
 * under way: each candidate tried after a failure begins from where that failure returned to.
 */
export type ViewportState = 'preparing' | 'validating' | 'swapping' | 'active' | 'presentation-degraded' | 'disposed';
/** Why a viewport's frame was due. */
export type DirtyFlag = 
/** Nodes, surfaces, selection or focus of the presented scene changed. */
'scene'
/** The viewport's own view (size, camera, projection) changed. */
 | 'view'
/** A surface's binding, capabilities or attachments changed. */
 | 'surfaces'
/** The viewport changed backend. */
 | 'backend'
/** The host asked for a frame. */
 | 'requested'
/** The viewport's representation policy was set, replaced or removed. */
 | 'representation';
/**
 * How to present one viewport: where, with which backends, and how much of it is live. Checked
 * when the viewport opens: an invalid option makes {@link Presenter.open} reject with
 * {@link SwfFailure} (`INVALID_INPUT`) naming it.
 */
export interface ViewportOptions {
    /** A viewport of the workspace's scene, not blank; at most one presented viewport per ID. */
    readonly viewportId: Id;
    /** The host's container the viewport is assembled in, opaque to the framework. */
    readonly container: unknown;
    /**
     * The backends to present with, most preferred first; at least one, each naming a renderer and
     * a compositor. The first that prepares is used; the others are its fallbacks when it fails, is
     * unregistered or loses its resources. The viewport keeps its own frozen copy.
     */
    readonly backends: readonly BackendChoice[];
    /**
     * `interactive` viewports (where the user works directly) are presented every frame they are
     * due; `background` ones (an overview, say) only while the frame budget lasts. Default
     * `interactive`.
     */
    readonly priority?: 'interactive' | 'background';
    /**
     * How many surfaces may show their own live content here at once; the rest are shown as
     * proxies. The focused window comes first, then the selection, then the largest on screen.
     * A whole number from 0, or `Infinity`. Default: no limit.
     */
    readonly maxLive?: number;
    /**
     * Whether a surface that stops being live here releases its attachment (when its endpoint
     * declares safe detachment) rather than keeping it, hidden. Default false.
     */
    readonly release?: boolean;
}
/**
 * What a presenter reads and presents through. It owns none of them: disposing the presenter
 * unsubscribes from each and leaves it as it was.
 */
export interface PresenterOptions {
    /**
     * The scene presented. The presenter reads its presented scene (the committed one with open
     * previews) and the geometry placed in it, and never changes it.
     */
    readonly workspace: WorkspaceReader;
    /**
     * The surface runtime that attaches live content. The presenter asks it to present, move and
     * hide attachments in its viewports (releasing an attachment only where the endpoint declares
     * safe detachment) and delivers hints through it; it never binds an endpoint or stops a host's
     * producer.
     */
    readonly runtime: SurfaceRuntime;
    /**
     * Where renderers, compositors and projectors are looked up by ID. The presenter follows its
     * changes: a viewport moves off a backend that is unregistered, and back to a preferred one that
     * is registered again.
     */
    readonly registry: PresentationRegistry;
    /**
     * The host's frame boundaries. The presenter has at most one frame requested at a time, asks
     * for one when something a viewport reads may have changed, and cancels it when disposed.
     */
    readonly frames: FrameSource;
    /**
     * Shows, in a viewport's container, that the viewport has no working backend, with why; the
     * returned function takes it away again. The viewport is degraded whether or not this throws:
     * a throw rejects the open or call that degraded it, or, for a handoff the viewport began on
     * its own, is kept as a `BACKGROUND_FAILED` diagnostic. A throw from the returned function is
     * kept as a `HOST_THREW` diagnostic, except when the viewport is disposed, which it rejects.
     */
    readonly showDegraded: (container: unknown, error: SwfError) => () => void;
    /** How long one frame's work may take before background viewports wait: milliseconds. Default 8. */
    readonly budgetMs?: number;
    /** The clock frames are measured with, in milliseconds. Default `Date.now`. */
    readonly now?: () => number;
    /**
     * The fallback order negotiation follows in every viewport; default
     * {@link DEFAULT_FALLBACK_POLICY}.
     */
    readonly policy?: FallbackPolicy;
}
/** What one frame of one viewport cost and did (frame presentation measures). */
export interface FrameMetrics {
    /** The viewport presented. */
    readonly viewportId: Id;
    /** The renderer that rendered the frame. */
    readonly rendererId: string;
    /** The compositor that assembled it. */
    readonly compositorId: string;
    /** The revision of the presented scene the frame shows. */
    readonly sceneRevision: number;
    /**
     * From the start of the frame to its metrics, attachments awaited included, in milliseconds by
     * the presenter's clock.
     */
    readonly durationMs: number;
    /** Frame boundaries this viewport waited through, out of budget, before this frame. */
    readonly skipped: number;
    /**
     * Why the frame was due, each reason once; a frame asked for with
     * {@link PresentedViewport.update} includes `requested`.
     */
    readonly dirty: readonly DirtyFlag[];
    /** Fragments planned. */
    readonly fragments: number;
    /** Surfaces showing their own content live. */
    readonly live: number;
    /** Changes the renderer and compositor made: none when nothing changed. */
    readonly writes: number;
    /** Hints delivered to adapters (repeats are coalesced away and not counted). */
    readonly hints: number;
}
/** One frame of a viewport, presented. */
export interface ViewportFrame {
    /** The viewport has a backend and the frame was presented. */
    readonly status: 'presented';
    /** The viewport presented. */
    readonly viewportId: Id;
    /** The plan the frame followed (stage 6). */
    readonly frame: RenderFrame;
    /** What the renderer realized (stage 7). */
    readonly rendered: RenderedFrame;
    /** What the compositor assembled (stage 7). */
    readonly composed: ComposedFrame;
    /** Surfaces attached (or revealed) here by this frame. */
    readonly presented: readonly Id[];
    /** Surfaces hidden here by this frame. */
    readonly hidden: readonly Id[];
    /** Surfaces whose presentation here the runtime refused; they are shown as proxies instead. */
    readonly refused: readonly {
        /** The surface refused. */
        readonly surfaceId: Id;
        /** Why the runtime refused it. */
        readonly error: SwfError;
    }[];
    /**
     * The advisory hint of every surface attached here, as this frame computed it (whether or not
     * the runtime delivered it again): visibility, occlusion and its confidence, the tier.
     */
    readonly hints: readonly PresentationHint[];
    /** What the frame cost and did, as the `frame` event publishes it (stage 8). */
    readonly metrics: FrameMetrics;
}
/** A frame of a viewport that has no working backend. */
export interface DegradedFrame {
    /** The viewport has no working backend; nothing was presented. */
    readonly status: 'degraded';
    /** The viewport without a working backend. */
    readonly viewportId: Id;
    /** Why it is degraded: `BACKEND_SWITCH_FAILED`, with the phase that failed in its details. */
    readonly error: SwfError;
}
/** What {@link PresentedViewport.update} gives: a presented frame, or a degraded one. */
export type ViewportUpdate = ViewportFrame | DegradedFrame;
/** Why a viewport changed backend. */
export type SwitchReason = 'opened' | 'requested' | 'unavailable' | 'lost' | 'restored';
/**
 * How a backend switch or restore ended. A backend that fails is reported here and as a
 * `backend.failed` event, never thrown; its error is `BACKEND_SWITCH_FAILED` (retryable), with
 * `details.phase` naming the handoff stage that failed (`preparing`, `validating` or `swapping`;
 * a candidate whose loss cannot be watched fails in `swapping`). A failed handoff releases every
 * session it prepared and undoes each step it carried out, going on when an undo step fails, so
 * the previous backend is as it was, but for the surfaces a `kept` outcome names as
 * `unrestored`; a failed handoff that left some has them in its error's `details.unrestored` as
 * well, by ID.
 */
export type SwitchOutcome = {
    /** The viewport is presented with `backend`. */
    readonly status: 'switched';
    /**
     * The backend now in use: the first tried that works, or the one the viewport had when it
     * was asked to switch to it or had nothing ahead of it to try.
     */
    readonly backend: BackendChoice;
}
/** No backend tried worked; the viewport kept the one it had. */
 | {
    /** No backend tried worked, and the one the viewport had still does. */
    readonly status: 'kept';
    /** The backend still in use. */
    readonly backend: BackendChoice;
    /** Why the last backend tried failed. */
    readonly error: SwfError;
    /**
     * The surfaces a failed handoff could not put back as they were (a rollback's step for
     * them was refused, and no later rollback put them back), each with why; empty when every
     * surface was put back.
     */
    readonly unrestored: readonly UnrestoredSurface[];
}
/** No backend works and the previous one is gone: the viewport is degraded. */
 | {
    /** The viewport is degraded: it presents nothing, and its container says so. */
    readonly status: 'degraded';
    /** Why the last backend tried failed, or that there was none to try. */
    readonly error: SwfError;
};
/** A surface a failed handoff could not put back as it was, in a `kept` {@link SwitchOutcome}. */
export interface UnrestoredSurface {
    /** The surface. */
    readonly surfaceId: Id;
    /** Why the runtime refused to put it back, as its rejection gave it. */
    readonly error: SwfError;
}
/** What a viewport is presented with. */
export interface BackendCapabilities {
    /** What the renderer declared at registration; frozen. */
    readonly renderer: RendererCapabilities;
    /** What the compositor declared at registration; frozen. */
    readonly compositor: CompositorCapabilities;
}
/**
 * What a presenter tells its listeners, synchronously and in the order it happens. Each event is
 * frozen and shared by every listener.
 */
export type PresenterEvent = {
    /** A frame was presented (stage 8, publish). */
    readonly type: 'frame';
    /** The viewport presented. */
    readonly viewportId: Id;
    /** What the frame cost and did. */
    readonly metrics: FrameMetrics;
    /** Every fallback negotiation chose in the frame; group them with {@link groupFallbacks}. */
    readonly fallbacks: readonly FallbackDiagnostic[];
} | {
    /**
     * A frame due at a frame boundary failed. The failure is reported here, not thrown; a frame
     * asked for with {@link PresentedViewport.update} rejects instead.
     */
    readonly type: 'frame.failed';
    /** The viewport whose frame failed. */
    readonly viewportId: Id;
    /** The typed error thrown, or `INVALID_INPUT` describing anything else thrown. */
    readonly error: SwfError;
} | {
    /** The viewport is presented with another backend, its live content moved into it. */
    readonly type: 'backend.switched';
    /** The viewport that changed backend. */
    readonly viewportId: Id;
    /** The backend before, or null when it had none (it was opening, or degraded). */
    readonly from: BackendChoice | null;
    /** The backend now in use. */
    readonly to: BackendChoice;
    /** Why it changed. */
    readonly reason: SwitchReason;
    /** What the new backend declared. */
    readonly capabilities: BackendCapabilities;
}
/** A backend could not be switched to or released; `error.details.phase` says where. */
 | {
    /** A backend could not be switched to or released. */
    readonly type: 'backend.failed';
    /** The viewport concerned. */
    readonly viewportId: Id;
    /** The backend that failed. */
    readonly backend: BackendChoice;
    /**
     * `BACKEND_SWITCH_FAILED`; `details.phase` is `preparing`, `validating` or `swapping` for a
     * handoff (retryable), or `releasing` for a session whose release threw.
     */
    readonly error: SwfError;
} | {
    /**
     * The backend in use lost resources it cannot present without. The viewport hands over to
     * its other preferences at once, and does not try this backend again until
     * {@link PresentedViewport.restore} or until the renderer or compositor is registered again.
     */
    readonly type: 'backend.lost';
    /** The viewport concerned. */
    readonly viewportId: Id;
    /** The backend that lost its resources. */
    readonly backend: BackendChoice;
    /** What the session said it lost. */
    readonly reason: string;
} | {
    /**
     * No backend works: the viewport presents nothing, its container shows why, and the scene
     * stays fully usable.
     */
    readonly type: 'viewport.degraded';
    /** The viewport degraded. */
    readonly viewportId: Id;
    /** Why: the last backend's failure, or that none was left to try. */
    readonly error: SwfError;
};
/** One viewport, presented through a backend chosen from its preferences. */
export interface PresentedViewport {
    /** The viewport presented. */
    readonly viewportId: Id;
    /** Where its presentation stands; it reads the current state each time. */
    readonly state: ViewportState;
    /** The backend in use, or null when degraded or disposed. */
    readonly backend: BackendChoice | null;
    /** What the backend in use declared, as a new frozen object, or null when it has none. */
    readonly capabilities: BackendCapabilities | null;
    /** Why the viewport is degraded, or null when it is not. */
    readonly degradedBy: SwfError | null;
    /** Asks for a frame at the next frame boundary, even when nothing it reads changed. */
    invalidate(): void;
    /**
     * Presents a frame now, without waiting for a frame boundary: projects, plans, renders and
     * composes the presented scene, attaches what is live here and hides what no longer is, then
     * delivers the hints. Frames and handoffs run one at a time, in call order. A degraded viewport
     * answers with a {@link DegradedFrame}. A frame that fails rejects with what it threw, a
     * disposed viewport with {@link SwfFailure} (`INVALID_TRANSITION`).
     */
    update(): Promise<ViewportUpdate>;
    /** Whether a surface's live content is here (as of the last frame) or shown as a proxy. */
    presentation(surfaceId: Id): 'live' | 'proxy';
    /**
     * Sets how the viewport represents each surface (full, compact or label only), or with null
     * shows every surface in full again; the next frame follows it. A representation never touches
     * a surface's binding or its endpoint. Throws {@link SwfFailure} (`INVALID_INPUT`) for something
     * that is not a representation policy, leaving the current one in place.
     */
    setRepresentation(policy: RepresentationPolicy | null): void;
    /** The representation policy the viewport follows, or null when every surface is shown in full. */
    representation(): RepresentationPolicy | null;
    /**
     * Hands the viewport over to `backend`: prepares it, negotiates the scene with its
     * capabilities, rebuilds the view and moves the live content into it, then activates it at
     * once and releases the previous one. Any failure keeps the previous backend. `backend` need
     * not be one of the viewport's preferences. Switching to the backend in use answers `switched`
     * at once. Throws {@link SwfFailure} (`INVALID_INPUT`) for a choice that does not name a
     * renderer and a compositor; rejects with `INVALID_TRANSITION` once the viewport is disposed.
     */
    switchBackend(backend: BackendChoice): Promise<SwitchOutcome>;
    /**
     * Tries the backends preferred to the current one again (all of them when degraded),
     * including those that lost their resources here: for when they are available again. A
     * viewport already on its first preferred backend has nothing to try, and answers `switched`
     * with that backend. Rejects with {@link SwfFailure} (`INVALID_TRANSITION`) once the viewport
     * is disposed.
     */
    restore(): Promise<SwitchOutcome>;
    /** The last frame presented, or null. */
    lastFrame(): ViewportFrame | null;
    /**
     * Hides its surfaces here (releasing their attachments where the endpoint allows) and releases
     * its backend. Returns the surfaces whose endpoint did not allow release; their content leaves
     * with the backend's resources. Safe to call twice: both calls get the same promise. It never
     * stops a surface's producer, and afterwards the presenter no longer lists the viewport and its
     * ID can be opened again, even when the host's `showDegraded` cleanup throws (which rejects it).
     */
    dispose(): Promise<{
        /**
         * Surfaces still attached here: their endpoint does not allow release, or hiding was refused.
         */
        readonly retained: readonly Id[];
    }>;
}
/**
 * A failure presentation went on past, with no caller to reject: `LISTENER_THREW`, a listener
 * that threw while the other listeners still heard the event; `BACKGROUND_FAILED`, a handoff a
 * viewport began on its own (its backend lost its resources or was unregistered, or a preferred
 * one was registered again) that failed to finish, such as when `showDegraded` threw; or
 * `HOST_THREW`, the function `showDegraded` returned throwing when a viewport stopped being
 * degraded, while the viewport went on.
 */
export interface PresenterDiagnostic {
    /** What failed. */
    readonly code: 'LISTENER_THREW' | 'BACKGROUND_FAILED' | 'HOST_THREW';
    /** What was being done: the event a listener was handling, or the viewport's work. */
    readonly message: string;
    /** When, by the presenter's clock, in milliseconds. */
    readonly timestamp: number;
    /**
     * `reason`: what was thrown, as a message. A `BACKGROUND_FAILED` or `HOST_THREW` diagnostic
     * also has `viewportId`; `BACKGROUND_FAILED` has `work` (`lost`, `unavailable` or `restored`:
     * why the handoff began), and `HOST_THREW` has `hook` (`showDegraded`).
     */
    readonly details: Readonly<Record<string, string>>;
}
/**
 * What the presenter holds, for leak checks. Once it is disposed every count is zero and no frame
 * is requested.
 */
export interface PresenterResources {
    /** Viewports open or still opening. */
    readonly viewports: number;
    /** Renderer and compositor sessions held. */
    readonly sessions: number;
    /** Listeners on the presenter's events. */
    readonly listeners: number;
    /** Subscriptions the presenter holds on the workspace, runtime, registry and sessions. */
    readonly subscriptions: number;
    /** Whether a frame is requested from the frame source. */
    readonly frameRequested: boolean;
}
/**
 * Presents a workspace's viewports frame by frame. It reads the presented scene (the committed
 * one with open previews), so previews show without being committed; it presents a viewport only
 * when something it reads changed; it never changes the scene and never manages producers.
 */
export interface Presenter {
    /**
     * Starts presenting a viewport with the first of its backends that prepares; with none, the
     * viewport opens degraded. The viewport is listed once it started. Rejects with
     * {@link SwfFailure}: `INVALID_INPUT` for invalid options or a viewport already open or still
     * opening, `UNKNOWN_ENTITY` for a viewport not in the scene, `INVALID_TRANSITION` once the
     * presenter is disposed. When starting fails (`showDegraded` throws, say), the viewport is
     * disposed and the open rejects with that failure: nothing of it stays registered, and its ID
     * can be opened again; when disposing it fails too, the open rejects with an `AggregateError`
     * of both. The presenter owns the viewport it resolves to; dispose it, or the presenter, to
     * release its backend.
     */
    open(options: ViewportOptions): Promise<PresentedViewport>;
    /**
     * The open viewport with this ID, or undefined when none is open (never opened, still opening,
     * failed to open, or disposed).
     */
    viewport(viewportId: Id): PresentedViewport | undefined;
    /**
     * Every open viewport, in the order they were opened, without those still opening; a new array
     * on each call.
     */
    viewports(): PresentedViewport[];
    /**
     * Listens to frames, handoffs, losses and degradation. A listener that throws does not stop
     * presentation or the other listeners; its failure is kept in {@link getDiagnostics}. Returns an
     * idempotent unsubscribe.
     */
    subscribe(listener: (event: PresenterEvent) => void): () => void;
    /**
     * The last 100 failures presentation went on past (listeners that threw, handoffs a viewport
     * began on its own that failed, host cleanups that threw), oldest first.
     */
    getDiagnostics(): readonly PresenterDiagnostic[];
    /** A frozen snapshot of what the presenter holds now. */
    resources(): PresenterResources;
    /**
     * Cancels a requested frame, unsubscribes from the workspace, runtime and registry, disposes
     * every viewport (releasing their backends) and drops its listeners. Safe to call twice: both
     * calls get the same promise. The workspace, runtime, registry and every producer stay as they
     * were.
     */
    dispose(): Promise<void>;
}
/**
 * Creates a presenter. Throws {@link SwfFailure} (`INVALID_INPUT`) for invalid options: options
 * that are not an object, `frames` without `request()`, `showDegraded` or `now` that is not a
 * function, or a `budgetMs` that is not a positive finite number. The presenter subscribes to
 * the workspace, the runtime and the registry at once; call {@link Presenter.dispose} to let go of
 * them and release every viewport's backend.
 *
 * @example
 * ```ts
 * const presenter = createPresenter({
 *   workspace: workspace.reader(),
 *   runtime,
 *   registry,
 *   frames: animationFrames(window), // from @swf/backend-dom
 *   showDegraded: (container, error) => {
 *     const note = document.createElement('p');
 *     note.textContent = error.message;
 *     (container as HTMLElement).append(note);
 *     return () => note.remove();
 *   },
 * });
 * const viewport = await presenter.open({
 *   viewportId: 'main',
 *   container: element,
 *   backends: [{ renderer: 'swf.dom-renderer/1', compositor: 'swf.dom-compositor/1' }],
 * });
 * // …
 * await presenter.dispose();
 * ```
 */
export declare function createPresenter(options: PresenterOptions): Presenter;
//# sourceMappingURL=presenter.d.ts.map