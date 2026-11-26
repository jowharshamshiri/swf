import { failure, utf8Length } from './document.js';
/**
 * A store in memory, atomic and with compare-and-swap: for tests, for hosts that keep layouts
 * only for a session, and as the model other stores follow. Its snapshots live as long as the
 * store; there is nothing to close.
 *
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` naming `maxBytes` or `now` when either
 *   is invalid.
 */
export function createMemoryStore(options = {}) {
    const maxBytes = options.maxBytes ?? Infinity;
    if (!(maxBytes === Infinity || (Number.isSafeInteger(maxBytes) && maxBytes > 0))) {
        throw failure('INVALID_INPUT', 'maxBytes must be a positive whole number', 'maxBytes');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
        throw failure('INVALID_INPUT', 'now must be a function', 'now');
    }
    return new MemoryStore(maxBytes, options.now ?? Date.now);
}
class MemoryStore {
    guarantees = Object.freeze({ atomic: true, compareAndSwap: true });
    #records = new Map();
    #maxBytes;
    #now;
    constructor(maxBytes, now) {
        this.#maxBytes = maxBytes;
        this.#now = now;
    }
    load(key) {
        return attempt(() => this.#records.get(checkKey(key)) ?? null);
    }
    save(request) {
        return attempt(() => {
            const raw = request;
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
                throw failure('INVALID_INPUT', 'expectedRevision must be null or a whole number of at least 0', 'expectedRevision');
            }
            const stored = this.#records.get(key);
            const storedRevision = stored?.revision ?? null;
            if (storedRevision !== expectedRevision) {
                throw failure('CONFLICT', `"${key}" holds ${storedRevision === null ? 'no snapshot' : `revision ${String(storedRevision)}`}, not ${expectedRevision === null ? 'none' : `revision ${String(expectedRevision)}`} as expected`, undefined, { storedRevision });
            }
            if (storedRevision !== null && revision < storedRevision) {
                throw failure('CONFLICT', `"${key}" holds revision ${String(storedRevision)}, newer than ${String(revision)}`, undefined, { storedRevision });
            }
            const bytes = utf8Length(request.document);
            const used = [...this.#records.values()].reduce((sum, r) => sum + r.bytes, 0);
            const after = used - (stored?.bytes ?? 0) + bytes;
            if (after > this.#maxBytes) {
                throw failure('QUOTA_EXCEEDED', `saving "${key}" would take ${String(after)} bytes, over the store's ${String(this.#maxBytes)}`, undefined, { bytes: after, limit: this.#maxBytes });
            }
            // Every check is done: the record is replaced in one step.
            const record = Object.freeze({
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
    list() {
        return attempt(() => [...this.#records.values()]
            .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
            .map(entryOf));
    }
    delete(key) {
        return attempt(() => this.#records.delete(checkKey(key)));
    }
}
function entryOf(record) {
    return Object.freeze({
        key: record.key,
        revision: record.revision,
        savedAt: record.savedAt,
        bytes: record.bytes,
    });
}
function checkKey(key) {
    if (typeof key !== 'string' || key.trim() === '') {
        throw failure('INVALID_INPUT', 'a snapshot key must be a non-blank string', 'key');
    }
    return key;
}
function isRevision(value) {
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
//# sourceMappingURL=store.js.map