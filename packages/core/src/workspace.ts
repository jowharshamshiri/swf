import type { ApplyContext, ApplyOutcome } from './apply.js';
import { applyCommands } from './apply.js';
import type { EventSource, OperationType, SceneCommand } from './commands.js';
import { SCENE_COMMAND_TYPES } from './commands.js';
import type { Constraint } from './constraints.js';
import { sortConstraints } from './constraints.js';
import type { PendingEvent } from './diff.js';
import { diffScenes } from './diff.js';
import type { SwfError } from './errors.js';
import { makeError, RejectionSignal, SwfFailure } from './errors.js';
import type { CancelReason, OperationPhase, WorkspaceEvent } from './events.js';
import { describe } from './json.js';
import type { GeometryLimits, GeometryProvider, ResolvedGeometry } from './geometry.js';
import { DEFAULT_GEOMETRY_LIMITS, GeometryRegistry } from './geometry.js';
import type {
  CameraRecord,
  Id,
  NodeRecord,
  SceneState,
  SurfaceRecord,
  ViewportRecord,
} from './model.js';
import type { ProjectionKind } from './projection-kinds.js';
import { ProjectionKindRegistry } from './projection-kinds.js';
import type { SceneSnapshot } from './snapshot.js';
import {
  cameraSnapshot,
  nodeSnapshot,
  serializeScene,
  surfaceSnapshot,
  validateSceneSnapshot,
  viewportSnapshot,
} from './snapshot.js';
import type { NodeQuery } from './query.js';
import { effectiveState, findNodes, surfaceGeometry } from './query.js';
import { Table } from './table.js';

/** Where a workspace is in its life. A disposed workspace rejects every operation. */
export type WorkspaceLifecycle = 'ready' | 'disposing' | 'disposed';

export interface WorkspaceOptions {
  /** The workspace's ID, unique within the host. */
  readonly id: Id;
  /** How many committed layout transactions can be undone: 0 to 10000. Default 100. */
  readonly undoCapacity?: number;
  /** How many idempotency keys are remembered for this session: at least 1. Default 1024. */
  readonly idempotencyCapacity?: number;
  /** How many diagnostics `getDiagnostics` keeps: at least 1. Default 100. */
  readonly diagnosticsCapacity?: number;
  /** The clock for timestamps, in milliseconds. Default `Date.now`. */
  readonly now?: () => number;
  /**
   * Supplies IDs for nodes and surfaces created without one; returning an ID already in use
   * rejects the transaction. Default: the next unused of `node-1`, `node-2`, ... in this
   * workspace, which keeps scenes reproducible.
   */
  readonly createId?: () => Id;
  readonly constraints?: readonly Constraint[];
  /** Geometry kinds beyond the built-in `rect` and `polygon`. */
  readonly geometry?: readonly GeometryProvider[];
  /** Overrides of the geometry complexity limits. */
  readonly geometryLimits?: Partial<GeometryLimits>;
  /** Projection kinds viewports may use. */
  readonly projectionKinds?: readonly ProjectionKind[];
  /** Receives every diagnostic as it is recorded. A sink that throws is ignored. */
  readonly onDiagnostic?: (diagnostic: Diagnostic) => void;
  /**
   * Coalesces high-frequency events to frame boundaries: given, `transform.preview` events are
   * held and delivered once per boundary (the latest of each preview, with every changed ID since
   * it was last delivered), and the workspace calls it with the function that delivers them, to be
   * run at the next boundary (such as an animation frame). Every other event is delivered at once,
   * after any held ones, so the order of events is kept and none is dropped. Without it every
   * event is delivered as it happens.
   */
  readonly frameBoundary?: (flush: () => void) => void;
}

export interface TxOptions {
  /** Commit only if the scene is still at this revision; otherwise reject with `CONFLICT`. */
  readonly expectedRevision?: number;
  /**
   * Repeating a committed transaction with the same key and commands returns the first result
   * without applying it again. Reusing a key for different commands is rejected.
   */
  readonly idempotencyKey?: string;
  /** Default `host`. */
  readonly source?: EventSource;
  /** A host correlation ID, carried on the events as their causation ID. */
  readonly causeId?: string;
  /** The preview this transaction commits; the preview ends with the transaction. */
  readonly previewId?: string;
}

export interface TxCommitted {
  readonly status: 'committed';
  readonly transactionId: string;
  readonly revision: number;
  readonly previousRevision: number;
  /** Nodes and surfaces the transaction created. */
  readonly createdIds: readonly Id[];
  readonly changedNodeIds: readonly Id[];
  readonly changedSurfaceIds: readonly Id[];
  /** True when this result is a replay for a repeated idempotency key. */
  readonly replayed: boolean;
}

export interface TxRejected {
  readonly status: 'rejected';
  readonly transactionId: string;
  readonly error: SwfError;
  /** The scene's revision, unchanged by the rejection. */
  readonly revision: number;
}

/** An operation requested from inside an event listener: it runs after the current delivery. */
export interface Queued<T> {
  readonly status: 'queued';
  readonly completion: Promise<T>;
}

export type TxOutcome = TxCommitted | TxRejected;
export type TxResult = TxOutcome | Queued<TxOutcome>;

export interface PreviewApplied {
  readonly status: 'previewed';
  readonly previewId: string;
  readonly changedNodeIds: readonly Id[];
  readonly changedSurfaceIds: readonly Id[];
}

export type PreviewOutcome = PreviewApplied | TxRejected;
export type PreviewResult = PreviewOutcome | Queued<PreviewOutcome>;

/** A committed layout transaction that undo can reverse. */
export interface HistoryEntry {
  readonly transactionId: string;
  readonly timestamp: number;
  readonly source: EventSource;
  readonly previousRevision: number;
  readonly revision: number;
  readonly commandTypes: readonly OperationType[];
  readonly changedNodeIds: readonly Id[];
  readonly changedSurfaceIds: readonly Id[];
}

export interface Diagnostic {
  readonly code: 'LISTENER_THREW';
  readonly message: string;
  readonly timestamp: number;
  readonly details: Readonly<Record<string, string>>;
}

export type Listener = (event: WorkspaceEvent) => void;

/** Read-only access to a workspace, for modules that must not change it. */
export interface WorkspaceReader {
  readonly id: Id;
  getState(): SceneState;
  getPreview(previewId: string): SceneState | undefined;
  subscribe(listener: Listener): () => void;
  watch<T>(
    selector: (state: SceneState) => T,
    listener: (value: T, revision: number) => void,
    equals?: (a: T, b: T) => boolean,
  ): () => void;
  findNodes(query: NodeQuery): Id[];
  history(): readonly HistoryEntry[];
  /**
   * A surface's presentation geometry placed in the world, as rendering and picking must use it.
   * Undefined for an unknown surface.
   */
  surfaceGeometry(surfaceId: Id): ResolvedGeometry | undefined;
  /**
   * The committed scene with every open preview applied, in the order they were opened: what
   * views show while gestures run. It is the committed scene when no preview is open.
   */
  getPresented(): SceneState;
  /** A surface's geometry placed in the presented scene; undefined for an unknown surface. */
  presentedGeometry(surfaceId: Id): ResolvedGeometry | undefined;
}

/**
 * The scene-changing operations of a workspace, for modules allowed to change the scene. Like
 * every scope, this is a software interface that makes a module's reach explicit, not a security
 * boundary: code running in the host stays under the host's own security model.
 */
/**
 * What a module that manages persistence may do: read the committed revision, take the scene's
 * canonical snapshot and hear of changes. It cannot change the scene. Like every scope, it makes a
 * module's reach explicit; it is not a security boundary.
 */
