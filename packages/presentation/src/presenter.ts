import type { Id, SceneState, SwfError, WorkspaceReader } from '@swf/core';
import { makeError, surfaceEffectiveState, SwfFailure } from '@swf/core';
import type { PresentationHint, PresentationOutcome, SurfaceRuntime } from '@swf/surfaces';
import type { SurfaceCondition } from './conditions.js';
import { surfaceCondition } from './conditions.js';
import type { CompositorCapabilities, RendererCapabilities } from './capabilities.js';
import type {
  ComposedFrame,
  Compositor,
  CompositorSession,
  RenderedFrame,
  RendererBackend,
  RendererSession,
  RenderFrame,
} from './contracts.js';
import type { ProjectedFragment, ScreenRect, ViewGeometry, ViewOutput } from './fragments.js';
import { createViewOutput, viewGeometryOf } from './fragments.js';
import type { FallbackDiagnostic, FallbackPolicy } from './negotiation.js';
import type { PresentationRegistry, Registered, RegistryChange } from './registry.js';
import type { RepresentationPolicy } from './representation.js';
import { representationPolicyIssue } from './representation.js';
import { planFrame } from './stages.js';
import type {
  HandoffEvent,
  Slot,
  SlotEvent,
  SwapAction,
  SwapUndo,
  ViewportState as LeanViewportState,
} from '@swf/models';
import { models } from '@swf/models';

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
export type ViewportState =
  'preparing' | 'validating' | 'swapping' | 'active' | 'presentation-degraded' | 'disposed';

