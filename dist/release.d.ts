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
export declare function runEach(steps: readonly (() => unknown)[]): Promise<Caught[]>;
/**
 * Throws `error` as it is when nothing else `failed`; otherwise an `AggregateError` holding
 * `error`, then each other failure, in order.
 */
export declare function failWith(error: unknown, failed: readonly Caught[]): never;
/**
 * Runs each release in turn, every one even when one before it fails, then rejects with what
 * failed (as {@link failWith} throws it), or resolves when nothing did.
 */
export declare function releaseAll(releases: readonly (() => unknown)[]): Promise<void>;
/**
 * Runs `body` with `made`, then releases it, the same whether `body` resolves or rejects. Passes
 * on `body`'s failure, the release's, or both together in an `AggregateError`.
 */
export declare function using<T, R>(made: T, release: (made: T) => Promise<void>, body: (made: T) => R | Promise<R>): Promise<R>;
//# sourceMappingURL=release.d.ts.map