import type { Id, OperationType, SwfError, WorkspaceEvent, WorkspaceReader } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type {
  BackendCapabilities,
  BackendChoice,
  DirtyFlag,
  FallbackDiagnostic,
  PresentationRegistry,
  Presenter,
  PresenterEvent,
  PresenterResources,
  ViewportState,
} from '@swf/presentation';
import { groupFallbacks } from '@swf/presentation';
import type { RuntimeEvent, SurfaceRuntime } from '@swf/surfaces';

/**
 * What diagnostics reads. It owns none of them: it subscribes to the workspace, the runtime and the
 * presenter, reads all four when a report is asked for, and never changes any of them;
 * {@link Diagnostics.dispose} removes its subscriptions and leaves each as it was.
 */
export interface DiagnosticsOptions {
  /**
   * The workspace whose scene and transactions are measured: its committed and refused
   * transactions are counted by command type, and its committed scene gives the density.
   */
  readonly workspace: WorkspaceReader;
  /**
   * The surface runtime presenting the workspace's surfaces: its presentations give the
   * attachment counts, and its state changes the binding times and binding failures.
   */
  readonly runtime: SurfaceRuntime;
  /**
   * The presenter of the workspace's viewports: its viewports give the backends and density, and
   * its frames the frame measures, fallbacks and presentation errors.
   */
  readonly presenter: Presenter;
  /** The registry the presenter looks backends up in; read only for its listener failures. */
  readonly registry: PresentationRegistry;
  /**
   * The clock errors are stamped with, in milliseconds; a function. Default `Date.now`. Frame,
   * binding and operation times come from the presenter, runtime and workspace, not from it.
   */
  readonly now?: () => number;
  /** How many typed errors are kept, the newest: a whole number from 1. Default 50. */
  readonly errorCapacity?: number;
}

/** A viewport's backend: what it is presented with, and in what state. */
export interface BackendReport {
  /** The open viewport reported. */
  readonly viewportId: Id;
  /** Where the viewport's presentation is: active, in a handoff, degraded or disposed. */
  readonly state: ViewportState;
  /** The renderer and compositor presenting the viewport, or null while it has none. */
  readonly backend: BackendChoice | null;
  /** What that renderer and compositor declared at registration, or null while it has none. */
  readonly capabilities: BackendCapabilities | null;
  /** Why the viewport is degraded, or null when it is not. */
  readonly degradedBy: SwfError | null;
}

/** The fallbacks a viewport's last frame chose, grouped by their reasons. */
export interface FallbackReport {
  /** The viewport whose last frame chose the fallbacks. */
  readonly viewportId: Id;
  /**
   * The group's first fallback, standing for all of them: the backends, the mode chosen and
   * preferred, and the requirements that were not met.
   */
  readonly example: FallbackDiagnostic;
  /** How many fallbacks the group holds, a surface's repeats included. */
  readonly count: number;
  /** The surfaces that fell back this way, each once, in first-seen order. */
  readonly surfaceIds: readonly Id[];
}

/**
 * Frame presentation measures of one viewport since diagnostics began. A viewport is reported
 * from its first presented frame on, and stays reported after it is disposed.
 */
export interface FrameReport {
  /** The viewport presented. */
  readonly viewportId: Id;
  /** The renderer that presented the last frame. */
  readonly rendererId: string;
  /** The compositor that assembled the last frame. */
  readonly compositorId: string;
  /** Frames presented, all told. */
  readonly frames: number;
  /** Frame boundaries the viewport waited through, out of budget, all told. */
  readonly skipped: number;
  /** How long the last frame took, in milliseconds by the presenter's clock. */
  readonly lastDurationMs: number;
  /** How long the slowest frame took, in milliseconds by the presenter's clock. */
  readonly maxDurationMs: number;
  /** Why the last frame was due, each reason once. */
  readonly lastDirty: readonly DirtyFlag[];
  /** Fragments the last frame drew. */
  readonly fragments: number;
  /** Changes the last frame made: none when nothing changed. */
  readonly writes: number;
}

