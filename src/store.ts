import { failure, utf8Length } from './document.js';

/**
 * A snapshot as a store holds it: its JSON text and the workspace revision it was taken at. The
 * stores of this package hand it out frozen.
 */
export interface StoredSnapshot {
  /** The key it is stored under: a non-blank string. */
  readonly key: string;
  /** The workspace revision the snapshot was taken at: a whole number from 0. */
  readonly revision: number;
  /** The snapshot's JSON text, exactly as saved; the store does not parse or validate it. */
  readonly document: string;
  /** When the store saved it, in milliseconds by the store's `now` clock. */
  readonly savedAt: number;
  /** The document's UTF-8 size, in bytes. */
  readonly bytes: number;
}

/** A stored snapshot without its document: what {@link SnapshotStore.list} gives. Frozen. */
export type SnapshotEntry = Omit<StoredSnapshot, 'document'>;

/** One snapshot to store, and what the caller expects the store to hold before it. */
export interface SaveRequest {
  /** The key to store it under: a non-blank string. */
  readonly key: string;
  /** The snapshot's JSON text; the store keeps it as given. */
  readonly document: string;
  /**
   * The workspace revision the snapshot was taken at: a whole number from 0, and not below the
   * revision stored under `key`.
   */
  readonly revision: number;
  /**
   * The revision the caller last saw stored under `key`, or null when it saw none. A store with
   * compare-and-swap refuses the save when what it holds differs.
   */
  readonly expectedRevision: number | null;
}

/**
 * A store's acknowledgement that a save is stored as its guarantees promise: the key, revision,
 * time and size it stored. Frozen.
 */
export type SaveAck = SnapshotEntry;

/** What a store promises about its saves. */
export interface StoreGuarantees {
  /** A save replaces the previous snapshot entirely or not at all. */
  readonly atomic: boolean;
  /** A save is refused when the stored revision is not the one expected. */
  readonly compareAndSwap: boolean;
}

/**
 * Where snapshots are kept: the host's choice, replaceable. A store acknowledges a save only once
 * the snapshot is stored as its guarantees promise, never stores a snapshot over a newer revision,
 * and leaves what it held intact when a save fails. Its operations reject with
 * {@link @swf/core!SwfFailure}: `INVALID_INPUT` for a blank key or a malformed request (naming
 * the field), `CONFLICT` for a stale expectation or a newer stored revision
 * (`details.storedRevision` says what it holds), `QUOTA_EXCEEDED` when it is full,
 * `STORAGE_FAILED` for anything else. Each operation stands alone: a store holds no handle a
 * caller must release.
 */
export interface SnapshotStore {
  /** What the store promises about its saves; frozen. */
  readonly guarantees: StoreGuarantees;
  /**
   * The snapshot stored under `key`, or null when there is none. Rejects with `INVALID_INPUT`
   * (naming `key`) for a blank key, and `STORAGE_FAILED` when what is stored is damaged.
   */
  load(key: string): Promise<StoredSnapshot | null>;
  /**
   * Stores a snapshot under its key, replacing what was there, and resolves with the
   * acknowledgement once it is stored as {@link StoreGuarantees} promise. A store with
   * compare-and-swap first checks that it holds `expectedRevision` (none, for null) and that
   * `revision` is not older than what it holds, refusing with `CONFLICT` otherwise. A save that
   * is refused or fails leaves what the store held as it was.
   */
  save(request: SaveRequest): Promise<SaveAck>;
  /** Every stored snapshot without its document, sorted by key; a new array on every call. */
  list(): Promise<SnapshotEntry[]>;
  /**
   * Removes the snapshot stored under `key`: only the store's record, nothing it describes is
   * touched, nor any other key. Resolves true when there was one, false when there was none.
   */
  delete(key: string): Promise<boolean>;
}

