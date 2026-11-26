import { SwfFailure } from '@swf/core';
import { failure, utf8Length } from './document.js';
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
export function createWebStorageStore(storage, options = {}) {
    const prefix = options.prefix ?? 'swf';
    if (typeof prefix !== 'string' || prefix.trim() === '' || prefix.includes('/')) {
        throw failure('INVALID_INPUT', 'prefix must be a non-blank string without "/"', 'prefix');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
        throw failure('INVALID_INPUT', 'now must be a function', 'now');
    }
    for (const method of ['getItem', 'setItem', 'removeItem', 'key']) {
        if (typeof storage?.[method] !== 'function') {
            throw failure('INVALID_INPUT', `storage must implement ${method}()`, 'storage');
        }
    }
    return new WebStorageStore(storage, prefix, options.now ?? Date.now);
}
class WebStorageStore {
    guarantees = Object.freeze({ atomic: true, compareAndSwap: true });
    #storage;
    #prefix;
    #now;
    constructor(storage, prefix, now) {
        this.#storage = storage;
        this.#prefix = prefix;
        this.#now = now;
    }
    load(key) {
        return attempt(() => {
            const marker = this.#marker(checkKey(key));
            if (marker === null) {
                return null;
            }
            const document = this.#call(`loading "${key}"`, () => this.#storage.getItem(this.#slotKey(key, marker.slot)));
            if (document?.length !== marker.length) {
                throw failure('STORAGE_FAILED', `the committed snapshot of "${key}" is damaged: its slot does not hold what its commit marker describes`);
            }
            return Object.freeze({ ...entryOf(key, marker), document });
        });
    }
    save(request) {
        return attempt(() => {
            const { key, document, revision } = checkRequest(request);
            const marker = this.#marker(key);
            checkExpected(key, marker?.revision ?? null, request.expectedRevision, revision);
            const slot = marker === null ? 0 : marker.slot === 0 ? 1 : 0;
            const candidate = this.#slotKey(key, slot);
            const next = {
                slot,
                revision,
                savedAt: this.#now(),
                bytes: utf8Length(document),
                length: document.length,
            };
            const committed = JSON.stringify(next);
            try {
                this.#call(`saving "${key}"`, () => {
                    this.#storage.setItem(candidate, document);
                    if (this.#storage.getItem(candidate) !== document) {
                        throw failure('STORAGE_FAILED', `saving "${key}" failed: the storage did not keep the candidate as written`);
                    }
                });
            }
            catch (error) {
                // The candidate never became the committed snapshot; it only takes room.
                this.#letGo(candidate);
                throw error;
            }
            // The commit: one write. Until it lands, the last good snapshot is the one that loads.
            try {
                this.#call(`committing "${key}"`, () => {
                    this.#storage.setItem(this.#markerKey(key), committed);
                });
            }
            catch (error) {
                // A write that throws may still have landed: what the marker holds decides. When it
                // cannot be read, the candidate is kept, since it may be the committed snapshot.
                let landed;
                try {
                    landed = this.#storage.getItem(this.#markerKey(key)) === committed;
                }
                catch {
                    landed = null;
                }
                if (landed !== true) {
                    if (landed === false) {
                        this.#letGo(candidate);
                    }
                    throw error;
                }
            }
            // Committed: letting go of the old slot only frees room, and the next save writes over it.
            if (marker !== null) {
                this.#letGo(this.#slotKey(key, marker.slot));
            }
            return entryOf(key, next);
        });
    }
    list() {
        return attempt(() => {
            const names = this.#call('listing', () => {
                const all = [];
                for (let i = 0; i < this.#storage.length; i++) {
                    all.push(this.#storage.key(i));
                }
                return all;
            });
            const keys = [];
            for (const name of names) {
                const key = name === null ? null : this.#keyOfMarker(name);
                if (key !== null) {
                    keys.push(key);
                }
            }
            return keys.sort().flatMap((key) => {
                const marker = this.#marker(key);
                return marker === null ? [] : [entryOf(key, marker)];
            });
        });
    }
    delete(key) {
        return attempt(() => {
            const marker = this.#marker(checkKey(key));
            if (marker === null) {
                return false;
            }
            this.#call(`deleting "${key}"`, () => {
                // The slot the marker does not name holds nothing of the snapshot.
                this.#storage.removeItem(this.#slotKey(key, marker.slot === 0 ? 1 : 0));
                // Removing the marker deletes the snapshot at once.
                this.#storage.removeItem(this.#markerKey(key));
            });
            // Deleted: letting go of its slot only frees room, and the key's next saves write over it.
            this.#letGo(this.#slotKey(key, marker.slot));
            return true;
        });
    }
    /**
     * The snapshot key a commit marker's item name stands for, or null for an item this store did
     * not write: another prefix, not a marker, or a key not encoded as the store encodes it.
     */
    #keyOfMarker(name) {
        const encoded = /^(.*)\/commit$/.exec(name)?.[1];
        if (encoded === undefined || !name.startsWith(`${this.#prefix}/`)) {
            return null;
        }
        const part = encoded.slice(this.#prefix.length + 1);
        let key;
        try {
            key = decodeURIComponent(part);
        }
        catch {
            return null;
        }
        return encodeURIComponent(key) === part ? key : null;
    }
    /**
     * Removes an item that holds no committed snapshot, to free its room. A storage that refuses
     * leaves it taking room until the key's next save writes over it; what the operation did
     * stands either way.
     */
    #letGo(item) {
        try {
            this.#storage.removeItem(item);
        }
        catch {
            // The room stays taken until the slot is written over; nothing the store holds is wrong.
        }
    }
    #marker(key) {
        const text = this.#call(`reading "${key}"`, () => this.#storage.getItem(this.#markerKey(key)));
        if (text === null) {
            return null;
        }
        let value;
        try {
            value = JSON.parse(text);
        }
        catch {
            value = null;
        }
        const m = value;
        if ((m?.slot !== 0 && m?.slot !== 1) ||
            !isWhole(m.revision) ||
            !isWhole(m.bytes) ||
            !isWhole(m.length) ||
            typeof m.savedAt !== 'number') {
            throw failure('STORAGE_FAILED', `the commit marker of "${key}" is damaged`);
        }
        return m;
    }
    #markerKey(key) {
        return `${this.#prefix}/${encodeURIComponent(key)}/commit`;
    }
    #slotKey(key, slot) {
        return `${this.#prefix}/${encodeURIComponent(key)}/${String(slot)}`;
    }
    /** Runs a storage call, turning a full storage into `QUOTA_EXCEEDED`. */
    #call(what, call) {
        try {
            return call();
        }
        catch (error) {
            throw storageFailure(what, error);
        }
    }
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
export function createIndexedDbStore(factory, options = {}) {
    const database = options.database ?? 'swf';
    if (typeof database !== 'string' || database.trim() === '') {
        throw failure('INVALID_INPUT', 'database must be a non-blank string', 'database');
    }
    if (typeof factory?.open !== 'function') {
        throw failure('INVALID_INPUT', 'factory must be an IndexedDB factory with open()', 'factory');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
        throw failure('INVALID_INPUT', 'now must be a function', 'now');
    }
    return new IndexedDbStore(factory, database, options.now ?? Date.now);
}
class IndexedDbStore {
    guarantees = Object.freeze({ atomic: true, compareAndSwap: true });
    #factory;
    #database;
    #now;
    constructor(factory, database, now) {
        this.#factory = factory;
        this.#database = database;
        this.#now = now;
    }
    async load(key) {
        checkKey(key);
        const found = await this.#transact('readonly', `loading "${key}"`, (store) => request(store.get(key)));
        return found === undefined ? null : recordOf(found, key);
    }
    async save(input) {
        const { key, document, revision } = checkRequest(input);
        return this.#transact('readwrite', `saving "${key}"`, async (store, transaction) => {
            const found = await request(store.get(key));
            const stored = found === undefined ? null : recordOf(found, key);
            try {
                checkExpected(key, stored?.revision ?? null, input.expectedRevision, revision);
            }
            catch (error) {
                transaction.abort();
                throw error;
            }
            const record = Object.freeze({
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
    async list() {
        const all = await this.#transact('readonly', 'listing', (store) => request(store.getAll()));
        return all
            .map((value) => recordOf(value, value?.key))
            .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
            .map((r) => entryOf(r.key, r));
    }
    async delete(key) {
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
    async #transact(mode, what, work) {
        const db = await this.#open(what);
        try {
            let transaction;
            try {
                transaction = db.transaction(SNAPSHOTS, mode);
            }
            catch (error) {
                throw storageFailure(what, error);
            }
            const settled = new Promise((resolve, reject) => {
                transaction.oncomplete = () => {
                    resolve();
                };
                const fail = () => {
                    reject(storageFailure(what, transaction.error ?? new Error('the transaction was aborted')));
                };
                transaction.onerror = fail;
                transaction.onabort = fail;
            });
            let result;
            try {
                result = await work(transaction.objectStore(SNAPSHOTS), transaction);
            }
            catch (error) {
                settled.catch(() => undefined);
                throw error instanceof SwfFailure ? error : storageFailure(what, error);
            }
            await settled;
            return result;
        }
        finally {
            db.close();
        }
    }
    #open(what) {
        return new Promise((resolve, reject) => {
            let open;
            try {
                open = this.#factory.open(this.#database, 1);
            }
            catch (error) {
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
                reject(failure('STORAGE_FAILED', `${what} failed: the database "${this.#database}" is held open by an older version`));
            };
        });
    }
}
/** A request's result, once it succeeds. */
function request(req) {
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
function recordOf(value, key) {
    const r = value;
    if (typeof r?.key !== 'string' ||
        r.key !== key ||
        !isWhole(r.revision) ||
        typeof r.document !== 'string' ||
        typeof r.savedAt !== 'number' ||
        r.bytes !== utf8Length(r.document)) {
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
function entryOf(key, r) {
    return Object.freeze({ key, revision: r.revision, savedAt: r.savedAt, bytes: r.bytes });
}
function checkKey(key) {
    if (typeof key !== 'string' || key.trim() === '') {
        throw failure('INVALID_INPUT', 'a snapshot key must be a non-blank string', 'key');
    }
    return key;
}
function checkRequest(request) {
    const raw = request;
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
        throw failure('INVALID_INPUT', 'expectedRevision must be null or a whole number of at least 0', 'expectedRevision');
    }
    return request;
}
/** Refuses a save whose expectation is stale or whose revision is older than the stored one. */
function checkExpected(key, stored, expected, revision) {
    if (stored !== expected) {
        throw failure('CONFLICT', `"${key}" holds ${stored === null ? 'no snapshot' : `revision ${String(stored)}`}, not ${expected === null ? 'none' : `revision ${String(expected)}`} as expected`, undefined, { storedRevision: stored });
    }
    if (stored !== null && revision < stored) {
        throw failure('CONFLICT', `"${key}" holds revision ${String(stored)}, newer than ${String(revision)}`, undefined, { storedRevision: stored });
    }
}
/** A platform failure as a typed one: a full storage is `QUOTA_EXCEEDED`. */
function storageFailure(what, error) {
    if (error instanceof SwfFailure) {
        return error;
    }
    const name = error?.name;
    const message = error instanceof Error ? error.message : String(error);
    const full = name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
    const typed = {
        ...failure(full ? 'QUOTA_EXCEEDED' : 'STORAGE_FAILED', `${what} failed: ${full ? 'the storage is full' : message}`, undefined, { reason: message }).error,
        retryable: !full,
    };
    return new SwfFailure(typed);
}
function isWhole(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
/** Runs `work` as an asynchronous store operation: a throw becomes a rejection. */
function attempt(work) {
    try {
        return Promise.resolve(work());
    }
    catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
}
//# sourceMappingURL=browser.js.map