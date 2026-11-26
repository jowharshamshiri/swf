import type { SwfError } from '@swf/core';
import { SwfFailure } from '@swf/core';
import type { SpacesEvent, SpacesMachine, SpacesRefusal, SpacesStep } from '@swf/models';
import { models } from '@swf/models';
import { failure } from './document.js';
import type { Persistence, RestoreOutcome } from './persistence.js';
import type { SaveOutcome, Saver, SaveState } from './saver.js';
import { createSaver } from './saver.js';
import type { SnapshotStore } from './store.js';

/**
 * Named spaces: several workspaces kept in one store, one shown at a time in the workspace,
 * switched in one call. Each space is stored under a key of its own (`space/<name>`), and the
 * space shown is saved there as it changes; switching to another first saves the space shown,
 * then restores the other in its place with the workspace's history started afresh, so nothing
 * done in one space is ever undone into another. A space the host seeds is always one of the
 * spaces: until it is stored, the host makes it when it is opened.
 */

/** Where spaces are stored, before each space's name. */
export const SPACE_KEY_PREFIX = 'space/';

/** The store key of a space. */
export const spaceKey = (name: string): string => `${SPACE_KEY_PREFIX}${encodeURIComponent(name)}`;

/** A space's name from a store key, or null for a key that is not a space's. */
export function spaceOfKey(key: string): string | null {
  if (!key.startsWith(SPACE_KEY_PREFIX)) {
    return null;
  }
  try {
    const name = decodeURIComponent(key.slice(SPACE_KEY_PREFIX.length));
    return spaceKey(name) === key ? name : null;
  } catch {
    return null;
  }
}

/**
 * Why a name cannot name a space, or null when it can: it needs something besides spaces, cannot
 * start or end with spaces, and is at most 80 UTF-16 code units long.
 */
export function spaceNameIssue(name: unknown): string | null {
  const issue = models.spacesNameIssue(typeof name === 'string' ? name : null);
  if (issue === null) {
    return null;
  }
  switch (issue.kind) {
    case 'missing':
      return 'a space needs a name';
    case 'padded':
      return 'a name cannot start or end with spaces';
    case 'tooLong':
      return `a name can be at most ${String(issue.max)} characters`;
  }
}

/** One of the spaces, as {@link Spaces.list} gives it. Frozen. */
export interface SpaceEntry {
  readonly name: string;
  /** The host seeds it: it is always one of the spaces, and removing it resets it. */
  readonly seeded: boolean;
  /** What the store holds of it, or null when it was never stored (a seeded space). */
  readonly stored: { readonly savedAt: number; readonly bytes: number } | null;
}

/** Where a change of space stands. */
export type SpacesPhase = 'idle' | 'saving' | 'asking' | 'opening' | 'forking' | 'resetting';

/** How the spaces stand. Frozen. */
export interface SpacesState {
  /** The space shown, or null before the first is opened. */
  readonly active: string | null;
  readonly phase: SpacesPhase;
  /** The space a switch, save as or reset under way is about, or null while idle. */
  readonly target: string | null;
  /** How the space shown is saved; `dirty` before any is shown. */
  readonly save: SaveState;
  /** Why the last save of the space shown failed, while it is `failed`. */
  readonly saveError: SwfError | null;
}

/** How a {@link Spaces.switchTo} or {@link Spaces.answer} ended. Frozen. */
export type SwitchOutcome =
  | {
      /** The space is shown. */
      readonly status: 'switched';
      readonly name: string;
      /** The restore of its stored snapshot, or null when the host seeded it afresh. */
      readonly restore: RestoreOutcome | null;
    }
  | {
      /** The space asked for is the one shown: nothing was done. */
      readonly status: 'unchanged';
    }
  | {
      /**
       * The space shown could not be saved first: nothing was switched. The person answers with
       * {@link Spaces.answer}: to switch anyway, giving up its unsaved changes, or to stay.
       */
      readonly status: 'asking';
      readonly name: string;
      readonly error: SwfError;
    }
  | {
      /** The person chose to stay: the space shown is as it was. */
      readonly status: 'stayed';
    }
  | {
      /** The space could not be opened: the space shown is as it was, and stays shown. */
      readonly status: 'failed';
      readonly name: string;
      readonly error: SwfError;
    };