/**
 * Surface attachment measures of one adapter type. An adapter type is reported while one of its
 * surfaces has a presentation, and from its first binding time or failure on.
 */
export interface AttachmentReport {
  /** The adapter type the surfaces name. */
  readonly adapterTypeId: string;
  /** Surfaces bound now (ready, presented or hidden). */
  readonly bound: number;
  /** Surfaces presented in at least one viewport now. */
  readonly presented: number;
  /** Binding or attachment failures since diagnostics began. */
  readonly failed: number;
  /**
   * How long its last and its slowest binding took, from `binding` to `ready`, in milliseconds by
   * the runtime's clock; null before any completed.
   */
  readonly bindMs: {
    /** The last completed binding, in milliseconds. */
    readonly last: number;
    /** The slowest completed binding, in milliseconds. */
    readonly max: number;
  } | null;
  /**
   * How its surfaces were presented, where not as preferred, in each viewport's last frame: a
   * count of fallbacks by the mode chosen.
   */
  readonly fallbacks: Readonly<Record<string, number>>;
}

/** Scene density: what there is, and what each viewport shows of it. */
export interface DensityReport {
  /** Nodes in the committed scene. */
  readonly nodes: number;
  /** Surfaces in the committed scene. */
  readonly surfaces: number;
  /** What each open viewport shows, in the order the viewports were opened. */
  readonly viewports: readonly {
    /** The open viewport. */
    readonly viewportId: Id;
    /** Surfaces with a fragment in the viewport's last frame: 0 before its first frame. */
    readonly candidates: number;
    /** Surfaces whose live content is attached and visible there now. */
    readonly mounted: number;
    /** Surfaces of the scene the last frame left out: `surfaces` less `candidates`. */
    readonly culled: number;
  }[];
}

/** Resource health: what the framework holds and listens to. */
export interface ResourceReport {
  /** The viewports, sessions, listeners, subscriptions and frame request the presenter holds. */
  readonly presenter: PresenterResources;
  /** Subscriptions diagnostics itself holds: 3 until it is disposed, then 0. */
  readonly subscriptions: number;
  /** Viewports in the middle of a handoff. */
  readonly handoffs: number;
}

/**
 * Scene operations of one command type since diagnostics began (AN-002): a transaction counts
 * once for each distinct command type it holds.
 */
export interface OperationReport {
  /**
   * The command type, or `scene.restore` for a restore. An undo or redo counts under the command
   * types of the transaction it reverses or repeats.
   */
  readonly commandType: OperationType;
  /** Transactions holding it that committed. */
  readonly committed: number;
  /** Transactions holding it that were refused. */
  readonly rejected: number;
  /** Nodes the committed ones changed, all told: a node changed twice counts twice. */
  readonly affectedNodes: number;
  /** The revision of the last such transaction: the one it committed, or that it was refused at. */
  readonly lastRevision: number;
  /** How long the last such transaction took, in milliseconds by the workspace's timer. */
  readonly lastDurationMs: number;
  /** How long the slowest took, in milliseconds by the workspace's timer. */
  readonly maxDurationMs: number;
  /** How long all of them took together, in milliseconds by the workspace's timer. */
  readonly totalDurationMs: number;
}

/** A typed error as it was reported, with where it came from. Frozen. */
export interface ReportedError {
  /** When diagnostics recorded it, in milliseconds by the `now` clock of its options. */
  readonly at: number;
  /**
   * `presentation` for a failed frame, a failed or degraded backend, or a surface whose
   * presentation the runtime refused in a frame (recorded again for every frame it is refused
   * in); `surfaces` for a binding or attachment that failed.
   */
  readonly source: 'presentation' | 'surfaces';
  /** The error as its source reported it. */
  readonly error: SwfError;
}

