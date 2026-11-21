import type { SwfError } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import { failure } from './document.js';
import type { CaptureFailure, Persistence } from './persistence.js';
import type { SaveAck, SnapshotStore } from './store.js';

/**
 * Where a workspace's saving is: `clean` when the store holds what the workspace shows, `dirty`
 * after a change, `saving` while a save is under way, `failed` after a save the store did not
 * acknowledge (the workspace is still unsaved, and the store holds what it held before).
 */
export type SaveState = 'clean' | 'dirty' | 'saving' | 'failed';

export interface SaverOptions {
  readonly persistence: Persistence;
  readonly store: SnapshotStore;
  /** The key the workspace's snapshot is stored under. */
  readonly key: string;
  /**
   * What the store holds under `key` already and the workspace shows (after a restore, say): the
   * change count it reflects and its revision. Without it the workspace counts as unsaved.
   */
  readonly saved?: { readonly revision: number; readonly changes: number };
}

export type SaveOutcome =
  | {
      readonly status: 'saved';
      readonly ack: SaveAck;
      /** States that could not be captured; the snapshot carries their last known state. */
      readonly failures: readonly CaptureFailure[];
    }
  | { readonly status: 'unchanged' }
  | { readonly status: 'failed'; readonly error: SwfError };

/** Saves one workspace to one store key, following the snapshot save state machine. */
export interface Saver {
  readonly state: SaveState;
  /** The revision the store acknowledged last, or null before any. */
  readonly savedRevision: number | null;
  /** Why the last save failed, or null. */
  readonly lastError: SwfError | null;
  /**
   * Saves what the workspace shows now: captures a snapshot and stores it, expecting the store to
   * hold the last acknowledged revision. Only an acknowledgement of exactly that key and revision
   * counts; it makes the state `clean` when nothing changed meanwhile, `dirty` otherwise. A save
   * asked for while one runs follows it. A retry always captures afresh, so it never stores an
   * older revision, and a store that holds a newer one refuses it.
   */
  save(): Promise<SaveOutcome>;
  /**
   * Calls `listener` with each new state. A listener that throws does not stop saving or the
   * others; its failure is kept in {@link getDiagnostics}. Returns an idempotent unsubscribe.
   */
  subscribe(listener: (state: SaveState) => void): () => void;
  /** The last 100 listener failures, oldest first. */
  getDiagnostics(): readonly string[];
  /** Stops following changes. Safe to call twice. */
  dispose(): void;
}

/** Creates a saver. Throws {@link SwfFailure} (`INVALID_INPUT`) for invalid options. */
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
  #state: SaveState;
  #savedRevision: number | null;
  /** The change count the store's snapshot reflects, or null when it holds none of this session. */
  #savedChanges: number | null;
  #lastError: SwfError | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #unsubscribe: (() => void) | null;

  constructor(options: SaverOptions) {
    this.#persistence = options.persistence;
    this.#store = options.store;
    this.#key = options.key;
    this.#savedRevision = options.saved?.revision ?? null;
    this.#savedChanges = options.saved?.changes ?? null;
    this.#state = this.#savedChanges === this.#persistence.changes() ? 'clean' : 'dirty';
    this.#unsubscribe = this.#persistence.subscribe(() => {
      if (this.#state === 'clean') {
        this.#set('dirty');
      }
    });
  }

  get state(): SaveState {
    return this.#state;
  }

  get savedRevision(): number | null {
    return this.#savedRevision;
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
    if (this.#savedChanges === this.#persistence.changes()) {
      return Object.freeze({ status: 'unchanged' });
    }
    this.#set('saving');
    try {
      const capture = await this.#persistence.capture();
      const revision = capture.document.revision;
      const ack = await this.#store.save({
        key: this.#key,
        document: this.#persistence.export(capture.document),
        revision,
        expectedRevision: this.#savedRevision,
      });
      if (ack.key !== this.#key || ack.revision !== revision) {
        throw failure(
          'STORAGE_FAILED',
          `the store acknowledged "${ack.key}" at revision ${String(ack.revision)}, not "${this.#key}" at ${String(revision)}`,
        );
      }
      this.#savedRevision = ack.revision;
      this.#savedChanges = capture.changes;
      this.#lastError = null;
      // Changes made while saving leave the workspace unsaved.
      this.#set(this.#persistence.changes() === capture.changes ? 'clean' : 'dirty');
      return Object.freeze({ status: 'saved', ack, failures: capture.failures });
    } catch (error) {
      this.#lastError =
        error instanceof SwfFailure
          ? error.error
          : makeError(
              'STORAGE_FAILED',
              `saving "${this.#key}" failed: ${error instanceof Error ? error.message : String(error)}`,
              { retryable: true },
            );
      this.#set('failed');
      return Object.freeze({ status: 'failed', error: this.#lastError });
    }
  }

  #set(state: SaveState): void {
    if (state === this.#state) {
      return;
    }
    this.#state = state;
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