export interface WorkspacePersistence {
  readonly id: Id;
  /** The committed scene's revision. */
  revision(): number;
  /** The committed scene as a canonical snapshot: data only, never a handle or callback. */
  serialize(): SceneSnapshot;
  /** Replaces the scene with a snapshot's, as {@link Workspace.restore} does. */
  restore(snapshot: SceneSnapshot, options?: RestoreOptions): TxResult;
  subscribe(listener: Listener): () => void;
}

/** Options of a restore: `source` defaults to `restore`. */
export type RestoreOptions = Pick<TxOptions, 'expectedRevision' | 'source' | 'causeId'>;

export interface WorkspaceMutator {
  readonly id: Id;
  /** Applies `commands` atomically: all commit as one revision, or none do. */
  transaction(commands: readonly SceneCommand[], options?: TxOptions): TxResult;
  /** A transaction of one command. */
  dispatch(command: SceneCommand, options?: TxOptions): TxResult;
  /**
   * Proposes `commands` without committing them: the result is readable with `getPreview` and is
   * never persisted or undoable. A later preview with the same ID replaces it; a rejected one
   * leaves the last valid preview in place.
   */
  preview(
    previewId: string,
    commands: readonly SceneCommand[],
    options?: Pick<TxOptions, 'source' | 'causeId'>,
  ): PreviewResult;
  /** Ends a preview without committing it. Returns false when there is no such preview. */
  cancelPreview(previewId: string, reason: CancelReason): boolean | Queued<boolean>;
  /** Reverses the most recent undoable transaction as a new commit. */
  undo(options?: Pick<TxOptions, 'source' | 'causeId'>): TxResult;
  /** Re-applies the most recently undone transaction as a new commit. */
  redo(options?: Pick<TxOptions, 'source' | 'causeId'>): TxResult;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Adds a constraint; the returned function removes it (and is safe to call twice). */
  registerConstraint(constraint: Constraint): () => void;
  /**
   * Adds a geometry kind. Throws {@link SwfFailure} when its kind is not namespaced or taken. The
   * returned function removes it; surfaces already using the kind then resolve to the surface
   * rectangle with `approximate` fidelity.
   */
  registerGeometry(provider: GeometryProvider): () => void;
  /**
   * Adds a projection kind viewports may use. Throws {@link SwfFailure} when it is malformed or its
   * ID is taken. The returned function removes it; viewports already using it keep their settings.
   */
  registerProjectionKind(kind: ProjectionKind): () => void;
}

/** An independent spatial scene and the operations on it. */
export interface Workspace extends WorkspaceReader, WorkspaceMutator {
  readonly id: Id;
  readonly lifecycle: WorkspaceLifecycle;
  getDiagnostics(): readonly Diagnostic[];
  /** The read-only scope: queries, subscriptions and history, but no changes. */
  reader(): WorkspaceReader;
  /** The scene-changing scope: transactions, previews, undo and scene configuration. */
  mutator(): WorkspaceMutator;
  /** The committed scene as a canonical snapshot (open previews are not part of it). */
  serialize(): SceneSnapshot;
  /**
   * Replaces the whole scene (nodes, surfaces, cameras, viewports, orbit root, selection and
   * focus) with a snapshot's, as one undoable revision. Nothing is replaced unless the snapshot is
   * valid and everything it names is usable here: its geometry and projection kinds registered,
   * their parameters accepted. A failure (`SNAPSHOT_INVALID` naming the path, `CONFLICT` for a
   * stale `expectedRevision`) leaves the workspace exactly as it was. Restoring the same snapshot
   * again changes nothing: the scene is replaced, never added to. Records equal to the current ones
   * are kept as they are, so they report no change. The revision never goes back: it becomes the
   * snapshot's when that is later than the next one. Undo puts the previous nodes and surfaces
   * back; cameras and viewports, being view state, are not undone.
   */
  restore(snapshot: SceneSnapshot, options?: RestoreOptions): TxResult;
  /** The persistence scope: the revision, snapshots and change notifications, but no changes. */
  persistence(): WorkspacePersistence;
  /**
   * Releases the workspace's listeners, previews and history. It never touches anything the host
   * owns. Safe to call more than once.
   */
  dispose(): Promise<void>;
}

const EVENT_SOURCES: readonly EventSource[] = ['user', 'host', 'policy', 'restore', 'system'];
const OPTION_KEYS = [
  'id',
  'undoCapacity',
  'idempotencyCapacity',
  'diagnosticsCapacity',
  'now',
  'createId',
  'constraints',
  'geometry',
  'geometryLimits',
  'projectionKinds',
  'onDiagnostic',
  'frameBoundary',
];

/** Creates an empty, independent workspace. Throws {@link SwfFailure} for invalid options. */
export function createWorkspace(options: WorkspaceOptions): Workspace {
  return new WorkspaceImpl(options);
}

/** The records a layout transaction changed, before and after (undefined: absent). */
interface UndoRecord {
  readonly entry: HistoryEntry;
  readonly nodesBefore: ReadonlyMap<Id, NodeRecord | undefined>;
  readonly nodesAfter: ReadonlyMap<Id, NodeRecord | undefined>;
  readonly surfacesBefore: ReadonlyMap<Id, SurfaceRecord | undefined>;
  readonly surfacesAfter: ReadonlyMap<Id, SurfaceRecord | undefined>;
  readonly rootsBefore: readonly Id[];
  readonly rootsAfter: readonly Id[];
}

interface PreviewRecord {
  readonly commands: readonly SceneCommand[];
  readonly source: EventSource;
  readonly causeId: string | null;
  state: SceneState;
}

interface Meta {
  readonly transactionId: string;
  readonly source: EventSource;
  readonly causeId: string | null;
  readonly timestamp: number;
}

