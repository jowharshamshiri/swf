import { failWith } from './release.js';
/**
 * A frame source whose frame boundaries come only when the test says, so frames are
 * deterministic: nothing is presented between two steps unless a step flushes.
 */
export class ManualFrames {
    #pending = [];
    /**
     * Holds `run` until the next {@link ManualFrames.flush}. Returns a function that drops it if it
     * has not run yet; safe to call twice.
     */
    request(run) {
        const entry = () => run();
        this.#pending.push(entry);
        return () => {
            const at = this.#pending.indexOf(entry);
            if (at >= 0) {
                this.#pending.splice(at, 1);
            }
        };
    }
    /**
     * Reaches a frame boundary: runs what was requested so far (not what that requests in turn),
     * every one even when one before it throws, and waits for all of them to finish. Resolves to how
     * many requests ran; rejects when one of them throws or rejects, with its failure, or with an
     * `AggregateError` holding each failure, in request order, when more than one fails.
     */
    async flush() {
        const due = this.#pending.splice(0);
        // A request that throws at once rejects like one that rejects: the others still run.
        const settled = await Promise.allSettled(due.map((run) => new Promise((resolve) => {
            resolve(run());
        })));
        const failed = settled.flatMap((s) => s.status === 'rejected' ? [{ error: s.reason }] : []);
        const [first, ...more] = failed;
        if (first !== undefined) {
            failWith(first.error, more);
        }
        return due.length;
    }
    /** Requests waiting for the next boundary. */
    get pending() {
        return this.#pending.length;
    }
}
//# sourceMappingURL=frames.js.map