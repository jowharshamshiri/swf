import type { Id, SwfError, WorkspaceReader } from '@swf/core';
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

export interface DiagnosticsOptions {
  readonly workspace: WorkspaceReader;
  readonly runtime: SurfaceRuntime;
  readonly presenter: Presenter;
  readonly registry: PresentationRegistry;
  /** The clock errors are stamped with, in milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /** How many typed errors are kept, newest last: at least 1. Default 50. */
  readonly errorCapacity?: number;
}

/** A viewport's backend: what it is presented with, and in what state. */
export interface BackendReport {
  readonly viewportId: Id;
  readonly state: ViewportState;
  readonly backend: BackendChoice | null;
  readonly capabilities: BackendCapabilities | null;
  readonly degradedBy: SwfError | null;
}

/** The fallbacks a viewport's last frame chose, grouped by their reasons. */
export interface FallbackReport {
  readonly viewportId: Id;
  readonly example: FallbackDiagnostic;
  readonly count: number;
  readonly surfaceIds: readonly Id[];
}

/** Frame presentation measures of one viewport since diagnostics began. */
export interface FrameReport {
  readonly viewportId: Id;
  readonly rendererId: string;
  readonly compositorId: string;
  readonly frames: number;
  /** Frame boundaries the viewport waited through, out of budget. */
  readonly skipped: number;
  readonly lastDurationMs: number;
  readonly maxDurationMs: number;
  readonly lastDirty: readonly DirtyFlag[];
  /** Fragments the last frame drew. */
  readonly fragments: number;
  /** Changes the last frame made: none when nothing changed. */
  readonly writes: number;
}

/** Surface attachment measures of one adapter type. */
export interface AttachmentReport {
  readonly adapterTypeId: string;
  /** Surfaces bound now (ready, presented or hidden). */
  readonly bound: number;
  /** Surfaces presented in at least one viewport now. */
  readonly presented: number;
  /** Binding or attachment failures since diagnostics began. */
  readonly failed: number;
  /** How long its last and its slowest binding took, or null before any completed. */
  readonly bindMs: { readonly last: number; readonly max: number } | null;
  /** How its surfaces were presented, where not as preferred, in the last frames: by mode. */
  readonly fallbacks: Readonly<Record<string, number>>;
}

/** Scene density: what there is, and what each viewport shows of it. */
export interface DensityReport {
  readonly nodes: number;
  readonly surfaces: number;
  readonly viewports: readonly {
    readonly viewportId: Id;
    /** Surfaces with a fragment in the viewport's last frame. */
    readonly candidates: number;
    /** Surfaces showing their own content there. */
    readonly mounted: number;
    /** Surfaces the last frame left out. */
    readonly culled: number;
  }[];
}

/** Resource health: what the framework holds and listens to. */
export interface ResourceReport {
  readonly presenter: PresenterResources;
  /** Subscriptions diagnostics itself holds. */
  readonly subscriptions: number;
  /** Viewports in the middle of a handoff. */
  readonly handoffs: number;
}

/** A typed error as it was reported, with where it came from. */
export interface ReportedError {
  readonly at: number;
  readonly source: 'presentation' | 'surfaces';
  readonly error: SwfError;
}

/**
 * What diagnostics can say, at one moment. It holds identifiers, counts and timings only: never
 * surface content, pixels, input or anything a producer sends.
 */
export interface DiagnosticsReport {
  readonly backends: readonly BackendReport[];
  readonly fallbacks: readonly FallbackReport[];
  readonly frames: readonly FrameReport[];
  readonly attachments: readonly AttachmentReport[];
  readonly density: DensityReport;
  readonly resources: ResourceReport;
  /** The last typed errors, oldest first. */
  readonly errors: readonly ReportedError[];
  /** Listener failures the presenter and registry isolated. */
  readonly listenerFailures: number;
}

/** Reads diagnostics of a running workspace presentation, locally; it changes nothing. */
export interface Diagnostics {
  read(): DiagnosticsReport;
  /** Stops listening. Safe to call twice. */
  dispose(): void;
}

/** Starts collecting. Throws {@link SwfFailure} (`INVALID_INPUT`) for invalid options. */
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