class WorkspaceImpl implements Workspace {
  readonly id: Id;
  #lifecycle: WorkspaceLifecycle = 'ready';
  #state: SceneState;
  readonly #undoCapacity: number;
  readonly #idempotencyCapacity: number;
  readonly #diagnosticsCapacity: number;
  readonly #now: () => number;
  readonly #createId: (inUse: (id: Id) => boolean) => Id;
  readonly #onDiagnostic: ((d: Diagnostic) => void) | undefined;
  readonly #frameBoundary: ((flush: () => void) => void) | undefined;
  /** Preview events held for the next frame boundary, by preview, in the order first held. */
  readonly #held = new Map<string, WorkspaceEvent>();
  #flushRequested = false;
  /** The committed scene with every open preview applied, cached until either changes. */
  #presented: {
    state: SceneState;
    previews: readonly PreviewRecord[];
    result: SceneState;
  } | null = null;
  readonly #constraints = new Map<string, Constraint>();
  #sortedConstraints: readonly Constraint[] = [];
  readonly #geometry = new GeometryRegistry();
  readonly #geometryLimits: GeometryLimits;
  readonly #projectionKinds = new ProjectionKindRegistry();
  readonly #listeners = new Set<Listener>();
  readonly #outbox: WorkspaceEvent[] = [];
  readonly #queue: (() => void)[] = [];
  #delivering = false;
  readonly #undo: UndoRecord[] = [];
  readonly #redo: UndoRecord[] = [];
  readonly #idempotency = new Map<string, { fingerprint: string; result: TxCommitted }>();
  readonly #previews = new Map<string, PreviewRecord>();
  readonly #diagnostics: Diagnostic[] = [];
  #txSeq = 0;
  #eventSeq = 0;
  #idSeq = 0;
  #disposalAnnounced = false;
  #disposed: Promise<void> | null = null;
  #resolveDisposed: (() => void) | null = null;

  constructor(options: WorkspaceOptions) {
    const record = checkOptions(options);
    this.id = record.id;
    this.#undoCapacity = record.undoCapacity;
    this.#idempotencyCapacity = record.idempotencyCapacity;
    this.#diagnosticsCapacity = record.diagnosticsCapacity;
    this.#now = record.now;
    const hostCreateId = record.createId;
    this.#createId =
      hostCreateId === undefined
        ? (inUse) => {
            let id: Id;
            do {
              this.#idSeq += 1;
              id = `node-${String(this.#idSeq)}`;
            } while (inUse(id));
            return id;
          }
        : () => hostCreateId();
    this.#onDiagnostic = record.onDiagnostic;
    this.#frameBoundary = record.frameBoundary;
    this.#geometryLimits = record.geometryLimits;
    for (const constraint of record.constraints) {
      this.#addConstraint(constraint);
    }
    for (const kind of record.projectionKinds) {
      this.#addProjectionKind(kind);
    }
    for (const provider of record.geometry) {
      this.#addGeometry(provider);
    }
    this.#state = Object.freeze({
      workspaceId: this.id,
      revision: 0,
      rootIds: Object.freeze([]),
      nodes: Table.empty<NodeRecord>(),
      surfaces: Table.empty<SurfaceRecord>(),
      cameras: Table.empty<CameraRecord>(),
      viewports: Table.empty<ViewportRecord>(),
      orbitRootId: null,
      selection: Object.freeze([]),
      focusedId: null,
    });
  }

  get lifecycle(): WorkspaceLifecycle {
    return this.#lifecycle;
  }

  getState(): SceneState {
    return this.#state;
  }

  serialize(): SceneSnapshot {
    return serializeScene(this.#state);
  }

  getPreview(previewId: string): SceneState | undefined {
    return this.#previews.get(previewId)?.state;
  }

  findNodes(query: NodeQuery): Id[] {
    return findNodes(this.#state, query);
  }

  history(): readonly HistoryEntry[] {
    return this.#undo.map((record) => record.entry);
  }

  surfaceGeometry(surfaceId: Id): ResolvedGeometry | undefined {
    return surfaceGeometry(this.#state, surfaceId, this.#geometry);
  }

  getPresented(): SceneState {
    return this.#combined();
  }

  presentedGeometry(surfaceId: Id): ResolvedGeometry | undefined {
    return surfaceGeometry(this.#combined(), surfaceId, this.#geometry);
  }

  canUndo(): boolean {
    return this.#lifecycle === 'ready' && this.#undo.length > 0;
  }

  canRedo(): boolean {
    return this.#lifecycle === 'ready' && this.#redo.length > 0;
  }

  getDiagnostics(): readonly Diagnostic[] {
    return [...this.#diagnostics];
  }

  reader(): WorkspaceReader {
    return Object.freeze({
      id: this.id,
      getState: () => this.getState(),
      getPreview: (previewId: string) => this.getPreview(previewId),
      subscribe: (listener: Listener) => this.subscribe(listener),
      watch: <T>(
        selector: (state: SceneState) => T,
        listener: (value: T, revision: number) => void,
        equals?: (a: T, b: T) => boolean,
      ) => this.watch(selector, listener, equals),
      findNodes: (query: NodeQuery) => this.findNodes(query),
      history: () => this.history(),
      surfaceGeometry: (surfaceId: Id) => this.surfaceGeometry(surfaceId),
      getPresented: () => this.getPresented(),
      presentedGeometry: (surfaceId: Id) => this.presentedGeometry(surfaceId),
    });
  }

  mutator(): WorkspaceMutator {
    return Object.freeze({
      id: this.id,
      transaction: (commands: readonly SceneCommand[], options?: TxOptions) =>
        this.transaction(commands, options),
      dispatch: (command: SceneCommand, options?: TxOptions) => this.dispatch(command, options),
      preview: (
        previewId: string,
        commands: readonly SceneCommand[],
        options?: Pick<TxOptions, 'source' | 'causeId'>,
      ) => this.preview(previewId, commands, options),
      cancelPreview: (previewId: string, reason: CancelReason) =>
        this.cancelPreview(previewId, reason),
      undo: (options?: Pick<TxOptions, 'source' | 'causeId'>) => this.undo(options),
      redo: (options?: Pick<TxOptions, 'source' | 'causeId'>) => this.redo(options),
      canUndo: () => this.canUndo(),
      canRedo: () => this.canRedo(),
      registerConstraint: (constraint: Constraint) => this.registerConstraint(constraint),
      registerGeometry: (provider: GeometryProvider) => this.registerGeometry(provider),
      registerProjectionKind: (kind: ProjectionKind) => this.registerProjectionKind(kind),
    });
  }

  persistence(): WorkspacePersistence {
    return Object.freeze({
      id: this.id,
      revision: () => this.#state.revision,
      serialize: () => this.serialize(),
      restore: (snapshot: SceneSnapshot, options?: RestoreOptions) =>
        this.restore(snapshot, options),
      subscribe: (listener: Listener) => this.subscribe(listener),
    });
  }

  // --- subscription -----------------------------------------------------------------------

  subscribe(listener: Listener): () => void {
    if (typeof listener !== 'function') {
      throw this.#failure(
        'INVALID_INPUT',
        `listener must be a function (got ${describe(listener)})`,
      );
    }
    if (this.#lifecycle !== 'ready') {
      throw this.#failure('WORKSPACE_DISPOSED', `workspace "${this.id}" is ${this.#lifecycle}`);
    }
    // Each subscription is its own entry, so subscribing one function twice delivers twice.
    const entry: Listener = (event) => {
      listener(event);
    };
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }

  watch<T>(
    selector: (state: SceneState) => T,
    listener: (value: T, revision: number) => void,
    equals: (a: T, b: T) => boolean = Object.is,
  ): () => void {
    let current = selector(this.#state);
    return this.subscribe((event) => {
      if (event.type !== 'transaction.committed') {
        return;
      }
      const next = selector(this.#state);
      if (!equals(current, next)) {
        current = next;
        listener(next, event.revision);
      }
    });
  }

  // --- constraints ------------------------------------------------------------------------

  registerConstraint(constraint: Constraint): () => void {
    if (this.#lifecycle !== 'ready') {
      throw this.#failure('WORKSPACE_DISPOSED', `workspace "${this.id}" is ${this.#lifecycle}`);
    }
    this.#addConstraint(constraint);
    return () => {
      if (this.#constraints.get(constraint.id) === constraint) {
        this.#constraints.delete(constraint.id);
        this.#sortedConstraints = sortConstraints(this.#constraints.values());
      }
    };
  }

  registerProjectionKind(kind: ProjectionKind): () => void {
    if (this.#lifecycle !== 'ready') {
      throw this.#failure('WORKSPACE_DISPOSED', `workspace "${this.id}" is ${this.#lifecycle}`);
    }
    return this.#addProjectionKind(kind);
  }

  #addProjectionKind(kind: ProjectionKind): () => void {
    try {
      return this.#projectionKinds.register(kind);
    } catch (error) {
      throw this.#failure('INVALID_INPUT', error instanceof Error ? error.message : String(error));
    }
  }

  registerGeometry(provider: GeometryProvider): () => void {
    if (this.#lifecycle !== 'ready') {
      throw this.#failure('WORKSPACE_DISPOSED', `workspace "${this.id}" is ${this.#lifecycle}`);
    }
    return this.#addGeometry(provider);
  }

  #addGeometry(provider: GeometryProvider): () => void {
    try {
      return this.#geometry.register(provider);
    } catch (error) {
      throw this.#failure('INVALID_INPUT', error instanceof Error ? error.message : String(error));
    }
  }

  #addConstraint(constraint: Constraint): void {
    checkConstraint(constraint, this.id);
    if (this.#constraints.has(constraint.id)) {
      throw this.#failure('INVALID_INPUT', `a constraint "${constraint.id}" is already registered`);
    }
    this.#constraints.set(constraint.id, constraint);
    this.#sortedConstraints = sortConstraints(this.#constraints.values());
  }

  // --- operations -------------------------------------------------------------------------

  transaction(commands: readonly SceneCommand[], options: TxOptions = {}): TxResult {
    return this.#schedule(() => this.#transaction(commands, options));
  }

  dispatch(command: SceneCommand, options: TxOptions = {}): TxResult {
    return this.transaction([command], options);
  }

  preview(
    previewId: string,
    commands: readonly SceneCommand[],
    options: Pick<TxOptions, 'source' | 'causeId'> = {},
  ): PreviewResult {
    return this.#schedule(() => this.#preview(previewId, commands, options));
  }

  cancelPreview(previewId: string, reason: CancelReason): boolean | Queued<boolean> {
    return this.#schedule(() => {
      const record = this.#previews.get(previewId);
      if (record === undefined || this.#lifecycle !== 'ready') {
        return false;
      }
      this.#previews.delete(previewId);
      this.#emit(
        'preview.cancelled',
        { previewId, reason },
        {
          source: record.source,
          causeId: previewId,
          phase: 'cancelled',
        },
      );
      return true;
    });
  }

  undo(options: Pick<TxOptions, 'source' | 'causeId'> = {}): TxResult {
    return this.#schedule(() => this.#travel('undo', options));
  }

  restore(snapshot: SceneSnapshot, options: RestoreOptions = {}): TxResult {
    return this.#schedule(() => this.#restore(snapshot, options));
  }

  redo(options: Pick<TxOptions, 'source' | 'causeId'> = {}): TxResult {
    return this.#schedule(() => this.#travel('redo', options));
  }

  dispose(): Promise<void> {
    if (this.#disposed !== null) {
      return this.#disposed;
    }
    this.#disposed = new Promise((resolve) => {
      this.#resolveDisposed = resolve;
    });
    this.#lifecycle = 'disposing';
    this.#drain();
    return this.#disposed;
  }

  // --- internals --------------------------------------------------------------------------

  #transaction(commands: unknown, rawOptions: unknown): TxOutcome {
    const transactionId = this.#nextTransactionId();
    let options: CheckedTxOptions;
    try {
      options = checkTxOptions(rawOptions);
    } catch (error) {
      return this.#reject(transactionId, error, { source: 'host', causeId: null, commands });
    }
    const meta: Meta = {
      transactionId,
      source: options.source,
      causeId: options.causeId,
      timestamp: this.#now(),
    };
    const settle = (outcome: TxOutcome): TxOutcome => {
      if (
        options.previewId !== null &&
        this.#previews.delete(options.previewId) &&
        outcome.status === 'rejected'
      ) {
        this.#emit(
          'preview.cancelled',
          {
            previewId: options.previewId,
            reason:
              outcome.error.code === 'CONSTRAINT_REJECTED'
                ? 'constraint-rejected'
                : 'commit-rejected',
          },
          { source: options.source, causeId: options.previewId, phase: 'cancelled' },
        );
      }
      return outcome;
    };
    if (this.#lifecycle !== 'ready') {
      return settle(this.#reject(transactionId, this.#disposedSignal(), { ...meta, commands }));
    }
    let fingerprint: string | null = null;
    if (options.idempotencyKey !== null) {
      fingerprint = fingerprintOf(commands, options);
      const known = this.#idempotency.get(options.idempotencyKey);
      if (known !== undefined) {
        if (known.fingerprint === fingerprint) {
          return settle({ ...known.result, replayed: true });
        }
        return settle(
          this.#reject(
            transactionId,
            new RejectionSignal(
              'INVALID_INPUT',
              `options.idempotencyKey "${options.idempotencyKey}" was already used for different commands`,
              { path: 'options.idempotencyKey' },
            ),
            { ...meta, commands },
          ),
        );
      }
    }
    if (options.expectedRevision !== null && options.expectedRevision !== this.#state.revision) {
      return settle(
        this.#reject(
          transactionId,
          new RejectionSignal(
            'CONFLICT',
            `the scene is at revision ${this.#state.revision}, not the expected ${options.expectedRevision}`,
            {
              path: 'options.expectedRevision',
              details: { currentRevision: this.#state.revision },
            },
          ),
          { ...meta, commands },
        ),
      );
    }
    let outcome: ApplyOutcome;
    try {
      outcome = applyCommands(
        this.#state,
        commands,
        this.#applyContext(options.source, meta.timestamp),
      );
    } catch (error) {
      return settle(this.#reject(transactionId, error, { ...meta, commands }));
    }
    if (options.previewId !== null) {
      this.#previews.delete(options.previewId);
    }
    const result = this.#commit(outcome, meta, {
      idempotencyKey: options.idempotencyKey,
      previewId: options.previewId,
      history: null,
    });
    if (options.idempotencyKey !== null && fingerprint !== null) {
      this.#idempotency.set(options.idempotencyKey, { fingerprint, result });
      for (const key of this.#idempotency.keys()) {
        if (this.#idempotency.size <= this.#idempotencyCapacity) {
          break;
        }
        this.#idempotency.delete(key);
      }
    }
    return result;
  }

  #restore(snapshot: unknown, rawOptions: unknown): TxOutcome {
    const transactionId = this.#nextTransactionId();
    const commands = [{ type: 'scene.restore' }];
    let options: CheckedTxOptions;
    try {
      options = checkTxOptions(rawOptions, ['expectedRevision', 'source', 'causeId']);
    } catch (error) {
      return this.#reject(transactionId, error, { source: 'restore', causeId: null, commands });
    }
    const source =
      (rawOptions as { source?: unknown }).source === undefined ? 'restore' : options.source;
    const meta: Meta = { transactionId, source, causeId: options.causeId, timestamp: this.#now() };
    if (this.#lifecycle !== 'ready') {
      return this.#reject(transactionId, this.#disposedSignal(), { ...meta, commands });
    }
    const before = this.#state;
    if (options.expectedRevision !== null && options.expectedRevision !== before.revision) {
      return this.#reject(
        transactionId,
        new RejectionSignal(
          'CONFLICT',
          `the scene is at revision ${before.revision}, not the expected ${options.expectedRevision}`,
          { path: 'options.expectedRevision', details: { currentRevision: before.revision } },
        ),
        { ...meta, commands },
      );
    }
    let scene: SceneSnapshot;
    try {
      scene = validateSceneSnapshot(snapshot);
      this.#checkUsable(scene, snapshot);
    } catch (error) {
      const signal =
        error instanceof SwfFailure
          ? new RejectionSignal(error.error.code, error.message, {
              ...(error.error.path === undefined ? {} : { path: error.error.path }),
            })
          : error;
      return this.#reject(transactionId, signal, { ...meta, commands });
    }
    const nodes = replaceRecords(before.nodes, scene.nodes, nodeSnapshot);
    const surfaces = replaceRecords(before.surfaces, scene.surfaces, surfaceSnapshot);
    const cameras = replaceRecords(before.cameras, scene.cameras, cameraSnapshot);
    const viewports = replaceRecords(before.viewports, scene.viewports, viewportSnapshot);
    const selectable = (id: Id) => effectiveState(nodes.table, id)?.selectable === true;
    const sameRoots =
      before.rootIds.length === scene.rootIds.length &&
      before.rootIds.every((id, i) => scene.rootIds[i] === id);
    return this.#commit(
      {
        nodes: nodes.table,
        surfaces: surfaces.table,
        cameras: cameras.table,
        viewports: viewports.table,
        orbitRootId: scene.orbitRootId,
        rootIds: sameRoots ? before.rootIds : scene.rootIds,
        selection: Object.freeze(scene.selection.filter(selectable)),
        focusedId: scene.focusedId !== null && selectable(scene.focusedId) ? scene.focusedId : null,
        commandTypes: Object.freeze(['scene.restore' as const]),
        touched: nodes.changed,
        touchedSurfaces: surfaces.changed,
        touchedCameras: cameras.changed,
        touchedViewports: viewports.changed,
        createdIds: Object.freeze([]),
      },
      meta,
      {
        idempotencyKey: null,
        previewId: null,
        history: null,
        // The revision never goes back, and a restored scene is never older than its snapshot.
        revision: Math.max(before.revision + 1, scene.revision),
      },
    );
  }

  /**
   * Throws `SNAPSHOT_INVALID` when the snapshot names a geometry or projection kind this
   * workspace does not have, or parameters the kind refuses. Paths name the snapshot as given.
   */
  #checkUsable(scene: SceneSnapshot, raw: unknown): void {
    const at = (list: 'surfaces' | 'viewports', id: Id): number => {
      const items = (raw as Record<string, unknown>)[list];
      const index = Array.isArray(items)
        ? items.findIndex((item: unknown) => (item as { id?: unknown } | null)?.id === id)
        : -1;
      return index;
    };
    const fail = (path: string, message: string) =>
      new RejectionSignal('SNAPSHOT_INVALID', `${path} ${message}`, { path });
    for (const surface of scene.surfaces) {
      const path = `surfaces[${String(at('surfaces', surface.id))}].geometry`;
      const { kind, params } = surface.geometry;
      const provider = this.#geometry.get(kind);
      if (provider === undefined) {
        throw fail(`${path}.kind`, `names geometry kind "${kind}", which is not registered here`);
      }
      let issue: string | null;
      try {
        issue = provider.validate(params, surface.bounds, this.#geometryLimits);
      } catch (error) {
        issue = `geometry provider "${kind}" failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (issue !== null) {
        throw fail(`${path}.params`, `is invalid: ${issue}`);
      }
    }
    for (const viewport of scene.viewports) {
      const path = `viewports[${String(at('viewports', viewport.id))}].projection`;
      const { id, config } = viewport.projection;
      const kind = this.#projectionKinds.get(id);
      if (kind === undefined) {
        throw fail(`${path}.id`, `names projection "${id}", which is not registered here`);
      }
      let issue: string | null;
      try {
        issue = kind.configIssue(config);
      } catch (error) {
        issue = `projection "${id}" failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (issue !== null) {
        throw fail(`${path}.config`, `is invalid: ${issue}`);
      }
    }
  }

  #applyContext(source: EventSource, now: number): ApplyContext {
    return {
      source,
      now,
      createId: this.#createId,
      constraints: this.#sortedConstraints,
      geometry: this.#geometry,
      geometryLimits: this.#geometryLimits,
      projectionKinds: this.#projectionKinds,
    };
  }

  #commit(
    outcome: ApplyOutcome,
    meta: Meta,
    extra: {
      idempotencyKey: string | null;
      previewId: string | null;
      history: { action: 'undo' | 'redo'; transactionId: string } | null;
      /** The new revision, when not the next one. */
      revision?: number;
    },
  ): TxCommitted {
    const before = this.#state;
    const after: SceneState = Object.freeze({
      workspaceId: this.id,
      revision: extra.revision ?? before.revision + 1,
      rootIds: outcome.rootIds,
      nodes: outcome.nodes,
      surfaces: outcome.surfaces,
      cameras: outcome.cameras,
      viewports: outcome.viewports,
      orbitRootId: outcome.orbitRootId,
      selection: outcome.selection,
      focusedId: outcome.focusedId,
    });
    this.#state = after;
    const layoutChanged =
      outcome.touched.length > 0 ||
      outcome.touchedSurfaces.length > 0 ||
      before.rootIds !== after.rootIds;
    if (extra.history === null && layoutChanged) {
      this.#record(before, after, outcome, meta);
    }
    for (const event of diffScenes(before, after, {
      nodes: outcome.touched,
      surfaces: outcome.touchedSurfaces,
      cameras: outcome.touchedCameras,
      viewports: outcome.touchedViewports,
    })) {
      this.#emitPending(event, {
        source: meta.source,
        causeId: meta.transactionId,
        phase: 'committed',
      });
    }
    this.#emit(
      'transaction.committed',
      {
        transactionId: meta.transactionId,
        previousRevision: before.revision,
        commandTypes: outcome.commandTypes,
        changedNodeIds: outcome.touched,
        changedSurfaceIds: outcome.touchedSurfaces,
        createdIds: outcome.createdIds,
        idempotencyKey: extra.idempotencyKey,
        previewId: extra.previewId,
        history: extra.history,
      },
      { source: meta.source, causeId: meta.causeId ?? meta.transactionId, phase: 'committed' },
    );
    this.#refreshPreviews();
    return Object.freeze({
      status: 'committed',
      transactionId: meta.transactionId,
      revision: after.revision,
      previousRevision: before.revision,
      createdIds: outcome.createdIds,
      changedNodeIds: outcome.touched,
      changedSurfaceIds: outcome.touchedSurfaces,
      replayed: false,
    });
  }

  #record(before: SceneState, after: SceneState, outcome: ApplyOutcome, meta: Meta): void {
    this.#redo.length = 0;
    if (this.#undoCapacity === 0) {
      return;
    }
    this.#undo.push({
      entry: Object.freeze({
        transactionId: meta.transactionId,
        timestamp: meta.timestamp,
        source: meta.source,
        previousRevision: before.revision,
        revision: after.revision,
        commandTypes: outcome.commandTypes,
        changedNodeIds: outcome.touched,
        changedSurfaceIds: outcome.touchedSurfaces,
      }),
      nodesBefore: snapshotOf(before.nodes, outcome.touched),
      nodesAfter: snapshotOf(after.nodes, outcome.touched),
      surfacesBefore: snapshotOf(before.surfaces, outcome.touchedSurfaces),
      surfacesAfter: snapshotOf(after.surfaces, outcome.touchedSurfaces),
      rootsBefore: before.rootIds,
      rootsAfter: after.rootIds,
    });
    if (this.#undo.length > this.#undoCapacity) {
      this.#undo.shift();
    }
  }

  /**
   * Undo or redo: restores the recorded records exactly, as a new commit. If anything recorded
   * has changed since (a later transaction outside history touched it), the step is rejected with
   * CONFLICT and history is left as it was.
   */
  #travel(action: 'undo' | 'redo', rawOptions: unknown): TxOutcome {
    const transactionId = this.#nextTransactionId();
    let options: CheckedTxOptions;
    try {
      options = checkTxOptions(rawOptions, ['source', 'causeId']);
    } catch (error) {
      return this.#reject(transactionId, error, { source: 'host', causeId: null, commands: [] });
    }
    const meta: Meta = {
      transactionId,
      source: options.source,
      causeId: options.causeId,
      timestamp: this.#now(),
    };
    if (this.#lifecycle !== 'ready') {
      return this.#reject(transactionId, this.#disposedSignal(), { ...meta, commands: [] });
    }
    const stack = action === 'undo' ? this.#undo : this.#redo;
    const record = stack.at(-1);
    if (record === undefined) {
      return this.#reject(
        transactionId,
        new RejectionSignal('INVALID_INPUT', `there is nothing to ${action}`),
        { ...meta, commands: [] },
      );
    }
    const undoing = action === 'undo';
    const nodesExpected = undoing ? record.nodesAfter : record.nodesBefore;
    const nodesTarget = undoing ? record.nodesBefore : record.nodesAfter;
    const surfacesExpected = undoing ? record.surfacesAfter : record.surfacesBefore;
    const surfacesTarget = undoing ? record.surfacesBefore : record.surfacesAfter;
    const rootsExpected = undoing ? record.rootsAfter : record.rootsBefore;
    const rootsTarget = undoing ? record.rootsBefore : record.rootsAfter;
    const state = this.#state;
    const staleNode = [...nodesExpected].find(([id, value]) => state.nodes.get(id) !== value);
    const staleSurface = [...surfacesExpected].find(
      ([id, value]) => state.surfaces.get(id) !== value,
    );
    const staleRoots = rootsExpected !== rootsTarget && state.rootIds !== rootsExpected;
    if (staleNode !== undefined || staleSurface !== undefined || staleRoots) {
      const what =
        staleNode !== undefined
          ? `node "${staleNode[0]}"`
          : staleSurface !== undefined
            ? `surface "${staleSurface[0]}"`
            : 'the root order';
      const entityId = staleNode?.[0] ?? staleSurface?.[0];
      return this.#reject(
        transactionId,
        new RejectionSignal(
          'CONFLICT',
          `cannot ${action} transaction ${record.entry.transactionId}: ${what} has changed since`,
          {
            ...(entityId === undefined ? {} : { entityId }),
            details: { currentRevision: state.revision },
          },
        ),
        { ...meta, commands: [] },
      );
    }
    const restored = restoreRecords(state.nodes, nodesTarget);
    const selectable = (id: Id) => effectiveState(restored, id)?.selectable === true;
    const selection = state.selection.filter(selectable);
    stack.pop();
    (undoing ? this.#redo : this.#undo).push(record);
    return this.#commit(
      {
        nodes: restored,
        surfaces: restoreRecords(state.surfaces, surfacesTarget),
        // Cameras and viewports are view state: undo and redo leave them as they are.
        cameras: state.cameras,
        viewports: state.viewports,
        orbitRootId:
          state.orbitRootId !== null && restored.has(state.orbitRootId) ? state.orbitRootId : null,
        rootIds: rootsTarget,
        selection:
          selection.length === state.selection.length ? state.selection : Object.freeze(selection),
        focusedId: state.focusedId !== null && selectable(state.focusedId) ? state.focusedId : null,
        commandTypes: record.entry.commandTypes,
        touched: record.entry.changedNodeIds,
        touchedSurfaces: record.entry.changedSurfaceIds,
        touchedCameras: Object.freeze([]),
        touchedViewports: Object.freeze([]),
        createdIds: Object.freeze([]),
      },
      meta,
      {
        idempotencyKey: null,
        previewId: null,
        history: { action, transactionId: record.entry.transactionId },
      },
    );
  }

  #preview(previewId: unknown, commands: unknown, rawOptions: unknown): PreviewOutcome {
    const transactionId = this.#nextTransactionId();
    let options: CheckedTxOptions;
    try {
      if (typeof previewId !== 'string' || previewId.trim() === '') {
        throw new RejectionSignal('INVALID_INPUT', 'previewId must be a non-blank string', {
          path: 'previewId',
        });
      }
      options = checkTxOptions(rawOptions, ['source', 'causeId']);
    } catch (error) {
      return this.#reject(transactionId, error, null);
    }
    if (this.#lifecycle !== 'ready') {
      return this.#reject(transactionId, this.#disposedSignal(), null);
    }
    let preview: {
      state: SceneState;
      changedNodeIds: readonly Id[];
      changedSurfaceIds: readonly Id[];
    };
    try {
      preview = this.#previewState(commands, options.source);
    } catch (error) {
      return this.#reject(transactionId, error, null);
    }
    const previous = this.#previews.get(previewId);
    this.#previews.set(previewId, {
      commands: commands as readonly SceneCommand[],
      source: options.source,
      causeId: options.causeId,
      state: preview.state,
    });
    // Open previews are presented together; one that cannot join the others is refused.
    try {
      this.#combined();
    } catch (error) {
      if (previous === undefined) {
        this.#previews.delete(previewId);
      } else {
        this.#previews.set(previewId, previous);
      }
      return this.#reject(transactionId, error, null);
    }
    const changed = {
      changedNodeIds: preview.changedNodeIds,
      changedSurfaceIds: preview.changedSurfaceIds,
    };
    this.#emit(
      'transform.preview',
      { previewId, ...changed },
      {
        source: options.source,
        causeId: options.causeId ?? previewId,
        phase: 'preview',
      },
    );
    return Object.freeze({ status: 'previewed', previewId, ...changed });
  }

  #previewState(
    commands: unknown,
    source: EventSource,
  ): { state: SceneState; changedNodeIds: readonly Id[]; changedSurfaceIds: readonly Id[] } {
    return this.#applyOnto(this.#state, commands, source);
  }

  /** `commands` applied to `base` as a preview: a scene at the committed revision. */
  #applyOnto(
    base: SceneState,
    commands: unknown,
    source: EventSource,
  ): { state: SceneState; changedNodeIds: readonly Id[]; changedSurfaceIds: readonly Id[] } {
    const outcome = applyCommands(base, commands, this.#applyContext(source, this.#now()));
    const state: SceneState = Object.freeze({
      workspaceId: this.id,
      revision: this.#state.revision,
      rootIds: outcome.rootIds,
      nodes: outcome.nodes,
      surfaces: outcome.surfaces,
      cameras: outcome.cameras,
      viewports: outcome.viewports,
      orbitRootId: outcome.orbitRootId,
      selection: outcome.selection,
      focusedId: outcome.focusedId,
    });
    return {
      state,
      changedNodeIds: outcome.touched,
      changedSurfaceIds: outcome.touchedSurfaces,
    };
  }

  /** Re-applies open previews to the newly committed scene, ending those that no longer apply. */
  #refreshPreviews(): void {
    for (const [previewId, record] of [...this.#previews]) {
      try {
        const preview = this.#previewState(record.commands, record.source);
        record.state = preview.state;
        this.#emit(
          'transform.preview',
          {
            previewId,
            changedNodeIds: preview.changedNodeIds,
            changedSurfaceIds: preview.changedSurfaceIds,
          },
          {
            source: record.source,
            causeId: record.causeId ?? previewId,
            phase: 'preview',
          },
        );
      } catch (error) {
        this.#previews.delete(previewId);
        const code = error instanceof RejectionSignal ? error.code : null;
        this.#emit(
          'preview.cancelled',
          {
            previewId,
            reason:
              code === 'UNKNOWN_ENTITY'
                ? 'target-detached'
                : code === 'CONSTRAINT_REJECTED'
                  ? 'constraint-rejected'
                  : 'invalidated',
          },
          { source: record.source, causeId: previewId, phase: 'cancelled' },
        );
      }
    }
    // The previews that still apply each on their own must also apply together: drop the newest
    // until they do.
    for (;;) {
      try {
        this.#combined();
        return;
      } catch {
        const newest = [...this.#previews.entries()].at(-1);
        if (newest === undefined) {
          return;
        }
        const [previewId, record] = newest;
        this.#previews.delete(previewId);
        this.#emit(
          'preview.cancelled',
          { previewId, reason: 'invalidated' },
          { source: record.source, causeId: previewId, phase: 'cancelled' },
        );
      }
    }
  }

  /**
   * The committed scene with every open preview applied, in the order they were opened. Throws
   * the rejection when they do not apply together.
   */
  #combined(): SceneState {
    const records = [...this.#previews.values()];
    if (records.length === 0) {
      return this.#state;
    }
    const cached = this.#presented;
    if (
      cached !== null &&
      cached.state === this.#state &&
      cached.previews.length === records.length &&
      cached.previews.every((r, i) => r === records[i])
    ) {
      return cached.result;
    }
    let state = this.#state;
    for (const record of records) {
      state = this.#applyOnto(state, record.commands, record.source).state;
    }
    this.#presented = { state: this.#state, previews: records, result: state };
    return state;
  }

  #reject(
    transactionId: string,
    error: unknown,
    meta: { source: EventSource; causeId: string | null; commands: unknown } | null,
  ): TxRejected {
    if (!(error instanceof RejectionSignal)) {
      throw error;
    }
    const swfError = makeError(error.code, error.message, {
      workspaceId: this.id,
      causeId: transactionId,
      ...(error.entityId === undefined ? {} : { entityId: error.entityId }),
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.details === undefined ? {} : { details: error.details }),
    });
    if (meta !== null && this.#lifecycle === 'ready') {
      this.#emit(
        'transaction.rejected',
        { transactionId, commandTypes: commandTypesOf(meta.commands), error: swfError },
        { source: meta.source, causeId: meta.causeId ?? transactionId, phase: 'rejected' },
      );
    }
    return Object.freeze({
      status: 'rejected',
      transactionId,
      error: swfError,
      revision: this.#state.revision,
    });
  }

  #disposedSignal(): RejectionSignal {
    return new RejectionSignal(
      'WORKSPACE_DISPOSED',
      `workspace "${this.id}" is ${this.#lifecycle}`,
    );
  }

  #failure(code: SwfError['code'], message: string): SwfFailure {
    return new SwfFailure(makeError(code, message, { workspaceId: this.id }));
  }

  #nextTransactionId(): string {
    this.#txSeq += 1;
    return `${this.id}/tx-${String(this.#txSeq)}`;
  }

  // --- delivery ---------------------------------------------------------------------------

  #emit<T extends WorkspaceEvent['type']>(
    type: T,
    payload: Extract<WorkspaceEvent, { type: T }>['payload'],
    how: { source: EventSource; causeId: string | null; phase: OperationPhase },
  ): void {
    this.#emitPending({ type, payload }, how);
  }

  #emitPending(
    event: PendingEvent,
    how: { source: EventSource; causeId: string | null; phase: OperationPhase },
  ): void {
    this.#eventSeq += 1;
    const built = Object.freeze({
      id: `${this.id}/ev-${String(this.#eventSeq)}`,
      type: event.type,
      workspaceId: this.id,
      revision: this.#state.revision,
      timestamp: this.#now(),
      source: how.source,
      causationId: how.causeId,
      phase: how.phase,
      payload: event.payload,
    }) as WorkspaceEvent;
    if (this.#frameBoundary !== undefined && built.type === 'transform.preview') {
      this.#hold(built);
      return;
    }
    // Held previews go first: events keep the order they happened in.
    this.#releaseHeld();
    this.#outbox.push(built);
  }

  /** Holds a preview event for the next frame boundary, merging it with one already held. */
  #hold(event: Extract<WorkspaceEvent, { type: 'transform.preview' }>): void {
    const previewId = event.payload.previewId;
    const held = this.#held.get(previewId);
    if (held?.type === 'transform.preview') {
      const union = (a: readonly Id[], b: readonly Id[]) =>
        Object.freeze([...new Set([...a, ...b])]);
      this.#held.set(
        previewId,
        Object.freeze({
          ...event,
          payload: Object.freeze({
            previewId,
            changedNodeIds: union(held.payload.changedNodeIds, event.payload.changedNodeIds),
            changedSurfaceIds: union(
              held.payload.changedSurfaceIds,
              event.payload.changedSurfaceIds,
            ),
          }),
        }),
      );
    } else {
      this.#held.set(previewId, event);
    }
    if (!this.#flushRequested && this.#frameBoundary !== undefined) {
      this.#flushRequested = true;
      this.#frameBoundary(() => {
        this.#flushRequested = false;
        if (this.#held.size > 0 && this.#lifecycle !== 'disposed') {
          this.#releaseHeld();
          this.#drain();
        }
      });
    }
  }

  /** Moves held preview events into the outbox, in the order they were first held. */
  #releaseHeld(): void {
    for (const event of this.#held.values()) {
      this.#outbox.push(event);
    }
    this.#held.clear();
  }

  /**
   * Runs `op` now, or, when called from inside an event listener, after the current delivery
   * finishes: a listener never changes the scene in the middle of another change's notification.
   */
  #schedule<T>(op: () => T): T | Queued<T> {
    if (this.#delivering) {
      let resolve: (value: T) => void = () => undefined;
      const completion = new Promise<T>((r) => {
        resolve = r;
      });
      this.#queue.push(() => {
        resolve(op());
      });
      return Object.freeze({ status: 'queued', completion });
    }
    const result = op();
    this.#drain();
    return result;
  }

  #drain(): void {
    if (this.#delivering) {
      return;
    }
    this.#delivering = true;
    try {
      for (;;) {
        const event = this.#outbox.shift();
        if (event !== undefined) {
          this.#deliver(event);
          continue;
        }
        const op = this.#queue.shift();
        if (op !== undefined) {
          op();
          continue;
        }
        if (this.#lifecycle === 'disposing' && !this.#disposalAnnounced) {
          this.#announceDisposal();
          continue;
        }
        break;
      }
    } finally {
      this.#delivering = false;
    }
    if (this.#lifecycle === 'disposing' && this.#disposalAnnounced) {
      this.#finishDisposal();
    }
  }

  #deliver(event: WorkspaceEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch (error) {
        this.#diagnose({
          code: 'LISTENER_THREW',
          message: `a listener threw while handling ${event.type}: ${error instanceof Error ? error.message : String(error)}`,
          timestamp: this.#now(),
          details: { eventId: event.id, eventType: event.type },
        });
      }
    }
  }

  #diagnose(diagnostic: Diagnostic): void {
    this.#diagnostics.push(Object.freeze(diagnostic));
    if (this.#diagnostics.length > this.#diagnosticsCapacity) {
      this.#diagnostics.shift();
    }
    try {
      this.#onDiagnostic?.(diagnostic);
    } catch {
      // A failing diagnostics sink must not interrupt the workspace.
    }
  }

  #announceDisposal(): void {
    this.#disposalAnnounced = true;
    for (const [previewId, record] of this.#previews) {
      this.#emit(
        'preview.cancelled',
        { previewId, reason: 'workspace-disposed' },
        {
          source: 'system',
          causeId: record.causeId ?? previewId,
          phase: 'cancelled',
        },
      );
    }
    this.#previews.clear();
    this.#emit('workspace.disposed', {}, { source: 'system', causeId: null, phase: 'committed' });
  }

  #finishDisposal(): void {
    this.#lifecycle = 'disposed';
    this.#listeners.clear();
    this.#undo.length = 0;
    this.#redo.length = 0;
    this.#idempotency.clear();
    this.#constraints.clear();
    this.#sortedConstraints = [];
    this.#resolveDisposed?.();
    this.#resolveDisposed = null;
  }
}

