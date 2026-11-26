import type { Direction, Ledger } from '@swf/models';
import { models } from '@swf/models';
import type { ApplyContext, ApplyOutcome } from './apply.js';
import { applyCommands } from './apply.js';
import type { EventSource, OperationType, SceneCommand } from './commands.js';
import { SCENE_COMMAND_TYPES } from './commands.js';
import type { Constraint } from './constraints.js';
import { sortConstraints } from './constraints.js';
import type { PendingEvent } from './diff.js';
import { diffScenes } from './diff.js';
import type { SwfError } from './errors.js';
import { makeError, RejectionSignal, SwfFailure, thrownText } from './errors.js';
import type { CancelReason, OperationPhase, WorkspaceEvent } from './events.js';
import { describe, describeAnswer } from './json.js';
import type { GeometryLimits, GeometryProvider, ResolvedGeometry } from './geometry.js';
import { DEFAULT_GEOMETRY_LIMITS, geometryParamsIssue, GeometryRegistry } from './geometry.js';
import type {
  CameraRecord,
  Id,
  NodeRecord,
  SceneState,
  SurfaceRecord,
  ViewportRecord,
} from './model.js';
import type { ProjectionKind } from './projection-kinds.js';
import { projectionConfigIssue, ProjectionKindRegistry } from './projection-kinds.js';
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

/**
 * How to make a workspace. The options are checked at run time: an unknown option or an invalid
 * value throws {@link SwfFailure} (`INVALID_INPUT`) with the path `options.<field>`.
 */
export interface WorkspaceOptions {
  /** The workspace's ID, unique within the host: a non-blank string. */
  readonly id: Id;
  /** How many committed layout transactions can be undone: 0 to 10000. Default 100. */
  readonly undoCapacity?: number;
  /** How many idempotency keys are remembered for this session: at least 1. Default 1024. */
  readonly idempotencyCapacity?: number;
  /** How many diagnostics `getDiagnostics` keeps: at least 1. Default 100. */
  readonly diagnosticsCapacity?: number;
  /**
   * The clock for timestamps, in milliseconds. Default `Date.now`. It is read once as each
   * operation begins, and every event and history entry of that operation carries the reading.
   * When it throws or reads as anything but a finite number, the operation is rejected with
   * `INVALID_INPUT` at `options.now`, naming the clock and what it threw or read, the scene is
   * left unchanged, and no event is sent, since none could be stamped.
   */
  readonly now?: () => number;
  /**
   * The clock transactions are timed with, in milliseconds: a monotonic one with sub-millisecond
   * resolution, such as `performance.now`, for useful durations. Default: `now`. It is read as a
   * transaction, undo, redo or restore begins and once more before it commits or is rejected;
   * when it fails it is reported as `now` is, at `options.timer`, and a commit it cannot time is
   * rejected before anything changes.
   */
  readonly timer?: () => number;
  /**
   * Supplies IDs for nodes, surfaces, cameras and viewports created without one; returning an ID
   * already in use rejects the transaction. Default: the next unused of `node-1`, `node-2`, ... in
   * this workspace, which keeps scenes reproducible. When it throws, the transaction is rejected
   * with `INVALID_INPUT` at the generated ID's path (such as `commands[1].node.id (generated)`),
   * naming `createId` and what it threw, and the scene is left unchanged.
   */
  readonly createId?: () => Id;
  /**
   * Constraints in force from the start, checked as {@link WorkspaceMutator.registerConstraint}
   * checks them.
   */
  readonly constraints?: readonly Constraint[];
  /** Geometry kinds beyond the built-in `rect` and `polygon`. */
  readonly geometry?: readonly GeometryProvider[];
  /** Overrides of the geometry complexity limits: positive integers. */
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
   * event is delivered as it happens. When it throws, the held events are delivered at once with
   * the operation's other events, a `FRAME_BOUNDARY_THREW` diagnostic records it, and the next
   * preview event asks for a boundary again.
   */
  readonly frameBoundary?: (flush: () => void) => void;
}

/**
 * How a transaction is checked and reported. The options are checked at run time: an unknown
 * option or an invalid value rejects the transaction with `INVALID_INPUT` naming
 * `options.<field>`.
 */
export interface TxOptions {
  /**
   * Commit only if the scene is still at this revision (a non-negative integer); otherwise reject
   * with `CONFLICT`, which is retryable and carries `details.currentRevision`.
   */
  readonly expectedRevision?: number;
  /**
   * Repeating a committed transaction with the same key and commands returns the first result
   * without applying it again. Reusing a key for different commands is rejected.
   *
   * A non-blank string. The commands, `expectedRevision`, `source` and `previewId` must all match
   * for a replay, which is marked `replayed`, applies nothing and sends no event; any difference
   * is rejected with `INVALID_INPUT` at `options.idempotencyKey`. Only committed transactions are
   * remembered, the most recent `idempotencyCapacity` keys of them.
   */
  readonly idempotencyKey?: string;
  /** Default `host`. */
  readonly source?: EventSource;
  /**
   * A host correlation ID: a non-blank string, carried as `causationId` on every event of the
   * operation it is given to. For a transaction, an undo, a redo or a restore, those are the
   * commit's entity events and its `transaction.committed`, or the refusal's
   * `transaction.rejected`; without one they carry the transaction's own ID. For a preview,
   * they are its `transform.preview` events and the `preview.cancelled` that ends it, however
   * it ends; without one they carry the preview's ID. A commit re-applying or ending open
   * previews sends their events with each preview's cause, not its own.
   */
  readonly causeId?: string;
  /**
   * The preview this transaction commits; the preview ends with the transaction. On a commit it
   * ends silently; on a rejection it ends with `preview.cancelled` (`constraint-rejected` or
   * `commit-rejected`).
   */
  readonly previewId?: string;
}

/** A transaction that committed. The result is frozen. */
export interface TxCommitted {
  /** Says the transaction committed. */
  readonly status: 'committed';
  /** The committed transaction's ID, unique within the workspace; the first one for a replay. */
  readonly transactionId: string;
  /** The revision the commit made. */
  readonly revision: number;
  /** The revision the scene was at before the commit. */
  readonly previousRevision: number;
  /** Nodes and surfaces the transaction created. */
  readonly createdIds: readonly Id[];
  /** Nodes created, changed or removed, in the order they were first touched. */
  readonly changedNodeIds: readonly Id[];
  /** Surfaces created, changed or removed, in the order they were first touched. */
  readonly changedSurfaceIds: readonly Id[];
  /** True when this result is a replay for a repeated idempotency key. */
  readonly replayed: boolean;
}

