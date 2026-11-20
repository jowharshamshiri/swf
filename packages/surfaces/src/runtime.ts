import type {
  BindingRef,
  EventSource,
  Id,
  SurfaceRecord,
  SwfError,
  SwfErrorCode,
  TxOutcome,
  Workspace,
  WorkspaceEvent,
} from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type {
  BindingContext,
  PresentationHint,
  PresentationTarget,
  SurfaceAdapter,
} from './adapter.js';
import { adapterIssue } from './adapter.js';
import type { SurfaceCapabilities } from './capabilities.js';
import { capabilitiesIssue, exceededCapabilities, freezeCapabilities } from './capabilities.js';
import type {
  PresentationState,
  RuntimeEvent,
  RuntimeEventPayload,
  RuntimeEventType,
  UnboundReason,
} from './events.js';

export interface SurfaceRuntimeOptions {
  /** How long a binding may take before it fails as retryable: milliseconds. Default 15000. */
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

/** A surface's presence in one viewport. */
export interface ViewportAttachment {
  readonly viewportId: Id;
  readonly visible: boolean;
}

/** What the runtime knows of one surface's presentation. */
export interface SurfacePresentation {
  readonly surfaceId: Id;
  readonly state: PresentationState;
  /** Increases with every binding attempt and every release; older completions are discarded. */
  readonly generation: number;
  readonly binding: BindingRef;
  /** The negotiated capabilities of the bound handle, or null when none is bound. */
  readonly capabilities: SurfaceCapabilities | null;
  readonly unboundReason: UnboundReason | null;
  readonly error: SwfError | null;
  readonly viewports: readonly ViewportAttachment[];
  /** A binding replacement is in progress. */
  readonly replacing: boolean;
}

export type PresentationOutcome =
  | { readonly status: 'ok'; readonly presentation: SurfacePresentation }
  | { readonly status: 'rejected'; readonly error: SwfError };

export type HintOutcome =
  | {
      readonly status: 'ok';
      /** False when the hint repeated the last one for that viewport and was coalesced away. */
      readonly delivered: boolean;
    }
  | { readonly status: 'rejected'; readonly error: SwfError };

export interface RuntimeDiagnostic {
  readonly code:
    | 'ADAPTER_THREW'
    | 'LISTENER_THREW'
    | 'STALE_COMPLETION'
    | 'CAPABILITIES_CHANGED'
    | 'HINT_IGNORED';
  readonly message: string;
  readonly timestamp: number;
  readonly surfaceId: Id | null;
  readonly details: Readonly<Record<string, string>>;
}

export type RuntimeListener = (event: RuntimeEvent) => void;

/**
 * Binds a workspace's surface associations to live endpoints through registered adapters and
 * drives each surface through the presentation lifecycle. It changes no scene state except when
 * asked to replace a binding, and it never manages the endpoints' producers.
 */
export interface SurfaceRuntime {
  readonly workspaceId: Id;
  readonly disposed: boolean;
  /**
   * Registers an adapter. Throws {@link SwfFailure}: `INVALID_INPUT` for a malformed adapter or a
   * taken ID, `UNSUPPORTED_CAPABILITY` for an incompatible contract version or contradictory
   * capabilities. The returned function unregisters it, releasing what it bound (safe to call
   * twice).
   */
  registerAdapter<THandle>(adapter: SurfaceAdapter<THandle>): () => void;
  get(surfaceId: Id): SurfacePresentation | undefined;
  list(): SurfacePresentation[];
  /** The bound handle, opaque to the framework, for a presentation backend; undefined if none. */
  handleOf(surfaceId: Id): unknown;
  /** Starts binding an unbound or failed surface; resolves when the attempt settles. */
  bind(surfaceId: Id): Promise<PresentationOutcome>;
  /**
   * Releases the surface's presentation attachment and handle, keeping the association: it ends
   * `unbound`. The endpoint is left as it is.
   */
  unbind(surfaceId: Id): Promise<PresentationOutcome>;
  /**
   * Attaches a bound surface to a viewport (or reveals it there again). A surface whose handle has
   * a single owner cannot be presented in a second viewport, nor can two surfaces present the same
   * single-owner endpoint: such requests are rejected with `UNSUPPORTED_CAPABILITY`, so the
   * caller shows a proxy instead.
   */
  present(surfaceId: Id, viewportId: Id, container: unknown): Promise<PresentationOutcome>;
  /**
   * Hides a surface in a viewport. With `release`, the attachment is released, but only when the
   * handle declares safe detachment; otherwise it stays attached and hidden.
   */
  hide(
    surfaceId: Id,
    viewportId: Id,
    options?: { release?: boolean },
  ): Promise<PresentationOutcome>;
  /** Passes an advisory hint to the adapter; a hint equal to the last one is coalesced away. */
  deliverHint(hint: PresentationHint): HintOutcome;
  /**
   * Replaces the surface's binding in place: the new endpoint is resolved and attached to every
   * viewport first, then the change commits as one transaction, then the old attachment is
   * released. Any failure before the commit leaves the old binding presented and the scene
   * unchanged.
   */
  replaceBinding(
    surfaceId: Id,
    binding: { readonly bindingKey: string; readonly adapterTypeId?: string },
    options?: { readonly source?: EventSource },
  ): Promise<PresentationOutcome>;
  subscribe(listener: RuntimeListener): () => void;
  getDiagnostics(): readonly RuntimeDiagnostic[];
  /** Releases every attachment and stops listening. The endpoints are left as they are. */
  dispose(): Promise<void>;
}

/** Creates the surface runtime of a workspace. Throws {@link SwfFailure} for invalid options. */
export function createSurfaceRuntime(
  workspace: Workspace,
  options: SurfaceRuntimeOptions = {},
): SurfaceRuntime {
  return new Runtime(workspace, options);
}

interface Attachment {
  target: PresentationTarget;
  visible: boolean;
  lastHint: PresentationHint | null;
}

/** One binding attempt: cancelling it aborts the adapter's resolve and stops waiting for it. */
interface Attempt {
  readonly controller: AbortController;
  readonly cancelled: Promise<'cancelled'>;
  cancel(): void;
}

type Resolution =
  | { readonly kind: 'bound'; readonly handle: unknown; readonly capabilities: SurfaceCapabilities }
  | { readonly kind: 'unknown-key' }
  | { readonly kind: 'failed'; readonly error: SwfError }
  | { readonly kind: 'cancelled' };

interface Entry {
  readonly surfaceId: Id;
  state: PresentationState;
  generation: number;
  binding: BindingRef;
  adapter: SurfaceAdapter | null;
  handle: unknown;
  capabilities: SurfaceCapabilities | null;
  unboundReason: UnboundReason | null;
  error: SwfError | null;
  attachments: Map<Id, Attachment>;
  /** Viewports whose attachment is in progress. */
  pending: Set<Id>;
  /**
   * The attempt whose handle is (or is being) bound. Its binding context counts only while it is
   * current; any later attempt, release or failure supersedes it.
   */
  attempt: Attempt | null;
  settled: Promise<void>;
  /** The binding a replacement in progress will commit, so its rebind event is expected. */
  replacing: BindingRef | null;
  removed: boolean;
}

const OPTION_KEYS = ['bindingTimeoutMs', 'autoBind', 'now', 'diagnosticsCapacity', 'onDiagnostic'];

class Runtime implements SurfaceRuntime {
  readonly workspaceId: Id;
  readonly #workspace: Workspace;
  readonly #timeoutMs: number;
  readonly #autoBind: boolean;
  readonly #now: () => number;
  readonly #diagnosticsCapacity: number;
  readonly #onDiagnostic: ((d: RuntimeDiagnostic) => void) | undefined;
  readonly #adapters = new Map<string, SurfaceAdapter>();
  readonly #entries = new Map<Id, Entry>();
  readonly #listeners = new Set<RuntimeListener>();
  readonly #outbox: RuntimeEvent[] = [];
  #delivering = false;
  readonly #diagnostics: RuntimeDiagnostic[] = [];
  #eventSeq = 0;
  #disposed: Promise<void> | null = null;
  readonly #unsubscribe: () => void;

