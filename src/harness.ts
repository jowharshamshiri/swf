/** Thrown by a conformance case whose expectation does not hold. */
export class ConformanceFailure extends Error {
  /** A failure saying which expectation did not hold; its `name` is `ConformanceFailure`. */
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceFailure';
  }
}

/** One named check of a contract, runnable in any test framework. */
export interface ConformanceCase {
  /** What the case checks, as a sentence. */
  readonly name: string;
  /**
   * Runs the check on fresh objects from the fixture. Resolves `passed`, or `not-applicable`
   * when the fixture does not offer what the case needs; rejects, usually with
   * {@link ConformanceFailure}, when the contract does not hold.
   */
  run(): Promise<'passed' | 'not-applicable'>;
}

/** How one case ended, as {@link runConformance} reports it. */
export interface ConformanceResult {
  /** The case's name. */
  readonly name: string;
  /** `failed` when the case threw or rejected; otherwise what it resolved. */
  readonly outcome: 'passed' | 'failed' | 'not-applicable';
  /** Why it failed: the error's message; null when it did not fail. */
  readonly message: string | null;
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
export async function runConformance(
  cases: readonly ConformanceCase[],
): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  for (const c of cases) {
    try {
      const outcome = await c.run();
      results.push({ name: c.name, outcome, message: null });
    } catch (error) {
      results.push({
        name: c.name,
        outcome: 'failed',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

export function check(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new ConformanceFailure(message);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Waits until `condition` holds, polling every millisecond, or fails after `ms`. */
export async function until(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new ConformanceFailure(`timed out after ${String(ms)} ms waiting for ${what}`);
    }
    await sleep(1);
  }
}
