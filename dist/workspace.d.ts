import type { EventSource, OperationType, SceneCommand } from './commands.js';
import type { Constraint } from './constraints.js';
import type { SwfError } from './errors.js';
import type { CancelReason, WorkspaceEvent } from './events.js';
import type { GeometryLimits, GeometryProvider, ResolvedGeometry } from './geometry.js';
import type { Id, SceneState } from './model.js';
import type { ProjectionKind } from './projection-kinds.js';
import type { SceneSnapshot } from './snapshot.js';
import type { NodeQuery } from './query.js';
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
    watch<T>(selector: (state: SceneState) => T, listener: (value: T, revision: number) => void, equals?: (a: T, b: T) => boolean): () => void;
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
export type RestoreOptions = Pick<TxOptions, 'expectedRevision' | 'source' | 'causeId'>;
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
    preview(previewId: string, commands: readonly SceneCommand[], options?: Pick<TxOptions, 'source' | 'causeId'>): PreviewResult;
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
     * back; cameras and viewports, being view state, are not undone.
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
export declare function createWorkspace(options: WorkspaceOptions): Workspace;
//# sourceMappingURL=workspace.d.ts.map