  constructor(workspace: Workspace, options: SurfaceRuntimeOptions) {
    const checked = checkOptions(options, workspace.id);
    if (workspace.lifecycle !== 'ready') {
      throw failure(
        'WORKSPACE_DISPOSED',
        `workspace "${workspace.id}" is ${workspace.lifecycle}`,
        workspace.id,
      );
    }
    this.workspaceId = workspace.id;
    this.#workspace = workspace;
    this.#timeoutMs = checked.bindingTimeoutMs;
    this.#autoBind = checked.autoBind;
    this.#now = checked.now;
    this.#diagnosticsCapacity = checked.diagnosticsCapacity;
    this.#onDiagnostic = checked.onDiagnostic;
    this.#unsubscribe = workspace.subscribe((event) => {
      this.#onWorkspaceEvent(event);
    });
    for (const surface of workspace.getState().surfaces) {
      this.#track(surface);
    }
  }

  get disposed(): boolean {
    return this.#disposed !== null;
  }

  // --- queries ----------------------------------------------------------------------------

  get(surfaceId: Id): SurfacePresentation | undefined {
    const entry = this.#entries.get(surfaceId);
    return entry === undefined ? undefined : snapshot(entry);
  }

  list(): SurfacePresentation[] {
    return [...this.#entries.values()].map(snapshot);
  }

  handleOf(surfaceId: Id): unknown {
    const entry = this.#entries.get(surfaceId);
    return entry === undefined || entry.capabilities === null ? undefined : entry.handle;
  }

  getDiagnostics(): readonly RuntimeDiagnostic[] {
    return [...this.#diagnostics];
  }

  subscribe(listener: RuntimeListener): () => void {
    if (typeof listener !== 'function') {
      throw failure('INVALID_INPUT', 'listener must be a function', this.workspaceId);
    }
    this.#assertLive();
    const entry: RuntimeListener = (event) => {
      listener(event);
    };
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }

  // --- adapters ---------------------------------------------------------------------------

  registerAdapter<THandle>(adapter: SurfaceAdapter<THandle>): () => void {
    this.#assertLive();
    const issue = adapterIssue(adapter);
    if (issue !== null) {
      throw failure(issue.code, issue.message, this.workspaceId);
    }
    if (this.#adapters.has(adapter.id)) {
      throw failure(
        'INVALID_INPUT',
        `an adapter "${adapter.id}" is already registered`,
        this.workspaceId,
      );
    }
    const registered: SurfaceAdapter = Object.freeze({
      id: adapter.id,
      apiVersion: adapter.apiVersion,
      declaredCapabilities: freezeCapabilities(adapter.declaredCapabilities),
      untimedBinding: adapter.untimedBinding ?? false,
      resolve: (key: string, signal: AbortSignal, context: BindingContext) =>
        adapter.resolve(key, signal, context),
      capabilities: (handle: unknown) => adapter.capabilities(handle as THandle),
      attach: (handle: unknown, target: PresentationTarget) =>
        adapter.attach(handle as THandle, target),
      update: (handle: unknown, hint: PresentationHint) => {
        adapter.update(handle as THandle, hint);
      },
      detach: (handle: unknown, target: PresentationTarget) =>
        adapter.detach(handle as THandle, target),
    });
    this.#adapters.set(adapter.id, registered);
    this.#emit('adapter.registered', { adapterId: adapter.id });
    if (this.#autoBind) {
      for (const entry of this.#entries.values()) {
        if (
          entry.state === 'unbound' &&
          entry.unboundReason === 'adapter-unavailable' &&
          entry.binding.adapterTypeId === adapter.id
        ) {
          this.#startBinding(entry);
        }
      }
    }
    return () => {
      if (this.#adapters.get(adapter.id) !== registered) {
        return;
      }
      this.#adapters.delete(adapter.id);
      for (const entry of this.#entries.values()) {
        if (entry.binding.adapterTypeId === adapter.id && isActive(entry.state)) {
          void this.#release(entry, 'unbound', 'adapter-unavailable');
        }
      }
      this.#emit('adapter.unregistered', { adapterId: adapter.id });
    };
  }

  // --- lifecycle operations ---------------------------------------------------------------

  bind(surfaceId: Id): Promise<PresentationOutcome> {
    const entry = this.#entries.get(surfaceId);
    if (entry === undefined) {
      return this.#rejected(this.#unknown(surfaceId));
    }
    if (this.#disposed !== null) {
      return this.#rejected(this.#disposedError());
    }
    if (entry.state !== 'unbound' && entry.state !== 'error') {
      return this.#rejected(
        this.#error(
          'INVALID_TRANSITION',
          `surface "${surfaceId}" is ${entry.state}; only an unbound or failed surface can bind`,
          surfaceId,
        ),
      );
    }
    this.#startBinding(entry);
    return entry.settled.then(() => this.#ok(entry));
  }

  unbind(surfaceId: Id): Promise<PresentationOutcome> {
    const entry = this.#entries.get(surfaceId);
    if (entry === undefined) {
      return this.#rejected(this.#unknown(surfaceId));
    }
    if (entry.state === 'detaching' || entry.replacing !== null) {
      const what = entry.replacing === null ? 'detaching' : 'replacing its binding';
      return this.#rejected(
        this.#error('INVALID_TRANSITION', `surface "${surfaceId}" is ${what}`, surfaceId),
      );
    }
    if (entry.state === 'unbound') {
      return Promise.resolve(this.#ok(entry));
    }
    return this.#release(entry, 'unbound', 'released').then(() => this.#ok(entry));
  }

  async present(surfaceId: Id, viewportId: Id, container: unknown): Promise<PresentationOutcome> {
    const entry = this.#entries.get(surfaceId);
    if (entry === undefined) {
      return this.#rejected(this.#unknown(surfaceId));
    }
    if (this.#disposed !== null) {
      return this.#rejected(this.#disposedError());
    }
    if (typeof viewportId !== 'string' || viewportId.trim() === '') {
      return this.#rejected(
        this.#error('INVALID_INPUT', 'viewportId must be a non-blank string', surfaceId),
      );
    }
    const blocked = this.#presentBlocker(entry, viewportId);
    if (blocked !== null) {
      return this.#rejected(blocked);
    }
    const existing = entry.attachments.get(viewportId);
    if (existing !== undefined) {
      // Hidden but still attached: reveal it, with no new attachment.
      existing.visible = true;
      this.#emit('presentation.viewportChanged', {
        surfaceId,
        viewportId,
        attached: true,
        visible: true,
      });
      this.#settleVisibility(entry);
      return this.#ok(entry);
    }
    const adapter = entry.adapter;
    const geometry = this.#workspace.surfaceGeometry(surfaceId);
    if (adapter === null || geometry === undefined) {
      return this.#rejected(this.#unknown(surfaceId));
    }
    const target: PresentationTarget = Object.freeze({
      surfaceId,
      viewportId,
      container,
      geometry,
    });
    const generation = entry.generation;
    const handle = entry.handle;
    entry.pending.add(viewportId);
    try {
      await adapter.attach(handle, target);
    } catch (error) {
      entry.pending.delete(viewportId);
      if (entry.generation !== generation || entry.removed) {
        return this.#rejected(this.#changedWhile(surfaceId, 'attaching'));
      }
      const failed = this.#error(
        'BIND_FAILED',
        `adapter "${adapter.id}" could not attach surface "${surfaceId}" in viewport "${viewportId}"`,
        surfaceId,
        { retryable: true, details: { phase: 'attach', reason: describeError(error) } },
      );
      await this.#fail(entry, failed);
      return this.#rejected(failed);
    }
    entry.pending.delete(viewportId);
    if (entry.generation !== generation || entry.removed) {
      // The surface was removed, rebound or unbound meanwhile: release only this attachment.
      this.#diagnose(
        'STALE_COMPLETION',
        `an attachment of surface "${surfaceId}" completed after the surface changed; released`,
        surfaceId,
        { phase: 'attach' },
      );
      await this.#detachQuietly(adapter, handle, target, surfaceId);
      return this.#rejected(this.#changedWhile(surfaceId, 'attaching'));
    }
    entry.attachments.set(viewportId, { target, visible: true, lastHint: null });
    this.#emit('presentation.viewportChanged', {
      surfaceId,
      viewportId,
      attached: true,
      visible: true,
    });
    this.#settleVisibility(entry);
    return this.#ok(entry);
  }

  async hide(
    surfaceId: Id,
    viewportId: Id,
    options: { release?: boolean } = {},
  ): Promise<PresentationOutcome> {
    const entry = this.#entries.get(surfaceId);
    if (entry === undefined) {
      return this.#rejected(this.#unknown(surfaceId));
    }
    const attachment = entry.attachments.get(viewportId);
    if (attachment === undefined || entry.adapter === null) {
      return this.#rejected(
        this.#error(
          'INVALID_TRANSITION',
          `surface "${surfaceId}" is not attached in viewport "${viewportId}"`,
          surfaceId,
        ),
      );
    }
    if (entry.replacing !== null) {
      return this.#rejected(
        this.#error(
          'INVALID_TRANSITION',
          `surface "${surfaceId}" is replacing its binding`,
          surfaceId,
        ),
      );
    }
    const adapter = entry.adapter;
    // Releasing is only safe when the handle says so; otherwise the attachment stays, hidden.
    const release = options.release === true && entry.capabilities?.safeDetach === true;
    if (!attachment.visible && !release) {
      return this.#ok(entry);
    }
    if (attachment.visible) {
      attachment.visible = false;
      this.#deliver(entry, adapter, hiddenHint(attachment, this.#workspace, surfaceId, viewportId));
    }
    if (release) {
      entry.attachments.delete(viewportId);
      await this.#detachQuietly(adapter, entry.handle, attachment.target, surfaceId);
    }
    this.#emit('presentation.viewportChanged', {
      surfaceId,
      viewportId,
      attached: !release,
      visible: false,
    });
    this.#settleVisibility(entry);
    return this.#ok(entry);
  }

  deliverHint(hint: PresentationHint): HintOutcome {
    const entry = this.#entries.get(hint.surfaceId);
    if (entry === undefined) {
      return { status: 'rejected', error: this.#unknown(hint.surfaceId) };
    }
    const attachment = entry.attachments.get(hint.viewportId);
    if (attachment === undefined || entry.adapter === null) {
      return {
        status: 'rejected',
        error: this.#error(
          'INVALID_TRANSITION',
          `surface "${hint.surfaceId}" is not attached in viewport "${hint.viewportId}"`,
          hint.surfaceId,
        ),
      };
    }
    if (attachment.lastHint !== null && sameHint(attachment.lastHint, hint)) {
      return { status: 'ok', delivered: false };
    }
    attachment.lastHint = hint;
    this.#deliver(entry, entry.adapter, hint);
    return { status: 'ok', delivered: true };
  }

  async replaceBinding(
    surfaceId: Id,
    binding: { readonly bindingKey: string; readonly adapterTypeId?: string },
    options: { readonly source?: EventSource } = {},
  ): Promise<PresentationOutcome> {
    const entry = this.#entries.get(surfaceId);
    if (entry === undefined) {
      return this.#rejected(this.#unknown(surfaceId));
    }
    if (this.#disposed !== null) {
      return this.#rejected(this.#disposedError());
    }
    const bound =
      entry.state === 'ready' || entry.state === 'presented' || entry.state === 'hidden';
    if (!bound || entry.replacing !== null || entry.adapter === null || entry.pending.size > 0) {
      const what = entry.replacing === null ? entry.state : 'already replacing its binding';
      return this.#rejected(
        this.#error(
          'INVALID_TRANSITION',
          `surface "${surfaceId}" is ${what}; a replacement hands off from a bound surface (use surface.rebind otherwise)`,
          surfaceId,
        ),
      );
    }
    if (typeof binding.bindingKey !== 'string' || binding.bindingKey.trim() === '') {
      return this.#rejected(
        this.#error('INVALID_INPUT', 'bindingKey must be a non-blank string', surfaceId),
      );
    }
    const next: BindingRef = Object.freeze({
      bindingKey: binding.bindingKey,
      adapterTypeId: binding.adapterTypeId ?? entry.binding.adapterTypeId,
    });
    const adapter = this.#adapters.get(next.adapterTypeId);
    if (adapter === undefined) {
      return this.#rejected(
        this.#error(
          'ADAPTER_UNAVAILABLE',
          `no adapter "${next.adapterTypeId}" is registered`,
          surfaceId,
        ),
      );
    }
    const oldAdapter = entry.adapter;
    const oldHandle = entry.handle;
    const previous = entry.binding;
    const generation = entry.generation;
    entry.replacing = next;
    const attempt = newAttempt();
    const cancelled = () => entry.removed || entry.generation !== generation;
    const attached: PresentationTarget[] = [];
    const giveUp = async (error: SwfError, handle?: unknown): Promise<PresentationOutcome> => {
      if (entry.replacing === next) {
        entry.replacing = null;
      }
      attempt.cancel();
      for (const target of attached) {
        await this.#detachQuietly(adapter, handle, target, surfaceId);
      }
      return Object.freeze({ status: 'rejected', error });
    };

    const resolution = await this.#resolve(adapter, next, entry, attempt);
    if (cancelled()) {
      return giveUp(this.#changedWhile(surfaceId, 'replacing its binding'));
    }
    if (resolution.kind === 'cancelled') {
      return giveUp(this.#changedWhile(surfaceId, 'replacing its binding'));
    }
    if (resolution.kind === 'unknown-key') {
      return giveUp(
        this.#error(
          'BIND_FAILED',
          `adapter "${adapter.id}" does not know the new binding key`,
          surfaceId,
          {
            retryable: true,
            details: { phase: 'resolve', reason: 'unknown binding key' },
          },
        ),
      );
    }
    if (resolution.kind === 'failed') {
      return giveUp(resolution.error);
    }
    const handle = resolution.handle;
    if (resolution.capabilities.viewportSharing === 'single-owner' && entry.attachments.size > 1) {
      return giveUp(
        this.#error(
          'UNSUPPORTED_CAPABILITY',
          `the new endpoint has a single owner and cannot be shown in ${entry.attachments.size} viewports`,
          surfaceId,
        ),
        handle,
      );
    }
    for (const [viewportId, attachment] of entry.attachments) {
      const geometry = this.#workspace.surfaceGeometry(surfaceId);
      if (geometry === undefined) {
        return giveUp(this.#unknown(surfaceId), handle);
      }
      const target: PresentationTarget = Object.freeze({
        surfaceId,
        viewportId,
        container: attachment.target.container,
        geometry,
      });
      try {
        await adapter.attach(handle, target);
      } catch (error) {
        attached.push(target);
        return giveUp(
          this.#error(
            'BIND_FAILED',
            `adapter "${adapter.id}" could not attach the new endpoint of surface "${surfaceId}"`,
            surfaceId,
            { retryable: true, details: { phase: 'attach', reason: describeError(error) } },
          ),
          handle,
        );
      }
      attached.push(target);
      if (cancelled()) {
        return giveUp(this.#changedWhile(surfaceId, 'replacing its binding'), handle);
      }
    }
    const committed = await settleTx(
      this.#workspace.dispatch(
        {
          type: 'surface.rebind',
          id: surfaceId,
          bindingKey: next.bindingKey,
          adapterTypeId: next.adapterTypeId,
        },
        { source: options.source ?? 'host' },
      ),
    );
    if (committed.status === 'rejected') {
      return giveUp(committed.error, handle);
    }
    // Committed: hand off. The new attachments take the old ones' places; the old are released.
    const oldTargets = [...entry.attachments.values()].map((a) => a.target);
    const previousCapabilities = entry.capabilities;
    entry.replacing = null;
    entry.generation += 1;
    entry.attempt = attempt;
    entry.binding = next;
    entry.adapter = adapter;
    entry.handle = handle;
    entry.capabilities = resolution.capabilities;
    for (const target of attached) {
      const attachment = entry.attachments.get(target.viewportId);
      if (attachment !== undefined) {
        attachment.target = target;
        attachment.lastHint = null;
      }
    }
    for (const target of oldTargets) {
      await this.#detachQuietly(oldAdapter, oldHandle, target, surfaceId);
    }
    this.#emit('presentation.replaced', { surfaceId, previous, binding: next });
    if (
      previousCapabilities !== null &&
      !sameCapabilities(previousCapabilities, resolution.capabilities)
    ) {
      this.#emit('presentation.capabilitiesChanged', {
        surfaceId,
        previous: previousCapabilities,
        capabilities: resolution.capabilities,
      });
    }
    return this.#ok(entry);
  }

  dispose(): Promise<void> {
    if (this.#disposed !== null) {
      return this.#disposed;
    }
    this.#unsubscribe();
    this.#disposed = (async () => {
      for (const entry of [...this.#entries.values()]) {
        await this.#remove(entry);
      }
      this.#adapters.clear();
      this.#listeners.clear();
    })();
    return this.#disposed;
  }

  // --- workspace events -------------------------------------------------------------------

  #onWorkspaceEvent(event: WorkspaceEvent): void {
    switch (event.type) {
      case 'surface.attached': {
        const surface = this.#workspace.getState().surfaces.get(event.payload.surfaceId);
        if (surface !== undefined) {
          this.#track(surface);
        }
        return;
      }
      case 'surface.detached': {
        const entry = this.#entries.get(event.payload.surfaceId);
        if (entry !== undefined) {
          void this.#remove(entry);
        }
        return;
      }
      case 'surface.rebound': {
        const entry = this.#entries.get(event.payload.surfaceId);
        if (entry === undefined) {
          return;
        }
        const binding = event.payload.binding;
        if (
          entry.replacing?.bindingKey === binding.bindingKey &&
          entry.replacing.adapterTypeId === binding.adapterTypeId
        ) {
          return; // The replacement in progress committed this and completes the handoff itself.
        }
        void this.#rebound(entry, binding);
        return;
      }
      case 'surface.updated': {
        const entry = this.#entries.get(event.payload.surfaceId);
        if (entry !== undefined && event.payload.fields.includes('bounds')) {
          this.#resendHints(entry);
        }
        return;
      }
      case 'workspace.disposed':
        void this.dispose();
        return;
      default:
        return;
    }
  }

  #track(surface: SurfaceRecord): void {
    const entry: Entry = {
      surfaceId: surface.id,
      state: 'unbound',
      generation: 0,
      binding: Object.freeze({
        bindingKey: surface.bindingKey,
        adapterTypeId: surface.adapterTypeId,
      }),
      adapter: null,
      handle: undefined,
      capabilities: null,
      unboundReason: null,
      error: null,
      attachments: new Map(),
      pending: new Set(),
      attempt: null,
      settled: Promise.resolve(),
      replacing: null,
      removed: false,
    };
    this.#entries.set(surface.id, entry);
    entry.unboundReason = this.#unboundReasonFor(entry);
    this.#emitState(entry, null);
    if (this.#autoBind && entry.unboundReason === 'released') {
      this.#startBinding(entry);
    }
  }

  async #rebound(entry: Entry, binding: BindingRef): Promise<void> {
    if (isActive(entry.state)) {
      await this.#release(entry, 'unbound', 'released');
    }
    if (entry.removed) {
      return;
    }
    entry.binding = Object.freeze({ ...binding });
    const reason = this.#unboundReasonFor(entry);
    if (entry.state !== 'unbound' || entry.unboundReason !== reason) {
      const from = entry.state;
      entry.state = 'unbound';
      entry.error = null;
      entry.unboundReason = reason;
      this.#emitState(entry, from);
    }
    if (this.#autoBind && reason === 'released') {
      this.#startBinding(entry);
    }
  }

  /** The placeholder reason a surface would show now, or `released` when it could bind. */
  #unboundReasonFor(entry: Entry): UnboundReason {
    if (entry.binding.bindingKey === null) {
      return 'no-binding-key';
    }
    return this.#adapters.has(entry.binding.adapterTypeId) ? 'released' : 'adapter-unavailable';
  }

  async #remove(entry: Entry): Promise<void> {
    if (entry.removed) {
      return;
    }
    entry.removed = true;
    await this.#release(entry, 'detached', null);
    this.#entries.delete(entry.surfaceId);
  }

  // --- binding ----------------------------------------------------------------------------

  #startBinding(entry: Entry): void {
    const reason = this.#unboundReasonFor(entry);
    const adapter = this.#adapters.get(entry.binding.adapterTypeId);
    if (reason !== 'released' || adapter === undefined) {
      const from = entry.state;
      entry.state = 'unbound';
      entry.unboundReason = reason;
      entry.error = null;
      if (from !== 'unbound' || entry.unboundReason !== reason) {
        this.#emitState(entry, from);
      }
      entry.settled = Promise.resolve();
      return;
    }
    entry.generation += 1;
    const generation = entry.generation;
    const attempt = newAttempt();
    entry.attempt = attempt;
    const from = entry.state;
    entry.state = 'binding';
    entry.unboundReason = null;
    entry.error = null;
    entry.adapter = adapter;
    this.#emitState(entry, from);
    entry.settled = this.#resolve(adapter, entry.binding, entry, attempt).then((resolution) => {
      if (entry.removed || entry.generation !== generation) {
        if (resolution.kind === 'bound') {
          // Never attached, so there is nothing of ours to release: the handle is dropped.
          this.#diagnose(
            'STALE_COMPLETION',
            `a binding of surface "${entry.surfaceId}" completed after the surface changed; discarded`,
            entry.surfaceId,
            { phase: 'resolve' },
          );
        }
        return;
      }
      switch (resolution.kind) {
        case 'bound':
          entry.handle = resolution.handle;
          entry.capabilities = resolution.capabilities;
          entry.state = 'ready';
          break;
        case 'unknown-key':
          entry.attempt = null;
          entry.adapter = null;
          entry.state = 'unbound';
          entry.unboundReason = 'unknown-binding-key';
          break;
        case 'failed':
          entry.attempt = null;
          entry.adapter = null;
          entry.state = 'error';
          entry.error = resolution.error;
          break;
        case 'cancelled':
          return;
      }
      this.#emitState(entry, 'binding');
    });
  }

  /**
   * Resolves a binding through its adapter, with the attempt's abort signal and the timeout, and
   * negotiates the handle's capabilities against the adapter's declaration. The binding context
   * it hands the adapter acts only while `attempt` is the surface's current attempt.
   */
  async #resolve(
    adapter: SurfaceAdapter,
    binding: BindingRef,
    entry: Entry,
    attempt: Attempt,
  ): Promise<Resolution> {
    const surfaceId = entry.surfaceId;
    const current = () => entry.attempt === attempt && !entry.removed;
    const context: BindingContext = Object.freeze({
      surfaceId,
      generation: entry.generation,
      announceCapabilities: (capabilities: SurfaceCapabilities) => {
        if (current() && entry.capabilities !== null) {
          void this.#capabilitiesChanged(entry, adapter, capabilities);
        }
      },
      reportUnavailable: (reason: string) => {
        if (current() && entry.capabilities !== null) {
          void this.#fail(
            entry,
            this.#error(
              'BIND_FAILED',
              `the endpoint of surface "${surfaceId}" became unavailable`,
              surfaceId,
              // Adapters are often plain JavaScript: describe whatever they pass as text.
              {
                retryable: true,
                details: { phase: 'presentation', reason: describeError(reason) },
              },
            ),
          );
        }
      },
    });
    let timer: unknown;
    const timedOut = new Promise<'timeout'>((resolve) => {
      if (adapter.untimedBinding !== true) {
        timer = setTimeout(() => {
          resolve('timeout');
        }, this.#timeoutMs);
      }
    });
    let outcome: unknown;
    try {
      outcome = await Promise.race([
        Promise.resolve().then(() =>
          adapter.resolve(binding.bindingKey ?? '', attempt.controller.signal, context),
        ),
        timedOut,
        attempt.cancelled,
      ]);
    } catch (error) {
      return {
        kind: 'failed',
        error: this.#error(
          'BIND_FAILED',
          `adapter "${adapter.id}" failed to resolve the binding of surface "${surfaceId}"`,
          surfaceId,
          { retryable: true, details: { phase: 'resolve', reason: describeError(error) } },
        ),
      };
    } finally {
      clearTimeout(timer);
    }
    if (outcome === 'cancelled') {
      return { kind: 'cancelled' };
    }
    if (outcome === 'timeout') {
      attempt.controller.abort('timeout');
      return {
        kind: 'failed',
        error: this.#error(
          'BIND_FAILED',
          `the binding of surface "${surfaceId}" timed out after ${String(this.#timeoutMs)} ms`,
          surfaceId,
          { retryable: true, details: { phase: 'resolve', reason: 'timeout' } },
        ),
      };
    }
    if (outcome === null) {
      return { kind: 'unknown-key' };
    }
    let capabilities: unknown;
    try {
      capabilities = adapter.capabilities(outcome);
    } catch (error) {
      return {
        kind: 'failed',
        error: this.#error(
          'BIND_FAILED',
          `adapter "${adapter.id}" failed to report capabilities for surface "${surfaceId}"`,
          surfaceId,
          { retryable: true, details: { phase: 'capabilities', reason: describeError(error) } },
        ),
      };
    }
    const issue =
      capabilitiesIssue(capabilities) ??
      exceeding(adapter.declaredCapabilities, capabilities as SurfaceCapabilities);
    if (issue !== null) {
      return {
        kind: 'failed',
        error: this.#error(
          'UNSUPPORTED_CAPABILITY',
          `adapter "${adapter.id}" reported unusable capabilities for surface "${surfaceId}": ${issue}`,
          surfaceId,
        ),
      };
    }
    return {
      kind: 'bound',
      handle: outcome,
      capabilities: freezeCapabilities(capabilities as SurfaceCapabilities),
    };
  }

  async #capabilitiesChanged(
    entry: Entry,
    adapter: SurfaceAdapter,
    raw: SurfaceCapabilities,
  ): Promise<void> {
    const previous = entry.capabilities;
    if (previous === null) {
      return;
    }
    const issue = capabilitiesIssue(raw) ?? exceeding(adapter.declaredCapabilities, raw);
    if (issue !== null) {
      await this.#fail(
        entry,
        this.#error(
          'UNSUPPORTED_CAPABILITY',
          `adapter "${adapter.id}" announced unusable capabilities for surface "${entry.surfaceId}": ${issue}`,
          entry.surfaceId,
        ),
      );
      return;
    }
    const capabilities = freezeCapabilities(raw);
    entry.capabilities = capabilities;
    this.#diagnose(
      'CAPABILITIES_CHANGED',
      `the capabilities of surface "${entry.surfaceId}" changed`,
      entry.surfaceId,
      { adapterId: adapter.id },
    );
    this.#emit('presentation.capabilitiesChanged', {
      surfaceId: entry.surfaceId,
      previous,
      capabilities,
    });
    // A handle that can no longer be shared keeps only its first attachment.
    if (capabilities.viewportSharing === 'single-owner' && entry.attachments.size > 1) {
      const [, ...extra] = [...entry.attachments];
      for (const [viewportId, attachment] of extra) {
        entry.attachments.delete(viewportId);
        await this.#detachQuietly(adapter, entry.handle, attachment.target, entry.surfaceId);
        this.#emit('presentation.viewportChanged', {
          surfaceId: entry.surfaceId,
          viewportId,
          attached: false,
          visible: false,
        });
      }
      this.#settleVisibility(entry);
    }
  }

  /** Releases the surface's attachments and handle and records a typed error. */
  async #fail(entry: Entry, error: SwfError): Promise<void> {
    entry.generation += 1;
    entry.attempt?.cancel();
    entry.attempt = null;
    await this.#releaseAttachments(entry);
    if (entry.removed) {
      return;
    }
    const from = entry.state;
    entry.state = 'error';
    entry.error = error;
    entry.handle = undefined;
    entry.capabilities = null;
    entry.adapter = null;
    this.#emitState(entry, from);
  }

  /**
   * Ends the surface's binding: supersedes any attempt in flight, releases every presentation
   * attachment through the adapter (never touching the endpoint itself), and leaves the surface
   * `unbound` (association kept) or `detached` (association removed).
   */
  async #release(
    entry: Entry,
    final: 'unbound' | 'detached',
    reason: UnboundReason | null,
  ): Promise<void> {
    entry.generation += 1;
    entry.attempt?.cancel();
    entry.attempt = null;
    entry.replacing = null;
    if (isActive(entry.state)) {
      const from = entry.state;
      entry.state = 'detaching';
      this.#emitState(entry, from);
      await this.#releaseAttachments(entry);
    }
    const from = entry.state;
    entry.state = final;
    entry.unboundReason = final === 'unbound' ? reason : null;
    entry.error = null;
    entry.handle = undefined;
    entry.capabilities = null;
    entry.adapter = null;
    entry.settled = Promise.resolve();
    this.#emitState(entry, from);
  }

  async #releaseAttachments(entry: Entry): Promise<void> {
    const adapter = entry.adapter;
    const attachments = [...entry.attachments];
    entry.attachments.clear();
    for (const [viewportId, attachment] of attachments) {
      if (adapter !== null) {
        await this.#detachQuietly(adapter, entry.handle, attachment.target, entry.surfaceId);
      }
      this.#emit('presentation.viewportChanged', {
        surfaceId: entry.surfaceId,
        viewportId,
        attached: false,
        visible: false,
      });
    }
  }

  async #detachQuietly(
    adapter: SurfaceAdapter,
    handle: unknown,
    target: PresentationTarget,
    surfaceId: Id,
  ): Promise<void> {
    try {
      await adapter.detach(handle, target);
    } catch (error) {
      this.#diagnose(
        'ADAPTER_THREW',
        `adapter "${adapter.id}" failed to detach surface "${surfaceId}"`,
        surfaceId,
        { phase: 'detach', reason: describeError(error) },
      );
    }
  }

  #presentBlocker(entry: Entry, viewportId: Id): SwfError | null {
    const id = entry.surfaceId;
    if (entry.replacing !== null) {
      return this.#error('INVALID_TRANSITION', `surface "${id}" is replacing its binding`, id);
    }
    if (entry.state !== 'ready' && entry.state !== 'presented' && entry.state !== 'hidden') {
      return this.#error(
        'INVALID_TRANSITION',
        `surface "${id}" is ${entry.state}; only a bound surface can be presented`,
        id,
      );
    }
    const existing = entry.attachments.get(viewportId);
    if (existing?.visible === true || entry.pending.has(viewportId)) {
      return this.#error(
        'INVALID_TRANSITION',
        `surface "${id}" is already presented in viewport "${viewportId}"`,
        id,
      );
    }
    if (existing !== undefined || entry.capabilities?.viewportSharing !== 'single-owner') {
      return null;
    }
    if (entry.attachments.size > 0 || entry.pending.size > 0) {
      return this.#error(
        'UNSUPPORTED_CAPABILITY',
        `surface "${id}" has a single-owner handle already presented in another viewport; show a proxy there`,
        id,
      );
    }
    for (const other of this.#entries.values()) {
      if (
        other !== entry &&
        other.binding.bindingKey === entry.binding.bindingKey &&
        other.binding.adapterTypeId === entry.binding.adapterTypeId &&
        (other.attachments.size > 0 || other.pending.size > 0)
      ) {
        return this.#error(
          'UNSUPPORTED_CAPABILITY',
          `the single-owner endpoint of surface "${id}" is already presented by surface "${other.surfaceId}"`,
          id,
        );
      }
    }
    return null;
  }

  /** Sets presented, hidden or ready from the surface's attachments. */
  #settleVisibility(entry: Entry): void {
    if (entry.state !== 'ready' && entry.state !== 'presented' && entry.state !== 'hidden') {
      return;
    }
    const attachments = [...entry.attachments.values()];
    const next: PresentationState = attachments.some((a) => a.visible)
      ? 'presented'
      : attachments.length > 0
        ? 'hidden'
        : 'ready';
    if (next !== entry.state) {
      const from = entry.state;
      entry.state = next;
      this.#emitState(entry, from);
    }
  }

  /** After the surface's spatial bounds change, re-sends each viewport's last hint with them. */
  #resendHints(entry: Entry): void {
    const surface = this.#workspace.getState().surfaces.get(entry.surfaceId);
    if (surface === undefined || entry.adapter === null) {
      return;
    }
    for (const attachment of entry.attachments.values()) {
      if (attachment.lastHint !== null) {
        attachment.lastHint = {
          ...attachment.lastHint,
          spatialBounds: surface.bounds,
          sceneRevision: this.#workspace.getState().revision,
        };
        this.#deliver(entry, entry.adapter, attachment.lastHint);
      }
    }
  }

  #deliver(entry: Entry, adapter: SurfaceAdapter, hint: PresentationHint): void {
    try {
      adapter.update(entry.handle, hint);
    } catch (error) {
      // Hints are advisory: an adapter that cannot take one leaves the surface as it is.
      this.#diagnose(
        'HINT_IGNORED',
        `adapter "${adapter.id}" threw on a hint for surface "${entry.surfaceId}"`,
        entry.surfaceId,
        { reason: describeError(error) },
      );
    }
  }

  // --- events and errors ------------------------------------------------------------------

  #emitState(entry: Entry, from: PresentationState | null): void {
    this.#emit('presentation.stateChanged', {
      surfaceId: entry.surfaceId,
      from,
      to: entry.state,
      generation: entry.generation,
      binding: entry.binding,
      unboundReason: entry.state === 'unbound' ? entry.unboundReason : null,
      error: entry.state === 'error' ? entry.error : null,
    });
  }

  #emit<T extends RuntimeEventType>(type: T, payload: RuntimeEventPayload<T>): void {
    this.#eventSeq += 1;
    this.#outbox.push(
      Object.freeze({
        id: `${this.workspaceId}/surfaces/ev-${String(this.#eventSeq)}`,
        type,
        workspaceId: this.workspaceId,
        revision: this.#workspace.getState().revision,
        timestamp: this.#now(),
        payload,
      }) as RuntimeEvent,
    );
    if (this.#delivering) {
      return; // Delivered after the event in progress, in order.
    }
    this.#delivering = true;
    try {
      for (let event = this.#outbox.shift(); event !== undefined; event = this.#outbox.shift()) {
        for (const listener of [...this.#listeners]) {
          try {
            listener(event);
          } catch (error) {
            this.#diagnose(
              'LISTENER_THREW',
              `a listener threw while handling ${event.type}`,
              null,
              {
                eventId: event.id,
                reason: describeError(error),
              },
            );
          }
        }
      }
    } finally {
      this.#delivering = false;
    }
  }

  #diagnose(
    code: RuntimeDiagnostic['code'],
    message: string,
    surfaceId: Id | null,
    details: Record<string, string>,
  ): void {
    const diagnostic: RuntimeDiagnostic = Object.freeze({
      code,
      message,
      timestamp: this.#now(),
      surfaceId,
      details: Object.freeze(details),
    });
    this.#diagnostics.push(diagnostic);
    if (this.#diagnostics.length > this.#diagnosticsCapacity) {
      this.#diagnostics.shift();
    }
    try {
      this.#onDiagnostic?.(diagnostic);
    } catch {
      // A failing diagnostics sink must not interrupt the runtime.
    }
  }

  #error(
    code: SwfErrorCode,
    message: string,
    surfaceId: Id,
    extra: { retryable?: boolean; details?: Record<string, string> } = {},
  ): SwfError {
    return makeError(code, message, {
      workspaceId: this.workspaceId,
      entityId: surfaceId,
      ...(extra.retryable === undefined ? {} : { retryable: extra.retryable }),
      ...(extra.details === undefined ? {} : { details: Object.freeze(extra.details) }),
    });
  }

  #changedWhile(surfaceId: Id, doing: string): SwfError {
    return this.#error('CANCELLED', `surface "${surfaceId}" changed while ${doing}`, surfaceId);
  }

  #unknown(surfaceId: Id): SwfError {
    return this.#error(
      'UNKNOWN_ENTITY',
      `no surface "${surfaceId}" in workspace "${this.workspaceId}"`,
      surfaceId,
    );
  }

  #disposedError(): SwfError {
    return makeError(
      'WORKSPACE_DISPOSED',
      `the surface runtime of workspace "${this.workspaceId}" is disposed`,
      { workspaceId: this.workspaceId },
    );
  }

  #assertLive(): void {
    if (this.#disposed !== null) {
      throw new SwfFailure(this.#disposedError());
    }
  }

  #ok(entry: Entry): PresentationOutcome {
    return Object.freeze({ status: 'ok', presentation: snapshot(entry) });
  }

  #rejected(error: SwfError): Promise<PresentationOutcome> {
    return Promise.resolve(Object.freeze({ status: 'rejected', error }));
  }
}

