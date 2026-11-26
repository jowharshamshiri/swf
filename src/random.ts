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
export const MAX_SEED = 0xffff_ffff;

/** Why `seed` is not a valid seed (an integer from 0 to {@link MAX_SEED}), or null when it is. */
export function seedIssue(seed: unknown): string | null {
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    return `a seed must be an integer from 0 to ${String(MAX_SEED)}`;
  }
  return null;
}

/**
 * A generator started from `seed`. The generator is frozen, and its state is its own: two made
 * from the same seed give the same sequence independently.
 *
 * @throws RangeError when the seed is not an integer from 0 to {@link MAX_SEED}, with the reason
 *   {@link seedIssue} gives.
 */
export function createRandom(seed: number): Random {
  const issue = seedIssue(seed);
  if (issue !== null) {
    throw new RangeError(`${issue} (got ${String(seed)})`);
  }
  let state = seed;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return Object.freeze({
    next,
    range: (min: number, max: number) => min + (max - min) * next(),
    integer: (min: number, max: number) => min + Math.floor((max - min + 1) * next()),
  });
}
