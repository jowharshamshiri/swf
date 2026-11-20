/** Thrown by a conformance case whose expectation does not hold. */
export class ConformanceFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConformanceFailure';
  }
}

/** One named check of a contract, runnable in any test framework. */
export interface ConformanceCase {
  /** What the case checks, as a sentence. */
  readonly name: string;
  /** Resolves `not-applicable` when the fixture does not offer what the case needs. */
  run(): Promise<'passed' | 'not-applicable'>;
}

export interface ConformanceResult {
  readonly name: string;
  readonly outcome: 'passed' | 'failed' | 'not-applicable';
  readonly message: string | null;
}

/** Runs cases one after another, reporting each; a case that throws has failed. */
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
