import type { JsonValue, SwfError, Workspace } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type {
  Persistence,
  PersistenceExtension,
  PolicySource,
  RemoveOutcome,
  RestoreOutcome,
  SaveState,
  SnapshotStore,
  SpaceEntry,
  Spaces,
  SpacesPhase,
  SwitchOutcome,
  WorkspaceDocument,
} from '@swf/persistence';
import { createPersistence, createSpaces, spaceKey, spaceOfKey } from '@swf/persistence';
import type * as Lean from '@swf/models';
import { models } from '@swf/models';

/**
 * The reference application's spaces in local storage (FR-127, FR-168, UX-016, PRIV-002): several
 * named workspaces, the space shown saved as it changes and switched in one press, the seeded
 * ones made by the application until they are stored; the space shown saved under a new name;
 * export to and import from a JSON file, each import previewed before it replaces anything; and
 * deleting every layout the application saved. Only layout is stored: the scene, the policies'
 * parameters and the host's opaque extension state, never what a window shows.
 */

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

/** Persistence measures since the application started (AN-007). */
export interface PersistenceMeasures {
  readonly saves: number;
  readonly saveFailures: number;
  readonly restores: number;
  readonly restoreFailures: number;
  readonly migrations: number;
  /** How many spaces have been switched to since the application started, the first among them. */
  readonly switches: number;
  /** The last snapshot written or read, in UTF-8 bytes; null before any. */
  readonly lastSnapshotBytes: number | null;
  /** The last save of the space shown, capture to store, in milliseconds. */
  readonly lastSaveMs: number | null;
  /** Taking the last exported snapshot and writing it out as JSON, in milliseconds. */
  readonly lastCaptureMs: number | null;
  readonly lastSerializeMs: number | null;
  /** Validating, migrating and restoring the last snapshot read, in milliseconds. */
  readonly lastRestoreMs: number | null;
}

/** How saving and the spaces stand, for the shell to show. */
export interface WorkspacesStatus {
  /** Whether the space shown is saved as it changes. */
  readonly autosave: boolean;
  readonly save: SaveState;
  /** Why the last save failed, while it is `failed`. */
  readonly saveError: SwfError | null;
  /** Why the last space or file could not be opened, until a snapshot is restored again. */
  readonly restoreError: SwfError | null;
  /** The space shown; null until the first is opened. */
  readonly space: string | null;
  /** Where a change of space stands. */
  readonly phase: SpacesPhase;
  /**
   * A switch waiting for the operator, since the space shown could not be saved first: the space
   * asked for, and why the save failed.
   */
  readonly asking: { readonly name: string; readonly error: SwfError } | null;
}

/** Where the application remembers the space shown, for the next visit. */
export interface SpaceMemory {
  /** The space shown last, or null when none is remembered. */
  get(): string | null;
  set(name: string): void;
}

/** The space shown remembered in a web storage area, under a key. */
export function webSpaceMemory(storage: Storage, key = 'swf-reference.space'): SpaceMemory {
  return Object.freeze({
    get: () => storage.getItem(key),
    set: (name: string) => {
      storage.setItem(key, name);
    },
  });
}

