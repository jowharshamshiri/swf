import type { SwfError } from '@swf/core';
import { SwfFailure } from '@swf/core';
import { failure, utf8Length } from './document.js';
import type {
  SaveAck,
  SaveRequest,
  SnapshotEntry,
  SnapshotStore,
  StoredSnapshot,
} from './store.js';

/**
 * The part of the Web Storage API (`localStorage`) the store uses. Declared here so the package
 * needs no DOM typings; a browser's `localStorage` is one.
 */
export interface WebStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface WebStorageStoreOptions {
  /** What every key the store writes starts with. Default `swf`. */
  readonly prefix?: string;
  /** The clock saves are stamped with, in milliseconds. Default `Date.now`. */
  readonly now?: () => number;
}

/** What says which slot holds a key's committed snapshot. */
interface Marker {
  readonly slot: 0 | 1;
  readonly revision: number;
  readonly savedAt: number;
  readonly bytes: number;
  /** The committed document's length in UTF-16 units, to tell a damaged slot. */
  readonly length: number;
}

/**
 * A store in Web Storage (`localStorage`), for layouts of a few megabytes. Each key has two
 * slots and a commit marker naming the slot that holds its last good snapshot. A save writes the
 * candidate into the other slot, reads it back, and only then rewrites the marker, in one write:
 * until that moment the last good snapshot stays the one that loads, so a save that fails or is
 * cut short (a full storage, a closed tab) never replaces it and never reports success. It is
 * atomic and compare-and-swap. Throws {@link SwfFailure} (`INVALID_INPUT`) for invalid options.
 */
export function createWebStorageStore(
  storage: WebStorage,
  options: WebStorageStoreOptions = {},
): SnapshotStore {
  const prefix = options.prefix ?? 'swf';
  if (typeof prefix !== 'string' || prefix.trim() === '' || prefix.includes('/')) {
    throw failure('INVALID_INPUT', 'prefix must be a non-blank string without "/"', 'prefix');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw failure('INVALID_INPUT', 'now must be a function', 'now');
  }
  for (const method of ['getItem', 'setItem', 'removeItem', 'key'] as const) {
    if (typeof (storage as Partial<WebStorage> | null)?.[method] !== 'function') {
      throw failure('INVALID_INPUT', `storage must implement ${method}()`, 'storage');
    }
  }
  return new WebStorageStore(storage, prefix, options.now ?? Date.now);
}

class WebStorageStore implements SnapshotStore {
  readonly guarantees = Object.freeze({ atomic: true, compareAndSwap: true });
  readonly #storage: WebStorage;
  readonly #prefix: string;
  readonly #now: () => number;

  constructor(storage: WebStorage, prefix: string, now: () => number) {
    this.#storage = storage;
    this.#prefix = prefix;
    this.#now = now;
  }