/** What {@link Spaces.remove} did. */
export type RemoveOutcome = 'deleted' | 'reset' | 'unchanged';

export interface SpacesOptions {
  /**
   * The workspace's persistence: it captures and restores each space. The spaces follow its
   * changes and never dispose it.
   */
  readonly persistence: Persistence;
  /** Where the spaces are stored, each under {@link spaceKey}; other keys are left as they are. */
  readonly store: SnapshotStore;
  /** The spaces the host seeds, in the order they are listed: valid names, each once. */
  readonly seeds: readonly string[];
  /**
   * Makes a seeded space in the workspace, as it is before anyone changed it: when it is opened
   * and the store does not hold it, and when it is reset. Resolves once it is in place; a
   * rejection fails the open or the reset. The spaces then start the workspace's history afresh.
   */
  readonly seed: (name: string) => Promise<void>;
  /** Whether saving is on: while it is off the space shown never changes, but for the first. */
  readonly saving: () => boolean;
}

/**
 * The spaces of one workspace. Every change of space, save and removal runs in the order asked,
 * one at a time: a save asked for while a switch is under way saves the space shown once the
 * switch has ended.
 */
export interface Spaces {
  /** How the spaces stand now. */
  readonly state: SpacesState;
  /**
   * Every space: the seeded ones in their order, then the others by name (in code-unit order),
   * each once.
   */
  list(): Promise<readonly SpaceEntry[]>;
  /**
   * Shows a space in place of the one shown. The first space is opened at once. Afterwards, the
   * space shown is saved first when it has unsaved changes; when that save fails, nothing is
   * switched and the outcome is `asking` until {@link answer}. The space is opened from what the
   * store holds of it, or seeded when it holds nothing, with the workspace's history started
   * afresh; a snapshot that cannot be restored fails the switch, leaving the space shown.
   *
   * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` naming `name` for a name no space has,
   *   `INVALID_TRANSITION` while saving is off (but for the first space), while another change of
   *   space is under way, or once disposed.
   */
  switchTo(name: string): Promise<SwitchOutcome>;
  /**
   * Answers the question a switch asked: `discard` opens the space asked for, giving up the
   * unsaved changes of the space shown; otherwise the space shown stays.
   *
   * @throws {@link @swf/core!SwfFailure} `INVALID_TRANSITION` when no question is asked.
   */
  answer(discard: boolean): Promise<SwitchOutcome>;
  /** Saves the space shown now (once any change of space under way has ended). */
  save(): Promise<SaveOutcome>;
  /**
   * Stores what is shown as the space `name` and shows it from then on; the space shown before
   * keeps what it last saved. A space of that name the host does not seed is replaced, only once
   * the new one is stored.
   *
   * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` naming `name` for a name that cannot
   *   name a space or that a seeded space has; `INVALID_TRANSITION` while saving is off, before any
   *   space is shown, while another change is under way or once disposed; the store's error when
   *   it refuses the save.
   */
  saveAs(name: string): Promise<SpaceEntry>;
  /**
   * Removes a space: a stored space that is not shown is deleted; a seeded one that is not shown
   * goes back to its seed (`deleted`, or `unchanged` when it was never stored); the space shown,
   * when seeded, is reset in place to its seed with the history started afresh (`reset`).
   *
   * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` naming `name` for a name no space has;
   *   `INVALID_TRANSITION` for the space shown when it is not seeded, while saving is off, while
   *   another change is under way, or once disposed.
   */
  remove(name: string): Promise<RemoveOutcome>;
  /**
   * Deletes every stored space; returns how many. The space shown stays shown, and counts as not
   * saved.
   *
   * @throws {@link @swf/core!SwfFailure} `INVALID_TRANSITION` while saving is off, while another
   *   change is under way, or once disposed.
   */
  clear(): Promise<number>;
  /**
   * Calls `listener` whenever the state or the spaces change. Returns an idempotent unsubscribe.
   */
  subscribe(listener: () => void): () => void;
  /** Stops saving and following the persistence, and drops every listener. Safe to call twice. */
  dispose(): void;
}

