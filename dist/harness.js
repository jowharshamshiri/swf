/** Thrown by a conformance case whose expectation does not hold. */
export class ConformanceFailure extends Error {
    /** A failure saying which expectation did not hold; its `name` is `ConformanceFailure`. */
    constructor(message) {
        super(message);
        this.name = 'ConformanceFailure';
    }
}
/**
 * Runs cases one after another, in order, reporting each; a case that throws has failed, and the
 * rest still run. It never rejects.
 *
 * @returns One result per case, in the cases' order.
 *
 * @example
 * ```ts
 * const fixture = {
 *   renderer: () => new MyRenderer(),
 *   compositor: () => new MyCompositor(),
 * };
 * const results = await runConformance([
 *   ...backendConformance(fixture),
 *   ...handoffConformance(fixture),
 * ]);
 * const failed = results.filter((r) => r.outcome === 'failed');
 * ```
 */
export async function runConformance(cases) {
    const results = [];
    for (const c of cases) {
        try {
            const outcome = await c.run();
            results.push({ name: c.name, outcome, message: null });
        }
        catch (error) {
            results.push({
                name: c.name,
                outcome: 'failed',
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return results;
}
export function check(condition, message) {
    if (!condition) {
        throw new ConformanceFailure(message);
    }
}
export function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
/** Waits until `condition` holds, polling every millisecond, or fails after `ms`. */
export async function until(condition, ms, what) {
    const deadline = Date.now() + ms;
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new ConformanceFailure(`timed out after ${String(ms)} ms waiting for ${what}`);
        }
        await sleep(1);
    }
}
//# sourceMappingURL=harness.js.map