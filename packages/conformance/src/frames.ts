import type { FrameSource } from '@swf/presentation';

/**
 * A frame source whose frame boundaries come only when the test says, so frames are
 * deterministic: nothing is presented between two steps unless a step flushes.
 */
export class ManualFrames implements FrameSource {
  readonly #pending: (() => unknown)[] = [];

  request(run: () => unknown): () => void {
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
   * Reaches a frame boundary: runs what was requested so far (not what that requests in turn)
   * and waits for it to finish. Returns how many requests ran.
   */
  async flush(): Promise<number> {
    const due = this.#pending.splice(0);
    await Promise.all(due.map((run) => run()));
    return due.length;
  }

  /** Requests waiting for the next boundary. */
  get pending(): number {
    return this.#pending.length;
  }
}
