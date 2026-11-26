import type { FrameSource } from '@swf/presentation';
/**
 * A frame source whose frame boundaries come only when the test says, so frames are
 * deterministic: nothing is presented between two steps unless a step flushes.
 */
export declare class ManualFrames implements FrameSource {
    #private;
    /**
     * Holds `run` until the next {@link ManualFrames.flush}. Returns a function that drops it if it
     * has not run yet; safe to call twice.
     */
    request(run: () => unknown): () => void;
    /**
     * Reaches a frame boundary: runs what was requested so far (not what that requests in turn),
     * every one even when one before it throws, and waits for all of them to finish. Resolves to how
     * many requests ran; rejects when one of them throws or rejects, with its failure, or with an
     * `AggregateError` holding each failure, in request order, when more than one fails.
     */
    flush(): Promise<number>;
    /** Requests waiting for the next boundary. */
    get pending(): number;
}
//# sourceMappingURL=frames.d.ts.map