/**
 * What diagnostics can say, at one moment. It holds identifiers, counts and timings only: never
 * surface content, pixels, input or anything a producer sends.
 */
export interface DiagnosticsReport {
  /** Each open viewport's backend, in the order the viewports were opened. */
  readonly backends: readonly BackendReport[];
  /** The fallbacks of each presented viewport's last frame, grouped, viewport by viewport. */
  readonly fallbacks: readonly FallbackReport[];
  /** Frame measures of each viewport presented since diagnostics began. */
  readonly frames: readonly FrameReport[];
  /** Attachment measures by adapter type, sorted by adapter type ID. */
  readonly attachments: readonly AttachmentReport[];
  /** What the scene holds and what each open viewport shows of it. */
  readonly density: DensityReport;
  /** Scene operations by command type, sorted by command type. */
  readonly operations: readonly OperationReport[];
  /** What the presenter and diagnostics hold, and the handoffs under way. */
  readonly resources: ResourceReport;
  /** The last typed errors, oldest first: at most `errorCapacity`. */
  readonly errors: readonly ReportedError[];
  /**
   * Listener failures the presenter and registry isolated and still keep (each keeps its last
   * 100).
   */
  readonly listenerFailures: number;
}

/**
 * Reads diagnostics of a running workspace presentation, locally; it changes nothing and sends
 * nothing anywhere. The caller owns it and calls {@link Diagnostics.dispose} when done.
 */
export interface Diagnostics {
  /**
   * What diagnostics can say now: the measures gathered since it began, with the presenter's,
   * runtime's and scene's current state. A new, deeply frozen report on every call. Still
   * readable after {@link Diagnostics.dispose}, with the measures as they were then.
   */
  read(): DiagnosticsReport;
  /**
   * Stops listening to the workspace, runtime and presenter; what was gathered is kept. It never
   * disposes any of them. Safe to call twice.
   */
  dispose(): void;
}

/**
 * Starts collecting diagnostics of a workspace, its surface runtime and its presenter, from now on:
 * nothing that happened before is counted. The caller owns the returned {@link Diagnostics} and
 * disposes it to stop listening.
 *
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT`, naming the option in its message, when
 *   `errorCapacity` is not a whole number of at least 1 or `now` is not a function. The four
 *   sources are not checked: they are used as given.
 *
 * @example
 * ```ts
 * const diagnostics = createDiagnostics({ workspace, runtime, presenter, registry });
 * const { frames, errors } = diagnostics.read();
 * diagnostics.dispose();
 * ```
 */
export function createDiagnostics(options: DiagnosticsOptions): Diagnostics {
  const capacity = options.errorCapacity ?? 50;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new SwfFailure(
      makeError('INVALID_INPUT', 'errorCapacity must be a whole number of at least 1'),
    );
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw new SwfFailure(makeError('INVALID_INPUT', 'now must be a function'));
  }
  return new Collector(options, capacity);
}

interface FrameTotals {
  rendererId: string;
  compositorId: string;
  frames: number;
  skipped: number;
  lastDurationMs: number;
  maxDurationMs: number;
  lastDirty: readonly DirtyFlag[];
  fragments: number;
  writes: number;
  fallbacks: readonly FallbackDiagnostic[];
}

interface OperationTotals {
  committed: number;
  rejected: number;
  affectedNodes: number;
  lastRevision: number;
  lastDurationMs: number;
  maxDurationMs: number;
  totalDurationMs: number;
}

interface AdapterTotals {
  failed: number;
  bindMs: { last: number; max: number } | null;
}

const BOUND = new Set(['ready', 'presented', 'hidden']);

class Collector implements Diagnostics {
  readonly #options: DiagnosticsOptions;
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #frames = new Map<Id, FrameTotals>();
  readonly #adapters = new Map<string, AdapterTotals>();
  readonly #operations = new Map<OperationType, OperationTotals>();
  /** When each surface's current binding attempt began. */
  readonly #binding = new Map<Id, number>();
  readonly #errors: ReportedError[] = [];
  #unsubscribe: (() => void)[];

