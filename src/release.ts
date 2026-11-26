/**
 * Releasing what a case made on every path: each release runs even when one before it fails, and
 * no failure is lost, neither the case's nor a release's.
 */

/** A failure caught, kept apart so that even a thrown `undefined` is one. */
export interface Caught {
  readonly error: unknown;
}

/**
 * Runs each step in turn, every one even when one before it fails, and resolves to what failed,
 * in order.
 */
export async function runEach(steps: readonly (() => unknown)[]): Promise<Caught[]> {
  const failed: Caught[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failed.push({ error });
    }
  }
  return failed;
}

/**
 * Throws `error` as it is when nothing else `failed`; otherwise an `AggregateError` holding
 * `error`, then each other failure, in order.
 */
export function failWith(error: unknown, failed: readonly Caught[]): never {
  if (failed.length === 0) {
    throw error;
  }
  const all = [error, ...failed.map((f) => f.error)];
  throw new AggregateError(all, all.map(describe).join('; and then '));
}

/**
 * Runs each release in turn, every one even when one before it fails, then rejects with what
 * failed (as {@link failWith} throws it), or resolves when nothing did.
 */
export async function releaseAll(releases: readonly (() => unknown)[]): Promise<void> {
  const [first, ...more] = await runEach(releases);
  if (first !== undefined) {
    failWith(first.error, more);
  }
}

/**
 * Runs `body` with `made`, then releases it, the same whether `body` resolves or rejects. Passes
 * on `body`'s failure, the release's, or both together in an `AggregateError`.
 */
export async function using<T, R>(
  made: T,
  release: (made: T) => Promise<void>,
  body: (made: T) => R | Promise<R>,
): Promise<R> {
  let result: R;
  try {
    result = await body(made);
  } catch (error) {
    return failWith(error, await runEach([() => release(made)]));
  }
  await release(made);
  return result;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