interface CheckedTxOptions {
  readonly expectedRevision: number | null;
  readonly idempotencyKey: string | null;
  readonly source: EventSource;
  readonly causeId: string | null;
  readonly previewId: string | null;
}

const TX_OPTION_KEYS = ['expectedRevision', 'idempotencyKey', 'source', 'causeId', 'previewId'];

function checkTxOptions(
  raw: unknown,
  allowed: readonly string[] = TX_OPTION_KEYS,
): CheckedTxOptions {
  const fail = (key: string, message: string) =>
    new RejectionSignal('INVALID_INPUT', `options.${key} ${message}`, { path: `options.${key}` });
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new RejectionSignal('INVALID_INPUT', `options must be an object (got ${describe(raw)})`, {
      path: 'options',
    });
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw fail(key, `is not a known option (expected one of ${allowed.join(', ')})`);
    }
  }
  const text = (key: string): string | null => {
    const value = record[key];
    if (value === undefined) {
      return null;
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw fail(key, 'must be a non-blank string');
    }
    return value;
  };
  const expected = record['expectedRevision'];
  if (
    expected !== undefined &&
    (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0)
  ) {
    throw fail('expectedRevision', 'must be a non-negative integer');
  }
  const source = record['source'] ?? 'host';
  if (!EVENT_SOURCES.includes(source as EventSource)) {
    throw fail('source', `must be one of ${EVENT_SOURCES.join(', ')}`);
  }
  return {
    expectedRevision: expected ?? null,
    idempotencyKey: text('idempotencyKey'),
    source: source as EventSource,
    causeId: text('causeId'),
    previewId: text('previewId'),
  };
}

