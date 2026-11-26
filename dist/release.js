/**
 * Releasing what a case made on every path: each release runs even when one before it fails, and
 * no failure is lost, neither the case's nor a release's.
 */
/**
 * Runs each step in turn, every one even when one before it fails, and resolves to what failed,
 * in order.
 */
export async function runEach(steps) {
    const failed = [];
    for (const step of steps) {
        try {
            await step();
        }
        catch (error) {
            failed.push({ error });
        }
    }
    return failed;
}
/**
 * Throws `error` as it is when nothing else `failed`; otherwise an `AggregateError` holding
 * `error`, then each other failure, in order.
 */
export function failWith(error, failed) {
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
export async function releaseAll(releases) {
    const [first, ...more] = await runEach(releases);
    if (first !== undefined) {
        failWith(first.error, more);
    }
}
/**
 * Runs `body` with `made`, then releases it, the same whether `body` resolves or rejects. Passes
 * on `body`'s failure, the release's, or both together in an `AggregateError`.
 */
export async function using(made, release, body) {
    let result;
    try {
        result = await body(made);
    }
    catch (error) {
        return failWith(error, await runEach([() => release(made)]));
    }
    await release(made);
    return result;
}
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=release.js.map