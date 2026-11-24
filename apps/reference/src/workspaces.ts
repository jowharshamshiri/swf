import type { JsonValue, SwfError, Workspace } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type {
  Persistence,
  PersistenceExtension,
  PolicySource,
  RestoreOutcome,
  Saver,
  SaveState,
  SnapshotStore,
  WorkspaceDocument,
} from '@swf/persistence';
import { createPersistence, createSaver } from '@swf/persistence';

/**
 * The reference application's workspaces in local storage (FR-127, FR-168, UX-016, PRIV-002): the
 * workspace saved as it changes, so the next visit restores it; named workspaces saved and opened
 * on request; export to and import from a JSON file, each import previewed before it replaces
 * anything; and deleting every layout the application saved. Only layout is stored: the scene,
 * the policies' parameters and the host's opaque extension state, never what a window shows.
 */

/**
 * Visits are saved as they change under `session/<started at>`, one key per visit: a visit's
 * workspace counts its revisions afresh, so it never saves over another visit's. The newest is
 * the one restored, and once a visit's workspace is stored the older visits' are removed.
 */
export const SESSION = 'session/';

/** The key a visit started at a time saves under. */
export const sessionKey = (startedAt: number) => `${SESSION}${String(startedAt)}`;

/** When a visit's key says it started, or null for a key that is not a visit's. */
function sessionStart(key: string): number | null {
  if (!key.startsWith(SESSION)) {
    return null;
  }
  const at = Number(key.slice(SESSION.length));
  return Number.isSafeInteger(at) ? at : null;
}

/** Named workspaces are stored as `named/<name>/<saved at>`: one entry per save. */
const NAMED = 'named/';

/** A named workspace as the store holds it. */
export interface NamedWorkspace {
  readonly name: string;
  readonly savedAt: number;
  readonly bytes: number;
}

/** What a snapshot holds, said before it replaces the workspace (FR-201). */
export interface SnapshotPreview {
  readonly windows: number;
  readonly groups: number;
  readonly surfaces: number;
  readonly viewports: number;
  readonly cameras: number;
  /** Namespaces of host and extension state it carries. */
  readonly extensions: readonly string[];
  readonly schema: string;
  readonly createdAt: number;
  readonly bytes: number;
}

/** A refusal of the workspaces module, by the field at fault: said to the operator as it is. */
export class WorkspaceRefusal extends Error {
  constructor(
    readonly field: string,
    message: string,
    readonly error: SwfError | null = null,
  ) {
    super(message);
    this.name = 'WorkspaceRefusal';
  }
}

/** Persistence measures since the application started (AN-007). */
export interface PersistenceMeasures {
  readonly saves: number;
  readonly saveFailures: number;
  readonly restores: number;
  readonly restoreFailures: number;
  readonly migrations: number;
  /** The last snapshot written or read, in UTF-8 bytes; null before any. */
  readonly lastSnapshotBytes: number | null;
  /** The last save of the workspace as it changes, capture to store, in milliseconds. */
  readonly lastSaveMs: number | null;
  /** Taking the last named or exported snapshot and writing it out as JSON, in milliseconds. */
  readonly lastCaptureMs: number | null;
  readonly lastSerializeMs: number | null;
  /** Validating, migrating and restoring the last snapshot read, in milliseconds. */
  readonly lastRestoreMs: number | null;
}

/** How saving stands, for the shell to show. */
export interface WorkspacesStatus {
  /** Whether the workspace is saved as it changes. */
  readonly autosave: boolean;
  readonly save: SaveState;
  /** Why the last save failed, while it is `failed`. */
  readonly saveError: SwfError | null;
  /** Why the last restore failed, until the next restore. */
  readonly restoreError: SwfError | null;
}

