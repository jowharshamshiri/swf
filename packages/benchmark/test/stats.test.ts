import { describe, expect, it } from 'vitest';
import {
  analyseFrames,
  FRAME_BUDGET_MS,
  growthExponent,
  meetsFrameBudget,
  quantile,
  summarize,
} from '../src/index.js';

/** Timestamps of frames at the given intervals, from zero. */
const stamps = (intervals: readonly number[]) =>
  intervals.reduce<number[]>((out, t) => [...out, (out.at(-1) ?? 0) + t], [0]);

describe('summaries by median, 95th percentile and maximum', () => {
  it('reports measured values by nearest rank, never interpolated ones', () => {
    const values = Array.from({ length: 100 }, (_, i) => 100 - i);
    expect(summarize(values)).toEqual({
      count: 100,
      min: 1,
      median: 50,
      p95: 95,
      max: 100,
      mean: 50.5,
    });
    expect(quantile([3, 7, 9], 0.5)).toBe(7);
    expect(quantile([3, 7, 9], 0)).toBe(3);
    expect(quantile([3, 7, 9], 1)).toBe(9);
    expect(summarize([4]).p95).toBe(4);
  });

  it('refuses nothing to summarize, values that are not finite and quantiles out of range', () => {
    expect(() => summarize([])).toThrow(/no values/);
    expect(() => summarize([1, Number.NaN])).toThrow(/finite/);
    expect(() => summarize([1, Infinity])).toThrow(/finite/);
    expect(() => quantile([1], 1.5)).toThrow(/from 0 to 1/);
    expect(() => quantile([], 0.5)).toThrow(/no values/);
  });
});

describe('frame analysis (NFR-001, QA-010)', () => {
  it('counts a frame clock wandering round 60 Hz as in budget, and a missed vsync as skipped', () => {
    const steady = analyseFrames(stamps([16.2, 17.2, 16.6, 16.8, 16.4, 17.1]));
    expect(steady.withinBudget).toBe(1);
    expect(steady.skipped).toBe(0);
    expect(meetsFrameBudget(steady)).toBe(true);
    const missed = analyseFrames(stamps([16.7, 33.3, 16.7, 50, 16.7]));
    expect(missed.withinBudget).toBeCloseTo(3 / 5, 12);
    expect(missed.skipped).toBe(1 + 2);
    expect(meetsFrameBudget(missed)).toBe(false);
  });

  it('fails a browser that settles at a slower rate, however evenly it paces', () => {
    const slow = analyseFrames(stamps(new Array<number>(60).fill(20)));
    expect(slow.withinBudget).toBe(1);
    expect(slow.fps).toBeCloseTo(50, 9);
    expect(meetsFrameBudget(slow)).toBe(false);
  });

  it('passes at 95% of frames in budget and fails just below', () => {
    const at = (missed: number) =>
      analyseFrames(
        stamps([
          ...new Array<number>(100 - missed).fill(FRAME_BUDGET_MS),
          ...new Array<number>(missed).fill(40),
        ]),
      );
    expect(meetsFrameBudget(at(5))).toBe(true);
    expect(meetsFrameBudget(at(6))).toBe(false);
  });

  it('makes a histogram of intervals by millisecond, with what is past its last bin', () => {
    const f = analyseFrames(stamps([16.2, 16.9, 33.4, 250]));
    expect(f.histogram.binMs).toBe(1);
    expect(f.histogram.counts[16]).toBe(2);
    expect(f.histogram.counts[33]).toBe(1);
    expect(f.histogram.over).toBe(1);
    expect(f.histogram.counts.reduce((a, b) => a + b, 0) + f.histogram.over).toBe(4);
  });

  it('refuses fewer than two frames and timestamps that go back', () => {
    expect(() => analyseFrames([1])).toThrow(/two frames/);
    expect(() => analyseFrames([0, 16, 10])).toThrow(/go back \(frame 2\)/);
  });
});

describe('growth with scene size (NFR-008)', () => {
  it('fits the exponent of a cost’s growth: constant, linear and quadratic', () => {
    const sizes = [125, 250, 500, 1000];
    expect(growthExponent(sizes.map((n) => ({ n, cost: 3 })))).toBeCloseTo(0, 12);
    expect(growthExponent(sizes.map((n) => ({ n, cost: 0.01 * n })))).toBeCloseTo(1, 12);
    expect(growthExponent(sizes.map((n) => ({ n, cost: 1e-5 * n * n })))).toBeCloseTo(2, 12);
    // n log n stays well short of quadratic.
    const nlogn = growthExponent(sizes.map((n) => ({ n, cost: n * Math.log(n) })));
    expect(nlogn).toBeGreaterThan(1);
    expect(nlogn).toBeLessThan(1.5);
  });

  it('refuses fewer than two sizes and costs that are not positive', () => {
    expect(() => growthExponent([{ n: 10, cost: 1 }])).toThrow(/two distinct sizes/);
    expect(() =>
      growthExponent([
        { n: 10, cost: 1 },
        { n: 10, cost: 2 },
      ]),
    ).toThrow(/two distinct/);
    expect(() =>
      growthExponent([
        { n: 10, cost: 0 },
        { n: 20, cost: 2 },
      ]),
    ).toThrow(/positive/);
  });
});