  constructor(options: DiagnosticsOptions, capacity: number) {
    this.#options = options;
    this.#capacity = capacity;
    this.#now = options.now ?? Date.now;
    this.#unsubscribe = [
      options.presenter.subscribe((event) => {
        this.#presenterEvent(event);
      }),
      options.runtime.subscribe((event) => {
        this.#runtimeEvent(event);
      }),
      options.workspace.subscribe((event) => {
        this.#workspaceEvent(event);
      }),
    ];
  }

  read(): DiagnosticsReport {
    const { presenter, runtime, workspace, registry } = this.#options;
    const viewports = presenter.viewports();
    const scene = workspace.getState();
    const presentations = runtime.list();
    const adapterOf = (surfaceId: Id) => scene.surfaces.get(surfaceId)?.adapterTypeId ?? null;
    const adapters = new Map<string, { bound: number; presented: number }>();
    for (const presentation of presentations) {
      const type = adapterOf(presentation.surfaceId);
      if (type === null) {
        continue;
      }
      const entry = adapters.get(type) ?? { bound: 0, presented: 0 };
      entry.bound += BOUND.has(presentation.state) ? 1 : 0;
      entry.presented += presentation.viewports.some((v) => v.visible) ? 1 : 0;
      adapters.set(type, entry);
    }
    for (const type of this.#adapters.keys()) {
      if (!adapters.has(type)) {
        adapters.set(type, { bound: 0, presented: 0 });
      }
    }
    const fallbacksByType = new Map<string, Record<string, number>>();
    for (const totals of this.#frames.values()) {
      for (const fallback of totals.fallbacks) {
        const type = adapterOf(fallback.surfaceId);
        if (type === null) {
          continue;
        }
        const counts = fallbacksByType.get(type) ?? {};
        counts[fallback.chosen] = (counts[fallback.chosen] ?? 0) + 1;
        fallbacksByType.set(type, counts);
      }
    }
    return deepFreeze({
      backends: viewports.map((v) => ({
        viewportId: v.viewportId,
        state: v.state,
        backend: v.backend,
        capabilities: v.capabilities,
        degradedBy: v.degradedBy,
      })),
      fallbacks: [...this.#frames].flatMap(([viewportId, totals]) =>
        groupFallbacks(totals.fallbacks).map((group) => ({ viewportId, ...group })),
      ),
      frames: [...this.#frames].map(([viewportId, totals]) => ({
        viewportId,
        rendererId: totals.rendererId,
        compositorId: totals.compositorId,
        frames: totals.frames,
        skipped: totals.skipped,
        lastDurationMs: totals.lastDurationMs,
        maxDurationMs: totals.maxDurationMs,
        lastDirty: totals.lastDirty,
        fragments: totals.fragments,
        writes: totals.writes,
      })),
      attachments: [...adapters]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([adapterTypeId, counts]) => ({
          adapterTypeId,
          bound: counts.bound,
          presented: counts.presented,
          failed: this.#adapters.get(adapterTypeId)?.failed ?? 0,
          bindMs: this.#adapters.get(adapterTypeId)?.bindMs ?? null,
          fallbacks: fallbacksByType.get(adapterTypeId) ?? {},
        })),
      density: {
        nodes: scene.nodes.size,
        surfaces: scene.surfaces.size,
        viewports: viewports.map((v) => {
          const frame = v.lastFrame();
          const candidates = new Set(frame?.frame.output.fragments.map((f) => f.surfaceId) ?? [])
            .size;
          return {
            viewportId: v.viewportId,
            candidates,
            mounted: presentations.filter((p) =>
              p.viewports.some((a) => a.viewportId === v.viewportId && a.visible),
            ).length,
            culled: scene.surfaces.size - candidates,
          };
        }),
      },
      operations: [...this.#operations]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([commandType, totals]) => ({ commandType, ...totals })),
      resources: {
        presenter: presenter.resources(),
        subscriptions: this.#unsubscribe.length,
        handoffs: viewports.filter((v) => ['preparing', 'validating', 'swapping'].includes(v.state))
          .length,
      },
      errors: [...this.#errors],
      listenerFailures: presenter.getDiagnostics().length + registry.getDiagnostics().length,
    });
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribe.splice(0)) {
      unsubscribe();
    }
  }

  #presenterEvent(event: PresenterEvent): void {
    switch (event.type) {
      case 'frame': {
        const m = event.metrics;
        const totals = this.#frames.get(event.viewportId);
        this.#frames.set(event.viewportId, {
          rendererId: m.rendererId,
          compositorId: m.compositorId,
          frames: (totals?.frames ?? 0) + 1,
          skipped: (totals?.skipped ?? 0) + m.skipped,
          lastDurationMs: m.durationMs,
          maxDurationMs: Math.max(totals?.maxDurationMs ?? 0, m.durationMs),
          lastDirty: m.dirty,
          fragments: m.fragments,
          writes: m.writes,
          fallbacks: event.fallbacks,
        });
        const refused = this.#options.presenter.viewport(event.viewportId)?.lastFrame()?.refused;
        for (const { error } of refused ?? []) {
          this.#error('presentation', error);
        }
        break;
      }
      case 'frame.failed':
      case 'backend.failed':
      case 'viewport.degraded':
        this.#error('presentation', event.error);
        break;
      case 'backend.switched':
      case 'backend.lost':
        break;
    }
  }

  #runtimeEvent(event: RuntimeEvent): void {
    if (event.type !== 'presentation.stateChanged') {
      return;
    }
    const { surfaceId, from, to, error, binding } = event.payload;
    if (to === 'binding') {
      this.#binding.set(surfaceId, event.timestamp);
      return;
    }
    const type = binding.adapterTypeId;
    const started = this.#binding.get(surfaceId);
    if (from === 'binding') {
      this.#binding.delete(surfaceId);
    }
    if (to === 'ready' && from === 'binding' && started !== undefined) {
      const totals = this.#totals(type);
      const took = event.timestamp - started;
      totals.bindMs = { last: took, max: Math.max(totals.bindMs?.max ?? 0, took) };
    }
    if (to === 'error' && error !== null) {
      this.#totals(type).failed += 1;
      this.#error('surfaces', error);
    }
  }

  #workspaceEvent(event: WorkspaceEvent): void {
    if (event.type !== 'transaction.committed' && event.type !== 'transaction.rejected') {
      return;
    }
    const p = event.payload;
    for (const type of new Set(p.commandTypes)) {
      const totals = this.#operations.get(type) ?? {
        committed: 0,
        rejected: 0,
        affectedNodes: 0,
        lastRevision: 0,
        lastDurationMs: 0,
        maxDurationMs: 0,
        totalDurationMs: 0,
      };
      if (event.type === 'transaction.committed') {
        totals.committed += 1;
        totals.affectedNodes += event.payload.changedNodeIds.length;
      } else {
        totals.rejected += 1;
      }
      totals.lastRevision = event.revision;
      totals.lastDurationMs = p.durationMs;
      totals.maxDurationMs = Math.max(totals.maxDurationMs, p.durationMs);
      totals.totalDurationMs += p.durationMs;
      this.#operations.set(type, totals);
    }
  }

  #totals(adapterTypeId: string): AdapterTotals {
    let totals = this.#adapters.get(adapterTypeId);
    if (totals === undefined) {
      totals = { failed: 0, bindMs: null };
      this.#adapters.set(adapterTypeId, totals);
    }
    return totals;
  }

  #error(source: ReportedError['source'], error: SwfError): void {
    this.#errors.push(Object.freeze({ at: this.#now(), source, error }));
    this.#errors.splice(0, Math.max(0, this.#errors.length - this.#capacity));
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}
