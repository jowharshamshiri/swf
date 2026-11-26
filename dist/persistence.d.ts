import type { JsonValue, SwfError, WorkspacePersistence } from '@swf/core';
import type { SnapshotLimits, WorkspaceDocument } from './document.js';
import type { MigrationStep, SchemaMigration } from './migrations.js';
/** What a persistence hook is given: its own namespace and a signal that ends its time. */
export interface HookContext {
    /** The namespace of the extension whose hook runs. */
    readonly namespace: string;
    /**
     * Aborted when the hook runs out of time (`EXTENSION_FAILED`), the caller's signal aborts
     * (`CANCELLED`), or the hook's call is over; its `reason` is the {@link SwfFailure} that
     * ended it. A hook that keeps working after it is aborted is no longer heard.
     */
    readonly signal: AbortSignal;
}
/**
 * An extension's persistence hooks. Its state is opaque to the framework: JSON data the
 * extension captures and gets back, under its own namespace only, within the size limits. The
 * extension stays the host's: the persistence calls its hooks and never disposes it.
 */
export interface PersistenceExtension {
    /**
     * `host.<name>` or `ext.<extension-id>` (see {@link NAMESPACE}), unique among registered
     * extensions.
     */
    readonly namespace: string;
    /** The version of the extension's own payload format: a whole number of at least 1. */
    readonly version: number;
    /**
     * The extension's current state, as JSON data, or a promise of it. It runs alone, within the
     * hook timeout and its namespace's size limit; a throw, a rejection, a timeout, data that is
     * not JSON or data over the limit fails only this extension's capture.
     */
    capture(context: HookContext): unknown;
    /**
     * Takes back a state this extension captured (after `migrate`, when it was older); may return
     * a promise. It runs alone, within the hook timeout; a failure is reported and the state is
     * held for later snapshots.
     */
    restore(data: JsonValue, context: HookContext): unknown;
    /**
     * Turns a payload of an older `fromVersion` into one of `version`, synchronously. It gets a copy
     * of its own; the result must be JSON data within the namespace's size limit. A throw or a
     * promise fails the migration (`MIGRATION_FAILED`) and the payload is held. Without it, an
     * older payload cannot be restored and is held.
     */
    migrate?(data: JsonValue, fromVersion: number): unknown;
    /**
     * Calls `changed` whenever the extension's state changes, so the workspace counts as changed;
     * returns what stops it, which is called when the extension is unregistered or the persistence
     * disposed. Called once, at registration: a throw, or an answer that is not a function, fails
     * the registration (`EXTENSION_FAILED`, naming `watch`) and leaves nothing registered.
     */
    watch?(changed: () => void): () => void;
}
/** What a policy's `restore` is given: its own ID and a signal that ends its time. */
export interface PolicyContext {
    /** The ID of the policy that takes back its parameters. */
    readonly id: string;
    /**
     * Aborted when the restore runs out of time (`EXTENSION_FAILED`), the caller's signal aborts
     * (`CANCELLED`), or the call is over; its `reason` is the {@link SwfFailure} that ended it. A
     * policy that keeps working after it is aborted is no longer heard.
     */
    readonly signal: AbortSignal;
}
/**
 * A policy's layout-relevant parameters, saved with the layout. The policy stays the host's: the
 * persistence calls it and never disposes it.
 */