/**
 * An operation the workspace refused. Nothing changed: the scene, the history and the open
 * previews (other than one it was to commit) are as they were. The result is frozen.
 */
export interface TxRejected {
  /** Says the operation was refused. */
  readonly status: 'rejected';
  /** The refused attempt's own ID, which `error.causeId` also holds. */
  readonly transactionId: string;
  /** Why it was refused: the code, the message and, where there is one, the failing `path`. */
  readonly error: SwfError;
  /** The scene's revision, unchanged by the rejection. */
  readonly revision: number;
}

/** An operation requested from inside an event listener: it runs after the current delivery. */
export interface Queued<T> {
  /** Says the operation has not run yet. */
  readonly status: 'queued';
  /**
   * Settles with the operation's outcome once it has run, after the event delivery in progress
   * ends. A refusal, including one caused by a host callback that threw, fulfils it with a
   * rejected outcome; it is not rejected for one. It is rejected only when the operation itself
   * throws, as {@link WorkspaceMutator.cancelPreview} does when the clock fails: with the Error
   * thrown, or an Error carrying a thrown non-Error as its `cause`. Either way the operations
   * queued after it still run.
   */
  readonly completion: Promise<T>;
}

/** What a transaction, undo, redo or restore came to. */
export type TxOutcome = TxCommitted | TxRejected;

/**
 * What a transaction, undo, redo or restore returns: its outcome, or {@link Queued} when it was
 * requested from inside an event listener.
 */
export type TxResult = TxOutcome | Queued<TxOutcome>;

/** A preview that was opened or replaced. The result is frozen. */
export interface PreviewApplied {
  /** Says the preview is open with the given commands. */
  readonly status: 'previewed';
  /** The preview, as the caller named it. */
  readonly previewId: string;
  /** Nodes the preview's commands create, change or remove. */
  readonly changedNodeIds: readonly Id[];
  /** Surfaces the preview's commands create, change or remove. */
  readonly changedSurfaceIds: readonly Id[];
}

/**
 * What a preview came to. A refused preview reports a {@link TxRejected} but sends no
 * `transaction.rejected` event.
 */
export type PreviewOutcome = PreviewApplied | TxRejected;

/** What a preview returns: its outcome, or {@link Queued} from inside an event listener. */
export type PreviewResult = PreviewOutcome | Queued<PreviewOutcome>;

/** A committed layout transaction that undo can reverse. The entry is frozen. */
export interface HistoryEntry {
  /** The transaction as it was first committed. */
  readonly transactionId: string;
  /** When it was committed, by the workspace's clock, in milliseconds: its events' time. */
  readonly timestamp: number;
  /** Who originated it. */
  readonly source: EventSource;
  /** The revision before it was committed. */
  readonly previousRevision: number;
  /** The revision its commit made. */
  readonly revision: number;
  /** The operations it applied, in order. */
  readonly commandTypes: readonly OperationType[];
  /** Nodes it created, changed or removed, which an undo puts back. */
  readonly changedNodeIds: readonly Id[];
  /** Surfaces it created, changed or removed, which an undo puts back. */
  readonly changedSurfaceIds: readonly Id[];
}

/**
 * Something the workspace noticed that is not the failure of an operation: a listener that threw.
 * Diagnostics are frozen.
 */
export interface Diagnostic {
  /**
   * What was noticed: `LISTENER_THREW`, a listener threw while handling an event;
   * `FRAME_BOUNDARY_THREW`, the workspace's `frameBoundary` threw when asked for a boundary, so the
   * preview events it held were delivered at once instead of at the boundary.
   */
  readonly code: 'LISTENER_THREW' | 'FRAME_BOUNDARY_THREW';
  /** A human-readable account, naming the event type or callback and what was thrown. */
  readonly message: string;
  /** The `timestamp` of the event concerned: the time of the operation that sent it. */
  readonly timestamp: number;
  /**
   * The `eventId` and `eventType` of the event concerned: the one being handled for
   * `LISTENER_THREW`, the one that asked for a boundary for `FRAME_BOUNDARY_THREW`.
   */
  readonly details: Readonly<Record<string, string>>;
}

/**
 * Receives workspace events, one call per event, synchronously and in order. What it throws is
 * caught and recorded as a `LISTENER_THREW` diagnostic; the other listeners still receive the
 * event. Operations it requests are queued until the delivery ends.
 */
export type Listener = (event: WorkspaceEvent) => void;

/**
 * Read-only access to a workspace, for modules that must not change it. Like every scope, it makes
 * a module's reach explicit; it is not a security boundary.
 */