export interface Workspaces {
  readonly persistence: Persistence;
  status(): WorkspacesStatus;
  /** Calls `listener` whenever saving, the spaces or a restore change. */
  subscribe(listener: () => void): () => void;
  /** Saves the space shown as it changes (the persistence feature on), or stops (off). */
  setAutosave(on: boolean): void;
  /**
   * Turns what the application stored before it kept spaces into spaces, then opens the space
   * shown last, or the default one when none is remembered or it is no longer one. A space that
   * cannot be opened is reported (as the restore error) and the next one in the list is opened
   * instead; resolves with the space opened. Throws when no space can be opened.
   */
  start(): Promise<string>;
  /** Every space: the seeded ones first, in their order, then the operator's by name. */
  list(): Promise<readonly SpaceEntry[]>;
  /**
   * Shows a space in place of the one shown, saving the one shown first. Throws
   * {@link WorkspaceRefusal} for a space there is not, while saving is off or while another
   * change of space is under way.
   */
  switchTo(name: string): Promise<SwitchOutcome>;
  /** Answers a switch that asked: switch anyway, giving up the unsaved changes, or stay. */
  answer(discard: boolean): Promise<SwitchOutcome>;
  /**
   * Saves the space shown now, as the save after a change would, without waiting for it (and
   * instead of it). Throws {@link WorkspaceRefusal} when saving is off, the workspaces are disposed
   * or the store refuses it.
   */
  saveNow(): Promise<void>;
  /**
   * Saves what is shown as a space of the operator's, and shows it from then on; a space of that
   * name is replaced only once the new one is stored. Throws {@link WorkspaceRefusal}.
   */
  saveAs(name: string): Promise<SpaceEntry>;
  /**
   * Deletes a space of the operator's, or puts a seeded one back as it was seeded (the space
   * shown in place, with nothing to undo). Throws {@link WorkspaceRefusal}.
   */
  remove(name: string): Promise<RemoveOutcome>;
  /**
   * Deletes every layout the application saved in this browser; returns how many. The space on
   * screen stays as it is, and is saved again as it changes.
   */
  deleteAll(): Promise<number>;
  /** The space shown as a JSON document to save to a file. */
  exportText(): Promise<string>;
  /**
   * What an imported file holds, read and validated without changing anything: its name must
   * end in `.json` and its text must be a valid snapshot within the size limit. Throws
   * {@link WorkspaceRefusal} naming the line or path at fault.
   */
  previewImport(fileName: string, text: string): SnapshotPreview;
  /** Replaces the space shown with an imported one, after its preview was confirmed. */
  importText(fileName: string, text: string): Promise<RestoreOutcome>;
  measures(): PersistenceMeasures;
  /**
   * Stops saving and lets go of the store and the workspace's events. Disposing again does nothing;
   * once disposed, turning saving on or off, saving now and clearing throw {@link WorkspaceRefusal}.
   */
  dispose(): void;
}

export interface WorkspacesOptions {
  readonly workspace: Workspace;
  readonly store: SnapshotStore;
  /** The host's own state saved with the layout, under its namespace. */
  readonly extensions: readonly PersistenceExtension[];
  /** Policies whose parameters are saved with the layout. */
  readonly policies: readonly PolicySource[];
  /** The spaces the application seeds, in their order. */
  readonly seeds: readonly string[];
  /** The seeded space shown when none is remembered: one of `seeds`. */
  readonly defaultSpace: string;
  /** Makes a seeded space's scene in the workspace, as it is before anyone changed it. */
  readonly seed: (name: string) => Promise<void>;
  /** Where the space shown is remembered. */
  readonly memory: SpaceMemory;
  /** Wall-clock milliseconds, for snapshots' times. */
  readonly now: () => number;
  /** A monotonic clock in milliseconds, for measures. */
  readonly timer: () => number;
  /** How long after a change the space shown is saved, in milliseconds. */
  readonly autosaveDelayMs: number;
}

/**
 * What the application stored before it kept spaces: the workspace of each visit, saved as it
 * changed under `session/<started at>`, and each named save under `named/<name>/<saved at>`. They
 * are made into spaces once, when the application starts, and deleted.
 */
const VISIT = 'session/';
const NAMED = 'named/';

/** When a visit's key says it started, or null for a key that is not a visit's. */
function visitStart(key: string): number | null {
  if (!key.startsWith(VISIT)) {
    return null;
  }
  const at = Number(key.slice(VISIT.length));
  return Number.isSafeInteger(at) ? at : null;
}