export interface Workspaces {
  readonly persistence: Persistence;
  status(): WorkspacesStatus;
  subscribe(listener: () => void): () => void;
  /** Saves the workspace as it changes (the persistence feature on), or stops (off). */
  setAutosave(on: boolean): void;
  /**
   * Restores the workspace saved last, if there is one: the outcome, or null when nothing is
   * saved. A snapshot that cannot be restored leaves the workspace as it is and is reported.
   */
  restoreLast(): Promise<RestoreOutcome | null>;
  /** The named workspaces, by name. */
  named(): Promise<readonly NamedWorkspace[]>;
  /**
   * Saves the workspace under a name; a workspace of that name is replaced only once the new one
   * is stored, so a failed save leaves it as it was. Throws {@link WorkspaceRefusal}.
   */
  saveAs(name: string): Promise<NamedWorkspace>;
  /** What a named workspace holds. Throws {@link WorkspaceRefusal}. */
  previewNamed(name: string): Promise<SnapshotPreview>;
  /** Replaces the workspace with a named one, as one undoable change. */
  openNamed(name: string): Promise<RestoreOutcome>;
  /** Deletes a named workspace from local storage. Throws {@link WorkspaceRefusal}. */
  deleteNamed(name: string): Promise<void>;
  /**
   * Deletes every layout the application saved in this browser, the one saved as it changes
   * among them; returns how many. The workspace on screen stays as it is.
   */
  deleteAll(): Promise<number>;
  /** The workspace as a JSON document to save to a file. */
  exportText(): Promise<string>;
  /**
   * What an imported file holds, read and validated without changing anything: its name must
   * end in `.json` and its text must be a valid snapshot within the size limit. Throws
   * {@link WorkspaceRefusal} naming the line or path at fault.
   */
  previewImport(fileName: string, text: string): SnapshotPreview;
  /** Replaces the workspace with an imported one, after its preview was confirmed. */
  importText(fileName: string, text: string): Promise<RestoreOutcome>;
  measures(): PersistenceMeasures;
  dispose(): void;
}

export interface WorkspacesOptions {
  readonly workspace: Workspace;
  readonly store: SnapshotStore;
  /** The host's own state saved with the layout, under its namespace. */
  readonly extensions: readonly PersistenceExtension[];
  /** Policies whose parameters are saved with the layout. */
  readonly policies: readonly PolicySource[];
  /** Wall-clock milliseconds, for snapshots' times. */
  readonly now: () => number;
  /** A monotonic clock in milliseconds, for measures. */
  readonly timer: () => number;
  /** How long after a change the workspace is saved, in milliseconds. */
  readonly autosaveDelayMs: number;
}

/** The key a named workspace saved at a time is stored under. */
const namedKey = (name: string, savedAt: number) =>
  `${NAMED}${encodeURIComponent(name)}/${String(savedAt)}`;

/** A name and when it was saved, from a key, or null for a key that is not a named workspace's. */
function parseNamedKey(key: string): { name: string; savedAt: number } | null {
  if (!key.startsWith(NAMED)) {
    return null;
  }
  const rest = key.slice(NAMED.length);
  const slash = rest.lastIndexOf('/');
  const savedAt = Number(rest.slice(slash + 1));
  if (slash <= 0 || !Number.isSafeInteger(savedAt)) {
    return null;
  }
  try {
    return { name: decodeURIComponent(rest.slice(0, slash)), savedAt };
  } catch {
    return null;
  }
}

/** The longest name a workspace can have. */
export const MAX_NAME_LENGTH = 80;

/** Why a name cannot name a workspace, or null when it can. */
export function nameIssue(name: unknown): string | null {
  if (typeof name !== 'string' || name.trim() === '') {
    return 'a workspace needs a name';
  }
  if (name !== name.trim()) {
    return 'a name cannot start or end with spaces';
  }
  if (name.length > MAX_NAME_LENGTH) {
    return `a name can be at most ${String(MAX_NAME_LENGTH)} characters`;
  }
  return null;
}

/** What a snapshot holds, counted. */
export function previewOf(document: WorkspaceDocument, bytes: number): SnapshotPreview {
  const active = document.nodes.filter((n) => n.status === 'active');
  return Object.freeze({
    windows: active.filter((n) => n.kind === 'window').length,
    groups: active.filter((n) => n.kind === 'group').length,
    surfaces: document.surfaces.length,
    viewports: document.viewports.length,
    cameras: document.cameras.length,
    extensions: Object.freeze(Object.keys(document.extensions).sort()),
    schema: document.schema,
    createdAt: document.createdAt,
    bytes,
  });
}

/** A failure as the operator is told it: its message, its path or line, and its typed error. */
function refusalOf(field: string, error: unknown): WorkspaceRefusal {
  if (error instanceof SwfFailure) {
    const at = error.error.path === undefined ? '' : ` (at ${error.error.path})`;
    return new WorkspaceRefusal(field, `${error.error.message}${at}`, error.error);
  }
  throw error;
}