function newAttempt(): Attempt {
  const controller = new AbortController();
  let settle: () => void = () => undefined;
  const cancelled = new Promise<'cancelled'>((resolve) => {
    settle = () => {
      resolve('cancelled');
    };
  });
  return {
    controller,
    cancelled,
    cancel() {
      if (!controller.signal.aborted) {
        controller.abort('released');
      }
      settle();
    },
  };
}

function snapshot(entry: Entry): SurfacePresentation {
  return Object.freeze({
    surfaceId: entry.surfaceId,
    state: entry.state,
    generation: entry.generation,
    binding: entry.binding,
    capabilities: entry.capabilities,
    unboundReason: entry.state === 'unbound' ? entry.unboundReason : null,
    error: entry.state === 'error' ? entry.error : null,
    viewports: Object.freeze(
      [...entry.attachments].map(([viewportId, a]) =>
        Object.freeze({ viewportId, visible: a.visible }),
      ),
    ),
    replacing: entry.replacing !== null,
  });
}

/** States holding (or acquiring) a binding, which releasing passes through `detaching`. */
function isActive(state: PresentationState): boolean {
  return state === 'binding' || state === 'ready' || state === 'presented' || state === 'hidden';
}

function exceeding(declared: SurfaceCapabilities, actual: SurfaceCapabilities): string | null {
  const exceeded = exceededCapabilities(declared, actual);
  return exceeded.length === 0
    ? null
    : `they exceed the declared capabilities (${exceeded.join(', ')})`;
}

