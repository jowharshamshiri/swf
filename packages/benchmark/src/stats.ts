/**
 * The statistics benchmark results are reported in: summaries by median, 95th percentile and
 * maximum, frame-interval analysis, and how a cost grows with scene size.
 */

/** A summary of measured values, in their own unit. Frozen. */
export interface Summary {
  /** How many values were summarized: at least 1. */
  readonly count: number;
  /** The smallest value. */
  readonly min: number;
  /** The median, by nearest rank: a value that was measured. */
  readonly median: number;
  /** The 95th percentile, by nearest rank. */
  readonly p95: number;
  /** The largest value. */
  readonly max: number;
  /** The arithmetic mean. */
  readonly mean: number;
}

/**
 * The value at quantile `q` (0 to 1) of sorted values, by nearest rank: the smallest value with at
 * least `q` of the values at or below it. Nearest rank reports a value that was measured, never
 * one interpolated between two.
 *
 * @param sorted - The values in ascending order; the order is not checked.
 * @throws `RangeError` for no values, or a `q` outside 0 to 1 (`NaN` included).
 */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) {
    throw new RangeError('a quantile of no values is undefined');
  }
  if (!(q >= 0 && q <= 1)) {
    throw new RangeError(`a quantile must be from 0 to 1 (got ${String(q)})`);
  }
  const rank = Math.max(1, Math.ceil(q * sorted.length));
  return valueAt(sorted, rank - 1);
}

/** The value at an index the caller knows is in range. */
function valueAt(values: readonly number[], index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new RangeError(`no value at ${String(index)} of ${String(values.length)}`);
  }
  return value;
}

/**
 * Summarizes values, in any order; the input is not changed.
 *
 * @throws `RangeError` for no values, or for a value that is not finite.
 */