interface CheckedOptions {
  readonly id: Id;
  readonly undoCapacity: number;
  readonly idempotencyCapacity: number;
  readonly diagnosticsCapacity: number;
  readonly now: () => number;
  readonly createId: (() => Id) | undefined;
  readonly constraints: readonly Constraint[];
  readonly geometry: readonly GeometryProvider[];
  readonly geometryLimits: GeometryLimits;
  readonly projectionKinds: readonly ProjectionKind[];
  readonly onDiagnostic: ((d: Diagnostic) => void) | undefined;
  readonly frameBoundary: ((flush: () => void) => void) | undefined;
}

/** Checks options passed from JavaScript, where the declared types are not enforced. */
function checkOptions(options: WorkspaceOptions): CheckedOptions {
  const fail = (field: string, message: string) =>
    new SwfFailure(
      makeError('INVALID_INPUT', `options.${field} ${message}`, { path: `options.${field}` }),
    );
  const raw: unknown = options;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SwfFailure(
      makeError('INVALID_INPUT', `workspace options must be an object (got ${describe(raw)})`),
    );
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!OPTION_KEYS.includes(key)) {
      throw fail(key, `is not a known option (expected one of ${OPTION_KEYS.join(', ')})`);
    }
  }
  const id = record['id'];
  if (typeof id !== 'string' || id.trim() === '') {
    throw fail('id', 'must be a non-blank string');
  }
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const value = record[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw fail(key, `must be an integer from ${min} to ${max}`);
    }
    return value;
  };
  for (const key of ['now', 'createId', 'onDiagnostic', 'frameBoundary']) {
    if (record[key] !== undefined && typeof record[key] !== 'function') {
      throw fail(key, 'must be a function');
    }
  }
  for (const key of ['constraints', 'geometry', 'projectionKinds']) {
    if (record[key] !== undefined && !Array.isArray(record[key])) {
      throw fail(key, 'must be an array');
    }
  }
  const limits: unknown = record['geometryLimits'] ?? {};
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
    throw fail('geometryLimits', 'must be an object');
  }
  const limitRecord = limits as Record<string, unknown>;
  for (const key of Object.keys(limitRecord)) {
    if (!(key in DEFAULT_GEOMETRY_LIMITS)) {
      throw fail(`geometryLimits.${key}`, 'is not a known limit');
    }
  }
  const limit = (key: keyof GeometryLimits): number => {
    const value = limitRecord[key] ?? DEFAULT_GEOMETRY_LIMITS[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw fail(`geometryLimits.${key}`, 'must be a positive integer');
    }
    return value;
  };
  return {
    id,
    undoCapacity: integer('undoCapacity', 100, 0, 10_000),
    idempotencyCapacity: integer('idempotencyCapacity', 1024, 1, Number.MAX_SAFE_INTEGER),
    diagnosticsCapacity: integer('diagnosticsCapacity', 100, 1, Number.MAX_SAFE_INTEGER),
    now: options.now ?? Date.now,
    createId: options.createId,
    constraints: options.constraints ?? [],
    geometry: options.geometry ?? [],
    projectionKinds: options.projectionKinds ?? [],
    geometryLimits: Object.freeze({
      maxParamsBytes: limit('maxParamsBytes'),
      maxPolygonVertices: limit('maxPolygonVertices'),
    }),
    onDiagnostic: options.onDiagnostic,
    frameBoundary: options.frameBoundary,
  };
}

