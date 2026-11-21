import { failure, utf8Length } from './document.js';

/** A snapshot as a store holds it: its JSON text and the workspace revision it was taken at. */
export interface StoredSnapshot {
  readonly key: string;
  readonly revision: number;
  readonly document: string;
  readonly savedAt: number;
  /** The document's UTF-8 size. */
  readonly bytes: number;
}

/** A stored snapshot without its document. */
export type SnapshotEntry = Omit<StoredSnapshot, 'document'>;

export interface SaveRequest {
  readonly key: string;
  /** The snapshot's JSON text. */
  readonly document: string;
  /** The workspace revision the snapshot was taken at. */
  readonly revision: number;
  /**
   * The revision the caller last saw stored under `key`, or null when it saw none. A store with
   * compare-and-swap refuses the save when what it holds differs.
   */
  readonly expectedRevision: number | null;
}

/** A store's acknowledgement that a save is stored as its guarantees promise. */
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
 * {@link SwfFailure}: `CONFLICT` for a stale expectation or a newer stored revision,
 * `QUOTA_EXCEEDED` when it is full, `STORAGE_FAILED` for anything else.
 */
export interface SnapshotStore {
  readonly guarantees: StoreGuarantees;
  load(key: string): Promise<StoredSnapshot | null>;
  save(request: SaveRequest): Promise<SaveAck>;
  /** Every stored snapshot, by key. */
  list(): Promise<SnapshotEntry[]>;
  /** Removes one stored snapshot (only the store's record: nothing it describes is touched). */
  delete(key: string): Promise<boolean>;
}

export interface MemoryStoreOptions {
  /** The most all stored documents may take, in UTF-8 bytes. Default: no limit. */
  readonly maxBytes?: number;
  /** The clock saves are stamped with, in milliseconds. Default `Date.now`. */
  readonly now?: () => number;
}

/**
 * A store in memory, atomic and with compare-and-swap: for tests, for hosts that keep layouts
 * only for a session, and as the model other stores follow. Throws {@link SwfFailure}
 * (`INVALID_INPUT`) for invalid options.
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