  load(key: string): Promise<StoredSnapshot | null> {
    return attempt(() => {
      const marker = this.#marker(checkKey(key));
      if (marker === null) {
        return null;
      }
      const document = this.#call(`loading "${key}"`, () =>
        this.#storage.getItem(this.#slotKey(key, marker.slot)),
      );
      if (document?.length !== marker.length) {
        throw failure(
          'STORAGE_FAILED',
          `the committed snapshot of "${key}" is damaged: its slot does not hold what its commit marker describes`,
        );
      }
      return Object.freeze({ ...entryOf(key, marker), document });
    });
  }

  save(request: SaveRequest): Promise<SaveAck> {
    return attempt(() => {
      const { key, document, revision } = checkRequest(request);
      const marker = this.#marker(key);
      checkExpected(key, marker?.revision ?? null, request.expectedRevision, revision);
      const slot: 0 | 1 = marker === null ? 0 : marker.slot === 0 ? 1 : 0;
      const candidate = this.#slotKey(key, slot);
      try {
        this.#call(`saving "${key}"`, () => {
          this.#storage.setItem(candidate, document);
        });
        if (this.#storage.getItem(candidate) !== document) {
          throw failure(
            'STORAGE_FAILED',
            `saving "${key}" failed: the storage did not keep the candidate as written`,
          );
        }
        const next: Marker = {
          slot,
          revision,
          savedAt: this.#now(),
          bytes: utf8Length(document),
          length: document.length,
        };
        // The commit: one write. Until it lands, the last good snapshot is the one that loads.
        this.#call(`committing "${key}"`, () => {
          this.#storage.setItem(this.#markerKey(key), JSON.stringify(next));
        });
        if (marker !== null) {
          this.#storage.removeItem(this.#slotKey(key, marker.slot));
        }
        return entryOf(key, next);
      } catch (error) {
        // The candidate never became the committed snapshot; it only takes room.
        if (this.#marker(key)?.slot !== slot) {
          this.#storage.removeItem(candidate);
        }
        throw error;
      }
    });
  }

  list(): Promise<SnapshotEntry[]> {
    return attempt(() => {
      const keys: string[] = [];
      for (let i = 0; i < this.#storage.length; i++) {
        const name = this.#storage.key(i);
        const match = name === null ? null : /^(.*)\/commit$/.exec(name);
        if (match?.[1] !== undefined && name?.startsWith(`${this.#prefix}/`) === true) {
          keys.push(decodeURIComponent(match[1].slice(this.#prefix.length + 1)));
        }
      }
      return keys.sort().flatMap((key) => {
        const marker = this.#marker(key);
        return marker === null ? [] : [entryOf(key, marker)];
      });
    });
  }

  delete(key: string): Promise<boolean> {
    return attempt(() => {
      const marker = this.#marker(checkKey(key));
      if (marker === null) {
        return false;
      }
      // Removing the marker deletes the snapshot at once; the slots are only room after that.
      this.#storage.removeItem(this.#markerKey(key));
      this.#storage.removeItem(this.#slotKey(key, 0));
      this.#storage.removeItem(this.#slotKey(key, 1));
      return true;
    });
  }

  #marker(key: string): Marker | null {
    const text = this.#call(`reading "${key}"`, () => this.#storage.getItem(this.#markerKey(key)));
    if (text === null) {
      return null;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = null;
    }
    const m = value as Partial<Marker> | null;
    if (
      (m?.slot !== 0 && m?.slot !== 1) ||
      !isWhole(m.revision) ||
      !isWhole(m.bytes) ||
      !isWhole(m.length) ||
      typeof m.savedAt !== 'number'
    ) {
      throw failure('STORAGE_FAILED', `the commit marker of "${key}" is damaged`);
    }
    return m as Marker;
  }

  #markerKey(key: string): string {
    return `${this.#prefix}/${encodeURIComponent(key)}/commit`;
  }

  #slotKey(key: string, slot: 0 | 1): string {
    return `${this.#prefix}/${encodeURIComponent(key)}/${String(slot)}`;
  }

  /** Runs a storage call, turning a full storage into `QUOTA_EXCEEDED`. */
  #call<T>(what: string, call: () => T): T {
    try {
      return call();
    } catch (error) {
      throw storageFailure(what, error);
    }
  }
}

// --- IndexedDB --------------------------------------------------------------------------------

/** A handler property of an IndexedDB object: the store sets it and never calls it. */
type Handler = ((this: never, event: never) => unknown) | null;

interface IdbError {
  readonly name: string;
  readonly message: string;
}

interface IdbRequest<T> {
  readonly result: T;
  readonly error: IdbError | null;
  onsuccess: Handler;
  onerror: Handler;
}

interface IdbObjectStore {
  get(key: string): IdbRequest<unknown>;
  put(value: unknown): IdbRequest<unknown>;
  delete(key: string): IdbRequest<unknown>;
  getAll(): IdbRequest<unknown[]>;
}

interface IdbTransaction {
  readonly error: IdbError | null;
  objectStore(name: string): IdbObjectStore;
  abort(): void;
  oncomplete: Handler;
  onerror: Handler;
  onabort: Handler;
}

interface IdbDatabase {
  readonly objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options: { keyPath: string }): unknown;
  transaction(store: string, mode: 'readonly' | 'readwrite'): IdbTransaction;
  close(): void;
}

interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
  onupgradeneeded: Handler;
  onblocked: Handler;
}

/**
 * The part of the IndexedDB API the store uses. Declared here so the package needs no DOM
 * typings; a browser's `indexedDB` is one.
 */
export interface IdbFactory {
  open(name: string, version: number): IdbOpenRequest;
}

export interface IndexedDbStoreOptions {
  /** The database the store keeps its snapshots in. Default `swf`. */
  readonly database?: string;
  /** The clock saves are stamped with, in milliseconds. Default `Date.now`. */
  readonly now?: () => number;
}