/** How a memory store is limited and stamped. */
export interface MemoryStoreOptions {
  /**
   * The most all stored documents may take together, in UTF-8 bytes: a positive whole number, or
   * `Infinity`. A save that would go over it is refused with `QUOTA_EXCEEDED`
   * (`details.bytes`, `details.limit`). Default: no limit.
   */
  readonly maxBytes?: number;
  /** The clock saves are stamped with, in milliseconds; a function. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * A store in memory, atomic and with compare-and-swap: for tests, for hosts that keep layouts
 * only for a session, and as the model other stores follow. Its snapshots live as long as the
 * store; there is nothing to close.
 *
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` naming `maxBytes` or `now` when either
 *   is invalid.
 */
export function createMemoryStore(options: MemoryStoreOptions = {}): SnapshotStore {
  const maxBytes = options.maxBytes ?? Infinity;
  if (!(maxBytes === Infinity || (Number.isSafeInteger(maxBytes) && maxBytes > 0))) {
    throw failure('INVALID_INPUT', 'maxBytes must be a positive whole number', 'maxBytes');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw failure('INVALID_INPUT', 'now must be a function', 'now');
  }
  return new MemoryStore(maxBytes, options.now ?? Date.now);
}

class MemoryStore implements SnapshotStore {
  readonly guarantees: StoreGuarantees = Object.freeze({ atomic: true, compareAndSwap: true });
  readonly #records = new Map<string, StoredSnapshot>();
  readonly #maxBytes: number;
  readonly #now: () => number;

  constructor(maxBytes: number, now: () => number) {
    this.#maxBytes = maxBytes;
    this.#now = now;
  }

  load(key: string): Promise<StoredSnapshot | null> {
    return attempt(() => this.#records.get(checkKey(key)) ?? null);
  }

  save(request: SaveRequest): Promise<SaveAck> {
    return attempt(() => {
      const raw: unknown = request;
      if (typeof raw !== 'object' || raw === null) {
        throw failure('INVALID_INPUT', 'a save request must be an object');
      }
      const key = checkKey(request.key);
      if (typeof request.document !== 'string') {
        throw failure('INVALID_INPUT', 'document must be JSON text', 'document');
      }
      const { revision, expectedRevision } = request;
      if (!isRevision(revision)) {
        throw failure('INVALID_INPUT', 'revision must be a whole number of at least 0', 'revision');
      }
      if (expectedRevision !== null && !isRevision(expectedRevision)) {
        throw failure(
          'INVALID_INPUT',
          'expectedRevision must be null or a whole number of at least 0',
          'expectedRevision',
        );
      }
      const stored = this.#records.get(key);
      const storedRevision = stored?.revision ?? null;
      if (storedRevision !== expectedRevision) {
        throw failure(
          'CONFLICT',
          `"${key}" holds ${storedRevision === null ? 'no snapshot' : `revision ${String(storedRevision)}`}, not ${expectedRevision === null ? 'none' : `revision ${String(expectedRevision)}`} as expected`,
          undefined,
          { storedRevision },
        );
      }
      if (storedRevision !== null && revision < storedRevision) {
        throw failure(
          'CONFLICT',
          `"${key}" holds revision ${String(storedRevision)}, newer than ${String(revision)}`,
          undefined,
          { storedRevision },
        );
      }
      const bytes = utf8Length(request.document);
      const used = [...this.#records.values()].reduce((sum, r) => sum + r.bytes, 0);
      const after = used - (stored?.bytes ?? 0) + bytes;
      if (after > this.#maxBytes) {
        throw failure(
          'QUOTA_EXCEEDED',
          `saving "${key}" would take ${String(after)} bytes, over the store's ${String(this.#maxBytes)}`,
          undefined,
          { bytes: after, limit: this.#maxBytes },
        );
      }
      // Every check is done: the record is replaced in one step.
      const record: StoredSnapshot = Object.freeze({
        key,
        revision,
        document: request.document,
        savedAt: this.#now(),
        bytes,
      });
      this.#records.set(key, record);
      return entryOf(record);
    });
  }

  list(): Promise<SnapshotEntry[]> {
    return attempt(() =>
      [...this.#records.values()]
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map(entryOf),
    );
  }

  delete(key: string): Promise<boolean> {
    return attempt(() => this.#records.delete(checkKey(key)));
  }
}

function entryOf(record: StoredSnapshot): SnapshotEntry {
  return Object.freeze({
    key: record.key,
    revision: record.revision,
    savedAt: record.savedAt,
    bytes: record.bytes,
  });
}

function checkKey(key: unknown): string {
  if (typeof key !== 'string' || key.trim() === '') {
    throw failure('INVALID_INPUT', 'a snapshot key must be a non-blank string', 'key');
  }
  return key;
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Runs `work` as an asynchronous store operation: a throw becomes a rejection. */
function attempt<T>(work: () => T): Promise<T> {
  try {
    return Promise.resolve(work());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}