export function summarize(values: readonly number[]): Summary {
  if (values.length === 0) {
    throw new RangeError('a summary of no values is undefined');
  }
  const bad = values.find((v) => !Number.isFinite(v));
  if (bad !== undefined) {
    throw new RangeError(`every value must be finite (got ${String(bad)})`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  return Object.freeze({
    count: sorted.length,
    min: valueAt(sorted, 0),
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: valueAt(sorted, sorted.length - 1),
    mean: sorted.reduce((sum, v) => sum + v, 0) / sorted.length,
  });
}

/** The display's frame interval at 60 Hz, in milliseconds: NFR-001's budget. */
export const FRAME_BUDGET_MS = 1000 / 60;

/**
 * The width of a frame-interval histogram's bins, in milliseconds, and how many there are:
 * 1 ms bins, 100 of them. Frozen.
 */
export const HISTOGRAM: {
  /** The width of each bin, in milliseconds. */
  readonly binMs: number;
  /** How many bins there are; longer intervals are counted together past the last. */
  readonly bins: number;
} = Object.freeze({ binMs: 1, bins: 100 });

/** What a run of frames shows. Frozen. */
export interface FrameAnalysis {
  /** Frames recorded: one more than the intervals between them. */
  readonly frames: number;
  /** The intervals between successive frames, in milliseconds. */
  readonly intervals: Summary;
  /**
   * The intervals by length: `counts[i]` holds those of `i` to `i + 1` bins' width, `over` those
   * past the last bin (QA-010).
   */
  readonly histogram: {
    /** The width of each bin, in milliseconds: {@link HISTOGRAM}'s. */
    readonly binMs: number;
    /** How many intervals fell in each bin, {@link HISTOGRAM}'s number of them. */
    readonly counts: readonly number[];
    /** How many intervals were as long as all the bins together, or longer. */
    readonly over: number;
  };
  /**
   * The share of intervals, from 0 to 1, that were one display frame: shorter than one and a half
   * budgets. A display shows frames only at its vsync, so an interval is a whole number of frame
   * periods; a browser's frame clock wanders round that by a fraction of a millisecond, which
   * this tolerates, while a missed frame makes an interval of two periods or more.
   */
  readonly withinBudget: number;
  /**
   * Frames missed: each interval counts the budgets it spans, rounded to the nearest whole, less
   * one.
   */
  readonly skipped: number;
  /** Frames per second over the run: 0 when the first and last timestamps are equal. */
  readonly fps: number;
}

/**
 * Analyses the timestamps of successive animation frames, in milliseconds.
 *
 * @param timestamps - Each frame's timestamp, in order, such as {@link FrameRecorder.stop} gives.
 * @param budgetMs - One display frame, in milliseconds; positive, not checked. Default
 *   {@link FRAME_BUDGET_MS}.
 * @throws `RangeError` for fewer than two frames, timestamps that go back, or an interval that is
 *   not finite.
 */
export function analyseFrames(
  timestamps: readonly number[],
  budgetMs: number = FRAME_BUDGET_MS,
): FrameAnalysis {
  if (timestamps.length < 2) {
    throw new RangeError('frame analysis needs two frames at least');
  }
  const intervals: number[] = [];
  for (let i = 1; i < timestamps.length; i++) {
    const interval = valueAt(timestamps, i) - valueAt(timestamps, i - 1);
    if (!(interval >= 0)) {
      throw new RangeError(`frame timestamps must not go back (frame ${String(i)})`);
    }
    intervals.push(interval);
  }
  const counts = new Array<number>(HISTOGRAM.bins).fill(0);
  let over = 0;
  for (const t of intervals) {
    const bin = Math.floor(t / HISTOGRAM.binMs);
    if (bin < HISTOGRAM.bins) {
      counts[bin] = (counts[bin] ?? 0) + 1;
    } else {
      over += 1;
    }
  }
  const within = intervals.filter((t) => t < 1.5 * budgetMs).length;
  const skipped = intervals.reduce((sum, t) => sum + Math.max(0, Math.round(t / budgetMs) - 1), 0);
  const span = valueAt(timestamps, timestamps.length - 1) - valueAt(timestamps, 0);
  return Object.freeze({
    frames: timestamps.length,
    intervals: summarize(intervals),
    histogram: Object.freeze({ binMs: HISTOGRAM.binMs, counts: Object.freeze(counts), over }),
    withinBudget: within / intervals.length,
    skipped,
    fps: span > 0 ? (intervals.length * 1000) / span : 0,
  });
}

/**
 * Whether frames meet NFR-001: at least 95% of intervals one display frame, and the browser
 * running at the 60 Hz rate itself (its median interval within a millisecond of the budget), so a
 * browser that settles at a slower rate fails however evenly it paces.
 */
export function meetsFrameBudget(
  frames: FrameAnalysis,
  budgetMs: number = FRAME_BUDGET_MS,
): boolean {
  return frames.withinBudget >= 0.95 && frames.intervals.median <= budgetMs + 1;
}

/** A cost measured at a scene size. */
export interface Growth {
  /** The scene's size, such as its number of windows: greater than 0. */
  readonly n: number;
  /** The cost measured at that size, in any one unit: greater than 0. */
  readonly cost: number;
}

/**
 * The exponent `k` of the best fit `cost ≈ c·n^k` through the points, by least squares on their
 * logarithms: about 1 for a cost that grows linearly with the scene, 2 for a quadratic one, 0 for
 * a constant one. Throws `RangeError` for fewer than two distinct sizes, or a size or cost that is
 * not positive.
 */
export function growthExponent(points: readonly Growth[]): number {
  const bad = points.find((p) => !(p.n > 0) || !(p.cost > 0));
  if (bad !== undefined) {
    throw new RangeError(
      `sizes and costs must be positive (got n=${String(bad.n)}, cost=${String(bad.cost)})`,
    );
  }
  if (new Set(points.map((p) => p.n)).size < 2) {
    throw new RangeError('growth needs two distinct sizes at least');
  }
  const xs = points.map((p) => Math.log(p.n));
  const ys = points.map((p) => Math.log(p.cost));
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = valueAt(xs, i) - mx;
    sxy += dx * (valueAt(ys, i) - my);
    sxx += dx * dx;
  }
  return sxy / sxx;
}
