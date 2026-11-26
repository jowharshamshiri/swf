import type { JsonValue, SceneSnapshot, SwfError, WorkspacePersistence } from '@swf/core';
import {
  canonicalJson,
  jsonValue,
  makeError,
  SCENE_SNAPSHOT_FIELDS,
  SwfFailure,
  VERSIONED_ID,
} from '@swf/core';
import { answeredWithPromise, describeAnswer } from './answers.js';
import type { ExtensionEntry, SnapshotLimits, WorkspaceDocument } from './document.js';
import {
  errorOf,
  exportDocument,
  failure,
  jsonBytes,
  NAMESPACE,
  parseDocument,
  parseJson,
  SNAPSHOT_ENGINE,
  SNAPSHOT_SCHEMA_ID,
  snapshotLimits,
  validateDocument,
} from './document.js';
import type { Migrated, MigrationStep, SchemaMigration } from './migrations.js';
import { migrateDocument } from './migrations.js';

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
export type RestoreOutcome =
  | {
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
  capture(options?: { readonly signal?: AbortSignal }): Promise<Capture>;
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
   * which refuses the scene with `CONFLICT` when its revision is another, and so is `history`:
   * `record` (the default) makes the restore one undoable revision, `fresh` starts the
   * workspace's history afresh with it, for a snapshot of another document opened in its place.
   * The state last known of absent owners is replaced by the snapshot's.
   *
   * @param input - JSON text, or a parsed snapshot of any format still read.
   */
  restore(
    input: unknown,
    options?: {
      readonly signal?: AbortSignal;
      readonly expectedRevision?: number;
      readonly history?: 'record' | 'fresh';
    },
  ): Promise<RestoreOutcome>;
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
export function createPersistence(options: PersistenceOptions): Persistence {
  const timeout = options.hookTimeoutMs ?? 5000;
  if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
    throw failure('INVALID_INPUT', 'hookTimeoutMs must be a positive number', 'hookTimeoutMs');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw failure('INVALID_INPUT', 'now must be a function', 'now');
  }
  return new PersistenceImpl(options, snapshotLimits(options.limits), timeout);
}

interface Registered<T> {
  readonly source: T;
  unwatch: () => void;
}

class PersistenceImpl implements Persistence {
  readonly limits: SnapshotLimits;
  readonly #workspace: WorkspacePersistence;
  readonly #now: () => number;
  readonly #timeout: number;
  readonly #migrations: readonly SchemaMigration[];
  readonly #extensions = new Map<string, Registered<PersistenceExtension>>();
  readonly #policies = new Map<string, Registered<PolicySource>>();
  /** The last state known of each namespace and policy, owner registered or not. */
  readonly #knownExtensions = new Map<string, ExtensionEntry>();
  readonly #knownPolicies = new Map<string, JsonValue>();
  /**
   * Namespaces whose owner did not take back its state at the last restore: their state from the
   * snapshot is kept, never overwritten by a capture of what the owner holds instead.
   */
  readonly #held = new Set<string>();
  readonly #listeners = new Set<() => void>();
  readonly #diagnostics: PersistenceDiagnostic[] = [];
  #changes = 0;
  #revision: number;
  #unsubscribe: (() => void) | null;