/** A named save's name and time, from its key, or null for a key that is not one. */
function namedSave(key: string): { name: string; savedAt: number } | null {
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

/**
 * Makes spaces of the entries stored before spaces, as the Lean model `Swf.AppWorkspaces` decides
 * (`workspacesMigration`): the newest visit becomes the default space and each name's newest save
 * the space of its name, never over a space already stored. Once those spaces are stored, every
 * entry of the earlier kind is deleted. Returns how many spaces were made.
 */
export async function migrateStore(store: SnapshotStore, defaultSpace: string): Promise<number> {
  const entries = await store.list();
  const visits: [string, bigint][] = [];
  const named: [string, [string, bigint]][] = [];
  const stored: string[] = [];
  const old: string[] = [];
  for (const { key } of entries) {
    const at = visitStart(key);
    const save = namedSave(key);
    const space = spaceOfKey(key);
    if (at !== null) {
      visits.push([key, BigInt(at)]);
      old.push(key);
    } else if (save !== null) {
      named.push([key, [save.name, BigInt(save.savedAt)]]);
      old.push(key);
    } else if (space !== null) {
      stored.push(space);
    }
  }
  if (old.length === 0) {
    return 0;
  }
  const plan = models.workspacesMigration(visits, named, defaultSpace, stored);
  for (const [key, space] of plan) {
    const entry = await store.load(key);
    if (entry === null) {
      throw new Error(`the stored entry "${key}" went while it was made into a space`);
    }
    await store.save({
      key: spaceKey(space),
      document: entry.document,
      revision: entry.revision,
      expectedRevision: null,
    });
  }
  for (const key of old) {
    await store.delete(key);
  }
  return plan.length;
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

/** What the spaces refused, said by the field at fault (`space` when no field is). */
async function refused<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SwfFailure) {
      return Promise.reject(
        new WorkspaceRefusal(error.error.path ?? 'space', error.error.message, error.error),
      );
    }
    throw error;
  }
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
  let restoreError: SwfError | null = null;
  let asking: { name: string; error: SwfError } | null = null;
  const measures = {
    saves: 0,
    saveFailures: 0,
    restores: 0,
    restoreFailures: 0,
    migrations: 0,
    switches: 0,
    lastSnapshotBytes: null as number | null,
    lastSaveMs: null as number | null,
    lastCaptureMs: null as number | null,
    lastSerializeMs: null as number | null,
    lastRestoreMs: null as number | null,
  };

  /** A store measured: each save it is asked for counted. */
  const measured: SnapshotStore = {
    guarantees: store.guarantees,
    async load(key) {
      const entry = await store.load(key);
      if (entry !== null) {
        measures.lastSnapshotBytes = entry.bytes;
      }
      return entry;
    },
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
      return ack;
    },
  };

  /**
   * Saving as the space shown changes, decided by the Lean model `Swf.AppWorkspaces`
   * (models/Swf/AppWorkspaces.lean), where it is proved that a save is scheduled only while saving
   * is on, and only once there is something to save. A save is scheduled exactly while the timer
   * runs.
   */
  let machine: Lean.WorkspacesMachine = { autosave: false, pending: false, disposed: false };
  const spaces: Spaces = createSpaces({
    persistence,
    store: measured,
    seeds: options.seeds,
    seed: options.seed,
    saving: () => machine.autosave,
  });
  const stopSpaces = spaces.subscribe(tell);
  let timerId: ReturnType<typeof setTimeout> | null = null;
  /** Saves the space shown, timed. */
  const save = async () => {
    const started = timer();
    const outcome = await spaces.save();
    if (outcome.status !== 'failed') {
      measures.lastSaveMs = timer() - started;
    }
    return outcome;
  };
  /** Does what the model decided for an event, but the save itself; throws its refusal. */
  const decide = (event: Lean.WorkspacesEvent): Lean.WorkspacesStep => {
    const step = models.workspacesStep(machine, event);
    machine = step.next;
    if (step.cancelTimer) {
      if (timerId === null) {
        throw new Error('a scheduled save has no timer to stop');
      }
      clearTimeout(timerId);
      timerId = null;
    }
    if (step.startTimer) {
      timerId = setTimeout(() => {
        timerId = null;
        if (decide({ kind: 'fired' }).save) {
          void save();
        }
      }, options.autosaveDelayMs);
    }
    if (step.announce) {
      tell();
    }
    if (step.refusal !== null) {
      throw new WorkspaceRefusal('save', step.refusal);
    }
    return step;
  };
  const stopChanges = persistence.subscribe(() => {
    decide({ kind: 'changed' });
  });

  /** Captures the space shown and writes it out as JSON, measured. */
  const snapshotText = async (): Promise<string> => {
    const started = timer();
    const { document } = await persistence.capture();
    const captured = timer();
    const text = persistence.export(document);
    measures.lastCaptureMs = captured - started;
    measures.lastSerializeMs = timer() - captured;
    return text;
  };

  /** Counts a restore's outcome; a rejection is kept as the last restore error. */
  const counted = (outcome: RestoreOutcome, started: number): RestoreOutcome => {
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

  /** Counts how a switch ended: a space opened, a question asked, or a space that would not open. */
  const switched = (outcome: SwitchOutcome, started: number): SwitchOutcome => {
    asking = outcome.status === 'asking' ? { name: outcome.name, error: outcome.error } : null;
    switch (outcome.status) {
      case 'switched':
        measures.switches += 1;
        // A seeded space restores nothing: a failure said before stays said.
        if (outcome.restore !== null) {
          counted(outcome.restore, started);
        }
        options.memory.set(outcome.name);
        break;
      case 'failed':
        measures.restoreFailures += 1;
        measures.lastRestoreMs = timer() - started;
        restoreError = outcome.error;
        break;
      case 'unchanged':
      case 'asking':
      case 'stayed':
        break;
    }
    tell();
    return outcome;
  };

  const readDocument = (text: string, field: string): WorkspaceDocument => {
    try {
      return persistence.import(text);
    } catch (error) {
      throw refusalOf(field, error);
    }
  };

  const checkFile = (fileName: unknown, text: unknown) => {
    const issue = models.workspacesImportIssue(
      typeof fileName === 'string' ? fileName : null,
      typeof text === 'string',
    );
    if (issue !== null) {
      throw new WorkspaceRefusal(
        'file',
        issue.kind === 'notJson' ? 'a workspace file is a .json file' : 'a workspace file is text',
      );
    }
  };

  return Object.freeze({
    persistence,
    status: () => {
      const state = spaces.state;
      return Object.freeze({
        autosave: machine.autosave,
        save: state.save,
        saveError: state.saveError,
        restoreError,
        space: state.active,
        phase: state.phase,
        asking,
      });
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setAutosave(on: boolean) {
      decide({ kind: 'setAutosave', on, saver: { kind: spaces.state.save } });
    },
    async start() {
      await migrateStore(measured, options.defaultSpace);
      const names = (await spaces.list()).map((space) => space.name);
      const remembered = options.memory.get();
      const order = [
        ...(remembered !== null && names.includes(remembered) ? [remembered] : []),
        options.defaultSpace,
        ...names,
      ].filter((name, i, all) => all.indexOf(name) === i);
      for (const name of order) {
        const started = timer();
        const outcome = switched(await spaces.switchTo(name), started);
        if (outcome.status === 'switched') {
          return name;
        }
      }
      throw new Error(
        `no space could be opened: ${restoreError?.message ?? 'none is stored or seeded'}`,
      );
    },
    list: () => spaces.list(),
    switchTo(name: string) {
      const started = timer();
      return refused(async () => switched(await spaces.switchTo(name), started));
    },
    answer(discard: boolean) {
      const started = timer();
      return refused(async () => switched(await spaces.answer(discard), started));
    },
    async saveNow() {
      if (!decide({ kind: 'saveNow' }).save) {
        return;
      }
      const outcome = await save();
      if (outcome.status === 'failed') {
        throw new WorkspaceRefusal('save', outcome.error.message, outcome.error);
      }
    },
    async saveAs(name: string) {
      const entry = await refused(() => spaces.saveAs(name));
      options.memory.set(entry.name);
      tell();
      return entry;
    },
    async remove(name: string) {
      const outcome = await refused(() => spaces.remove(name));
      tell();
      return outcome;
    },
    async deleteAll() {
      const deleted = await refused(() => spaces.clear());
      // Nothing is stored now: the space on screen counts as unsaved, and is saved again.
      decide({ kind: 'cleared' });
      return deleted;
    },
    async exportText() {
      return snapshotText();
    },
    previewImport(fileName: string, text: string) {
      checkFile(fileName, text);
      const document = readDocument(text, 'file');
      return previewOf(document, new TextEncoder().encode(text).length);
    },
    async importText(fileName: string, text: string) {
      checkFile(fileName, text);
      readDocument(text, 'file');
      const started = timer();
      return counted(await persistence.restore(text), started);
    },
    measures: () => Object.freeze({ ...measures }),
    dispose() {
      decide({ kind: 'dispose' });
      stopChanges();
      stopSpaces();
      spaces.dispose();
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