/** Why a viewport's frame was due. */
export type DirtyFlag =
  /** Nodes, surfaces, selection or focus of the presented scene changed. */
  | 'scene'
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
export type SwitchOutcome =
  | {
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
export type PresenterEvent =
  | {
      /** A frame was presented (stage 8, publish). */
      readonly type: 'frame';
      /** The viewport presented. */
      readonly viewportId: Id;
      /** What the frame cost and did. */
      readonly metrics: FrameMetrics;
      /** Every fallback negotiation chose in the frame; group them with {@link groupFallbacks}. */
      readonly fallbacks: readonly FallbackDiagnostic[];
    }
  | {
      /**
       * A frame due at a frame boundary failed. The failure is reported here, not thrown; a frame
       * asked for with {@link PresentedViewport.update} rejects instead.
       */
      readonly type: 'frame.failed';
      /** The viewport whose frame failed. */
      readonly viewportId: Id;
      /** The typed error thrown, or `INVALID_INPUT` describing anything else thrown. */
      readonly error: SwfError;
    }
  | {
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
    }
  | {
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
    }
  | {
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
   * its backend. A viewport whose record is deleted shows its last frame and presents nothing more
   * until the record comes back; dispose it with the record. Returns the surfaces whose endpoint did not allow release; their content leaves
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
export function createPresenter(options: PresenterOptions): Presenter {
  const raw: unknown = options;
  if (typeof raw !== 'object' || raw === null) {
    throw invalid('presenter options must be an object');
  }
  const frames = (options as { frames?: Partial<FrameSource> | null }).frames;
  if (typeof frames?.request !== 'function') {
    throw invalid('frames must be a frame source with request()');
  }
  if (typeof options.showDegraded !== 'function') {
    throw invalid('showDegraded must be a function');
  }
  const budget = options.budgetMs ?? 8;
  if (typeof budget !== 'number' || !(budget > 0) || !Number.isFinite(budget)) {
    throw invalid('budgetMs must be a positive finite number');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw invalid('now must be a function');
  }
  return new PresenterImpl(options, budget);
}

function invalid(message: string): SwfFailure {
  return new SwfFailure(makeError('INVALID_INPUT', message));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const BOUND_STATES = new Set(['ready', 'presented', 'hidden']);

const sameChoice = (a: BackendChoice, b: BackendChoice) =>
  a.renderer === b.renderer && a.compositor === b.compositor;

/** A prepared backend for one viewport. */
interface Backend {
  readonly choice: BackendChoice;
  readonly renderer: Registered<RendererBackend, RendererCapabilities>;
  readonly compositor: Registered<Compositor, CompositorCapabilities>;
  readonly rendererSession: RendererSession;
  readonly compositorSession: CompositorSession;
  /** What stops watching its sessions for loss, each with the session it watches. */
  readonly watches: LossWatch[];
}

/** A watch on one of a backend's sessions for loss: what stops it, and which session it is. */
interface LossWatch {
  readonly session: 'renderer' | 'compositor';
  readonly stop: () => void;
}

/** Why a viewport began a handoff on its own, as its `BACKGROUND_FAILED` diagnostic says it. */
const BACKGROUND_WORK: Readonly<Record<'lost' | 'unavailable' | 'restored', string>> =
  Object.freeze({
    lost: 'the loss of its backend’s resources',
    unavailable: 'its backend being unregistered',
    restored: 'a preferred backend being registered again',
  });

class PresenterImpl implements Presenter {
  readonly options: PresenterOptions;
  readonly budget: number;
  readonly now: () => number;
  readonly #viewports = new Map<Id, ViewportImpl>();
  readonly #listeners = new Set<(event: PresenterEvent) => void>();
  readonly #diagnostics: PresenterDiagnostic[] = [];
  readonly #unsubscribe: (() => void)[];
  #cancelFrame: (() => void) | null = null;
  #ticking = false;
  #disposed: Promise<void> | null = null;

  constructor(options: PresenterOptions, budget: number) {
    this.options = options;
    this.budget = budget;
    this.now = options.now ?? Date.now;
    this.#unsubscribe = [
      options.workspace.subscribe(() => {
        this.request();
      }),
      options.runtime.subscribe((event) => {
        // A viewport's own attachments change while it presents; other viewports may care
        // (a single-owner endpoint becomes free), and changes of binding concern every one.
        switch (event.type) {
          case 'presentation.viewportChanged':
            this.#markSurfaces((v) => v.viewportId !== event.payload.viewportId);
            break;
          case 'presentation.stateChanged':
            if (BOUND_STATES.has(event.payload.from ?? '') !== BOUND_STATES.has(event.payload.to)) {
              this.#markSurfaces(() => true);
            }
            break;
          default:
            this.#markSurfaces(() => true);
        }
      }),
      options.registry.subscribe((change) => {
        for (const viewport of this.#viewports.values()) {
          viewport.registryChanged(change);
        }
      }),
    ];
  }

  async open(options: ViewportOptions): Promise<PresentedViewport> {
    if (this.#disposed !== null) {
      throw new SwfFailure(makeError('INVALID_TRANSITION', 'the presenter is disposed'));
    }
    const checked = checkViewportOptions(options);
    const slot = this.#viewports.get(checked.viewportId)?.slot ?? ABSENT;
    const opening = models.slotStep(slot, { kind: 'open' });
    if (opening === null) {
      throw invalid(`viewport "${checked.viewportId}" is already ${slot.kind}`);
    }
    // Throws UNKNOWN_ENTITY for a viewport the scene does not have.
    viewGeometryOf(this.options.workspace.getState(), checked.viewportId);
    const viewport = new ViewportImpl(this, checked, opening);
    this.#viewports.set(checked.viewportId, viewport);
    try {
      await viewport.start();
    } catch (error) {
      // A viewport that cannot start is disposed, which frees its ID.
      try {
        await viewport.dispose();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          `viewport "${checked.viewportId}" failed to start (${describe(error)}), and disposing it failed too (${describe(cleanup)})`,
          { cause: cleanup },
        );
      }
      throw error;
    }
    return viewport;
  }

  viewport(viewportId: Id): PresentedViewport | undefined {
    const viewport = this.#viewports.get(viewportId);
    return viewport !== undefined && models.slotListed(viewport.slot) ? viewport : undefined;
  }

  viewports(): PresentedViewport[] {
    return [...this.#viewports.values()].filter((v) => models.slotListed(v.slot));
  }

  subscribe(listener: (event: PresenterEvent) => void): () => void {
    const entry = (event: PresenterEvent) => {
      listener(event);
    };
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }

  getDiagnostics(): readonly PresenterDiagnostic[] {
    return Object.freeze([...this.#diagnostics]);
  }

  resources(): PresenterResources {
    const viewports = [...this.#viewports.values()];
    const held = viewports.filter((v) => v.backend !== null).length;
    return Object.freeze({
      viewports: viewports.length,
      sessions: held * 2,
      listeners: this.#listeners.size,
      subscriptions: this.#unsubscribe.length + held * 2,
      frameRequested: this.#cancelFrame !== null,
    });
  }

  dispose(): Promise<void> {
    this.#disposed ??= (async () => {
      this.#cancelFrame?.();
      this.#cancelFrame = null;
      for (const unsubscribe of this.#unsubscribe.splice(0)) {
        unsubscribe();
      }
      for (const viewport of [...this.#viewports.values()]) {
        await viewport.dispose();
      }
      this.#listeners.clear();
    })();
    return this.#disposed;
  }

  emit(event: PresenterEvent): void {
    const frozen = Object.freeze(event);
    for (const listener of [...this.#listeners]) {
      try {
        listener(frozen);
      } catch (error) {
        // Presentation goes on, and the other listeners still hear the event.
        this.diagnose('LISTENER_THREW', `a listener threw while handling ${event.type}`, {
          reason: describe(error),
        });
      }
    }
  }

  /** Keeps a failure presentation went on past, with the last 100 kept. */
  diagnose(
    code: PresenterDiagnostic['code'],
    message: string,
    details: Readonly<Record<string, string>>,
  ): void {
    this.#diagnostics.push(
      Object.freeze({
        code,
        message,
        timestamp: this.now(),
        details: Object.freeze({ ...details }),
      }),
    );
    this.#diagnostics.splice(0, this.#diagnostics.length - 100);
  }

  /**
   * Moves a viewport's ID as the presenter model decides on `event`, and lets go of the viewport
   * once its ID is free; an event out of order is a defect.
   */
  step(viewport: ViewportImpl, event: SlotEvent['kind']): void {
    const next = models.slotStep(viewport.slot, { kind: event });
    if (next === null || this.#viewports.get(viewport.viewportId) !== viewport) {
      throw new Error(
        `viewport "${viewport.viewportId}" cannot take ${event} while ${viewport.slot.kind}`,
      );
    }
    viewport.slot = next;
    if (next.kind === 'absent') {
      this.#viewports.delete(viewport.viewportId);
    }
  }

  /** Asks the frame source for one frame, unless one is already coming. */
  request(): void {
    if (this.#cancelFrame !== null || this.#ticking || this.#disposed !== null) {
      return;
    }
    this.#cancelFrame = this.options.frames.request(() => {
      this.#cancelFrame = null;
      return this.#tick();
    });
  }

  #markSurfaces(which: (viewport: ViewportImpl) => boolean): void {
    for (const viewport of this.#viewports.values()) {
      if (which(viewport)) {
        viewport.mark('surfaces');
      }
    }
    this.request();
  }

  /**
   * One frame: every due interactive viewport is presented, then background ones while the
   * budget lasts (always at least one viewport, so every one gets its turn). Those left over wait
   * for the next frame with their latest state; nothing queues up behind them.
   */
  async #tick(): Promise<void> {
    this.#ticking = true;
    try {
      const started = this.now();
      const due = [...this.#viewports.values()]
        .map((viewport) => ({ viewport, flags: viewport.due() }))
        .filter((d): d is { viewport: ViewportImpl; flags: DirtyFlag[] } => d.flags !== null)
        .sort(
          (a, b) =>
            Number(a.viewport.priority === 'background') -
              Number(b.viewport.priority === 'background') ||
            a.viewport.skipped - b.viewport.skipped,
        );
      let presented = 0;
      for (const { viewport, flags } of due) {
        const late =
          viewport.priority === 'background' &&
          presented > 0 &&
          this.now() - started >= this.budget;
        if (late) {
          viewport.skipped += 1;
          continue;
        }
        presented += 1;
        await viewport.scheduled(flags);
      }
    } finally {
      this.#ticking = false;
    }
    if ([...this.#viewports.values()].some((v) => v.due() !== null)) {
      this.request();
    }
  }
}

function checkViewportOptions(options: ViewportOptions): ViewportOptions {
  const raw: unknown = options;
  if (typeof raw !== 'object' || raw === null) {
    throw invalid('viewport options must be an object');
  }
  if (typeof options.viewportId !== 'string' || options.viewportId.trim() === '') {
    throw invalid('viewportId must be a non-blank string');
  }
  const backends: unknown = options.backends;
  if (!Array.isArray(backends) || backends.length === 0) {
    throw invalid(`viewport "${options.viewportId}": backends must be a non-empty array`);
  }
  backends.forEach((b: unknown, i) => {
    const choice = b as Partial<BackendChoice> | null;
    if (
      typeof choice !== 'object' ||
      choice === null ||
      typeof choice.renderer !== 'string' ||
      typeof choice.compositor !== 'string'
    ) {
      throw invalid(
        `viewport "${options.viewportId}": backends[${String(i)}] must name a renderer and a compositor`,
      );
    }
  });
  if (options.priority !== undefined && !['interactive', 'background'].includes(options.priority)) {
    throw invalid(
      `viewport "${options.viewportId}": priority must be "interactive" or "background"`,
    );
  }
  const maxLive = options.maxLive;
  if (
    maxLive !== undefined &&
    !(maxLive === Infinity || (Number.isInteger(maxLive) && maxLive >= 0))
  ) {
    throw invalid(`viewport "${options.viewportId}": maxLive must be a whole number or Infinity`);
  }
  if (options.release !== undefined && typeof options.release !== 'boolean') {
    throw invalid(`viewport "${options.viewportId}": release must be a boolean`);
  }
  return Object.freeze({
    ...options,
    backends: Object.freeze(backends.map((b: BackendChoice) => Object.freeze({ ...b }))),
  });
}

/** What the last frame read, to tell whether the next one has anything to do. */
interface Seen {
  readonly scene: SceneState;
  readonly view: string;
  readonly fragments: readonly ProjectedFragment[];
  readonly projectorId: string;
}

class ViewportImpl implements PresentedViewport {
  readonly viewportId: Id;
  readonly priority: 'interactive' | 'background';
  skipped = 0;
  /** Where its ID is in the presenter: opening until it started, then open. */
  slot: Slot;
  readonly #presenter: PresenterImpl;
  readonly #options: ViewportOptions;
  #state: ViewportState = STATES[models.viewportOpened().kind];
  #backend: Backend | null = null;
  #degradedBy: SwfError | null = null;
  #hideDegraded: (() => void) | null = null;
  /** Backends that lost their resources here, by renderer and compositor; not tried again until restored. */
  readonly #lost = new Set<string>();
  readonly #flags = new Set<DirtyFlag>();
  #seen: Seen | null = null;
  #representation: RepresentationPolicy | null = null;
  #live: ReadonlySet<Id> = new Set();
  #last: ViewportFrame | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #disposed: Promise<{ readonly retained: readonly Id[] }> | null = null;

  constructor(presenter: PresenterImpl, options: ViewportOptions, slot: Slot) {
    this.slot = slot;
    this.#presenter = presenter;
    this.#options = options;
    this.viewportId = options.viewportId;
    this.priority = options.priority ?? 'interactive';
  }

  get state(): ViewportState {
    return this.#state;
  }

  get backend(): BackendChoice | null {
    return this.#backend?.choice ?? null;
  }

  get capabilities(): BackendCapabilities | null {
    const backend = this.#backend;
    return backend === null
      ? null
      : Object.freeze({
          renderer: backend.renderer.capabilities,
          compositor: backend.compositor.capabilities,
        });
  }

  get degradedBy(): SwfError | null {
    return this.#degradedBy;
  }

  /**
   * Activates the first preferred backend that works, or opens degraded; then the presenter lists
   * it. A failure leaves it opening, for the presenter to dispose.
   */
  async start(): Promise<void> {
    await this.#serial(async () => {
      await this.#activate(this.#options.backends, 'opened', false);
      this.#presenter.step(this, 'started');
    });
  }

  invalidate(): void {
    this.mark('requested');
  }

  mark(flag: DirtyFlag): void {
    this.#flags.add(flag);
    this.#presenter.request();
  }

  update(): Promise<ViewportUpdate> {
    return this.#serial(() => this.#present([...(this.due() ?? []), 'requested']));
  }

  /** A frame at a frame boundary; a failure is reported, not thrown. */
  scheduled(flags: DirtyFlag[]): Promise<void> {
    return this.#serial(async () => {
      if (!models.viewportPresents(leanState(this.#state))) {
        return;
      }
      try {
        await this.#present(flags);
      } catch (error) {
        this.#presenter.emit({
          type: 'frame.failed',
          viewportId: this.viewportId,
          error:
            error instanceof SwfFailure
              ? error.error
              : makeError(
                  'INVALID_INPUT',
                  `frame of viewport "${this.viewportId}" failed: ${describe(error)}`,
                  {
                    entityId: this.viewportId,
                  },
                ),
        });
      }
    });
  }

  presentation(surfaceId: Id): 'live' | 'proxy' {
    return this.#live.has(surfaceId) ? 'live' : 'proxy';
  }

  setRepresentation(policy: RepresentationPolicy | null): void {
    if (policy !== null) {
      const issue = representationPolicyIssue(policy);
      if (issue !== null) {
        throw invalid(`viewport "${this.viewportId}": ${issue}`);
      }
    }
    if (policy === this.#representation) {
      return;
    }
    this.#representation = policy;
    this.mark('representation');
  }

  representation(): RepresentationPolicy | null {
    return this.#representation;
  }

  switchBackend(backend: BackendChoice): Promise<SwitchOutcome> {
    const checked = checkViewportOptions({ ...this.#options, backends: [backend] }).backends;
    return this.#serial(() => this.#activate(checked, 'requested', this.#backend !== null));
  }

  restore(): Promise<SwitchOutcome> {
    return this.#serial(() => {
      this.#lost.clear();
      return this.#activate(this.#ahead(), 'restored', this.#backend !== null);
    });
  }

  lastFrame(): ViewportFrame | null {
    return this.#last;
  }

  dispose(): Promise<{ readonly retained: readonly Id[] }> {
    this.#disposed ??= this.#serial(() => this.#dispose());
    return this.#disposed;
  }

  /**
   * The dirt that makes a frame due, or null when there is none. The presented scene is compared
   * by what this viewport reads of it, so another viewport's camera, say, leaves this one be. A
   * viewport whose record the presented scene no longer has is never due: there is no view to
   * present until the record comes back, and its host disposes it.
   */
  due(): DirtyFlag[] | null {
    if (!models.viewportPresents(leanState(this.#state))) {
      return null;
    }
    const scene = this.#presenter.options.workspace.getPresented();
    if (!scene.viewports.has(this.viewportId)) {
      return null;
    }
    const flags = new Set(this.#flags);
    const seen = this.#seen;
    if (seen === null) {
      flags.add('scene');
    } else {
      if (scene !== seen.scene) {
        if (!sameContent(scene, seen.scene)) {
          flags.add('scene');
        }
        if (viewKey(viewGeometryOf(scene, this.viewportId)) !== seen.view) {
          flags.add('view');
        }
      }
    }
    return flags.size === 0 ? null : [...flags];
  }

  /** A registration changed: a backend in use may be gone, or a preferred one back. */
  registryChanged(change: RegistryChange): void {
    if (change.kind === 'projector') {
      this.mark('view');
      return;
    }
    const uses = (choice: BackendChoice) =>
      change.kind === 'renderer' ? choice.renderer === change.id : choice.compositor === change.id;
    if (!change.registered) {
      const current = this.#backend;
      if (current !== null && uses(current.choice)) {
        this.#background('unavailable', async () => {
          if (this.#backend?.choice === current.choice) {
            await this.#activate(this.#fallbacks(current.choice), 'unavailable', false);
          }
        });
      }
      return;
    }
    // A module registered afresh has not lost anything yet.
    for (const key of [...this.#lost]) {
      const [renderer, compositor] = JSON.parse(key) as [string, string];
      if (uses({ renderer, compositor })) {
        this.#lost.delete(key);
      }
    }
    if (this.#ahead().some(uses)) {
      this.#background('restored', () =>
        this.#activate(this.#ahead(), 'restored', this.#backend !== null),
      );
    }
  }

  /**
   * Queues a handoff the viewport begins on its own, after the work queued before it. Nobody
   * waits for it, so its failure is kept as a `BACKGROUND_FAILED` diagnostic; once the viewport
   * is disposed it has nothing left to do and does nothing.
   */
  #background(work: keyof typeof BACKGROUND_WORK, run: () => Promise<unknown>): void {
    const next = this.#queue.then(() =>
      models.viewportAdmits(leanState(this.#state)) ? run() : undefined,
    );
    this.#queue = next.catch(() => undefined);
    next.catch((error: unknown) => {
      this.#presenter.diagnose(
        'BACKGROUND_FAILED',
        `viewport "${this.viewportId}" failed to finish handling ${BACKGROUND_WORK[work]}`,
        { viewportId: this.viewportId, work, reason: describe(error) },
      );
    });
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(() => {
      if (!models.viewportAdmits(leanState(this.#state))) {
        throw new SwfFailure(
          makeError('INVALID_TRANSITION', `viewport "${this.viewportId}" is disposed`, {
            entityId: this.viewportId,
          }),
        );
      }
      return work();
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** The preferred backends ahead of the current one: all of them when there is none. */
  #ahead(): BackendChoice[] {
    const current = this.#backend?.choice;
    const all = this.#options.backends;
    const at = current === undefined ? -1 : all.findIndex((b) => sameChoice(b, current));
    return [...(at < 0 ? all : all.slice(0, at))];
  }

  /** The fallbacks for a backend that went away: the preferences in order, without it. */
  #fallbacks(gone: BackendChoice): BackendChoice[] {
    return this.#options.backends.filter((b) => !sameChoice(b, gone));
  }

  // --- frames --------------------------------------------------------------------------------

  async #present(dirty: readonly DirtyFlag[]): Promise<ViewportUpdate> {
    const backend = this.#backend;
    if (models.viewportDegraded(leanState(this.#state), backend !== null) || backend === null) {
      return Object.freeze({
        status: 'degraded',
        viewportId: this.viewportId,
        error: this.#degradedBy ?? this.#noBackend(),
      });
    }
    const { runtime } = this.#presenter.options;
    const started = this.#presenter.now();
    const skipped = this.skipped;
    this.skipped = 0;
    this.#flags.clear();
    // Stage 4: project the presented scene.
    const scene = this.#presenter.options.workspace.getPresented();
    const view = viewGeometryOf(scene, this.viewportId);
    const output = this.#project(scene, view);
    const notHere = this.#virtualized(scene, output);
    const refused: { surfaceId: Id; error: SwfError }[] = [];
    const presented: Id[] = [];
    // Each refusal shows that surface as a proxy and plans again; refusals only grow, so this ends.
    for (;;) {
      // Stages 6 and 7: plan, render and compose.
      const frame = this.#plan(scene, view, output, backend, notHere);
      const rendered = backend.rendererSession.render(frame);
      const composed = backend.compositorSession.compose(rendered);
      const live = liveIn(rendered);
      let replan = false;
      for (const surfaceId of live) {
        const here = attachmentHere(runtime, surfaceId, this.viewportId);
        if (here?.visible === true) {
          continue;
        }
        const outcome = await runtime.present(
          surfaceId,
          this.viewportId,
          this.#target(backend, surfaceId),
        );
        if (outcome.status === 'ok') {
          presented.push(surfaceId);
        } else {
          refused.push({ surfaceId, error: outcome.error });
          notHere.add(surfaceId);
          replan = true;
        }
      }
      if (replan) {
        continue;
      }
      const { hidden, refused: hiding } = await this.#hideAllBut(
        live,
        this.#options.release === true,
      );
      const [unhidden] = hiding;
      if (unhidden !== undefined) {
        throw new SwfFailure(unhidden);
      }
      this.#live = new Set(live);
      // Stage 5: the hints, once the attachments have settled.
      const hinted = this.#hint(scene, view, frame);
      const metrics: FrameMetrics = Object.freeze({
        viewportId: this.viewportId,
        rendererId: backend.choice.renderer,
        compositorId: backend.choice.compositor,
        sceneRevision: scene.revision,
        durationMs: this.#presenter.now() - started,
        skipped,
        dirty: Object.freeze([...new Set(dirty)]),
        fragments: frame.planned.length,
        live: live.length,
        writes: rendered.writes + composed.writes,
        hints: hinted.delivered,
      });
      const result: ViewportFrame = Object.freeze({
        status: 'presented',
        viewportId: this.viewportId,
        frame,
        rendered,
        composed,
        presented: Object.freeze(presented),
        hidden: Object.freeze(hidden),
        refused: Object.freeze(refused),
        hints: hinted.hints,
        metrics,
      });
      this.#last = result;
      // Stage 8: publish.
      this.#presenter.emit({
        type: 'frame',
        viewportId: this.viewportId,
        metrics,
        fallbacks: frame.fallbacks,
      });
      return result;
    }
  }

  /** Stage 4, cached: the fragments only change when what this viewport reads changes. */
  #project(scene: SceneState, view: ViewGeometry): ViewOutput {
    const projector = this.#presenter.options.registry.projector(view.projectionId);
    if (projector === undefined) {
      throw new SwfFailure(
        makeError(
          'UNSUPPORTED_CAPABILITY',
          `viewport "${this.viewportId}" uses projection "${view.projectionId}", which is not registered`,
          { entityId: this.viewportId },
        ),
      );
    }
    const key = viewKey(view);
    const seen = this.#seen;
    // The same view keeps what it projected: all of it while the scene shows the same, and what
    // stands where it stood otherwise.
    const sameView = seen !== null && seen.view === key && seen.projectorId === view.projectionId;
    const fragments =
      sameView && sameContent(scene, seen.scene)
        ? seen.fragments
        : projector.module.project(
            scene,
            view,
            (id) => this.#presenter.options.workspace.presentedGeometry(id),
            sameView ? { scene: seen.scene, fragments: seen.fragments } : undefined,
          );
    this.#seen = { scene, view: key, fragments, projectorId: view.projectionId };
    return createViewOutput(scene, this.viewportId, fragments);
  }

  /** Stage 6. */
  #plan(
    scene: SceneState,
    view: ViewGeometry,
    output: ViewOutput,
    backend: Backend,
    notHere: ReadonlySet<Id>,
  ): RenderFrame {
    const { runtime, registry, workspace, policy } = this.#presenter.options;
    const projector = registry.projector(view.projectionId);
    if (projector === undefined) {
      throw new SwfFailure(
        makeError(
          'UNSUPPORTED_CAPABILITY',
          `viewport "${this.viewportId}" uses projection "${view.projectionId}", which is not registered`,
          { entityId: this.viewportId },
        ),
      );
    }
    const attachedElsewhere = (id: Id): boolean =>
      runtime.get(id)?.viewports.some((v) => v.viewportId !== this.viewportId) ?? false;
    const condition = (id: Id): SurfaceCondition =>
      surfaceCondition(runtime.get(id), attachedElsewhere(id));
    return planFrame({
      scene,
      view,
      output,
      renderer: { id: backend.choice.renderer, capabilities: backend.renderer.capabilities },
      compositor: { id: backend.choice.compositor, capabilities: backend.compositor.capabilities },
      projection: projector.capabilities,
      ...(policy === undefined ? {} : { policy }),
      ...(this.#representation === null ? {} : { representation: this.#representation }),
      condition,
      // A single-owner handle presented in another viewport stays there; this one shows a proxy.
      viewportOwns: (id) => {
        if (notHere.has(id)) {
          return false;
        }
        const now = condition(id);
        return !(now.kind === 'bound' && now.presentedElsewhere);
      },
      geometry: (id) => workspace.presentedGeometry(id),
    });
  }

  /**
   * The surfaces beyond `maxLive` that are shown as proxies here: the focused window's first, then
   * the selection's in order, then the largest on screen.
   */
  #virtualized(scene: SceneState, output: ViewOutput): Set<Id> {
    const max = this.#options.maxLive ?? Infinity;
    const owners = output.fragments.filter((f) => f.nativeOwner);
    if (owners.length <= max) {
      return new Set();
    }
    const ownerOf = (id: Id) => scene.surfaces.get(id)?.ownerNodeId;
    const rank = (f: ProjectedFragment) => {
      const owner = ownerOf(f.surfaceId);
      if (owner !== undefined && owner === scene.focusedId) {
        return -1;
      }
      const selected = owner === undefined ? -1 : scene.selection.indexOf(owner);
      return selected < 0 ? scene.selection.length : selected;
    };
    const ordered = [...owners].sort(
      (a, b) =>
        rank(a) - rank(b) ||
        area(b.bounds) - area(a.bounds) ||
        (a.surfaceId < b.surfaceId ? -1 : a.surfaceId > b.surfaceId ? 1 : 0),
    );
    return new Set(ordered.slice(max).map((f) => f.surfaceId));
  }

  /** Where a surface's live content goes in this backend's last render. */
  #target(backend: Backend, surfaceId: Id): unknown {
    const target = backend.rendererSession.targetOf(surfaceId);
    if (target === undefined) {
      throw new Error(
        `surface "${surfaceId}" is live in viewport "${this.viewportId}" without a target`,
      );
    }
    return target;
  }

  /**
   * Hides here every surface shown here that is not in `live`. With `release`, attachments are
   * released where the endpoint declares safe detachment, hidden ones included; the others stay
   * attached, hidden, and the endpoint stays the host's. A refusal leaves that surface as it is
   * and the others are hidden all the same; returns the surfaces hidden and every refusal.
   */
  async #hideAllBut(
    live: readonly Id[],
    release: boolean,
  ): Promise<{ readonly hidden: Id[]; readonly refused: SwfError[] }> {
    const { runtime } = this.#presenter.options;
    const hidden: Id[] = [];
    const refused: SwfError[] = [];
    for (const presentation of runtime.list()) {
      const here = presentation.viewports.find((v) => v.viewportId === this.viewportId);
      if (here === undefined || live.includes(presentation.surfaceId)) {
        continue;
      }
      const releasable = release && presentation.capabilities?.safeDetach === true;
      if (!here.visible && !releasable) {
        continue;
      }
      const outcome = await runtime.hide(presentation.surfaceId, this.viewportId, { release });
      if (outcome.status === 'rejected') {
        refused.push(outcome.error);
      } else if (here.visible) {
        hidden.push(presentation.surfaceId);
      }
    }
    return { hidden, refused };
  }

  /**
   * Stage 5: one advisory hint per surface attached here, built from this frame. Visibility,
   * mounting, the scene's own flag, intersection, occlusion and attention are kept apart.
   * Repeats are coalesced away by the runtime; returns how many hints were delivered.
   */
  #hint(
    scene: SceneState,
    view: ViewGeometry,
    frame: RenderFrame,
  ): { readonly hints: readonly PresentationHint[]; readonly delivered: number } {
    const { runtime } = this.#presenter.options;
    const hints: PresentationHint[] = [];
    let delivered = 0;
    for (const presentation of runtime.list()) {
      const here = presentation.viewports.find((v) => v.viewportId === this.viewportId);
      if (here === undefined) {
        continue;
      }
      const hint = hintFor(scene, view, frame, presentation.surfaceId, this.#live);
      if (hint === null) {
        continue;
      }
      hints.push(hint);
      const outcome = runtime.deliverHint(hint);
      if (outcome.status === 'ok' && outcome.delivered) {
        delivered += 1;
      }
    }
    return { hints: Object.freeze(hints), delivered };
  }

  // --- handoff -------------------------------------------------------------------------------

  /**
   * Hands over to the first of `candidates` that works. When none does, the previous backend
   * stays when it still works (`usable`); otherwise the viewport degrades.
   */
  async #activate(
    candidates: readonly BackendChoice[],
    reason: SwitchReason,
    usable: boolean,
  ): Promise<SwitchOutcome> {
    const old = this.#backend;
    let error: SwfError | null = null;
    // The surfaces a failed rollback could not put back, until a later rollback puts them back.
    const unrestored = new Map<Id, SwfError>();
    for (const choice of candidates) {
      if (old !== null && usable && sameChoice(old.choice, choice)) {
        return Object.freeze({ status: 'switched', backend: old.choice });
      }
      const failure = await this.#handoff(choice, old, usable, reason, unrestored);
      if (failure === null) {
        return Object.freeze({ status: 'switched', backend: choice });
      }
      // Everything the candidate did is undone: the viewport is back on the previous backend,
      // active when it still works and degraded otherwise, before the next candidate is begun.
      this.#advance({ kind: 'failed', oldUsable: old !== null && usable });
      error = failure;
      this.#presenter.emit({
        type: 'backend.failed',
        viewportId: this.viewportId,
        backend: choice,
        error: failure,
      });
    }
    // Every candidate tried set `error`: none is set only when there was nothing to try.
    const settlement = models.settle(
      error === null ? { kind: 'untried' } : { kind: 'failed', restored: unrestored.size === 0 },
      old !== null && usable,
    );
    const state = STATES[models.settledState(settlement).kind];
    switch (settlement.kind) {
      case 'switched':
        if (old === null) {
          throw new Error(
            `the handoff model settled viewport "${this.viewportId}" as switched without a backend`,
          );
        }
        this.#state = state;
        return Object.freeze({ status: 'switched', backend: old.choice });
      case 'kept':
        if (old === null || error === null) {
          throw new Error(
            `the handoff model kept viewport "${this.viewportId}" without a backend or a failure`,
          );
        }
        this.#state = state;
        return Object.freeze({
          status: 'kept',
          backend: old.choice,
          error,
          unrestored: Object.freeze(
            [...unrestored].map(([surfaceId, why]) => Object.freeze({ surfaceId, error: why })),
          ),
        });
      case 'degraded': {
        const why = error ?? this.#noBackend();
        await this.#degrade(why, state);
        return Object.freeze({ status: 'degraded', error: why });
      }
    }
  }

  /**
   * Prepares `choice`, negotiates the scene with it, rebuilds the view in it and moves the live
   * content over, then watches it for loss, activates it and releases `old`. Returns null on
   * success; on failure, every session it prepared is released and every step it carried out is
   * undone, so the previous backend is as it was, but for the surfaces an undo step could not put
   * back: those are kept in `unrestored`, and a surface put back is taken out of it.
   */
  async #handoff(
    choice: BackendChoice,
    old: Backend | null,
    usable: boolean,
    reason: SwitchReason,
    unrestored: Map<Id, SwfError>,
  ): Promise<SwfError | null> {
    const { registry, workspace, runtime } = this.#presenter.options;
    const fail = (
      phase: string,
      message: string,
      cause?: unknown,
      left: readonly Id[] = [],
    ): SwfError =>
      makeError(
        'BACKEND_SWITCH_FAILED',
        `viewport "${this.viewportId}" cannot switch to renderer "${choice.renderer}" with compositor "${choice.compositor}": ${message}`,
        {
          entityId: this.viewportId,
          retryable: true,
          details: {
            phase,
            renderer: choice.renderer,
            compositor: choice.compositor,
            ...(cause === undefined ? {} : { reason: describe(cause) }),
            ...(left.length === 0 ? {} : { unrestored: Object.freeze([...left]) }),
          },
        },
      );
    this.#advance({ kind: 'begin' });
    const renderer = registry.renderer(choice.renderer);
    const compositor = registry.compositor(choice.compositor);
    if (renderer === undefined) {
      return fail('preparing', 'the renderer is not registered');
    }
    if (compositor === undefined) {
      return fail('preparing', 'the compositor is not registered');
    }
    if (this.#lost.has(lostKey(choice))) {
      return fail('preparing', 'it lost its resources in this viewport and was not restored');
    }
    const scene = workspace.getPresented();
    let view: ViewGeometry;
    let rendererSession: RendererSession | null = null;
    let compositorSession: CompositorSession | null = null;
    try {
      view = viewGeometryOf(scene, this.viewportId);
      rendererSession = await renderer.module.prepare(scene, view);
      compositorSession = await compositor.module.prepare(
        { viewportId: this.viewportId, container: this.#options.container },
        rendererSession,
      );
    } catch (error) {
      await this.#releaseQuietly(choice, compositorSession, rendererSession);
      return fail('preparing', 'it could not be prepared', error);
    }
    const candidate: Backend = {
      choice,
      renderer,
      compositor,
      rendererSession,
      compositorSession,
      watches: [],
    };
    const abandon = async (error: SwfError) => {
      await this.#releaseQuietly(choice, candidate.compositorSession, candidate.rendererSession);
      return error;
    };

    // Validating: the scene negotiated with the new capabilities, and the live content movable.
    this.#advance({ kind: 'prepared' });
    const stranded = new Set<Id>();
    for (const presentation of runtime.list()) {
      const surfaceId = presentation.surfaceId;
      if (attachmentHere(runtime, surfaceId, this.viewportId) === undefined) {
        continue;
      }
      const validation = models.validateSurface(
        usable,
        presentation.capabilities?.safeDetach === true,
      );
      if (validation.kind === 'movable') {
        continue;
      }
      if (validation.kind === 'refuse') {
        return abandon(
          fail(
            'validating',
            `surface "${surfaceId}" is attached here and its endpoint does not allow safe detachment, so it cannot move`,
          ),
        );
      }
      // The old backend is gone: what cannot move is shown as a proxy, attached but hidden.
      stranded.add(surfaceId);
    }
    let frame: RenderFrame;
    try {
      const output = createViewOutput(scene, this.viewportId, this.#projectFresh(scene, view));
      frame = this.#plan(scene, view, output, candidate, stranded);
    } catch (error) {
      return abandon(fail('validating', 'the scene cannot be planned with it', error));
    }

    // Swapping: rebuild the view in the new resources and move the live content into them.
    this.#advance({ kind: 'validated' });
    let live: Id[];
    try {
      const rendered = candidate.rendererSession.render(frame);
      candidate.compositorSession.compose(rendered);
      live = liveIn(rendered);
    } catch (error) {
      return abandon(fail('swapping', 'it could not render the view', error));
    }
    const undo: { readonly surfaceId: Id; readonly run: () => Promise<PresentationOutcome> }[] = [];
    // Every undo step is carried out, latest first, whether or not one before it failed: a
    // surface not put back is kept in `unrestored`, and one put back is taken out of it.
    const rollback = async (phase: string, message: string, cause?: unknown) => {
      const left: Id[] = [];
      for (const step of undo.reverse()) {
        const outcome = await step.run();
        if (outcome.status === 'ok') {
          unrestored.delete(step.surfaceId);
        } else {
          unrestored.set(step.surfaceId, outcome.error);
          left.push(step.surfaceId);
        }
      }
      return abandon(fail(phase, message, cause, left));
    };
    // Attachments here move into the new resources when they stay live, and leave the old ones
    // (released where the endpoint allows) when they do not. Newly live content is attached by
    // the next frame, like any other.
    for (const presentation of runtime.list()) {
      const surfaceId = presentation.surfaceId;
      const here = presentation.viewports.find((v) => v.viewportId === this.viewportId);
      if (here === undefined) {
        continue;
      }
      const from = old?.rendererSession.targetOf(surfaceId);
      const action = models.swapSurface(live.includes(surfaceId), stranded.has(surfaceId));
      let outcome: PresentationOutcome;
      if (action.kind === 'move') {
        const target = candidate.rendererSession.targetOf(surfaceId);
        if (target === undefined) {
          return rollback('swapping', `surface "${surfaceId}" is live without a target`);
        }
        outcome = await runtime.move(surfaceId, this.viewportId, target);
      } else {
        // A surface kept hidden cannot leave without safe detachment: it stays attached, hidden,
        // and the host's.
        outcome = await runtime.hide(surfaceId, this.viewportId, {
          release: action.kind === 'release',
        });
      }
      const step = models.swapStep(
        action,
        outcome.status === 'ok',
        here.visible,
        from !== undefined,
      );
      if (step.kind === 'rollback') {
        return rollback(
          'swapping',
          `surface "${surfaceId}" could not be ${SWAP_VERBS[action.kind]}`,
          outcome.status === 'rejected' ? outcome.error.message : undefined,
        );
      }
      const back = this.#undoStep(step.undo, surfaceId, from, here.visible);
      if (back !== null) {
        undo.push({ surfaceId, run: back });
      }
    }

    // A backend whose loss cannot be watched cannot be used: watching is the last step that can
    // fail, before the previous backend is let go.
    try {
      this.#watch(candidate);
    } catch (error) {
      return rollback('swapping', 'its loss could not be watched', error);
    }
    // Activate at once, then release the previous backend.
    this.#backend = candidate;
    this.#live = new Set(
      live.filter((id) => attachmentHere(runtime, id, this.viewportId)?.visible === true),
    );
    this.#advance({ kind: 'swapped' });
    this.#degradedBy = null;
    this.#takeDegradedAway();
    if (old !== null) {
      this.#unwatch(old);
      await this.#releaseQuietly(old.choice, old.compositorSession, old.rendererSession);
    }
    this.#presenter.emit({
      type: 'backend.switched',
      viewportId: this.viewportId,
      from: old?.choice ?? null,
      to: choice,
      reason,
      capabilities: Object.freeze({
        renderer: renderer.capabilities,
        compositor: compositor.capabilities,
      }),
    });
    this.mark('backend');
    return null;
  }

  /**
   * What a rollback does for a surface whose swap step was carried out, as the handoff model
   * decided: move it back into `from`, present it there again (hidden again when it was hidden),
   * show it again where it stayed attached, or nothing. Each resolves to the runtime's outcome:
   * the first refusal, or the last step's success.
   */
  #undoStep(
    undo: SwapUndo,
    surfaceId: Id,
    from: unknown,
    visible: boolean,
  ): (() => Promise<PresentationOutcome>) | null {
    const { runtime } = this.#presenter.options;
    switch (undo.kind) {
      case 'nothing':
        return null;
      case 'moveBack':
        return () => runtime.move(surfaceId, this.viewportId, from);
      case 'represent':
        return async () => {
          const presented = await runtime.present(surfaceId, this.viewportId, from);
          return presented.status === 'ok' && !visible
            ? runtime.hide(surfaceId, this.viewportId)
            : presented;
        };
      case 'reveal':
        // Still attached: presenting it again shows it where it is.
        return () => runtime.present(surfaceId, this.viewportId, from);
    }
  }

  /** Moves the viewport as the handoff model decides on `event`; an event out of order is a defect. */
  #advance(event: HandoffEvent): void {
    const next = models.handoffStep(leanState(this.#state), event);
    if (next === null) {
      throw new Error(
        `viewport "${this.viewportId}" cannot take ${event.kind} while ${this.#state}`,
      );
    }
    this.#state = STATES[next.kind];
  }

  /** Projects without the cache: a new backend validates against a fresh projection. */
  #projectFresh(scene: SceneState, view: ViewGeometry): readonly ProjectedFragment[] {
    const projector = this.#presenter.options.registry.projector(view.projectionId);
    if (projector === undefined) {
      throw new Error(`projection "${view.projectionId}" is not registered`);
    }
    return projector.module.project(scene, view, (id) =>
      this.#presenter.options.workspace.presentedGeometry(id),
    );
  }

  /**
   * Listens for the backend losing its resources, keeping what stops listening in its `watches`.
   * When a session's `watchLoss` throws, the watches already made are stopped and it rethrows.
   */
  #watch(backend: Backend): void {
    const lost = (reason: string) => {
      this.#background('lost', async () => {
        if (this.#backend !== backend) {
          return;
        }
        this.#lost.add(lostKey(backend.choice));
        this.#presenter.emit({
          type: 'backend.lost',
          viewportId: this.viewportId,
          backend: backend.choice,
          reason,
        });
        await this.#activate(this.#fallbacks(backend.choice), 'lost', false);
      });
    };
    try {
      backend.watches.push({ session: 'renderer', stop: backend.rendererSession.watchLoss(lost) });
      backend.watches.push({
        session: 'compositor',
        stop: backend.compositorSession.watchLoss(lost),
      });
    } catch (error) {
      this.#unwatch(backend);
      throw error;
    }
  }

  /**
   * Stops every watch on the backend's sessions for loss. A stop that throws is reported as a
   * `backend.failed` event of the `releasing` phase, and the others are stopped all the same.
   */
  #unwatch(backend: Backend): void {
    for (const watch of backend.watches.splice(0)) {
      try {
        watch.stop();
      } catch (error) {
        const id =
          watch.session === 'renderer' ? backend.choice.renderer : backend.choice.compositor;
        this.#presenter.emit({
          type: 'backend.failed',
          viewportId: this.viewportId,
          backend: backend.choice,
          error: makeError(
            'BACKEND_SWITCH_FAILED',
            `viewport "${this.viewportId}": stopping the loss watch of ${watch.session} "${id}" failed`,
            { entityId: this.viewportId, details: { phase: 'releasing', reason: describe(error) } },
          ),
        });
      }
    }
  }

  /**
   * Takes away what shows that the viewport is degraded, if anything does. The host's function
   * that throws is kept as a `HOST_THREW` diagnostic, and is never called again.
   */
  #takeDegradedAway(): void {
    const hide = this.#hideDegraded;
    this.#hideDegraded = null;
    if (hide === null) {
      return;
    }
    try {
      hide();
    } catch (error) {
      this.#presenter.diagnose(
        'HOST_THREW',
        `viewport "${this.viewportId}": taking away what showed that it was degraded threw`,
        { viewportId: this.viewportId, hook: 'showDegraded', reason: describe(error) },
      );
    }
  }

  /**
   * No backend works: the live content leaves the old resources (released where the endpoint
   * allows), they are released, and the container shows that the viewport is degraded. The
   * viewport is degraded, its old backend released and `viewport.degraded` sent even when hiding
   * a surface is refused or `showDegraded` throws; then it throws what failed: that failure, or
   * an `AggregateError` of them all.
   */
  async #degrade(error: SwfError, state: ViewportState): Promise<void> {
    const old = this.#backend;
    this.#backend = null;
    this.#live = new Set();
    this.#state = state;
    this.#degradedBy = error;
    const failures: unknown[] = [];
    if (old !== null) {
      this.#unwatch(old);
      try {
        const { refused } = await this.#hideAllBut([], true);
        failures.push(...refused.map((r) => new SwfFailure(r)));
      } finally {
        await this.#releaseQuietly(old.choice, old.compositorSession, old.rendererSession);
      }
    }
    this.#takeDegradedAway();
    try {
      this.#hideDegraded = this.#presenter.options.showDegraded(this.#options.container, error);
    } catch (thrown) {
      failures.push(thrown);
    }
    this.#presenter.emit({ type: 'viewport.degraded', viewportId: this.viewportId, error });
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        `viewport "${this.viewportId}" degraded, but ${failures.map(describe).join('; ')}`,
      );
    }
  }

  async #releaseQuietly(
    choice: BackendChoice,
    compositor: CompositorSession | null,
    renderer: RendererSession | null,
  ): Promise<void> {
    for (const [phase, session] of [
      ['releasing the compositor', compositor],
      ['releasing the renderer', renderer],
    ] as const) {
      if (session === null) {
        continue;
      }
      try {
        await session.release();
      } catch (error) {
        this.#presenter.emit({
          type: 'backend.failed',
          viewportId: this.viewportId,
          backend: choice,
          error: makeError(
            'BACKEND_SWITCH_FAILED',
            `viewport "${this.viewportId}": ${phase} "${phase.endsWith('compositor') ? choice.compositor : choice.renderer}" failed`,
            {
              entityId: this.viewportId,
              details: { phase: 'releasing', reason: describe(error) },
            },
          ),
        });
      }
    }
  }

  #noBackend(): SwfError {
    return makeError(
      'BACKEND_SWITCH_FAILED',
      `viewport "${this.viewportId}" has no backend that works`,
      { entityId: this.viewportId, retryable: true, details: { phase: 'preparing' } },
    );
  }

  async #dispose(): Promise<{ readonly retained: readonly Id[] }> {
    const { runtime } = this.#presenter.options;
    const old = this.#backend;
    this.#backend = null;
    this.#live = new Set();
    this.#advance({ kind: 'dispose' });
    const retained: Id[] = [];
    try {
      for (const presentation of runtime.list()) {
        if (!presentation.viewports.some((v) => v.viewportId === this.viewportId)) {
          continue;
        }
        const outcome = await runtime.hide(presentation.surfaceId, this.viewportId, {
          release: true,
        });
        const still = attachmentHere(runtime, presentation.surfaceId, this.viewportId);
        if (outcome.status === 'rejected' || still !== undefined) {
          retained.push(presentation.surfaceId);
        }
      }
      if (old !== null) {
        this.#unwatch(old);
        await this.#releaseQuietly(old.choice, old.compositorSession, old.rendererSession);
      }
      const hideDegraded = this.#hideDegraded;
      this.#hideDegraded = null;
      hideDegraded?.();
    } finally {
      // A disposed viewport frees its ID, even when the host's hook threw.
      this.#presenter.step(this, 'closed');
    }
    return Object.freeze({ retained: Object.freeze(retained) });
  }
}

