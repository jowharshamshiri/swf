import type { SwfError } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import { failure } from './document.js';
import type { AckRefusal, SaveAnswer, SaveMachine } from '@swf/models';
import { models } from '@swf/models';
import type { Capture, CaptureFailure, Persistence } from './persistence.js';
import type { SaveAck, SnapshotStore } from './store.js';

/**
 * Where a workspace's saving is: `clean` when the store holds what the workspace shows, `dirty`
 * after a change, `saving` while a save is under way, `failed` after a save the store did not
 * acknowledge (the workspace is still unsaved, and the store holds what it held before).
 */
export type SaveState = 'clean' | 'dirty' | 'saving' | 'failed';

/** What a saver saves, where, and what the store already holds. */
export interface SaverOptions {
  /**
   * The workspace's persistence, which captures and exports each snapshot. The saver follows its
   * changes and never disposes it.
   */
  readonly persistence: Persistence;
  /** The store the snapshots go to. The saver only saves to it, under `key`; it never deletes. */
  readonly store: SnapshotStore;
  /** The key the workspace's snapshot is stored under: a non-blank string. */
  readonly key: string;
  /**
   * What the store holds under `key` already and the workspace shows (after a restore, say): the
   * change count it reflects and its revision. With it the saver opens `clean` when that change
   * count is the persistence's current one; without it the workspace counts as unsaved and the
   * first save expects the store to hold nothing under `key`.
   */
  readonly saved?: {
    /** The revision the store holds: a whole number from 0. */
    readonly revision: number;
    /** The {@link Persistence.changes} count that snapshot reflects: a whole number. */
    readonly changes: number;
  };
}

/** How one {@link Saver.save} ended. Frozen. */
export type SaveOutcome =
  | {
      /** The store acknowledged the snapshot. */
      readonly status: 'saved';
      /** The store's acknowledgement, of exactly the key and revision saved. */
      readonly ack: SaveAck;
      /** States that could not be captured; the snapshot carries their last known state. */
      readonly failures: readonly CaptureFailure[];
    }
  | {
      /** The store already holds what the workspace shows: nothing was captured or saved. */
      readonly status: 'unchanged';
    }
  | {
      /** The save failed; the saver is `failed` and the store holds what it held before. */
      readonly status: 'failed';
      /**
       * Why: the store's error (`CONFLICT`, `QUOTA_EXCEEDED`, `STORAGE_FAILED`, …), a capture
       * that failed, or `STORAGE_FAILED` for an acknowledgement of another key or revision, or of
       * a revision older than the one the store already acknowledged.
       */
      readonly error: SwfError;
    };

/**
 * Saves one workspace to one store key, following the snapshot save state machine. The caller
 * owns it and calls {@link Saver.dispose} when done; it never disposes the persistence or the
 * store.
 */
export interface Saver {
  /** Where saving is now; see {@link SaveState}. */
  readonly state: SaveState;
  /** The revision the store acknowledged last, or null before any. */
  readonly savedRevision: number | null;
  /** Why the last save failed, or null when it succeeded or none has ended yet. */
  readonly lastError: SwfError | null;
  /**
   * Saves what the workspace shows now: captures a snapshot and stores it, expecting the store to
   * hold the last acknowledged revision. Only an acknowledgement of exactly that key and revision
   * counts; it makes the state `clean` when nothing changed meanwhile, `dirty` otherwise. A save
   * asked for while one runs follows it. A retry always captures afresh, so it never stores an
   * older revision, and a store that holds a newer one refuses it.
   *
   * It never rejects: a failure resolves as `failed`, with the saver `failed` until the next
   * save. A change during a save keeps the state `saving` and makes it `dirty` once acknowledged.
   */
  save(): Promise<SaveOutcome>;
  /**
   * Calls `listener` with each new state. A listener that throws does not stop saving or the
   * others; its failure is kept in {@link getDiagnostics}. Returns an idempotent unsubscribe.
   */
  subscribe(listener: (state: SaveState) => void): () => void;
  /** The last 100 listener failures, oldest first, as messages; a new frozen array on each call. */
  getDiagnostics(): readonly string[];
  /**
   * Stops following the persistence's changes and drops every listener; the persistence and the
   * store are left as they are. A save under way still ends. Safe to call twice.
   */
  dispose(): void;
}

/**
 * Creates a saver of one workspace's snapshots to one store key, `clean` or `dirty` as
 * {@link SaverOptions.saved} says. The caller owns it and disposes it.
 *
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` naming `key` for a blank or missing key,
 *   or `saved` when it does not give a whole revision of at least 0 and a whole change count.
 *   `persistence` and `store` are used as given.
 */
export function createSaver(options: SaverOptions): Saver {
  if (typeof options.key !== 'string' || options.key.trim() === '') {
    throw failure('INVALID_INPUT', 'key must be a non-blank string', 'key');
  }
  const saved = options.saved;
  if (
    saved !== undefined &&
    !(
      Number.isSafeInteger(saved.revision) &&
      saved.revision >= 0 &&
      Number.isSafeInteger(saved.changes)
    )
  ) {
    throw failure('INVALID_INPUT', 'saved must give a revision and a change count', 'saved');
  }
  return new SaverImpl(options);
}

