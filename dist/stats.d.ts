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
export declare function quantile(sorted: readonly number[], q: number): number;
/**
 * Summarizes values, in any order; the input is not changed.
 *
 * @throws `RangeError` for no values, or for a value that is not finite.
 */
export declare function summarize(values: readonly number[]): Summary;
/** The display's frame interval at 60 Hz, in milliseconds: NFR-001's budget. */
export declare const FRAME_BUDGET_MS: number;
/**
 * The width of a frame-interval histogram's bins, in milliseconds, and how many there are:
 * 1 ms bins, 100 of them. Frozen.
 */
export declare const HISTOGRAM: {
    /** The width of each bin, in milliseconds. */
    readonly binMs: number;
    /** How many bins there are; longer intervals are counted together past the last. */
    readonly bins: number;
};
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
export declare function analyseFrames(timestamps: readonly number[], budgetMs?: number): FrameAnalysis;
/**
 * Whether frames meet NFR-001: at least 95% of intervals one display frame, and the browser
 * running at the 60 Hz rate itself (its median interval within a millisecond of the budget), so a
 * browser that settles at a slower rate fails however evenly it paces.
 */
export declare function meetsFrameBudget(frames: FrameAnalysis, budgetMs?: number): boolean;
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
export declare function growthExponent(points: readonly Growth[]): number;
//# sourceMappingURL=stats.d.ts.map