export interface PolicySource {
    /** The policy's versioned ID, such as `swf.interaction/1`; unique among registered policies. */
    readonly id: string;
    /**
     * The policy's current parameters, as JSON data, synchronously. A throw, a promise or data that
     * is not JSON fails only this policy's capture, and its last known parameters are kept.
     */
    capture(): unknown;
    /**
     * Takes back parameters this policy captured, when a snapshot is restored; may return a
     * promise. It runs alone, within the hook timeout and the caller's signal; a throw, a rejection
     * or a timeout is reported in the restore's failures, and the layout stays restored.
     */
    restore?(parameters: JsonValue, context: PolicyContext): unknown;
    /**
     * Calls `changed` whenever the parameters change, so the workspace counts as changed; returns
     * what stops it, which is called when the policy is unregistered or the persistence disposed.
     * Called once, at registration: a throw, or an answer that is not a function, fails the
     * registration (`EXTENSION_FAILED`, naming `watch`) and leaves nothing registered.
     */
    watch?(changed: () => void): () => void;
}
/** What a persistence captures from, and the limits it holds snapshots to. */
export interface PersistenceOptions {
    /**
     * The workspace's persistence scope (`workspace.persistence()`): the persistence reads its
     * revision, serializes and restores its scene, and follows its commits. It never disposes it.
     */
    readonly workspace: WorkspacePersistence;
    /** The clock snapshots are stamped with, in milliseconds; a function. Default `Date.now`. */
    readonly now?: () => number;
    /**
     * Size limits, each in UTF-8 bytes; those not given are {@link DEFAULT_SNAPSHOT_LIMITS}'.
     * Checked as {@link snapshotLimits} does.
     */
    readonly limits?: Partial<SnapshotLimits>;
    /**
     * How long one extension's capture or restore may take: milliseconds, finite and greater than
     * 0. Default 5000.
     */
    readonly hookTimeoutMs?: number;
    /**
     * Steps from older snapshot formats, tried before the built-in ones: a converter of a host's
     * earlier layout format, say.
     */
    readonly migrations?: readonly SchemaMigration[];
}
/** A policy or extension whose state could not be restored; the layout was restored. */
export type RestoreFailure = CaptureFailure;
/** How one {@link Persistence.restore} ended. Frozen. */
export type RestoreOutcome = {
    /** The scene was replaced, and each policy and extension asked to take back its state. */
    readonly status: 'restored';
    /** The workspace revision the restore committed. */
    readonly revision: number;
    /** The format the snapshot was in, and the one it was brought to. */
    readonly sourceVersion: string;
    /** The format it was brought to: always {@link SNAPSHOT_SCHEMA_ID}. */
    readonly targetVersion: string;
    /** The format migration steps that ran, in order. */
    readonly migrations: readonly MigrationStep[];
    /** What the person restoring should know: migration notes, state kept for absent owners. */
    readonly warnings: readonly string[];
    /**
     * Policies and extensions that could not take back their state; each extension's state
     * from the snapshot is held for later snapshots.
     */
    readonly failures: readonly RestoreFailure[];
}
/** Nothing was replaced: the workspace and every policy and extension are as they were. */
 | {
    /** The snapshot was refused before anything changed. */
    readonly status: 'rejected';
    /**
     * Why: `SNAPSHOT_INVALID` or `MIGRATION_FAILED` for the snapshot, or the workspace's
     * refusal of the scene (`CONFLICT` for a stale `expectedRevision`, say). Once the
     * snapshot has been parsed, `details.sourceVersion` names the format it was in (null when
     * it names none); text over the size limit or not JSON has no format to name.
     */
    readonly error: SwfError;
};
/** A state that could not be captured: the snapshot carries its last known state, if any. */
export interface CaptureFailure {
    /** Whether an extension's state or a policy's parameters failed. */
    readonly kind: 'extension' | 'policy';
    /** The extension's namespace or the policy's ID. */
    readonly id: string;
    /**
     * Why: `EXTENSION_FAILED` for a hook that threw, rejected or timed out (`details.reason`
     * `timeout`) or whose state is held since a restore (`details.reason` `held`), `CANCELLED` when
     * the caller's signal aborted, `QUOTA_EXCEEDED` for state over a size limit, `INVALID_INPUT`
     * for data that is not JSON or a policy capture that answered with a promise, or
     * `MIGRATION_FAILED` for a migration that threw or answered with a promise.
     */
    readonly error: SwfError;
}
/** A listener that threw: the change stood, and the other listeners heard of it. Frozen. */
export interface PersistenceDiagnostic {
    /** What went wrong: always a listener that threw. */
    readonly code: 'LISTENER_THREW';
    /** Which change it was hearing of, and what it threw. */
    readonly message: string;
    /** When it threw, in milliseconds by the persistence's `now` clock. */
    readonly timestamp: number;
}
/** A snapshot taken, with the change count it reflects and what could not be captured. Frozen. */
export interface Capture {
    /** The snapshot: validated, canonical and deeply frozen. */
    readonly document: WorkspaceDocument;
    /** The change count the snapshot reflects (see {@link Persistence.changes}). */
    readonly changes: number;
    /** States that could not be captured; the snapshot carries their last known state, if any. */
    readonly failures: readonly CaptureFailure[];
}
/**
 * Snapshots of one workspace with its policies' parameters and its extensions' state. The caller
 * owns it and calls {@link Persistence.dispose} when done; it never disposes the workspace, the
 * policies or the extensions.
 */