function sameCapabilities(a: SurfaceCapabilities, b: SurfaceCapabilities): boolean {
  return (Object.keys(a) as (keyof SurfaceCapabilities)[]).every((key) => a[key] === b[key]);
}

function hiddenHint(
  attachment: Attachment,
  workspace: Workspace,
  surfaceId: Id,
  viewportId: Id,
): PresentationHint {
  const surface = workspace.getState().surfaces.get(surfaceId);
  if (attachment.lastHint === null && surface === undefined) {
    throw new Error(`surface "${surfaceId}" is attached but missing from the scene`);
  }
  const hint: PresentationHint = {
    ...(attachment.lastHint ?? {
      surfaceId,
      viewportId,
      sceneRevision: workspace.getState().revision,
      occlusion: { value: null, confidence: 'unknown' },
      projectedBounds: null,
      spatialBounds: surface?.bounds ?? [1, 1, 1],
      requestedIntrinsicSize: null,
    }),
    visible: false,
    intersectionRatio: 0,
    tier: 'hidden',
    attention: 'background',
  };
  attachment.lastHint = hint;
  return hint;
}

function sameHint(a: PresentationHint, b: PresentationHint): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failure(code: SwfErrorCode, message: string, workspaceId: Id): SwfFailure {
  return new SwfFailure(makeError(code, message, { workspaceId }));
}