export interface WorkspaceReader {
  /** The workspace's ID. */
  readonly id: Id;
  /**
   * The committed scene: an immutable state, the same object until the next commit. Open previews
   * are not part of it.
   */
  getState(): SceneState;
  /**
   * The scene as one open preview proposes it: the committed scene with that preview's commands
   * applied, at the committed revision. Undefined when no such preview is open.
   */
  getPreview(previewId: string): SceneState | undefined;
  /**
   * Adds a listener for every event the workspace sends from now on, and returns the function
   * that removes it (safe to call more than once). Subscribing one function twice delivers each
   * event to it twice. A listener added or removed during a delivery takes effect from the next
   * event. Disposal releases every listener.
   *
   * @throws {@link SwfFailure} `INVALID_INPUT` when `listener` is not a function, and
   *   `WORKSPACE_DISPOSED` once the workspace is disposing or disposed.
   */
  subscribe(listener: Listener): () => void;
  /**
   * Calls `listener` whenever a commit changes what `selector` picks from the committed scene,
   * by `equals` (default `Object.is`), with the new value and the revision. `selector` runs at
   * once and after every commit; `listener` is not called for the value at subscription. Returns
   * the function that stops watching. Throws as {@link WorkspaceReader.subscribe} does.
   */
  watch<T>(
    selector: (state: SceneState) => T,
    listener: (value: T, revision: number) => void,
    equals?: (a: T, b: T) => boolean,
  ): () => void;
  /** Nodes of the committed scene matching `query`, as {@link findNodes} finds them. */
  findNodes(query: NodeQuery): Id[];
  /**
   * The transactions undo can reverse, oldest first: at most `undoCapacity` of them. An undone
   * transaction leaves this list until it is redone. A new array on every call.
   */
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
 * What a module that manages persistence may do: read the committed revision, take the scene's
 * canonical snapshot and hear of changes. It cannot change the scene. Like every scope, it makes a
 * module's reach explicit; it is not a security boundary.
 */
export interface WorkspacePersistence {
  /** The workspace's ID. */
  readonly id: Id;
  /** The committed scene's revision. */
  revision(): number;
  /** The committed scene as a canonical snapshot: data only, never a handle or callback. */
  serialize(): SceneSnapshot;
  /** Replaces the scene with a snapshot's, as {@link Workspace.restore} does. */
  restore(snapshot: SceneSnapshot, options?: RestoreOptions): TxResult;
  /** Adds a listener for every event, as {@link WorkspaceReader.subscribe} does. */
  subscribe(listener: Listener): () => void;
}

/** Options of a restore: `source` defaults to `restore`. */
export interface RestoreOptions extends Pick<TxOptions, 'expectedRevision' | 'source' | 'causeId'> {
  /**
   * What the restore does to the history. `record` (the default) records it as one undoable
   * revision, as any change to the layout. `fresh` starts the history afresh with it, leaving
   * nothing to undo or redo: for a snapshot of another document opened in the workspace's place,
   * whose history is not the replaced scene's, so that no undo ever brings the replaced scene
   * back into it.
   */
  readonly history?: 'record' | 'fresh';
}

/** What a restore may do to the history. */
const RESTORE_HISTORY = Object.freeze(['record', 'fresh'] as const);

/**
 * The scene-changing operations of a workspace, for modules allowed to change the scene. Like
 * every scope, this is a software interface that makes a module's reach explicit, not a security
 * boundary: code running in the host stays under the host's own security model.
 *
 * Every operation runs synchronously and reports a refusal through its result rather than by
 * throwing; only the `register` methods throw for invalid input, and `cancelPreview` when the
 * workspace's clock fails. A host callback an operation calls (a constraint's `appliesTo` or
 * `resolve`, a geometry provider's `validate`, a projection kind's `configIssue`, the workspace's
 * `createId`, `now` and `timer`) that throws or answers what it may not rejects the operation,
 * naming the callback and what it threw or answered, and leaves the workspace unchanged. Called
 * from inside an event listener, an operation is queued and runs once the delivery in progress
 * ends.
 */
export interface WorkspaceMutator {
  /** The workspace's ID. */
  readonly id: Id;
  /**
   * Applies `commands` atomically: all commit as one revision, or none do.
   *
   * `commands` must be a non-empty array. Each command is checked against the scene as the
   * earlier ones left it, then the proposed placements are resolved through the constraints. The
   * first failure rejects the whole transaction with the error's code and the path of the
   * failing field, such as `commands[2].node.transform.rotation`, and sends
   * `transaction.rejected`. A commit advances the revision by one and sends the entity events,
   * then `transaction.committed`; open previews are then re-applied to the new scene. A commit
   * that changes nodes, surfaces or the root order is recorded for undo and clears the redo
   * history. A disposed workspace rejects with `WORKSPACE_DISPOSED`.
   *
   * @example
   * ```ts
   * const result = workspace.transaction(
   *   [
   *     { type: 'node.create', node: { id: 'notes', kind: 'window', bounds: [1.6, 0.9, 0.02] } },
   *     { type: 'selection.set', ids: ['notes'] },
   *   ],
   *   { expectedRevision: workspace.getState().revision, idempotencyKey: 'create-notes' },
   * );
   * if (result.status === 'rejected') {
   *   console.warn(result.error.code, result.error.path, result.error.message);
   * }
   * ```
   */
  transaction(commands: readonly SceneCommand[], options?: TxOptions): TxResult;
  /** A transaction of one command. */
  dispatch(command: SceneCommand, options?: TxOptions): TxResult;
  /**
   * Proposes `commands` without committing them: the result is readable with `getPreview` and is
   * never persisted or undoable. A later preview with the same ID replaces it; a rejected one
   * leaves the last valid preview in place.
   *
   * `previewId` must be a non-blank string. Open previews are presented together in the order
   * they were opened, so a preview that cannot apply on top of the others is rejected. A preview
   * sends `transform.preview`. After every commit each open preview is applied again to the new
   * scene, and one that no longer applies ends with `preview.cancelled`. A preview ends when a
   * transaction commits it (`previewId`), when it is cancelled, or when the workspace is disposed.
   */
  preview(
    previewId: string,
    commands: readonly SceneCommand[],
    options?: Pick<TxOptions, 'source' | 'causeId'>,
  ): PreviewResult;
  /**
   * Ends a preview without committing it, sending `preview.cancelled` with `reason`. Returns false
   * when there is no such preview or the workspace is disposing or disposed. Previews opened after
   * it that no longer apply together without it end too, as `invalidated`.
   *
   * @throws {@link SwfFailure} `INVALID_INPUT` at `options.now` when the workspace's clock throws
   *   or reads as anything but a finite number; the preview stays open.
   */
  cancelPreview(previewId: string, reason: CancelReason): boolean | Queued<boolean>;
  /**
   * Reverses the most recent undoable transaction as a new commit.
   *
   * The nodes, surfaces and root order it changed are put back exactly; cameras and viewports are
   * left as they are, and the selection and focus lose any node that is no longer selectable.
   * Rejected with `INVALID_INPUT` when there is nothing to undo, and with `CONFLICT` (retryable,
   * leaving the history as it was) when a later change outside the history touched what it would
   * put back. The commit's `transaction.committed` names the undone transaction in `history`.
   */
  undo(options?: Pick<TxOptions, 'source' | 'causeId'>): TxResult;
  /**
   * Re-applies the most recently undone transaction as a new commit, checked and reported as
   * {@link WorkspaceMutator.undo} is. A new layout commit clears what can be redone.
   */
  redo(options?: Pick<TxOptions, 'source' | 'causeId'>): TxResult;
  /**
   * Whether there is a transaction to undo and the workspace is ready. An undo can still be
   * rejected with `CONFLICT`.
   */
  canUndo(): boolean;
  /**
   * Whether there is a transaction to redo and the workspace is ready. A redo can still be
   * rejected with `CONFLICT`.
   */
  canRedo(): boolean;
  /**
   * Adds a constraint; the returned function removes it (and is safe to call twice). It applies to
   * transactions and previews from then on; placements already committed are not revisited.
   *
   * @throws {@link SwfFailure} `INVALID_INPUT` when the constraint is malformed (a blank ID, a
   *   non-finite `order`, a non-boolean `required`, a missing `resolve`) or its ID is taken, and
   *   `WORKSPACE_DISPOSED` once the workspace is disposing or disposed.
   */
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
  /** The workspace's ID, as its options gave it. */
  readonly id: Id;
  /**
   * `ready` until {@link Workspace.dispose} is called, `disposing` while it ends open previews
   * and announces the disposal, then `disposed`.
   */
  readonly lifecycle: WorkspaceLifecycle;
  /**
   * The diagnostics recorded so far, oldest first: at most `diagnosticsCapacity`, the oldest
   * dropped first. A new array on every call.
   */
  getDiagnostics(): readonly Diagnostic[];
  /**
   * The read-only scope: queries, subscriptions and history, but no changes. A new frozen object
   * on every call, bound to this workspace; it needs no disposal.
   */
  reader(): WorkspaceReader;
  /**
   * The scene-changing scope: transactions, previews, undo and scene configuration. A new frozen
   * object on every call, bound to this workspace; it needs no disposal.
   */
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
   * back; cameras and viewports, being view state, are not undone. With `history: 'fresh'` the
   * history starts afresh instead: nothing is left to undo or redo. An unknown `history` is
   * `INVALID_INPUT` naming `options.history`.
   */
  restore(snapshot: SceneSnapshot, options?: RestoreOptions): TxResult;
  /**
   * The persistence scope: the revision, snapshots and change notifications, but no changes. A new
   * frozen object on every call, bound to this workspace; it needs no disposal.
   */
  persistence(): WorkspacePersistence;
  /**
   * Releases the workspace's listeners, previews and history. It never touches anything the host
   * owns. Safe to call more than once.
   *
   * Open previews end with `preview.cancelled` (`workspace-disposed`), then `workspace.disposed`
   * is sent and every listener, the history, the idempotency keys and the constraints are
   * released. The returned promise, the same one on every call, resolves once that is done. From
   * the first call on, operations are refused with `WORKSPACE_DISPOSED`. Scene states already
   * handed out stay readable. The disposal's events carry the time of the first call; when the
   * workspace's clock throws or reads as anything but a finite number then, the promise returned
   * is rejected with {@link SwfFailure} (`INVALID_INPUT` at `options.now`), nothing is disposed,
   * and a later call tries again.
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
  'timer',
  'createId',
  'constraints',
  'geometry',
  'geometryLimits',
  'projectionKinds',
  'onDiagnostic',
  'frameBoundary',
];

/**
 * Creates an empty, independent workspace at revision 0. The workspace is the caller's: it holds
 * no global state and touches nothing outside itself, and {@link Workspace.dispose} releases it.
 *
 * @throws {@link SwfFailure} `INVALID_INPUT` for invalid options, naming `options.<field>`: an
 *   unknown option, a blank `id`, a capacity out of range, a callback that is not a function, or
 *   a constraint, geometry provider or projection kind its `register` method would refuse.
 *
 * @example
 * ```ts
 * const workspace = createWorkspace({ id: 'desk' });
 * const stop = workspace.subscribe((event) => {
 *   if (event.type === 'node.created') console.log('created', event.payload.nodeId);
 * });
 * workspace.transaction([
 *   { type: 'node.create', node: { id: 'notes', kind: 'window', bounds: [1.6, 0.9, 0.02] } },
 *   {
 *     type: 'surface.attach',
 *     surface: {
 *       ownerNodeId: 'notes',
 *       bindingKey: 'notes-editor',
 *       adapterTypeId: 'host.view/1',
 *       bounds: [1.6, 0.9, 0.02],
 *     },
 *   },
 * ]);
 * stop();
 * await workspace.dispose();
 * ```
 */
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
  /** When the preview was last applied, by the clock: the time its records are changed at. */
  timestamp: number;
  state: SceneState;
}

/** The clocks as an operation read them when it began. */
interface Clocks {
  /** When the operation happened, by `now`: every event and record it makes carries it. */
  readonly timestamp: number;
  /** When the operation began, by the timer. */
  readonly started: number;
}

interface Meta extends Clocks {
  readonly transactionId: string;
  readonly source: EventSource;
  readonly causeId: string | null;
}

/** How an event is sent: its source, cause, phase and the time of the operation it belongs to. */
interface EmitHow {
  readonly source: EventSource;
  readonly causeId: string | null;
  readonly phase: OperationPhase;
  readonly timestamp: number;
}

class WorkspaceImpl implements Workspace {
  readonly id: Id;
  /**
   * The lifecycle, revision and history counts, as the kernel model (`Swf.Kernel`) keeps them:
   * every admission, commit, undo, redo and disposal step is its decision.
   */
  #ledger: Ledger;
  #state: SceneState;
  readonly #diagnosticsCapacity: number;
  readonly #now: () => number;
  readonly #timer: () => number;
  readonly #timerOption: 'now' | 'timer';
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
  #disposed: Promise<void> | null = null;
  #resolveDisposed: (() => void) | null = null;
  /** When `dispose` was called, by the clock: the time of the disposal's events. */
  #disposedAt = 0;