/** The records with the given IDs (undefined where absent), for undo. */
function snapshotOf<T>(table: Table<T>, ids: readonly Id[]): ReadonlyMap<Id, T | undefined> {
  return new Map(ids.map((id) => [id, table.get(id)]));
}

/**
 * A table holding exactly `records`, keeping each current record whose canonical form equals the
 * new one, so unchanged entities stay the same objects and report no change. Returns the IDs whose
 * record was added, removed or replaced.
 */
function replaceRecords<T extends { readonly id: Id }>(
  table: Table<T>,
  records: readonly T[],
  canonical: (record: T) => T,
): { table: Table<T>; changed: readonly Id[] } {
  const draft = Table.empty<T>().edit();
  const changed: Id[] = [];
  for (const record of records) {
    const current = table.get(record.id);
    const same =
      current !== undefined && JSON.stringify(canonical(current)) === JSON.stringify(record);
    draft.set(record.id, same ? current : record);
    if (!same) {
      changed.push(record.id);
    }
  }
  for (const id of table.ids()) {
    if (!draft.has(id)) {
      changed.push(id);
    }
  }
  return { table: changed.length === 0 ? table : draft.freeze(), changed: Object.freeze(changed) };
}

/** `table` with the recorded records put back (an undefined record is removed). */
function restoreRecords<T>(table: Table<T>, records: ReadonlyMap<Id, T | undefined>): Table<T> {
  const draft = table.edit();
  for (const [id, value] of records) {
    if (value === undefined) {
      draft.delete(id);
    } else {
      draft.set(id, value);
    }
  }
  return draft.freeze();
}