export interface Persistence {
    /** The size limits every snapshot is held to; frozen. */
    readonly limits: SnapshotLimits;
    /**
     * Registers an extension's hooks and calls its `watch`, if any. Returns what unregisters it
     * (safe to call twice): that stops its watch and leaves the state last captured of it to be
     * carried in later snapshots.
     *
     * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` for an extension that is not an object,
     *   a malformed namespace or version, or a missing or non-function hook (naming `namespace`,
     *   `version` or the hook), or a namespace already registered; `EXTENSION_FAILED` (naming
     *   `watch`) for a `watch` that throws or answers with something other than a function;
     *   `INVALID_TRANSITION` once the persistence is disposed. A registration that fails leaves
     *   nothing registered.
     */
    registerExtension(extension: PersistenceExtension): () => void;
    /**
     * Registers a policy's parameters, as `registerExtension` does.
     *
     * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` for a source that is not an object, an
     *   `id` that is not a versioned ID, a missing `capture` or a non-function hook (naming the
     *   field), or an ID already registered; `EXTENSION_FAILED` (naming `watch`) for a `watch` that
     *   throws or answers with something other than a function; `INVALID_TRANSITION` once the
     *   persistence is disposed. A registration that fails leaves nothing registered.
     */
    registerPolicy(source: PolicySource): () => void;
    /**
     * Takes a snapshot: the committed scene, every policy's parameters and every extension's state.
     * Each extension is captured alone, within the hook timeout and size limits; one that fails is
     * reported, and its last known state (from an earlier capture or {@link retain}) is kept, so
     * a failing extension never loses state or the layout. State of extensions that are not
     * registered, kept by {@link retain}, is carried unchanged, and so is the restored state of an
     * extension that did not take it back at the last {@link restore} (reported as held): its own
     * state then is not captured over it.
     *
     * Within the total extension limit, namespaces are kept in sorted order; one that no longer
     * fits is left out and reported (`QUOTA_EXCEEDED`). Aborting `signal` cancels the extension
     * hooks still to run (`CANCELLED`); the capture still resolves, with the layout.
     *
     * @throws {@link @swf/core!SwfFailure} when the workspace cannot be serialized, or the snapshot
     *   is not valid (`SNAPSHOT_INVALID`).
     */
    capture(options?: {
        readonly signal?: AbortSignal;
    }): Promise<Capture>;
    /**
     * Keeps a snapshot's policy parameters and extension state as the last known state of each, so
     * later captures carry those whose owner is absent, exactly as they were. The scene is not
     * touched, and owners are not told.
     *
     * @throws {@link @swf/core!SwfFailure} `SNAPSHOT_INVALID` for a document that is not valid
     *   within this persistence's limits.
     */
    retain(document: WorkspaceDocument): void;
    /**
     * Increases with every change that makes an earlier snapshot out of date: a commit, a policy's
     * parameters or an extension's state changing.
     */
    changes(): number;
    /**
     * Calls `listener` after each change. A listener that throws does not stop the others; its
     * failure is kept in {@link getDiagnostics}. Returns an idempotent unsubscribe.
     */
    subscribe(listener: () => void): () => void;
    /** The last 100 listener failures, oldest first; a new frozen array on each call. */
    getDiagnostics(): readonly PersistenceDiagnostic[];
    /**
     * The snapshot's canonical JSON text, as {@link exportDocument} gives it within this
     * persistence's limits.
     *
     * @throws {@link @swf/core!SwfFailure} `SNAPSHOT_INVALID` or `QUOTA_EXCEEDED`.
     */
    export(document: WorkspaceDocument): string;
    /**
     * A snapshot read from JSON text and validated, within this persistence's limits, as
     * {@link parseDocument} does; nothing is restored.
     *
     * @throws {@link @swf/core!SwfFailure} `SNAPSHOT_INVALID` naming the failing path.
     */
    import(text: string): WorkspaceDocument;
    /**
     * Restores a snapshot (JSON text or a document) in two phases. First, changing nothing: the
     * snapshot is read within the limits, brought to the current format on a copy and validated,
     * and each extension's state of an older version is migrated on a copy by its owner. Then the
     * workspace's scene is replaced in one revision (its surfaces come back as placeholders that
     * bind as their adapters resolve them), the policies and extensions take back their state, each
     * alone within the hook timeout, and the state of namespaces whose owner is absent is kept for
     * later snapshots. A failure of the first phase, or the workspace refusing the scene, is
     * `rejected` with nothing changed and an error naming the path and `details.sourceVersion`. A
     * policy or extension that fails to take back its state is reported; the layout stays restored.
     *
     * The policies take back their parameters first, then the extensions their state, each alone
     * within the hook timeout and `signal`. `expectedRevision` is passed to the workspace,
     * which refuses the scene with `CONFLICT` when its revision is another. The state last known
     * of absent owners is replaced by the snapshot's.
     *
     * @param input - JSON text, or a parsed snapshot of any format still read.
     */
    restore(input: unknown, options?: {
        readonly signal?: AbortSignal;
        readonly expectedRevision?: number;
    }): Promise<RestoreOutcome>;
    /**
     * Stops listening to the workspace, policies and extensions (calling each `watch`'s stop),
     * unregisters every policy and extension and drops every listener. It never disposes any of
     * them. Registering afterwards throws `INVALID_TRANSITION`. Safe to call twice.
     */
    dispose(): void;
}
/**
 * Creates the persistence of a workspace, subscribed to its commits from now on with a change
 * count of 0. The caller owns it and disposes it.
 *
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` naming `hookTimeoutMs`, `now` or
 *   `limits.<field>` when one is invalid. `migrations` are checked when a restore uses them.
 *
 * @example
 * ```ts
 * const persistence = createPersistence({ workspace: workspace.persistence() });
 * persistence.registerExtension({
 *   namespace: 'ext.notes',
 *   version: 1,
 *   capture: () => notes.state(),
 *   restore: (data) => notes.load(data),
 * });
 * const { document, failures } = await persistence.capture();
 * const text = persistence.export(document);
 * ```
 */
export declare function createPersistence(options: PersistenceOptions): Persistence;
//# sourceMappingURL=persistence.d.ts.map