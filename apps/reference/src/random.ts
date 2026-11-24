/**
 * A seeded pseudo-random generator (Mulberry32). The same seed always gives the same sequence on
 * every engine, so demo scenes generated from a seed are reproducible across runs and releases.
 */
export interface Random {
  /** The next number in [0, 1). */
  next(): number;
  /** The next number in [min, max). */
  range(min: number, max: number): number;
  /** The next integer in [min, max]. */
  integer(min: number, max: number): number;
}

/** Seeds are unsigned 32-bit integers. */
export const MAX_SEED = 0xffff_ffff;

export function seedIssue(seed: unknown): string | null {
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > MAX_SEED) {
    return `a seed must be an integer from 0 to ${String(MAX_SEED)}`;
  }
  return null;
}

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