const SNAPSHOTS = 'snapshots';

/**
 * A store in IndexedDB, for large layouts. Each save checks the stored revision and writes the
 * new snapshot in one transaction, so it is atomic and compare-and-swap: a save that fails or is
 * cut short (a full disk, a closed tab) leaves the last good snapshot stored and never reports
 * success. Throws {@link SwfFailure} (`INVALID_INPUT`) for invalid options.
 */
export function createIndexedDbStore(
  factory: IdbFactory,
  options: IndexedDbStoreOptions = {},
): SnapshotStore {
  const database = options.database ?? 'swf';
  if (typeof database !== 'string' || database.trim() === '') {
    throw failure('INVALID_INPUT', 'database must be a non-blank string', 'database');
  }
  if (typeof (factory as Partial<IdbFactory> | null)?.open !== 'function') {
    throw failure('INVALID_INPUT', 'factory must be an IndexedDB factory with open()', 'factory');
  }
  if (options.now !== undefined && typeof options.now !== 'function') {
    throw failure('INVALID_INPUT', 'now must be a function', 'now');
  }
  return new IndexedDbStore(factory, database, options.now ?? Date.now);
}

class IndexedDbStore implements SnapshotStore {
  readonly guarantees = Object.freeze({ atomic: true, compareAndSwap: true });
  readonly #factory: IdbFactory;
  readonly #database: string;
  readonly #now: () => number;

  constructor(factory: IdbFactory, database: string, now: () => number) {
    this.#factory = factory;
    this.#database = database;
    this.#now = now;
  }

  async load(key: string): Promise<StoredSnapshot | null> {
    checkKey(key);
    const found = await this.#transact('readonly', `loading "${key}"`, (store) =>
      request(store.get(key)),
    );
    return found === undefined ? null : recordOf(found, key);
  }

  async save(input: SaveRequest): Promise<SaveAck> {
    const { key, document, revision } = checkRequest(input);
    return this.#transact('readwrite', `saving "${key}"`, async (store, transaction) => {
      const found = await request(store.get(key));
      const stored = found === undefined ? null : recordOf(found, key);
      try {
        checkExpected(key, stored?.revision ?? null, input.expectedRevision, revision);
      } catch (error) {
        transaction.abort();
        throw error;
      }
      const record: StoredSnapshot = Object.freeze({
        key,
        revision,
        document,
        savedAt: this.#now(),
        bytes: utf8Length(document),
      });
      await request(store.put(record));
      return entryOf(key, record);
    });
  }

  async list(): Promise<SnapshotEntry[]> {
    const all = await this.#transact('readonly', 'listing', (store) => request(store.getAll()));
    return all
      .map((value) => recordOf(value, (value as { key?: unknown } | null)?.key))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((r) => entryOf(r.key, r));
  }

  async delete(key: string): Promise<boolean> {
    checkKey(key);
    return this.#transact('readwrite', `deleting "${key}"`, async (store) => {
      const found = await request(store.get(key));
      if (found === undefined) {
        return false;
      }
      await request(store.delete(key));
      return true;
    });
  }

  /**
   * Runs `work` in one transaction and resolves with its result only once the transaction has
   * committed: a transaction that aborts or fails rejects, whatever `work` returned.
   */
  async #transact<T>(
    mode: 'readonly' | 'readwrite',
    what: string,
    work: (store: IdbObjectStore, transaction: IdbTransaction) => Promise<T>,
  ): Promise<T> {
    const db = await this.#open(what);
    try {
      let transaction: IdbTransaction;
      try {
        transaction = db.transaction(SNAPSHOTS, mode);
      } catch (error) {
        throw storageFailure(what, error);
      }
      const settled = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => {
          resolve();
        };
        const fail = () => {
          reject(
            storageFailure(what, transaction.error ?? new Error('the transaction was aborted')),
          );
        };
        transaction.onerror = fail;
        transaction.onabort = fail;
      });
      let result: T;
      try {
        result = await work(transaction.objectStore(SNAPSHOTS), transaction);
      } catch (error) {
        settled.catch(() => undefined);
        throw error instanceof SwfFailure ? error : storageFailure(what, error);
      }
      await settled;
      return result;
    } finally {
      db.close();
    }
  }

  #open(what: string): Promise<IdbDatabase> {
    return new Promise((resolve, reject) => {
      let open: IdbOpenRequest;
      try {
        open = this.#factory.open(this.#database, 1);
      } catch (error) {
        reject(storageFailure(what, error));
        return;
      }
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(SNAPSHOTS)) {
          db.createObjectStore(SNAPSHOTS, { keyPath: 'key' });
        }
      };
      open.onsuccess = () => {
        resolve(open.result);
      };
      open.onerror = () => {
        reject(storageFailure(what, open.error ?? new Error('the database could not be opened')));
      };
      open.onblocked = () => {
        reject(
          failure(
            'STORAGE_FAILED',
            `${what} failed: the database "${this.#database}" is held open by an older version`,
          ),
        );
      };
    });
  }
}