/** The refusal of an event, as the caller is told it. */
function refusal(kind: SpacesRefusal['kind'], name: string): SwfFailure {
  switch (kind) {
    case 'disposed':
      return failure('INVALID_TRANSITION', 'the spaces are disposed');
    case 'off':
      return failure('INVALID_TRANSITION', 'saving is off: the spaces cannot change');
    case 'unknown':
      return failure('INVALID_INPUT', `no space is named “${name}”`, 'name');
    case 'busy':
      return failure('INVALID_TRANSITION', 'another change of space is under way');
    case 'badName':
      return failure('INVALID_INPUT', spaceNameIssue(name) ?? 'the name is invalid', 'name');
    case 'taken':
      return failure(
        'INVALID_INPUT',
        `“${name}” is a seeded space: save under another name`,
        'name',
      );
    case 'shown':
      return failure(
        'INVALID_TRANSITION',
        `“${name}” is the space shown: show another space to remove it`,
        'name',
      );
    case 'unexpected':
      throw new Error(`the spaces were told of an event that does not belong to ${name}`);
  }
}

/**
 * Creates the spaces of a workspace, none shown until the first {@link Spaces.switchTo}. The
 * caller owns them and disposes them; they never dispose the persistence or the store.
 *
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` naming `seeds` when a seed's name is
 *   invalid or given twice, or naming `seed` or `saving` when either is not a function.
 */