async function settleTx(result: ReturnType<Workspace['dispatch']>): Promise<TxOutcome> {
  return result.status === 'queued' ? result.completion : result;
}

function checkOptions(
  options: SurfaceRuntimeOptions,
  workspaceId: Id,
): {
  bindingTimeoutMs: number;
  autoBind: boolean;
  now: () => number;
  diagnosticsCapacity: number;
  onDiagnostic: ((d: RuntimeDiagnostic) => void) | undefined;
} {
  const fail = (field: string, message: string) =>
    new SwfFailure(
      makeError('INVALID_INPUT', `options.${field} ${message}`, {
        workspaceId,
        path: `options.${field}`,
      }),
    );
  const raw: unknown = options;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SwfFailure(
      makeError('INVALID_INPUT', 'surface runtime options must be an object', { workspaceId }),
    );
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!OPTION_KEYS.includes(key)) {
      throw fail(key, `is not a known option (expected one of ${OPTION_KEYS.join(', ')})`);
    }
  }
  const timeout = record['bindingTimeoutMs'] ?? 15_000;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    throw fail('bindingTimeoutMs', 'must be a positive number of milliseconds');
  }
  const autoBind = record['autoBind'] ?? true;
  if (typeof autoBind !== 'boolean') {
    throw fail('autoBind', 'must be a boolean');
  }
  const capacity = record['diagnosticsCapacity'] ?? 100;
  if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1) {
    throw fail('diagnosticsCapacity', 'must be a positive integer');
  }
  for (const key of ['now', 'onDiagnostic']) {
    if (record[key] !== undefined && typeof record[key] !== 'function') {
      throw fail(key, 'must be a function');
    }
  }
  return {
    bindingTimeoutMs: timeout,
    autoBind,
    now: options.now ?? Date.now,
    diagnosticsCapacity: capacity,
    onDiagnostic: options.onDiagnostic,
  };
}