class SaverImpl implements Saver {
  readonly #persistence: Persistence;
  readonly #store: SnapshotStore;
  readonly #key: string;
  readonly #listeners = new Set<(state: SaveState) => void>();
  readonly #diagnostics: string[] = [];
  /** The save machine (`Swf.Save`): every state, and what the store holds, is its decision. */
  #machine: SaveMachine;
  #lastError: SwfError | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #unsubscribe: (() => void) | null;

  constructor(options: SaverOptions) {
    this.#persistence = options.persistence;
    this.#store = options.store;
    this.#key = options.key;
    this.#machine = models.saveOpen(
      options.saved === undefined ? null : BigInt(options.saved.revision),
      options.saved === undefined ? null : BigInt(options.saved.changes),
      BigInt(this.#persistence.changes()),
    );
    this.#unsubscribe = this.#persistence.subscribe(() => {
      this.#move(models.saveChanged(this.#machine, BigInt(this.#persistence.changes())));
    });
  }

  get state(): SaveState {
    return this.#machine.state.kind;
  }

  get savedRevision(): number | null {
    const revision = this.#machine.savedRevision;
    return revision === null ? null : Number(revision);
  }

  get lastError(): SwfError | null {
    return this.#lastError;
  }

  save(): Promise<SaveOutcome> {
    const next = this.#queue.then(() => this.#save());
    this.#queue = next.catch(() => undefined);
    return next;
  }

  subscribe(listener: (state: SaveState) => void): () => void {
    const entry = (state: SaveState) => {
      listener(state);
    };
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }

  getDiagnostics(): readonly string[] {
    return Object.freeze([...this.#diagnostics]);
  }

  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#listeners.clear();
  }

  async #save(): Promise<SaveOutcome> {
    const begun = models.saveBegin(this.#machine, BigInt(this.#persistence.changes()));
    if (begun === null) {
      return Object.freeze({ status: 'unchanged' });
    }
    // The store is expected to hold the revision it acknowledged last.
    const expectedRevision = this.savedRevision;
    this.#move(begun);
    let answer: SaveAnswer;
    let ack: SaveAck | null = null;
    let capture: Capture | null = null;
    let failed: unknown = null;
    try {
      capture = await this.#persistence.capture();
      ack = await this.#store.save({
        key: this.#key,
        document: this.#persistence.export(capture.document),
        revision: capture.document.revision,
        expectedRevision,
      });
      answer = {
        kind: 'acknowledged',
        confirmed: ack.key === this.#key && ack.revision === capture.document.revision,
        revision: BigInt(ack.revision),
      };
    } catch (error) {
      failed = error;
      answer = { kind: 'failed' };
    }
    const end = models.saveEnd(
      this.#machine,
      BigInt(capture?.changes ?? this.#persistence.changes()),
      BigInt(this.#persistence.changes()),
      answer,
    );
    if (end.refused === null && failed === null && ack !== null && capture !== null) {
      this.#lastError = null;
      this.#move(end.next);
      return Object.freeze({ status: 'saved', ack, failures: capture.failures });
    }
    this.#lastError = this.#failure(failed, end.refused, ack, capture);
    this.#move(end.next);
    return Object.freeze({ status: 'failed', error: this.#lastError });
  }

  /** Why a save failed: the storage's error, or an acknowledgement that does not count. */
  #failure(
    error: unknown,
    refused: AckRefusal | null,
    ack: SaveAck | null,
    capture: Capture | null,
  ): SwfError {
    if (refused !== null && ack !== null && capture !== null) {
      const revision = capture.document.revision;
      return failure(
        'STORAGE_FAILED',
        refused.kind === 'mismatch'
          ? `the store acknowledged "${ack.key}" at revision ${String(ack.revision)}, not "${this.#key}" at ${String(revision)}`
          : `the store acknowledged revision ${String(ack.revision)}, older than the revision ${String(this.savedRevision)} it holds`,
      ).error;
    }
    return error instanceof SwfFailure
      ? error.error
      : makeError(
          'STORAGE_FAILED',
          `saving "${this.#key}" failed: ${error instanceof Error ? error.message : String(error)}`,
          { retryable: true },
        );
  }

  /** Puts the machine in the state the model decided, telling the listeners of a new state. */
  #move(next: SaveMachine): void {
    const changed = next.state.kind !== this.#machine.state.kind;
    this.#machine = next;
    if (!changed) {
      return;
    }
    const state = next.state.kind;
    for (const listener of [...this.#listeners]) {
      try {
        listener(state);
      } catch (error) {
        this.#diagnostics.push(
          `a listener threw while hearing of state ${state}: ${error instanceof Error ? error.message : String(error)}`,
        );
        this.#diagnostics.splice(0, Math.max(0, this.#diagnostics.length - 100));
      }
    }
  }
}
