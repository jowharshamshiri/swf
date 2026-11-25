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
  /** How many items the storage holds; read by {@link SnapshotStore.list}. */
  readonly length: number;
  /** The name of the item at `index`, or null past the end. */
  key(index: number): string | null;
  /** The item stored under `key`, or null when there is none. */
  getItem(key: string): string | null;
  /**
   * Stores `value` under `key`. A throw named `QuotaExceededError` (or
   * `NS_ERROR_DOM_QUOTA_REACHED`) is reported as `QUOTA_EXCEEDED`, any other as `STORAGE_FAILED`.
   */
  setItem(key: string, value: string): void;
  /** Removes the item stored under `key`, if any. */
  removeItem(key: string): void;
}

/** Where a Web Storage store keeps its items, and how it stamps saves. */
export interface WebStorageStoreOptions {
  /**
   * What every item the store writes starts with: a non-blank string without `/`. Default `swf`.
   * A snapshot under key `k` takes the items `<prefix>/<k>/commit`, `<prefix>/<k>/0` and
   * `<prefix>/<k>/1`, with `k` URI-encoded; the store never touches other items.
   */
  readonly prefix?: string;
  /** The clock saves are stamped with, in milliseconds; a function. Default `Date.now`. */
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
 * atomic and compare-and-swap.
 *
 * Every operation reads and writes the storage directly, holding nothing open; the storage stays
 * the host's. A damaged commit marker, or a slot that does not hold what its marker describes,
 * makes `load` (and `list`, for a marker) reject with `STORAGE_FAILED`. `delete` removes the
 * marker first, which deletes the snapshot at once, then both slots.
 *
 * @param storage - The storage, such as `localStorage`; it must have `getItem`, `setItem`,
 *   `removeItem` and `key`.
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` naming `prefix`, `now` or `storage`
 *   when one is invalid.
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

/**
 * A handler property of an IndexedDB object (`onsuccess`, `onerror`, …): the store sets it, the
 * platform calls it, and the store never calls it itself. Null when none is set.
 */
export type Handler = ((this: never, event: never) => unknown) | null;

/** The part of a `DOMException` the store reads from a failed IndexedDB request or transaction. */
export interface IdbError {
  /** The exception's name; `QuotaExceededError` is reported as `QUOTA_EXCEEDED`. */
  readonly name: string;
  /** What went wrong, quoted in the store's error message. */
  readonly message: string;
}

/** The part of an `IDBRequest` the store uses: it sets the handlers and reads the outcome. */
export interface IdbRequest<T> {
  /** What the request produced, read once `onsuccess` is called. */
  readonly result: T;
  /** Why the request failed, read once `onerror` is called; null when there is no reason. */
  readonly error: IdbError | null;
  /** Called when the request succeeds. */
  onsuccess: Handler;
  /** Called when the request fails. */
  onerror: Handler;
}

/** The part of an `IDBObjectStore` the store uses, on its `snapshots` object store. */
export interface IdbObjectStore {
  /** Reads the record with this key; its result is undefined when there is none. */
  get(key: string): IdbRequest<unknown>;
  /** Writes a record, replacing the one with the same `key`. */
  put(value: unknown): IdbRequest<unknown>;
  /** Removes the record with this key. */
  delete(key: string): IdbRequest<unknown>;
  /** Reads every record. */
  getAll(): IdbRequest<unknown[]>;
}

/** The part of an `IDBTransaction` the store uses: one per store operation. */
export interface IdbTransaction {
  /** Why the transaction failed or was aborted, or null. */
  readonly error: IdbError | null;
  /** The object store of this name, within the transaction. */
  objectStore(name: string): IdbObjectStore;
  /** Abandons the transaction, leaving the database as it was; used to refuse a save. */
  abort(): void;
  /** Called when the transaction has committed; only then does an operation resolve. */
  oncomplete: Handler;
  /** Called when the transaction fails. */
  onerror: Handler;
  /** Called when the transaction is aborted. */
  onabort: Handler;
}

/** The part of an `IDBDatabase` the store uses. */
export interface IdbDatabase {
  /** The names of the database's object stores. */
  readonly objectStoreNames: {
    /** Whether the database has an object store of this name. */
    contains(name: string): boolean;
  };
  /** Creates an object store, during an upgrade; the store creates `snapshots` keyed by `key`. */
  createObjectStore(
    name: string,
    options: {
      /** The record field the object store is keyed by. */
      keyPath: string;
    },
  ): unknown;
  /** Starts a transaction on one object store. */
  transaction(store: string, mode: 'readonly' | 'readwrite'): IdbTransaction;
  /** Closes the connection; the store closes it after every operation. */
  close(): void;
}

/** The part of an `IDBOpenDBRequest` the store uses; its result is the opened database. */
export interface IdbOpenRequest extends IdbRequest<IdbDatabase> {
  /** Called when the database is new or older than version 1; the store adds its object store. */
  onupgradeneeded: Handler;
  /**
   * Called when another connection holds an older version open; the operation then fails with
   * `STORAGE_FAILED`.
   */
  onblocked: Handler;
}

/**
 * The part of the IndexedDB API the store uses. Declared here so the package needs no DOM
 * typings; a browser's `indexedDB` is one.
 */
export interface IdbFactory {
  /** Opens the database `name` at `version`; the store always asks for version 1. */
  open(name: string, version: number): IdbOpenRequest;
}

/** Which IndexedDB database a store keeps its snapshots in, and how it stamps saves. */
export interface IndexedDbStoreOptions {
  /**
   * The database the store keeps its snapshots in, in an object store named `snapshots`: a
   * non-blank string. Default `swf`.
   */
  readonly database?: string;
  /** The clock saves are stamped with, in milliseconds; a function. Default `Date.now`. */
  readonly now?: () => number;
}

const SNAPSHOTS = 'snapshots';

/**
 * A store in IndexedDB, for large layouts. Each save checks the stored revision and writes the
 * new snapshot in one transaction, so it is atomic and compare-and-swap: a save that fails or is
 * cut short (a full disk, a closed tab) leaves the last good snapshot stored and never reports
 * success.
 *
 * Each operation opens the database, runs one transaction and closes it again, resolving only
 * once the transaction has committed; nothing stays open between operations. Records are checked
 * as they are read, since anyone with the origin can change them: a damaged one makes `load`
 * and `list` reject with `STORAGE_FAILED`. A database held open at an older version by another
 * connection fails the operation with `STORAGE_FAILED`.
 *
 * @param factory - The IndexedDB factory, such as `indexedDB`; it must have `open`.
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` naming `database`, `factory` or `now`
 *   when one is invalid.
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
