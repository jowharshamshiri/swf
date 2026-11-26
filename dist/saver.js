import { makeError, SwfFailure } from '@swf/core';
import { failure } from './document.js';
import { models } from '@swf/models';
/**
 * Creates a saver of one workspace's snapshots to one store key, `clean` or `dirty` as
 * {@link SaverOptions.saved} says. The caller owns it and disposes it.
 *
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` naming `key` for a blank or missing key,
 *   or `saved` when it does not give a whole revision of at least 0 and a whole change count.
 *   `persistence` and `store` are used as given.
 */
export function createSaver(options) {
    if (typeof options.key !== 'string' || options.key.trim() === '') {
        throw failure('INVALID_INPUT', 'key must be a non-blank string', 'key');
    }
    const saved = options.saved;
    if (saved !== undefined &&
        !(Number.isSafeInteger(saved.revision) &&
            saved.revision >= 0 &&
            Number.isSafeInteger(saved.changes))) {
        throw failure('INVALID_INPUT', 'saved must give a revision and a change count', 'saved');
    }
    return new SaverImpl(options);
}
class SaverImpl {
    #persistence;
    #store;
    #key;
    #listeners = new Set();
    #diagnostics = [];
    /** The save machine (`Swf.Save`): every state, and what the store holds, is its decision. */
    #machine;
    #lastError = null;
    #queue = Promise.resolve();
    #unsubscribe;
    constructor(options) {
        this.#persistence = options.persistence;
        this.#store = options.store;
        this.#key = options.key;
        this.#machine = models.saveOpen(options.saved === undefined ? null : BigInt(options.saved.revision), options.saved === undefined ? null : BigInt(options.saved.changes), BigInt(this.#persistence.changes()));
        this.#unsubscribe = this.#persistence.subscribe(() => {
            this.#move(models.saveChanged(this.#machine, BigInt(this.#persistence.changes())));
        });
    }
    get state() {
        return this.#machine.state.kind;
    }
    get savedRevision() {
        const revision = this.#machine.savedRevision;
        return revision === null ? null : Number(revision);
    }
    get lastError() {
        return this.#lastError;
    }
    save() {
        const next = this.#queue.then(() => this.#save());
        this.#queue = next.catch(() => undefined);
        return next;
    }
    subscribe(listener) {
        const entry = (state) => {
            listener(state);
        };
        this.#listeners.add(entry);
        return () => {
            this.#listeners.delete(entry);
        };
    }
    getDiagnostics() {
        return Object.freeze([...this.#diagnostics]);
    }
    dispose() {
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        this.#listeners.clear();
    }
    async #save() {
        const begun = models.saveBegin(this.#machine, BigInt(this.#persistence.changes()));
        if (begun === null) {
            return Object.freeze({ status: 'unchanged' });
        }
        // The store is expected to hold the revision it acknowledged last.
        const expectedRevision = this.savedRevision;
        this.#move(begun);
        let answer;
        let ack = null;
        let capture = null;
        let failed = null;
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
        }
        catch (error) {
            failed = error;
            answer = { kind: 'failed' };
        }
        const end = models.saveEnd(this.#machine, BigInt(capture?.changes ?? this.#persistence.changes()), BigInt(this.#persistence.changes()), answer);
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
    #failure(error, refused, ack, capture) {
        if (refused !== null && ack !== null && capture !== null) {
            const revision = capture.document.revision;
            return failure('STORAGE_FAILED', refused.kind === 'mismatch'
                ? `the store acknowledged "${ack.key}" at revision ${String(ack.revision)}, not "${this.#key}" at ${String(revision)}`
                : `the store acknowledged revision ${String(ack.revision)}, older than the revision ${String(this.savedRevision)} it holds`).error;
        }
        return error instanceof SwfFailure
            ? error.error
            : makeError('STORAGE_FAILED', `saving "${this.#key}" failed: ${error instanceof Error ? error.message : String(error)}`, { retryable: true });
    }
    /** Puts the machine in the state the model decided, telling the listeners of a new state. */
    #move(next) {
        const changed = next.state.kind !== this.#machine.state.kind;
        this.#machine = next;
        if (!changed) {
            return;
        }
        const state = next.state.kind;
        for (const listener of [...this.#listeners]) {
            try {
                listener(state);
            }
            catch (error) {
                this.#diagnostics.push(`a listener threw while hearing of state ${state}: ${error instanceof Error ? error.message : String(error)}`);
                this.#diagnostics.splice(0, Math.max(0, this.#diagnostics.length - 100));
            }
        }
    }
}
//# sourceMappingURL=saver.js.map