function checkConstraint(constraint: unknown, workspaceId: Id): void {
  const fail = (message: string) =>
    new SwfFailure(makeError('INVALID_INPUT', `constraint ${message}`, { workspaceId }));
  if (typeof constraint !== 'object' || constraint === null) {
    throw fail(`must be an object (got ${describe(constraint)})`);
  }
  const c = constraint as Record<string, unknown>;
  if (typeof c['id'] !== 'string' || c['id'].trim() === '') {
    throw fail('id must be a non-blank string');
  }
  if (typeof c['order'] !== 'number' || !Number.isFinite(c['order'])) {
    throw fail(`"${c['id']}" order must be a finite number`);
  }
  if (typeof c['required'] !== 'boolean') {
    throw fail(`"${c['id']}" required must be a boolean`);
  }
  if (typeof c['resolve'] !== 'function') {
    throw fail(`"${c['id']}" resolve must be a function`);
  }
  if (c['appliesTo'] !== undefined && typeof c['appliesTo'] !== 'function') {
    throw fail(`"${c['id']}" appliesTo must be a function`);
  }
}

function commandTypesOf(commands: unknown): readonly OperationType[] {
  if (!Array.isArray(commands)) {
    return [];
  }
  return commands.flatMap((command: unknown) => {
    const type: unknown =
      typeof command === 'object' && command !== null
        ? (command as { type?: unknown }).type
        : undefined;
    return [...SCENE_COMMAND_TYPES, 'scene.restore' as const].filter((known) => known === type);
  });
}

/** A canonical rendering of a request, for recognizing a repeated idempotency key. */
function fingerprintOf(commands: unknown, options: CheckedTxOptions): string {
  return JSON.stringify(
    {
      commands,
      expectedRevision: options.expectedRevision,
      source: options.source,
      previewId: options.previewId,
    },
    (_key, value: unknown) =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : value,
  );
}
