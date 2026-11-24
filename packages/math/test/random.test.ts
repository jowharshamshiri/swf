import { describe, expect, it } from 'vitest';
import { createRandom, MAX_SEED, seedIssue } from '../src/index.js';

describe('the seeded generator', () => {
  it('gives the same sequence for a seed, and another for another seed', () => {
    const take = (seed: number) => {
      const r = createRandom(seed);
      return Array.from({ length: 8 }, () => r.next());
    };
    expect(take(1)).toEqual(take(1));
    expect(take(1)).not.toEqual(take(2));
    expect(take(MAX_SEED)).toEqual(take(MAX_SEED));
    for (const value of take(3)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('rejects a seed that is not an unsigned 32-bit integer', () => {
    for (const seed of [-1, 1.5, MAX_SEED + 1, Number.NaN, Infinity, '1']) {
      expect(seedIssue(seed)).toBe('a seed must be an integer from 0 to 4294967295');
      expect(() => createRandom(seed as number)).toThrow(
        /seed must be an integer from 0 to 4294967295/,
      );
    }
  });

  it('keeps integers and ranges within their bounds', () => {
    const r = createRandom(9);
    for (let i = 0; i < 1000; i++) {
      const n = r.integer(-3, 3);
      expect(Number.isInteger(n) && n >= -3 && n <= 3).toBe(true);
      const x = r.range(2, 5);
      expect(x >= 2 && x < 5).toBe(true);
    }
  });
});