/** A request's result, once it succeeds. */
function request<T>(req: IdbRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(new Error(req.error?.message ?? 'the request failed'));
    };
  });
}

/** A stored record, checked: IndexedDB content can be changed by anyone with the origin. */
function recordOf(value: unknown, key: unknown): StoredSnapshot {
  const r = value as Partial<StoredSnapshot> | null;
  if (
    typeof r?.key !== 'string' ||
    r.key !== key ||
    !isWhole(r.revision) ||
    typeof r.document !== 'string' ||
    typeof r.savedAt !== 'number' ||
    r.bytes !== utf8Length(r.document)
  ) {
    throw failure('STORAGE_FAILED', `the stored snapshot of ${JSON.stringify(key)} is damaged`);
  }
  return Object.freeze({
    key: r.key,
    revision: r.revision,
    document: r.document,
    savedAt: r.savedAt,
    bytes: r.bytes,
  });
}

// --- shared -------------------------------------------------------------------------------------

function entryOf(
  key: string,
  r: { readonly revision: number; readonly savedAt: number; readonly bytes: number },
): SnapshotEntry {
  return Object.freeze({ key, revision: r.revision, savedAt: r.savedAt, bytes: r.bytes });
}

function checkKey(key: unknown): string {
  if (typeof key !== 'string' || key.trim() === '') {
    throw failure('INVALID_INPUT', 'a snapshot key must be a non-blank string', 'key');
  }
  return key;
}

function checkRequest(request: SaveRequest): SaveRequest {
  const raw: unknown = request;
  if (typeof raw !== 'object' || raw === null) {
    throw failure('INVALID_INPUT', 'a save request must be an object');
  }
  checkKey(request.key);
  if (typeof request.document !== 'string') {
    throw failure('INVALID_INPUT', 'document must be JSON text', 'document');
  }
  if (!isWhole(request.revision)) {
    throw failure('INVALID_INPUT', 'revision must be a whole number of at least 0', 'revision');
  }
  if (request.expectedRevision !== null && !isWhole(request.expectedRevision)) {
    throw failure(
      'INVALID_INPUT',
      'expectedRevision must be null or a whole number of at least 0',
      'expectedRevision',
    );
  }
  return request;
}

/** Refuses a save whose expectation is stale or whose revision is older than the stored one. */
function checkExpected(
  key: string,
  stored: number | null,
  expected: number | null,
  revision: number,
): void {
  if (stored !== expected) {
    throw failure(
      'CONFLICT',
      `"${key}" holds ${stored === null ? 'no snapshot' : `revision ${String(stored)}`}, not ${expected === null ? 'none' : `revision ${String(expected)}`} as expected`,
      undefined,
      { storedRevision: stored },
    );
  }
  if (stored !== null && revision < stored) {
    throw failure(
      'CONFLICT',
      `"${key}" holds revision ${String(stored)}, newer than ${String(revision)}`,
      undefined,
      { storedRevision: stored },
    );
  }
}

/** A platform failure as a typed one: a full storage is `QUOTA_EXCEEDED`. */
function storageFailure(what: string, error: unknown): SwfFailure {
  if (error instanceof SwfFailure) {
    return error;
  }
  const name = (error as { name?: unknown } | null)?.name;
  const message = error instanceof Error ? error.message : String(error);
  const full = name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
  const typed: SwfError = {
    ...failure(
      full ? 'QUOTA_EXCEEDED' : 'STORAGE_FAILED',
      `${what} failed: ${full ? 'the storage is full' : message}`,
      undefined,
      { reason: message },
    ).error,
    retryable: !full,
  };
  return new SwfFailure(typed);
}

function isWhole(value: unknown): value is number {
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