  constructor(options: WorkspaceOptions) {
    const record = checkOptions(options);
    this.id = record.id;
    this.#ledger = models.initial(BigInt(record.undoCapacity), BigInt(record.idempotencyCapacity));
    this.#diagnosticsCapacity = record.diagnosticsCapacity;
    this.#now = record.now;
    this.#timer = record.timer;
    this.#timerOption = record.timerOption;
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
    return this.#ledger.lifecycle.kind;
  }

  /** Whether the workspace admits an operation now. */
  #ready(): boolean {
    return models.admits(this.#ledger.lifecycle);
  }

  /**
   * Reads one of the host's clocks. One that throws or reads as anything but a finite number is
   * reported as the rejection `INVALID_INPUT` at the workspace option it came from.
   */
  #read(clock: 'now' | 'timer'): number {
    const option = clock === 'now' ? 'now' : this.#timerOption;
    const path = `options.${option}`;
    let value: unknown;
    try {
      value = clock === 'now' ? this.#now() : this.#timer();
    } catch (error) {
      throw new RejectionSignal(
        'INVALID_INPUT',
        `${path}: the workspace's ${option} clock threw: ${thrownText(error)}`,
        { path },
      );
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new RejectionSignal(
        'INVALID_INPUT',
        `${path}: the workspace's ${option} clock returned ${describeAnswer(value)}, not a finite number`,
        { path },
      );
    }
    return value;
  }