export function createSpaces(options: SpacesOptions): Spaces {
  const { persistence, store } = options;
  const seeds = [...options.seeds];
  seeds.forEach((name, i) => {
    const issue = spaceNameIssue(name);
    if (issue !== null) {
      throw failure('INVALID_INPUT', `seeds[${String(i)}]: ${issue}`, `seeds[${String(i)}]`);
    }
    if (seeds.indexOf(name) !== i) {
      throw failure('INVALID_INPUT', `seeds[${String(i)}]: “${name}” is given twice`, 'seeds');
    }
  });
  for (const field of ['seed', 'saving'] as const) {
    if (typeof options[field] !== 'function') {
      throw failure('INVALID_INPUT', `${field} must be a function`, field);
    }
  }

  const listeners = new Set<() => void>();
  const tell = () => {
    for (const listener of [...listeners]) {
      listener();
    }
  };
  /** The model of the spaces (`Swf.Spaces`): every state, and what each event does, is its. */
  let machine: SpacesMachine = models.spacesInitial();
  /** The saver of the space shown; null before any. */
  let saver: Saver | null = null;
  let stopSaver: (() => void) | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  /** Runs an operation after the ones asked before it. */
  const queued = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run);
    queue = next.catch(() => undefined);
    return next;
  };

  /** The model's step for an event, the machine moved; a refusal is thrown. */
  const decide = (event: SpacesEvent, name: string): SpacesStep => {
    const step = models.spacesStep(machine, event);
    if (step.refusal !== null) {
      throw refusal(step.refusal.kind, name);
    }
    const changed =
      step.next.active !== machine.active ||
      JSON.stringify(step.next.phase) !== JSON.stringify(machine.phase);
    machine = step.next;
    if (changed) {
      tell();
    }
    return step;
  };

  /** Saves the space shown under its key from now on, as `saved` says the store holds it. */
  const adoptSaver = (name: string, saved?: { revision: number; changes: number }) => {
    stopSaver?.();
    saver?.dispose();
    saver = createSaver({
      persistence,
      store,
      key: spaceKey(name),
      ...(saved === undefined ? {} : { saved }),
    });
    stopSaver = saver.subscribe(tell);
  };

  const storedNames = async (): Promise<Map<string, { savedAt: number; bytes: number }>> => {
    const all = new Map<string, { savedAt: number; bytes: number }>();
    for (const entry of await store.list()) {
      const name = spaceOfKey(entry.key);
      if (name !== null) {
        all.set(name, { savedAt: entry.savedAt, bytes: entry.bytes });
      }
    }
    return all;
  };

  const saverState = (): SaveState => saver?.state ?? 'dirty';

  /**
   * Puts a space in the workspace with its history started afresh: its stored snapshot, or its
   * seed. Resolves with how it went; the saver is the caller's to adopt.
   */
  const bring = async (
    name: string,
  ): Promise<
    | { ok: true; restore: RestoreOutcome | null; saved?: { revision: number; changes: number } }
    | { ok: false; error: SwfError }
  > => {
    const stored = await store.load(spaceKey(name));
    if (stored !== null) {
      const outcome = await persistence.restore(stored.document, { history: 'fresh' });
      if (outcome.status !== 'restored') {
        return { ok: false, error: outcome.error };
      }
      return {
        ok: true,
        restore: outcome,
        saved: { revision: stored.revision, changes: persistence.changes() },
      };
    }
    return seedFresh(name);
  };

  /** The host seeds a space, then its history starts afresh with it: nothing stored of it. */
  const seedFresh = async (
    name: string,
  ): Promise<{ ok: true; restore: null } | { ok: false; error: SwfError }> => {
    try {
      await options.seed(name);
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof SwfFailure
            ? error.error
            : failure(
                'INVALID_TRANSITION',
                `the space “${name}” could not be seeded: ${error instanceof Error ? error.message : String(error)}`,
              ).error,
      };
    }
    const { document } = await persistence.capture();
    const outcome = await persistence.restore(document, { history: 'fresh' });
    if (outcome.status !== 'restored') {
      return { ok: false, error: outcome.error };
    }
    return { ok: true, restore: null };
  };

  /** Opens the space a step names, and tells the model how it went. */
  const open = async (name: string): Promise<SwitchOutcome> => {
    const brought = await bring(name);
    decide({ kind: 'opened', ok: brought.ok }, name);
    if (!brought.ok) {
      return Object.freeze({ status: 'failed', name, error: brought.error });
    }
    adoptSaver(name, 'saved' in brought ? brought.saved : undefined);
    tell();
    return Object.freeze({ status: 'switched', name, restore: brought.restore });
  };

  const known = async (name: string) => seeds.includes(name) || (await storedNames()).has(name);

  return Object.freeze({
    get state(): SpacesState {
      const phase = machine.phase;
      return Object.freeze({
        active: machine.active,
        phase: phase.kind,
        target: phase.kind === 'idle' ? null : 'target' in phase ? phase.target : phase.name,
        save: saverState(),
        saveError: saver?.state === 'failed' ? saver.lastError : null,
      });
    },
    async list() {
      const stored = await storedNames();
      const others = [...stored.keys()]
        .filter((name) => !seeds.includes(name))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.freeze(
        [...seeds, ...others].map((name) =>
          Object.freeze({
            name,
            seeded: seeds.includes(name),
            stored: stored.get(name) ?? null,
          }),
        ),
      );
    },
    switchTo(name: string) {
      return queued(async () => {
        const step = decide(
          {
            kind: 'request',
            target: name,
            known: await known(name),
            on: options.saving(),
            saver: { kind: saverState() },
          },
          name,
        );
        if (step.openTarget !== null) {
          return open(step.openTarget);
        }
        if (!step.save) {
          return Object.freeze({ status: 'unchanged' });
        }
        if (saver === null) {
          throw new Error('the spaces save a space shown, but none is');
        }
        const saved = await saver.save();
        const next = decide({ kind: 'saved', ok: saved.status !== 'failed' }, name);
        if (next.openTarget !== null) {
          return open(next.openTarget);
        }
        if (!next.ask || saved.status !== 'failed') {
          throw new Error('a failed save before a switch did not ask');
        }
        return Object.freeze({ status: 'asking', name, error: saved.error });
      });
    },
    answer(discard: boolean) {
      return queued(async () => {
        if (machine.phase.kind !== 'asking') {
          throw failure('INVALID_TRANSITION', 'no switch is waiting for an answer');
        }
        const step = decide({ kind: 'answer', discard }, machine.phase.target);
        if (step.openTarget !== null) {
          return open(step.openTarget);
        }
        return Object.freeze({ status: 'stayed' });
      });
    },
    save() {
      return queued(async () => {
        if (machine.disposed) {
          throw refusal('disposed', '');
        }
        if (saver === null) {
          throw failure('INVALID_TRANSITION', 'no space is shown to save');
        }
        const outcome = await saver.save();
        if (outcome.status === 'saved') {
          tell();
        }
        return outcome;
      });
    },
    saveAs(name: string) {
      return queued(async () => {
        const step = decide(
          {
            kind: 'fork',
            name,
            issue: spaceNameIssue(name) !== null,
            taken: seeds.includes(name),
            on: options.saving(),
          },
          name,
        );
        if (step.store === null) {
          throw new Error('a fork did not store');
        }
        let ack;
        let changes;
        try {
          const capture = await persistence.capture();
          changes = capture.changes;
          ack = await store.save({
            key: spaceKey(name),
            document: persistence.export(capture.document),
            revision: capture.document.revision,
            expectedRevision: (await store.load(spaceKey(name)))?.revision ?? null,
          });
        } catch (error) {
          decide({ kind: 'forked', ok: false }, name);
          throw error;
        }
        decide({ kind: 'forked', ok: true }, name);
        adoptSaver(name, { revision: ack.revision, changes });
        tell();
        return Object.freeze({
          name,
          seeded: false,
          stored: Object.freeze({ savedAt: ack.savedAt, bytes: ack.bytes }),
        });
      });
    },
    remove(name: string) {
      return queued(async (): Promise<RemoveOutcome> => {
        const stored = (await storedNames()).has(name);
        const step = decide(
          {
            kind: 'remove',
            name,
            seeded: seeds.includes(name),
            stored,
            on: options.saving(),
          },
          name,
        );
        if (step.delete !== null) {
          await store.delete(spaceKey(step.delete));
          tell();
          return 'deleted';
        }
        if (!step.reseed) {
          return 'unchanged';
        }
        const seeded = await seedFresh(name);
        decide({ kind: 'reset', ok: seeded.ok }, name);
        if (!seeded.ok) {
          throw new SwfFailure(seeded.error);
        }
        if (stored) {
          await store.delete(spaceKey(name));
        }
        adoptSaver(name);
        tell();
        return 'reset';
      });
    },
    clear() {
      return queued(async () => {
        decide({ kind: 'clear', on: options.saving() }, '');
        let deleted = 0;
        for (const entry of await store.list()) {
          if (spaceOfKey(entry.key) !== null && (await store.delete(entry.key))) {
            deleted += 1;
          }
        }
        if (machine.active !== null) {
          adoptSaver(machine.active);
        }
        tell();
        return deleted;
      });
    },
    subscribe(listener: () => void) {
      const entry = () => {
        listener();
      };
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
    dispose() {
      machine = models.spacesStep(machine, { kind: 'dispose' }).next;
      stopSaver?.();
      stopSaver = null;
      saver?.dispose();
      listeners.clear();
    },
  });
}