export function createWorkspaces(options: WorkspacesOptions): Workspaces {
  const { workspace, store, now, timer } = options;
  const persistence = createPersistence({ workspace: workspace.persistence(), now });
  const unregister = [
    ...options.extensions.map((e) => persistence.registerExtension(e)),
    ...options.policies.map((p) => persistence.registerPolicy(p)),
  ];
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const listener of listeners) {
      listener();
    }
  };
  let autosave = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let restoreError: SwfError | null = null;
  let disposed = false;
  const measures = {
    saves: 0,
    saveFailures: 0,
    restores: 0,
    restoreFailures: 0,
    migrations: 0,
    lastSnapshotBytes: null as number | null,
    lastSaveMs: null as number | null,
    lastCaptureMs: null as number | null,
    lastSerializeMs: null as number | null,
    lastRestoreMs: null as number | null,
  };

  /** The stored visits, newest first. */
  const sessions = async () =>
    (await store.list())
      .flatMap((entry) => {
        const at = sessionStart(entry.key);
        return at === null ? [] : [{ key: entry.key, at }];
      })
      .sort((a, b) => b.at - a.at);

  /** The key this visit saves under. */
  let session = sessionKey(now());

  /** A store measured: each save it is asked for timed and counted. */
  const measured: SnapshotStore = {
    guarantees: store.guarantees,
    load: (key) => store.load(key),
    list: () => store.list(),
    delete: (key) => store.delete(key),
    async save(request) {
      let ack;
      try {
        ack = await store.save(request);
      } catch (error) {
        measures.saveFailures += 1;
        throw error;
      }
      measures.saves += 1;
      measures.lastSnapshotBytes = ack.bytes;
      // This visit is stored: older visits are no longer the last one, and go.
      if (request.key === session) {
        for (const older of await sessions()) {
          if (older.key !== session) {
            await store.delete(older.key);
          }
        }
      }
      return ack;
    },
  };

  let saver: Saver = createSaver({ persistence, store: measured, key: session });
  let stopSaver = saver.subscribe(tell);
  const replaceSaver = (key: string, saved?: { revision: number; changes: number }) => {
    stopSaver();
    saver.dispose();
    session = key;
    saver = createSaver({
      persistence,
      store: measured,
      key,
      ...(saved === undefined ? {} : { saved }),
    });
    stopSaver = saver.subscribe(tell);
    tell();
  };

  const schedule = () => {
    if (!autosave || disposed) {
      return;
    }
    if (timerId !== null) {
      clearTimeout(timerId);
    }
    timerId = setTimeout(() => {
      timerId = null;
      const started = timer();
      void saver.save().then(() => {
        measures.lastSaveMs = timer() - started;
      });
    }, options.autosaveDelayMs);
  };
  const stopChanges = persistence.subscribe(schedule);

  /** Captures the workspace and writes it out as JSON, measured. */
  const snapshotText = async (): Promise<{ text: string; revision: number }> => {
    const started = timer();
    const { document } = await persistence.capture();
    const captured = timer();
    const text = persistence.export(document);
    measures.lastCaptureMs = captured - started;
    measures.lastSerializeMs = timer() - captured;
    return { text, revision: document.revision };
  };

  /** Restores a snapshot, measured; a rejection is kept as the last restore error. */
  const restore = async (input: unknown): Promise<RestoreOutcome> => {
    const started = timer();
    const outcome = await persistence.restore(input);
    measures.lastRestoreMs = timer() - started;
    if (outcome.status === 'restored') {
      measures.restores += 1;
      measures.migrations += outcome.migrations.length;
      restoreError = null;
    } else {
      measures.restoreFailures += 1;
      restoreError = outcome.error;
    }
    tell();
    return outcome;
  };

  /** Every stored save of each named workspace, newest first. */
  const namedEntries = async () => {
    const all = new Map<string, { savedAt: number; key: string; bytes: number }[]>();
    for (const entry of await store.list()) {
      const parsed = parseNamedKey(entry.key);
      if (parsed === null) {
        continue;
      }
      const list = all.get(parsed.name) ?? [];
      list.push({ savedAt: parsed.savedAt, key: entry.key, bytes: entry.bytes });
      all.set(parsed.name, list);
    }
    for (const list of all.values()) {
      list.sort((a, b) => b.savedAt - a.savedAt);
    }
    return all;
  };

  const loadNamed = async (name: string) => {
    const issue = nameIssue(name);
    if (issue !== null) {
      throw new WorkspaceRefusal('name', issue);
    }
    const newest = (await namedEntries()).get(name)?.[0];
    const stored = newest === undefined ? null : await store.load(newest.key);
    if (stored === null) {
      throw new WorkspaceRefusal('name', `no workspace is saved as “${name}”`);
    }
    return stored;
  };

  const readDocument = (text: string, field: string): WorkspaceDocument => {
    try {
      return persistence.import(text);
    } catch (error) {
      throw refusalOf(field, error);
    }
  };

  const checkFile = (fileName: string, text: string) => {
    if (typeof fileName !== 'string' || !fileName.toLowerCase().endsWith('.json')) {
      throw new WorkspaceRefusal('file', 'a workspace file is a .json file');
    }
    if (typeof text !== 'string') {
      throw new WorkspaceRefusal('file', 'a workspace file is text');
    }
  };

  return Object.freeze({
    persistence,
    status: () =>
      Object.freeze({
        autosave,
        save: saver.state,
        saveError: saver.state === 'failed' ? saver.lastError : null,
        restoreError,
      }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setAutosave(on: boolean) {
      if (autosave === on) {
        return;
      }
      autosave = on;
      if (!on && timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      if (on && saver.state !== 'clean') {
        schedule();
      }
      tell();
    },
    async restoreLast() {
      const newest = (await sessions())[0];
      const stored = newest === undefined ? null : await store.load(newest.key);
      if (stored === null) {
        return null;
      }
      measures.lastSnapshotBytes = stored.bytes;
      const outcome = await restore(stored.document);
      if (outcome.status === 'restored') {
        // The visit goes on: the store holds what the workspace now shows, under its key.
        replaceSaver(stored.key, { revision: stored.revision, changes: persistence.changes() });
      }
      return outcome;
    },
    async named() {
      return [...(await namedEntries())]
        .map(([name, list]): NamedWorkspace => {
          const newest = list[0];
          if (newest === undefined) {
            throw new Error(`named workspace "${name}" has no entry`);
          }
          return Object.freeze({ name, savedAt: newest.savedAt, bytes: newest.bytes });
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async saveAs(name: string) {
      const issue = nameIssue(name);
      if (issue !== null) {
        throw new WorkspaceRefusal('name', issue);
      }
      const older = (await namedEntries()).get(name) ?? [];
      const { text, revision } = await snapshotText();
      let savedAt = now();
      // A later save of the same name at the same millisecond still gets a key of its own.
      while (older.some((o) => o.savedAt >= savedAt)) {
        savedAt += 1;
      }
      let ack;
      try {
        ack = await measured.save({
          key: namedKey(name, savedAt),
          document: text,
          revision,
          expectedRevision: null,
        });
      } catch (error) {
        throw refusalOf('name', error);
      }
      // Only now that the new one is stored are the older saves of the name removed.
      for (const entry of older) {
        await store.delete(entry.key);
      }
      return Object.freeze({ name, savedAt, bytes: ack.bytes });
    },
    async previewNamed(name: string) {
      const stored = await loadNamed(name);
      return previewOf(readDocument(stored.document, 'name'), stored.bytes);
    },
    async openNamed(name: string) {
      const stored = await loadNamed(name);
      measures.lastSnapshotBytes = stored.bytes;
      return restore(stored.document);
    },
    async deleteNamed(name: string) {
      const issue = nameIssue(name);
      if (issue !== null) {
        throw new WorkspaceRefusal('name', issue);
      }
      const entries = (await namedEntries()).get(name);
      if (entries === undefined) {
        throw new WorkspaceRefusal('name', `no workspace is saved as “${name}”`);
      }
      for (const entry of entries) {
        await store.delete(entry.key);
      }
      tell();
    },
    async deleteAll() {
      let deleted = 0;
      for (const entry of await store.list()) {
        if (sessionStart(entry.key) !== null || parseNamedKey(entry.key) !== null) {
          if (await store.delete(entry.key)) {
            deleted += 1;
          }
        }
      }
      // Nothing is stored now: the workspace on screen counts as unsaved, a visit afresh.
      replaceSaver(sessionKey(now()));
      if (autosave) {
        schedule();
      }
      return deleted;
    },
    async exportText() {
      return (await snapshotText()).text;
    },
    previewImport(fileName: string, text: string) {
      checkFile(fileName, text);
      const document = readDocument(text, 'file');
      return previewOf(document, new TextEncoder().encode(text).length);
    },
    async importText(fileName: string, text: string) {
      checkFile(fileName, text);
      readDocument(text, 'file');
      return restore(text);
    },
    measures: () => Object.freeze({ ...measures }),
    dispose() {
      disposed = true;
      if (timerId !== null) {
        clearTimeout(timerId);
        timerId = null;
      }
      stopChanges();
      stopSaver();
      saver.dispose();
      for (const stop of unregister) {
        stop();
      }
      persistence.dispose();
      listeners.clear();
    },
  });
}

/** A host extension holding JSON state through the given accessors. */
export function hostExtension(
  namespace: string,
  state: {
    capture(): JsonValue;
    restore(data: JsonValue): void;
    watch(changed: () => void): () => void;
  },
): PersistenceExtension {
  return Object.freeze({
    namespace,
    version: 1,
    capture: () => state.capture(),
    restore: (data: JsonValue) => {
      state.restore(data);
    },
    watch: (changed: () => void) => state.watch(changed),
  });
}

/** A refusal for a workspace's state that cannot be taken back, naming the field. */
export function stateRefusal(field: string, message: string): SwfFailure {
  return new SwfFailure(makeError('INVALID_INPUT', message, { path: field }));
}