  /** The clocks read once as an operation begins; every event it sends carries this time. */
  #clocks(): Clocks {
    return { started: this.#read('timer'), timestamp: this.#read('now') };
  }

  /** How long the operation of `meta` has taken so far, by the timer. */
  #elapsed(meta: Clocks): number {
    return this.#read('timer') - meta.started;
  }

  /**
   * Reads the `now` clock for an operation that reports no rejection: a failing clock is the
   * {@link SwfFailure} the caller receives.
   */
  #readNowOrFail(): number {
    try {
      return this.#read('now');
    } catch (error) {
      if (!(error instanceof RejectionSignal)) {
        throw error;
      }
      throw new SwfFailure(
        makeError(error.code, error.message, {
          workspaceId: this.id,
          ...(error.path === undefined ? {} : { path: error.path }),
        }),
      );
    }
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
    return models.canTravel(this.#ledger, UNDO);
  }

  canRedo(): boolean {
    return models.canTravel(this.#ledger, REDO);
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
    if (!this.#ready()) {
      throw this.#failure('WORKSPACE_DISPOSED', `workspace "${this.id}" is ${this.lifecycle}`);
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
    if (!this.#ready()) {
      throw this.#failure('WORKSPACE_DISPOSED', `workspace "${this.id}" is ${this.lifecycle}`);
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
    if (!this.#ready()) {
      throw this.#failure('WORKSPACE_DISPOSED', `workspace "${this.id}" is ${this.lifecycle}`);
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
    if (!this.#ready()) {
      throw this.#failure('WORKSPACE_DISPOSED', `workspace "${this.id}" is ${this.lifecycle}`);
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
      if (record === undefined || !this.#ready()) {
        return false;
      }
      const timestamp = this.#readNowOrFail();
      this.#previews.delete(previewId);
      this.#emit(
        'preview.cancelled',
        { previewId, reason },
        {
          source: record.source,
          causeId: record.causeId ?? previewId,
          phase: 'cancelled',
          timestamp,
        },
      );
      this.#keepCombinable(timestamp);
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
    try {
      this.#disposedAt = this.#readNowOrFail();
    } catch (error) {
      return Promise.reject(asError(error));
    }
    this.#disposed = new Promise((resolve) => {
      this.#resolveDisposed = resolve;
    });
    this.#ledger = models.dispose(this.#ledger);
    this.#drain();
    return this.#disposed;
  }

  // --- internals --------------------------------------------------------------------------

  #transaction(commands: unknown, rawOptions: unknown): TxOutcome {
    const transactionId = this.#nextTransactionId();
    let clocks: Clocks;
    try {
      clocks = this.#clocks();
    } catch (error) {
      return this.#reject(transactionId, error, null);
    }
    let options: CheckedTxOptions;
    try {
      options = checkTxOptions(rawOptions);
    } catch (error) {
      return this.#reject(transactionId, error, {
        source: 'host',
        causeId: null,
        commands,
        ...clocks,
      });
    }
    const meta: Meta = {
      transactionId,
      source: options.source,
      causeId: options.causeId,
      ...clocks,
    };
    const settle = (outcome: TxOutcome): TxOutcome => {
      const previewId = options.previewId;
      const committing = previewId === null ? undefined : this.#previews.get(previewId);
      if (previewId === null || committing === undefined) {
        return outcome;
      }
      this.#previews.delete(previewId);
      if (outcome.status === 'rejected') {
        this.#emit(
          'preview.cancelled',
          {
            previewId,
            reason:
              outcome.error.code === 'CONSTRAINT_REJECTED'
                ? 'constraint-rejected'
                : 'commit-rejected',
          },
          {
            source: options.source,
            causeId: committing.causeId ?? previewId,
            phase: 'cancelled',
            timestamp: meta.timestamp,
          },
        );
        this.#keepCombinable(meta.timestamp);
      }
      return outcome;
    };
    const key = this.#ready() ? options.idempotencyKey : null;
    const fingerprint = key === null ? null : fingerprintOf(commands, options);
    const known = key === null ? undefined : this.#idempotency.get(key);
    const gate = models.gate(this.#ledger, {
      known: known === undefined ? null : known.fingerprint === fingerprint,
      expected: options.expectedRevision === null ? null : BigInt(options.expectedRevision),
    });
    switch (gate.kind) {
      case 'refuseDisposed':
        return settle(this.#reject(transactionId, this.#disposedSignal(), { ...meta, commands }));
      case 'replay':
        if (known === undefined) {
          throw new Error(
            'the kernel model replayed an idempotency key the workspace does not know',
          );
        }
        return settle({ ...known.result, replayed: true });
      case 'refuseKeyReused':
        return settle(
          this.#reject(
            transactionId,
            new RejectionSignal(
              'INVALID_INPUT',
              `options.idempotencyKey "${String(key)}" was already used for different commands`,
              { path: 'options.idempotencyKey' },
            ),
            { ...meta, commands },
          ),
        );
      case 'refuseStale':
        return settle(
          this.#reject(transactionId, this.#staleSignal(options), { ...meta, commands }),
        );
      case 'proceed':
        break;
    }
    let outcome: ApplyOutcome;
    let durationMs: number;
    try {
      outcome = applyCommands(
        this.#state,
        commands,
        this.#applyContext(options.source, meta.timestamp),
      );
      durationMs = this.#elapsed(meta);
    } catch (error) {
      return settle(this.#reject(transactionId, error, { ...meta, commands }));
    }
    if (options.previewId !== null) {
      this.#previews.delete(options.previewId);
    }
    const decision = models.commit(this.#ledger, {
      kind: 'commands',
      layout: layoutChanged(this.#state, outcome),
      keyed: key !== null,
    });
    const result = this.#commit(outcome, meta, durationMs, decision, {
      idempotencyKey: options.idempotencyKey,
      previewId: options.previewId,
      history: null,
      // Validated by applying them.
      commands: commands as readonly SceneCommand[],
    });
    if (key !== null && fingerprint !== null) {
      this.#idempotency.set(key, { fingerprint, result });
      // The oldest keys first: the one just remembered is the newest.
      let evict = Number(decision.evictKeys);
      for (const old of this.#idempotency.keys()) {
        if (evict === 0) {
          break;
        }
        this.#idempotency.delete(old);
        evict -= 1;
      }
    }
    return result;
  }

  #restore(snapshot: unknown, rawOptions: unknown): TxOutcome {
    const transactionId = this.#nextTransactionId();
    const commands = [{ type: 'scene.restore' }];
    let clocks: Clocks;
    try {
      clocks = this.#clocks();
    } catch (error) {
      return this.#reject(transactionId, error, null);
    }
    let options: CheckedTxOptions;
    let history: (typeof RESTORE_HISTORY)[number];
    try {
      options = checkTxOptions(rawOptions, ['expectedRevision', 'source', 'causeId', 'history']);
      history = checkRestoreHistory(rawOptions);
    } catch (error) {
      return this.#reject(transactionId, error, {
        source: 'restore',
        causeId: null,
        commands,
        ...clocks,
      });
    }
    const source =
      (rawOptions as { source?: unknown }).source === undefined ? 'restore' : options.source;
    const meta: Meta = {
      transactionId,
      source,
      causeId: options.causeId,
      ...clocks,
    };
    const gate = models.gate(this.#ledger, {
      known: null,
      expected: options.expectedRevision === null ? null : BigInt(options.expectedRevision),
    });
    if (gate.kind === 'refuseDisposed') {
      return this.#reject(transactionId, this.#disposedSignal(), { ...meta, commands });
    }
    if (gate.kind === 'refuseStale') {
      return this.#reject(transactionId, this.#staleSignal(options), { ...meta, commands });
    }
    if (gate.kind !== 'proceed') {
      throw new Error(`the kernel model answered a restore with ${gate.kind}`);
    }
    const before = this.#state;
    let scene: SceneSnapshot;
    let durationMs: number;
    try {
      scene = validateSceneSnapshot(snapshot);
      this.#checkUsable(scene, snapshot);
      durationMs = this.#elapsed(meta);
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
    const outcome: ApplyOutcome = {
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
    };
    // The revision never goes back, and a restored scene is never older than its snapshot.
    const decision = models.commit(this.#ledger, {
      kind: 'restore',
      layout: layoutChanged(before, outcome),
      snapshotRevision: BigInt(scene.revision),
      fresh: history === 'fresh',
    });
    return this.#commit(outcome, meta, durationMs, decision, {
      idempotencyKey: null,
      previewId: null,
      history: null,
      commands: null,
    });
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
      const issue = geometryParamsIssue(provider, params, surface.bounds, this.#geometryLimits);
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
      const issue = projectionConfigIssue(kind, config);
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
    /** How long the operation took, read before anything is changed. */
    durationMs: number,
    /** What the kernel model decided the commit does to the revision and the history. */
    decision: {
      readonly next: Ledger;
      readonly clearUndo: boolean;
      readonly clearRedo: boolean;
      readonly push: boolean;
      readonly dropOldest: boolean;
    },
    extra: {
      idempotencyKey: string | null;
      previewId: string | null;
      history: { action: 'undo' | 'redo'; transactionId: string } | null;
      /** The commands committed; null for an undo, redo or restore. */
      commands: readonly SceneCommand[] | null;
    },
  ): TxCommitted {
    const before = this.#state;
    const after: SceneState = Object.freeze({
      workspaceId: this.id,
      revision: Number(decision.next.revision),
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
    this.#ledger = decision.next;
    if (decision.clearUndo) {
      this.#undo.length = 0;
    }
    if (decision.clearRedo) {
      this.#redo.length = 0;
    }
    if (decision.push) {
      this.#record(before, after, outcome, meta);
    }
    if (decision.dropOldest) {
      this.#undo.shift();
    }
    // Every event of the commit, its entity events and its transaction.committed, carries the
    // host's cause, or the transaction's own ID when the host gave none.
    const how: EmitHow = {
      source: meta.source,
      causeId: meta.causeId ?? meta.transactionId,
      phase: 'committed',
      timestamp: meta.timestamp,
    };
    for (const event of diffScenes(before, after, {
      nodes: outcome.touched,
      surfaces: outcome.touchedSurfaces,
      cameras: outcome.touchedCameras,
      viewports: outcome.touchedViewports,
    })) {
      this.#emitPending(event, how);
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
        commands: extra.commands,
        durationMs,
      },
      how,
    );
    this.#refreshPreviews(meta.timestamp);
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
  }

  /**
   * Undo or redo: restores the recorded records exactly, as a new commit. If anything recorded
   * has changed since (a later transaction outside history touched it), the step is rejected with
   * CONFLICT and history is left as it was.
   */
  #travel(action: 'undo' | 'redo', rawOptions: unknown): TxOutcome {
    const transactionId = this.#nextTransactionId();
    let clocks: Clocks;
    try {
      clocks = this.#clocks();
    } catch (error) {
      return this.#reject(transactionId, error, null);
    }
    let options: CheckedTxOptions;
    try {
      options = checkTxOptions(rawOptions, ['source', 'causeId']);
    } catch (error) {
      return this.#reject(transactionId, error, {
        source: 'host',
        causeId: null,
        commands: [],
        ...clocks,
      });
    }
    const meta: Meta = {
      transactionId,
      source: options.source,
      causeId: options.causeId,
      ...clocks,
    };
    const undoing = action === 'undo';
    const stack = undoing ? this.#undo : this.#redo;
    const record = stack.at(-1);
    const state = this.#state;
    // What the step would restore that has changed since it was recorded, if there is a step.
    let stale: { readonly what: string; readonly entityId: Id | undefined } | null = null;
    if (record !== undefined) {
      const nodesExpected = undoing ? record.nodesAfter : record.nodesBefore;
      const surfacesExpected = undoing ? record.surfacesAfter : record.surfacesBefore;
      const rootsExpected = undoing ? record.rootsAfter : record.rootsBefore;
      const rootsTarget = undoing ? record.rootsBefore : record.rootsAfter;
      const staleNode = [...nodesExpected].find(([id, value]) => state.nodes.get(id) !== value);
      const staleSurface = [...surfacesExpected].find(
        ([id, value]) => state.surfaces.get(id) !== value,
      );
      if (staleNode !== undefined) {
        stale = { what: `node "${staleNode[0]}"`, entityId: staleNode[0] };
      } else if (staleSurface !== undefined) {
        stale = { what: `surface "${staleSurface[0]}"`, entityId: staleSurface[0] };
      } else if (rootsExpected !== rootsTarget && state.rootIds !== rootsExpected) {
        stale = { what: 'the root order', entityId: undefined };
      }
    }
    const travel = models.travel(this.#ledger, undoing ? UNDO : REDO, stale !== null);
    switch (travel.kind) {
      case 'refuseDisposed':
        return this.#reject(transactionId, this.#disposedSignal(), { ...meta, commands: [] });
      case 'refuseEmpty':
        return this.#reject(
          transactionId,
          new RejectionSignal('INVALID_INPUT', `there is nothing to ${action}`),
          { ...meta, commands: [] },
        );
      case 'refuseStale':
        if (record === undefined || stale === null) {
          throw new Error(`the kernel model refused an ${action} the workspace has no record of`);
        }
        return this.#reject(
          transactionId,
          new RejectionSignal(
            'CONFLICT',
            `cannot ${action} transaction ${record.entry.transactionId}: ${stale.what} has changed since`,
            {
              ...(stale.entityId === undefined ? {} : { entityId: stale.entityId }),
              details: { currentRevision: state.revision },
            },
          ),
          { ...meta, commands: [] },
        );
      case 'commit':
        break;
    }
    if (record === undefined) {
      throw new Error(`the kernel model took an ${action} the workspace has no record of`);
    }
    let durationMs: number;
    try {
      durationMs = this.#elapsed(meta);
    } catch (error) {
      return this.#reject(transactionId, error, { ...meta, commands: [] });
    }
    const nodesTarget = undoing ? record.nodesBefore : record.nodesAfter;
    const surfacesTarget = undoing ? record.surfacesBefore : record.surfacesAfter;
    const rootsTarget = undoing ? record.rootsBefore : record.rootsAfter;
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
      durationMs,
      { next: travel.next, clearUndo: false, clearRedo: false, push: false, dropOldest: false },
      {
        idempotencyKey: null,
        previewId: null,
        history: { action, transactionId: record.entry.transactionId },
        commands: null,
      },
    );
  }

  #preview(previewId: unknown, commands: unknown, rawOptions: unknown): PreviewOutcome {
    const transactionId = this.#nextTransactionId();
    let timestamp: number;
    try {
      timestamp = this.#read('now');
    } catch (error) {
      return this.#reject(transactionId, error, null);
    }
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
    if (!this.#ready()) {
      return this.#reject(transactionId, this.#disposedSignal(), null);
    }
    let preview: {
      state: SceneState;
      changedNodeIds: readonly Id[];
      changedSurfaceIds: readonly Id[];
    };
    try {
      preview = this.#applyOnto(this.#state, commands, options.source, timestamp);
    } catch (error) {
      return this.#reject(transactionId, error, null);
    }
    const previous = this.#previews.get(previewId);
    this.#previews.set(previewId, {
      commands: commands as readonly SceneCommand[],
      source: options.source,
      causeId: options.causeId,
      timestamp,
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
        timestamp,
      },
    );
    return Object.freeze({ status: 'previewed', previewId, ...changed });
  }

  /**
   * `commands` applied to `base` as a preview, at `timestamp`: a scene at the committed revision.
   */
  #applyOnto(
    base: SceneState,
    commands: unknown,
    source: EventSource,
    timestamp: number,
  ): { state: SceneState; changedNodeIds: readonly Id[]; changedSurfaceIds: readonly Id[] } {
    const outcome = applyCommands(base, commands, this.#applyContext(source, timestamp));
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

  /**
   * Re-applies open previews to the newly committed scene, at the commit's `timestamp`, ending
   * those that no longer apply.
   */
  #refreshPreviews(timestamp: number): void {
    for (const [previewId, record] of [...this.#previews]) {
      try {
        const preview = this.#applyOnto(this.#state, record.commands, record.source, timestamp);
        record.state = preview.state;
        record.timestamp = timestamp;
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
            timestamp,
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
          {
            source: record.source,
            causeId: record.causeId ?? previewId,
            phase: 'cancelled',
            timestamp,
          },
        );
      }
    }
    this.#keepCombinable(timestamp);
  }

  /**
   * Keeps the open previews presentable together: while they do not apply together, the newest is
   * ended as invalidated (at `timestamp`). Run whenever the committed scene or the set of open
   * previews changes, so presenting them never applies anything.
   */
  #keepCombinable(timestamp: number): void {
    for (;;) {
      try {
        this.#combined();
        return;
      } catch (error) {
        const newest = [...this.#previews.entries()].at(-1);
        if (newest === undefined) {
          // With no preview open the committed scene itself is presented, which cannot fail.
          throw new Error('the committed scene failed to present', { cause: error });
        }
        const [previewId, record] = newest;
        this.#previews.delete(previewId);
        this.#emit(
          'preview.cancelled',
          { previewId, reason: 'invalidated' },
          {
            source: record.source,
            causeId: record.causeId ?? previewId,
            phase: 'cancelled',
            timestamp,
          },
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
      state = this.#applyOnto(state, record.commands, record.source, record.timestamp).state;
    }
    this.#presented = { state: this.#state, previews: records, result: state };
    return state;
  }

  /**
   * Reports `error` as the operation's rejection, sending `transaction.rejected` when `meta` is
   * given and the workspace is ready. A rejection whose duration cannot be timed, because the
   * timer fails, is reported as the timer's failure instead, and sent nowhere: no event can be
   * made without the clock.
   */
  #reject(
    transactionId: string,
    error: unknown,
    meta: {
      source: EventSource;
      causeId: string | null;
      commands: unknown;
      started: number;
      timestamp: number;
    } | null,
  ): TxRejected {
    if (!(error instanceof RejectionSignal)) {
      throw error;
    }
    let durationMs = 0;
    if (meta !== null && this.#ready()) {
      try {
        durationMs = this.#elapsed(meta);
      } catch (clockError) {
        return this.#reject(transactionId, clockError, null);
      }
    }
    const swfError = makeError(error.code, error.message, {
      workspaceId: this.id,
      causeId: transactionId,
      ...(error.entityId === undefined ? {} : { entityId: error.entityId }),
      ...(error.path === undefined ? {} : { path: error.path }),
      ...(error.details === undefined ? {} : { details: error.details }),
    });
    if (meta !== null && this.#ready()) {
      this.#emit(
        'transaction.rejected',
        {
          transactionId,
          commandTypes: commandTypesOf(meta.commands),
          error: swfError,
          durationMs,
        },
        {
          source: meta.source,
          causeId: meta.causeId ?? transactionId,
          phase: 'rejected',
          timestamp: meta.timestamp,
        },
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
    return new RejectionSignal('WORKSPACE_DISPOSED', `workspace "${this.id}" is ${this.lifecycle}`);
  }

  /** The scene is not at the revision a transaction expected. */
  #staleSignal(options: CheckedTxOptions): RejectionSignal {
    const revision = this.#state.revision;
    return new RejectionSignal(
      'CONFLICT',
      `the scene is at revision ${revision}, not the expected ${String(options.expectedRevision)}`,
      { path: 'options.expectedRevision', details: { currentRevision: revision } },
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
    how: EmitHow,
  ): void {
    this.#emitPending({ type, payload }, how);
  }

  #emitPending(event: PendingEvent, how: EmitHow): void {
    this.#eventSeq += 1;
    const built = Object.freeze({
      id: `${this.id}/ev-${String(this.#eventSeq)}`,
      type: event.type,
      workspaceId: this.id,
      revision: this.#state.revision,
      timestamp: how.timestamp,
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
      try {
        this.#frameBoundary(() => {
          this.#flushRequested = false;
          if (this.#held.size > 0 && models.delivers(this.#ledger.lifecycle)) {
            this.#releaseHeld();
            this.#drain();
          }
        });
      } catch (error) {
        // No boundary will come: what is held goes out with the operation's other events.
        this.#flushRequested = false;
        this.#releaseHeld();
        this.#diagnose({
          code: 'FRAME_BOUNDARY_THREW',
          message: `frameBoundary threw: ${thrownText(error)}; the held preview events were delivered at once`,
          timestamp: event.timestamp,
          details: { eventId: event.id, eventType: event.type },
        });
      }
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
      let run: () => void = () => undefined;
      const completion = new Promise<T>((resolve, reject) => {
        run = () => {
          let result: T;
          try {
            result = op();
          } catch (error) {
            // Settled either way: the queue goes on with the next operation.
            reject(asError(error));
            return;
          }
          resolve(result);
        };
      });
      this.#queue.push(run);
      return Object.freeze({ status: 'queued', completion });
    }
    try {
      return op();
    } finally {
      this.#drain();
    }
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
        const step = models.idle(this.#ledger);
        if (step.kind === 'announce') {
          this.#ledger = step.next;
          this.#announceDisposal();
          continue;
        }
        break;
      }
    } finally {
      this.#delivering = false;
    }
    const step = models.idle(this.#ledger);
    if (step.kind === 'finish') {
      this.#ledger = step.next;
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
          message: `a listener threw while handling ${event.type}: ${thrownText(error)}`,
          timestamp: event.timestamp,
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
    for (const [previewId, record] of this.#previews) {
      this.#emit(
        'preview.cancelled',
        { previewId, reason: 'workspace-disposed' },
        {
          source: 'system',
          causeId: record.causeId ?? previewId,
          phase: 'cancelled',
          timestamp: this.#disposedAt,
        },
      );
    }
    this.#previews.clear();
    this.#emit(
      'workspace.disposed',
      {},
      { source: 'system', causeId: null, phase: 'committed', timestamp: this.#disposedAt },
    );
  }

  #finishDisposal(): void {
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