function lostKey(choice: BackendChoice): string {
  return JSON.stringify([choice.renderer, choice.compositor]);
}

function attachmentHere(runtime: SurfaceRuntime, surfaceId: Id, viewportId: Id) {
  return runtime.get(surfaceId)?.viewports.find((v) => v.viewportId === viewportId);
}

function liveIn(rendered: RenderedFrame): Id[] {
  return rendered.layers.flatMap((l) =>
    l.category === 'content-native' && l.surfaceId !== null ? [l.surfaceId] : [],
  );
}

/** What a viewport reads of a view, as a key: equal keys mean the same view. */
function viewKey(view: ViewGeometry): string {
  return JSON.stringify(view);
}

/**
 * Whether two scenes agree on everything a view presents: the same node and surface records
 * (records are immutable, so the same object means unchanged), selection and focus.
 */
function sameContent(a: SceneState, b: SceneState): boolean {
  if (a === b) {
    return true;
  }
  if (
    a.nodes.size !== b.nodes.size ||
    a.surfaces.size !== b.surfaces.size ||
    a.focusedId !== b.focusedId ||
    a.selection.length !== b.selection.length ||
    a.selection.some((id, i) => b.selection[i] !== id)
  ) {
    return false;
  }
  for (const node of a.nodes.values()) {
    if (b.nodes.get(node.id) !== node) {
      return false;
    }
  }
  for (const surface of a.surfaces.values()) {
    if (b.surfaces.get(surface.id) !== surface) {
      return false;
    }
  }
  return true;
}