  constructor(options: PersistenceOptions, limits: SnapshotLimits, timeout: number) {
    this.limits = limits;
    this.#workspace = options.workspace;
    this.#now = options.now ?? Date.now;
    this.#timeout = timeout;
    this.#migrations = options.migrations ?? [];
    this.#revision = options.workspace.revision();
    this.#unsubscribe = options.workspace.subscribe(() => {
      // Previews and other notifications leave the committed scene as it was.
      const revision = this.#workspace.revision();
      if (revision !== this.#revision) {
        this.#revision = revision;
        this.#changed();
      }
    });
  }

  registerExtension(extension: PersistenceExtension): () => void {
    const raw: unknown = extension;
    if (typeof raw !== 'object' || raw === null) {
      throw failure('INVALID_INPUT', 'an extension must be an object');
    }
    const { namespace, version } = extension;
    if (typeof namespace !== 'string' || !NAMESPACE.test(namespace)) {
      throw failure(
        'INVALID_INPUT',
        `extension namespace ${JSON.stringify(namespace)} must be "host.<name>" or "ext.<extension-id>"`,
        'namespace',
      );
    }
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
      throw failure(
        'INVALID_INPUT',
        `extension "${namespace}": version must be a whole number of at least 1`,
        'version',
      );
    }
    for (const hook of ['capture', 'restore'] as const) {
      if (typeof extension[hook] !== 'function') {
        throw failure('INVALID_INPUT', `extension "${namespace}" must implement ${hook}()`, hook);
      }
    }
    for (const hook of ['migrate', 'watch'] as const) {
      if (extension[hook] !== undefined && typeof extension[hook] !== 'function') {
        throw failure(
          'INVALID_INPUT',
          `extension "${namespace}": ${hook} must be a function`,
          hook,
        );
      }
    }
    return this.#add(this.#extensions, namespace, 'extension', extension);
  }

  registerPolicy(source: PolicySource): () => void {
    const raw: unknown = source;
    if (typeof raw !== 'object' || raw === null) {
      throw failure('INVALID_INPUT', 'a policy source must be an object');
    }
    if (typeof source.id !== 'string' || !VERSIONED_ID.test(source.id)) {
      throw failure(
        'INVALID_INPUT',
        `policy id ${JSON.stringify(source.id)} must be a versioned ID "<name>/<version>"`,
        'id',
      );
    }
    if (typeof source.capture !== 'function') {
      throw failure('INVALID_INPUT', `policy "${source.id}" must implement capture()`, 'capture');
    }
    for (const hook of ['restore', 'watch'] as const) {
      if (source[hook] !== undefined && typeof source[hook] !== 'function') {
        throw failure('INVALID_INPUT', `policy "${source.id}": ${hook} must be a function`, hook);
      }
    }
    return this.#add(this.#policies, source.id, 'policy', source);
  }

  async capture(options: { readonly signal?: AbortSignal } = {}): Promise<Capture> {
    const changes = this.#changes;
    const scene = this.#workspace.serialize();
    const failures: CaptureFailure[] = [];
    for (const [id, { source }] of this.#policies) {
      try {
        const parameters = source.capture();
        if (answeredWithPromise(parameters)) {
          throw failure(
            'INVALID_INPUT',
            `policy "${id}" could not be captured: capture returned a promise; it gives its parameters synchronously`,
            `policies.${id}`,
          );
        }
        this.#knownPolicies.set(id, canonicalJson(jsonValue(parameters, `policies.${id}`)));
      } catch (error) {
        failures.push({
          kind: 'policy',
          id,
          error: asError(error, `policy "${id}" could not be captured`),
        });
      }
    }
    for (const [namespace, { source }] of this.#extensions) {
      if (this.#held.has(namespace)) {
        failures.push({
          kind: 'extension',
          id: namespace,
          error: errorOf(
            'EXTENSION_FAILED',
            `extension "${namespace}" did not take back its state when the snapshot was restored, so that state is kept and its current one is not captured`,
            `extensions.${namespace}`,
            { reason: 'held' },
          ),
        });
        continue;
      }
      try {
        const data = await this.#run(source, options.signal);
        const bytes = jsonBytes(data);
        if (bytes > this.limits.extensionBytes) {
          throw failure(
            'QUOTA_EXCEEDED',
            `extension "${namespace}" captured ${String(bytes)} bytes, over the limit of ${String(this.limits.extensionBytes)} per namespace`,
            `extensions.${namespace}.data`,
            { bytes, limit: this.limits.extensionBytes },
          );
        }
        this.#knownExtensions.set(namespace, Object.freeze({ version: source.version, data }));
      } catch (error) {
        failures.push({
          kind: 'extension',
          id: namespace,
          error: asError(error, `extension "${namespace}" could not be captured`),
        });
      }
    }
    // Within the total limit, namespaces are kept in order; one that no longer fits is left out.
    const extensions: Record<string, ExtensionEntry> = {};
    let total = 0;
    for (const namespace of [...this.#knownExtensions.keys()].sort()) {
      const entry = this.#knownExtensions.get(namespace);
      if (entry === undefined) {
        continue;
      }
      const bytes = jsonBytes(entry.data);
      if (total + bytes > this.limits.extensionTotalBytes) {
        failures.push({
          kind: 'extension',
          id: namespace,
          error: errorOf(
            'QUOTA_EXCEEDED',
            `extension "${namespace}" does not fit: the extensions would take ${String(total + bytes)} bytes, over the limit of ${String(this.limits.extensionTotalBytes)} in all`,
            `extensions.${namespace}.data`,
            { bytes: total + bytes, limit: this.limits.extensionTotalBytes },
          ),
        });
        continue;
      }
      total += bytes;
      extensions[namespace] = entry;
    }
    const document = validateDocument(
      {
        schema: SNAPSHOT_SCHEMA_ID,
        engine: SNAPSHOT_ENGINE,
        createdAt: this.#now(),
        ...scene,
        policies: Object.fromEntries(this.#knownPolicies),
        extensions,
      },
      this.limits,
    );
    return Object.freeze({ document, changes, failures: Object.freeze(failures) });
  }

  retain(document: WorkspaceDocument): void {
    const valid = validateDocument(document, this.limits);
    for (const [id, value] of Object.entries(valid.policies)) {
      this.#knownPolicies.set(id, value);
    }
    for (const [namespace, entry] of Object.entries(valid.extensions)) {
      this.#knownExtensions.set(namespace, entry);
    }
  }

  changes(): number {
    return this.#changes;
  }

  subscribe(listener: () => void): () => void {
    const entry = () => {
      listener();
    };
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }

  getDiagnostics(): readonly PersistenceDiagnostic[] {
    return Object.freeze([...this.#diagnostics]);
  }

  export(document: WorkspaceDocument): string {
    return exportDocument(document, this.limits);
  }

  import(text: string): WorkspaceDocument {
    return parseDocument(text, this.limits);
  }

  async restore(
    input: unknown,
    options: {
      readonly signal?: AbortSignal;
      readonly expectedRevision?: number;
      readonly history?: 'record' | 'fresh';
    } = {},
  ): Promise<RestoreOutcome> {
    const rejected = (error: SwfError): RestoreOutcome =>
      Object.freeze({ status: 'rejected', error });
    // Phase one: read, migrate and validate, changing nothing.
    let migrated: Migrated;
    try {
      const value = typeof input === 'string' ? parseJson(input, this.limits) : input;
      migrated = migrateDocument(value, { migrations: this.#migrations, limits: this.limits });
    } catch (error) {
      if (error instanceof SwfFailure) {
        return rejected(error.error);
      }
      throw error;
    }
    const { document, sourceVersion } = migrated;
    const warnings: string[] = migrated.steps.flatMap((step) => [...step.warnings]);
    const failures: RestoreFailure[] = [];
    // Each extension's state at the version its owner reads, migrated on a copy.
    const staged = new Map<string, ExtensionEntry>();
    const unmigrated: string[] = [];
    for (const [namespace, entry] of Object.entries(document.extensions)) {
      const owner = this.#extensions.get(namespace)?.source;
      if (owner === undefined) {
        warnings.push(`extension "${namespace}" is not registered: its state is kept as it was`);
        continue;
      }
      try {
        staged.set(namespace, this.#migrateExtension(owner, entry));
        if (entry.version !== owner.version) {
          warnings.push(
            `extension "${namespace}" state was migrated from version ${String(entry.version)} to ${String(owner.version)}`,
          );
        }
      } catch (error) {
        unmigrated.push(namespace);
        failures.push({
          kind: 'extension',
          id: namespace,
          error: asError(error, `extension "${namespace}" state could not be migrated`),
        });
      }
    }
    // Phase two: the scene, in one revision. If the workspace refuses it, nothing changes.
    const scene = Object.fromEntries(
      SCENE_SNAPSHOT_FIELDS.map((field) => [field, document[field]]),
    ) as unknown as SceneSnapshot;
    let result = this.#workspace.restore(scene, {
      ...(options.expectedRevision === undefined
        ? {}
        : { expectedRevision: options.expectedRevision }),
      ...(options.history === undefined ? {} : { history: options.history }),
    });
    if (result.status === 'queued') {
      result = await result.completion;
    }
    if (result.status === 'rejected') {
      return rejected({
        ...result.error,
        details: { ...(result.error.details ?? {}), sourceVersion },
      });
    }
    // The replaced layout's state of absent owners goes with it; the snapshot's takes its place.
    for (const namespace of [...this.#knownExtensions.keys()]) {
      if (!this.#extensions.has(namespace)) {
        this.#knownExtensions.delete(namespace);
      }
    }
    for (const id of [...this.#knownPolicies.keys()]) {
      if (!this.#policies.has(id)) {
        this.#knownPolicies.delete(id);
      }
    }
    this.retain(document);
    for (const [namespace, entry] of staged) {
      this.#knownExtensions.set(namespace, entry);
    }
    // An owner that cannot take back its state must not overwrite it with what it holds instead.
    this.#held.clear();
    for (const namespace of unmigrated) {
      this.#held.add(namespace);
    }
    for (const [id, parameters] of Object.entries(document.policies)) {
      const source = this.#policies.get(id)?.source;
      if (source === undefined) {
        warnings.push(`policy "${id}" is not registered: its parameters are kept as they were`);
        continue;
      }
      const restore = source.restore?.bind(source);
      if (restore === undefined) {
        continue;
      }
      try {
        await this.#hook(policyHook(id), options.signal, (signal) =>
          restore(parameters, { id, signal }),
        );
      } catch (error) {
        failures.push({
          kind: 'policy',
          id,
          error: asError(error, `policy "${id}" could not take back its parameters`),
        });
      }
    }
    for (const [namespace, entry] of staged) {
      const owner = this.#extensions.get(namespace)?.source;
      if (owner === undefined) {
        continue;
      }
      try {
        await this.#hook(extensionHook(namespace, 'restore'), options.signal, (signal) =>
          owner.restore(entry.data, { namespace, signal }),
        );
      } catch (error) {
        this.#held.add(namespace);
        failures.push({
          kind: 'extension',
          id: namespace,
          error: asError(error, `extension "${namespace}" could not take back its state`),
        });
      }
    }
    return Object.freeze({
      status: 'restored',
      revision: result.revision,
      sourceVersion,
      targetVersion: migrated.targetVersion,
      migrations: migrated.steps,
      warnings: Object.freeze(warnings),
      failures: Object.freeze(failures),
    });
  }

  /** An extension's state at the version its owner reads, migrated on a copy when older. */
  #migrateExtension(owner: PersistenceExtension, entry: ExtensionEntry): ExtensionEntry {
    const namespace = owner.namespace;
    if (entry.version === owner.version) {
      return entry;
    }
    if (entry.version > owner.version || owner.migrate === undefined) {
      throw failure(
        'EXTENSION_FAILED',
        entry.version > owner.version
          ? `extension "${namespace}" reads version ${String(owner.version)}, but the snapshot holds the newer version ${String(entry.version)}; it is kept as it was`
          : `extension "${namespace}" cannot migrate its state from version ${String(entry.version)} to ${String(owner.version)}; it is kept as it was`,
        `extensions.${namespace}.version`,
      );
    }
    let migrated: unknown;
    try {
      // Its own copy: the snapshot's data stays as it was.
      migrated = owner.migrate(JSON.parse(JSON.stringify(entry.data)) as JsonValue, entry.version);
      if (answeredWithPromise(migrated)) {
        throw new Error('migrate returned a promise; it migrates synchronously');
      }
    } catch (error) {
      throw failure(
        'MIGRATION_FAILED',
        `extension "${namespace}" failed to migrate its state from version ${String(entry.version)}: ${error instanceof Error ? error.message : String(error)}`,
        `extensions.${namespace}.data`,
      );
    }
    const data = canonicalJson(jsonValue(migrated, `extensions.${namespace}.data`));
    const bytes = jsonBytes(data);
    if (bytes > this.limits.extensionBytes) {
      throw failure(
        'QUOTA_EXCEEDED',
        `extension "${namespace}" migrated its state to ${String(bytes)} bytes, over the limit of ${String(this.limits.extensionBytes)} per namespace`,
        `extensions.${namespace}.data`,
        { bytes, limit: this.limits.extensionBytes },
      );
    }
    return Object.freeze({ version: owner.version, data });
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    for (const registered of [...this.#extensions.values(), ...this.#policies.values()]) {
      registered.unwatch();
    }
    this.#extensions.clear();
    this.#policies.clear();
    this.#listeners.clear();
  }

  /**
   * Registers a policy or an extension and starts its watch. A watch that throws, or answers with
   * something other than what stops it, fails the registration and leaves nothing registered.
   */
  #add<T extends { watch?(changed: () => void): () => void }>(
    map: Map<string, Registered<T>>,
    id: string,
    kind: 'extension' | 'policy',
    source: T,
  ): () => void {
    if (this.#unsubscribe === null) {
      throw failure('INVALID_TRANSITION', 'the persistence is disposed');
    }
    if (map.has(id)) {
      throw failure(
        'INVALID_INPUT',
        `${kind === 'extension' ? 'an extension' : 'a policy'} "${id}" is already registered`,
      );
    }
    const registered: Registered<T> = { source, unwatch: () => undefined };
    map.set(id, registered);
    if (source.watch !== undefined) {
      try {
        const stop: unknown = source.watch(() => {
          if (map.get(id) === registered) {
            this.#changed();
          }
        });
        if (typeof stop !== 'function') {
          throw new Error(`watch returned ${describeAnswer(stop)}, not a function that stops it`);
        }
        registered.unwatch = stop as () => void;
      } catch (error) {
        map.delete(id);
        throw failure(
          'EXTENSION_FAILED',
          `${kind} "${id}" could not start watching its ${kind === 'extension' ? 'state' : 'parameters'}: ${error instanceof Error ? error.message : String(error)}`,
          'watch',
        );
      }
    }
    return () => {
      if (map.get(id) === registered) {
        map.delete(id);
        registered.unwatch();
      }
    };
  }

  /** Runs one capture hook alone: its own copy of the result, its own time limit. */
  async #run(extension: PersistenceExtension, outer: AbortSignal | undefined): Promise<JsonValue> {
    const namespace = extension.namespace;
    const result = await this.#hook(extensionHook(namespace, 'capture'), outer, (signal) =>
      extension.capture({ namespace, signal }),
    );
    return canonicalJson(jsonValue(result, `extensions.${namespace}.data`));
  }

  /**
   * Runs one hook alone, within the hook timeout and the caller's signal: a timeout is
   * `EXTENSION_FAILED`, a cancellation `CANCELLED`, a throw or a rejection `EXTENSION_FAILED` with
   * its reason. The hook is given a signal that aborts when its time is over.
   */
  async #hook(
    run: HookRun,
    outer: AbortSignal | undefined,
    call: (signal: AbortSignal) => unknown,
  ): Promise<unknown> {
    const controller = new AbortController();
    const cancel = () => {
      stop(failure('CANCELLED', `${run.doing} was cancelled`, run.path));
    };
    let stop: (error: SwfFailure) => void = () => undefined;
    const ended = new Promise<never>((_, reject) => {
      stop = (error: SwfFailure) => {
        controller.abort(error);
        reject(error);
      };
      const timer = setTimeout(() => {
        stop(
          failure(
            'EXTENSION_FAILED',
            `${run.who} did not ${run.task} within ${String(this.#timeout)} ms`,
            run.path,
            { reason: 'timeout' },
          ),
        );
      }, this.#timeout);
      controller.signal.addEventListener('abort', () => {
        clearTimeout(timer);
      });
    });
    if (outer?.aborted === true) {
      cancel();
    } else {
      outer?.addEventListener('abort', cancel, { once: true });
    }
    try {
      return await Promise.race([Promise.resolve().then(() => call(controller.signal)), ended]);
    } catch (error) {
      if (error instanceof SwfFailure) {
        throw error;
      }
      throw failure(
        'EXTENSION_FAILED',
        `${run.who} failed to ${run.task}: ${error instanceof Error ? error.message : String(error)}`,
        run.path,
      );
    } finally {
      outer?.removeEventListener('abort', cancel);
      if (!controller.signal.aborted) {
        controller.abort(failure('CANCELLED', `${run.doing} is over`, run.path));
      }
      ended.catch(() => undefined);
    }
  }

  #changed(): void {
    this.#changes += 1;
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        this.#diagnostics.push(
          Object.freeze({
            code: 'LISTENER_THREW' as const,
            message: `a listener threw while hearing of change ${String(this.#changes)}: ${error instanceof Error ? error.message : String(error)}`,
            timestamp: this.#now(),
          }),
        );
        this.#diagnostics.splice(0, Math.max(0, this.#diagnostics.length - 100));
      }
    }
  }
}

function asError(error: unknown, context: string): SwfError {
  if (error instanceof SwfFailure) {
    return error.error;
  }
  return makeError(
    'EXTENSION_FAILED',
    `${context}: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/** A hook as its messages name it. */
interface HookRun {
  /** Whose hook it is: `extension "ext.notes"`, `policy "host.snap/1"`. */
  readonly who: string;
  /** What it does: `capture its state`, `take back its parameters`. */
  readonly task: string;
  /** The same, as it goes on: `capturing extension "ext.notes"`. */
  readonly doing: string;
  /** Where its failure is in the snapshot, when its failures name one. */
  readonly path: string | undefined;
}

function extensionHook(namespace: string, verb: 'capture' | 'restore'): HookRun {
  return {
    who: `extension "${namespace}"`,
    task: `${verb} its state`,
    doing: `${verb === 'capture' ? 'capturing' : 'restoring'} extension "${namespace}"`,
    path: undefined,
  };
}

function policyHook(id: string): HookRun {
  return {
    who: `policy "${id}"`,
    task: 'take back its parameters',
    doing: `restoring policy "${id}"`,
    path: `policies.${id}`,
  };
}
