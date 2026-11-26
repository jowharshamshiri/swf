import type { SnapshotStore } from './store.js';
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
/**
 * A store in Web Storage (`localStorage`), for layouts of a few megabytes. Each key has two
 * slots and a commit marker naming the slot that holds its last good snapshot. A save writes the
 * candidate into the other slot, reads it back, and only then rewrites the marker, in one write:
 * until that moment the last good snapshot stays the one that loads, so a save that fails or is
 * cut short (a full storage, a closed tab) never replaces it and never reports success. A save
 * whose marker write landed is committed and resolves, even when the call that wrote it threw. It
 * is atomic and compare-and-swap.
 *
 * Every operation reads and writes the storage directly, holding nothing open; the storage stays
 * the host's, and any call of it that throws rejects the operation with `STORAGE_FAILED` (or
 * `QUOTA_EXCEEDED` for a full storage). A damaged commit marker, or a slot that does not hold
 * what its marker describes, makes `load` (and `list`, for a marker) reject with
 * `STORAGE_FAILED`. `delete` removes the slot the marker does not name, then the marker, which
 * deletes the snapshot at once, then the slot it named. Letting go of a slot that no longer holds
 * the committed snapshot, after a save or a delete has taken effect, never fails it: a slot the
 * storage refuses to remove takes room until the key's next save writes over it. `list` skips
 * items under the prefix that the store did not write.
 *
 * @param storage - The storage, such as `localStorage`; it must have `getItem`, `setItem`,
 *   `removeItem` and `key`.
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` naming `prefix`, `now` or `storage`
 *   when one is invalid.
 */
export declare function createWebStorageStore(storage: WebStorage, options?: WebStorageStoreOptions): SnapshotStore;
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
    createObjectStore(name: string, options: {
        /** The record field the object store is keyed by. */
        keyPath: string;
    }): unknown;
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
export declare function createIndexedDbStore(factory: IdbFactory, options?: IndexedDbStoreOptions): SnapshotStore;
//# sourceMappingURL=browser.d.ts.map