function area(rect: ScreenRect): number {
  return Math.max(0, rect[2]) * Math.max(0, rect[3]);
}

function overlap(a: ScreenRect, b: ScreenRect): number {
  const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The area of a projected quadrilateral, by the shoelace formula. */
function quadArea(corners: NonNullable<ProjectedFragment['corners']>): number {
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = corners[i] ?? [0, 0];
    const [x1, y1] = corners[(i + 1) % 4] ?? [0, 0];
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

/**
 * A surface's hint in a frame, or null when the scene no longer has it. `visible` is whether the
 * frame shows it at all (live, drawn or as a proxy); `mounted` whether its own content is attached
 * and shown here; `sceneVisible` the scene's own flag; the intersection is the share of the
 * projected surface inside the view; the occlusion is estimated from the bounds of what is drawn
 * in front (exactly zero when nothing in front overlaps them, unknown when it is not shown).
 */
function hintFor(
  scene: SceneState,
  view: ViewGeometry,
  frame: RenderFrame,
  surfaceId: Id,
  live: ReadonlySet<Id>,
): PresentationHint | null {
  const surface = scene.surfaces.get(surfaceId);
  if (surface === undefined) {
    return null;
  }
  const order = frame.output.fragments;
  const own = order.filter((f) => f.surfaceId === surfaceId);
  const visible = own.length > 0;
  const mine = frame.planned.filter((p) => p.fragment.surfaceId === surfaceId);
  const layers = mine.map((p) => p.negotiation.layer);
  const representation = mine[0]?.representation ?? 'full';
  const shown = own.reduce((sum, f) => sum + area(f.bounds), 0);
  const whole = own.find((f) => f.corners !== null)?.corners ?? null;
  const intersectionRatio = !visible
    ? 0
    : whole === null
      ? 1
      : Math.min(1, quadArea(whole) > 0 ? shown / quadArea(whole) : 1);
  let occlusion: PresentationHint['occlusion'];
  if (!visible || shown === 0) {
    occlusion = { value: null, confidence: 'unknown' };
  } else {
    let covered = 0;
    for (const fragment of own) {
      const at = order.indexOf(fragment);
      for (const front of order.slice(at + 1)) {
        if (front.surfaceId !== surfaceId) {
          covered += overlap(fragment.bounds, front.bounds);
        }
      }
    }
    occlusion =
      covered === 0
        ? { value: 0, confidence: 'exact' }
        : { value: Math.min(1, covered / shown), confidence: 'estimated' };
  }
  const anchor = own.find((f) => f.nativeOwner) ?? own[0];
  const focused = scene.focusedId !== null && scene.focusedId === surface.ownerNodeId;
  return {
    surfaceId,
    viewportId: view.viewportId,
    sceneRevision: scene.revision,
    visible,
    mounted: live.has(surfaceId),
    sceneVisible: surfaceEffectiveState(scene, surfaceId)?.visible === true,
    intersectionRatio,
    occlusion: Object.freeze(occlusion),
    projectedBounds: anchor === undefined ? null : anchor.bounds,
    tier: !visible
      ? 'hidden'
      : layers.some((l) => l === 'content-native' || l === 'content-raster')
        ? 'full'
        : representation === 'compact'
          ? 'compact'
          : 'proxy',
    attention: focused ? 'active' : visible ? 'context' : 'background',
    spatialBounds: surface.bounds,
    requestedIntrinsicSize: null,
  };
}

/** Each viewport state as the handoff model names it, and back. */
const LEAN_STATES: Readonly<Record<ViewportState, LeanViewportState['kind']>> = Object.freeze({
  preparing: 'preparing',
  validating: 'validating',
  swapping: 'swapping',
  active: 'active',
  'presentation-degraded': 'degraded',
  disposed: 'disposed',
});

/** A viewport ID no viewport holds. */
const ABSENT: Slot = Object.freeze({ kind: 'absent' });

/** What a refused swap step failed to do, by its action. */
const SWAP_VERBS: Readonly<Record<SwapAction['kind'], string>> = Object.freeze({
  move: 'moved into it',
  keepHidden: 'hidden',
  release: 'released',
});

const STATES: Readonly<Record<LeanViewportState['kind'], ViewportState>> = Object.freeze({
  preparing: 'preparing',
  validating: 'validating',
  swapping: 'swapping',
  active: 'active',
  degraded: 'presentation-degraded',
  disposed: 'disposed',
});

function leanState(state: ViewportState): LeanViewportState {
  return { kind: LEAN_STATES[state] };
}