/** What was thrown, as an Error: itself when it is one, else an Error carrying it as `cause`. */
function asError(thrown: unknown): Error {
  return thrown instanceof Error
    ? thrown
    : new Error(`the operation threw ${describeAnswer(thrown)}`, { cause: thrown });
}

const UNDO: Direction = Object.freeze({ kind: 'undo' });
const REDO: Direction = Object.freeze({ kind: 'redo' });

/** Whether an outcome changes the layout: any node, any surface or the root order. Only such a
 * commit is recorded for undo. */
function layoutChanged(before: SceneState, outcome: ApplyOutcome): boolean {
  return (
    outcome.touched.length > 0 ||
    outcome.touchedSurfaces.length > 0 ||
    before.rootIds !== outcome.rootIds
  );
}

interface CheckedTxOptions {
  readonly expectedRevision: number | null;
  readonly idempotencyKey: string | null;
  readonly source: EventSource;
  readonly causeId: string | null;
  readonly previewId: string | null;
}

const TX_OPTION_KEYS = ['expectedRevision', 'idempotencyKey', 'source', 'causeId', 'previewId'];

/** What a restore's options ask of the history: `record` unless they say otherwise. */
function checkRestoreHistory(raw: unknown): (typeof RESTORE_HISTORY)[number] {
  const value = (raw as { history?: unknown }).history ?? 'record';
  if (!(RESTORE_HISTORY as readonly unknown[]).includes(value)) {
    throw new RejectionSignal(
      'INVALID_INPUT',
      `options.history must be one of ${RESTORE_HISTORY.join(', ')} (got ${describe(value)})`,
      { path: 'options.history' },
    );
  }
  return value as (typeof RESTORE_HISTORY)[number];
}

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
  readonly timer: () => number;
  /** The option the timer is: `timer` when given, else `now` (which defaults to `Date.now`). */
  readonly timerOption: 'now' | 'timer';
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
  for (const key of ['now', 'timer', 'createId', 'onDiagnostic', 'frameBoundary']) {
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
    if (!Object.hasOwn(DEFAULT_GEOMETRY_LIMITS, key)) {
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
    timer: options.timer ?? options.now ?? Date.now,
    timerOption: options.timer === undefined ? 'now' : 'timer',
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
