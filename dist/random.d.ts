/**
 * A seeded pseudo-random generator (Mulberry32). The same seed always gives the same sequence on
 * every engine, so scenes generated from a seed (demo presets, benchmark fixtures) are
 * reproducible across runs, engines and releases. It is not suitable for cryptography. Its methods
 * do not check their arguments.
 */
export interface Random {
    /** The next number in [0, 1). */
    next(): number;
    /** The next number in [min, max), for `min` below `max`. */
    range(min: number, max: number): number;
    /** The next integer in [min, max], for integers `min` no greater than `max`. */
    integer(min: number, max: number): number;
}
/** Seeds are unsigned 32-bit integers. */
export declare const MAX_SEED = 4294967295;
/** Why `seed` is not a valid seed (an integer from 0 to {@link MAX_SEED}), or null when it is. */
export declare function seedIssue(seed: unknown): string | null;
/**
 * A generator started from `seed`. The generator is frozen, and its state is its own: two made
 * from the same seed give the same sequence independently.
 *
 * @throws RangeError when the seed is not an integer from 0 to {@link MAX_SEED}, with the reason
 *   {@link seedIssue} gives.
 */
export declare function createRandom(seed: number): Random;
//# sourceMappingURL=random.d.ts.map