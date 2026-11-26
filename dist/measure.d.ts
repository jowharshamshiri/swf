import type { Id } from '@swf/core';
import type { BenchmarkHost } from './host.js';
/**
 * Measures taken in the page while a benchmark scenario runs: animation-frame timestamps
 * (NFR-001), the time from each pointer event to the frame that shows its preview (NFR-004), and
 * the router's hit queries (NFR-003).
 */
/** Records the timestamp of every animation frame until stopped. */
export interface FrameRecorder {
    /**
     * Stops recording, cancelling the frame it requested, and returns the frames' timestamps, in
     * milliseconds by the window's frame clock, oldest first: final and frozen, the same array on
     * every call.
     */
    stop(): readonly number[];
}
/**
 * Starts recording the timestamp of every animation frame of `view`, from the next one, by
 * requesting one frame after another. The caller must call {@link FrameRecorder.stop}, which ends
 * the requests.
 */
export declare function recordFrames(view: Window): FrameRecorder;
/**
 * The control a run is read against: the page itself moving one plain element every animation
 * frame, with no framework, for `durationMs`, on a page of the given size. What the browser
 * manages here is what the machine and the browser can give a page at all; a run's frames are
 * read against it. Resolves to the frames' timestamps, in milliseconds.
 *
 * The control's page element is appended to `parent` and removed again when it is done.
 *
 * @param size - The page's size, in CSS pixels.
 * @param durationMs - How long to run, in milliseconds by the window's frame clock.
 * @throws `Error` (as a rejection) when `parent` is not in a window.
 */
export declare function recordControl(parent: HTMLElement, size: {
    readonly width: number;
    readonly height: number;
}, durationMs: number): Promise<readonly number[]>;
/** What a preview-latency recording found. */
export interface PreviewLatency {
    /** For each pointer move shown, milliseconds from its event to the frame after it was drawn. */
    readonly latencies: readonly number[];
    /**
     * Pointer moves not seen shown when the recording stopped: never presented, or presented in a
     * frame whose next frame had not yet begun, so their latency is not known.
     */
    readonly unshown: number;
    /** The most pointer moves waiting to be shown at once. */
    readonly maxPending: number;
}
/** Records preview latency until stopped. */
export interface PreviewRecorder {
    /**
     * Stops listening to the host's input and frames, cancels the frames it requested, and returns
     * what was found: final and deeply frozen, the same object on every call.
     */
    stop(): PreviewLatency;
}
/**
 * Records how long each pointer move over the host's first viewport takes to become visible while
 * it previews a window's move: from the event's own timestamp (when the browser received the
 * input, as the DOM input device passes it on) to the start of the animation frame after the one
 * whose presentation showed the window where that move put it, or somewhere a later move put it.
 * That next frame begins once the presented one is painted, so the measure includes the paint.
 * A move is counted only while a preview of `nodeId` is open. The caller must stop the recorder.
 *
 * @throws `Error` when the host has no viewport or is not in a window.
 */
export declare function recordPreviewLatency(host: BenchmarkHost, nodeId: Id): PreviewRecorder;
/** The router's hit queries for pointer input, as it timed them. */
export interface PickRecorder {
    /**
     * Stops recording and returns each hit query's time, in milliseconds, in dispatch order: final
     * and frozen, the same array on every call.
     */
    stop(): readonly number[];
}
/**
 * Starts recording the time of every hit query the host's router makes for pointer input, as the
 * router timed it. The caller must call {@link PickRecorder.stop}, which stops observing input.
 */
export declare function recordPicks(host: BenchmarkHost): PickRecorder;
/**
 * Times hit queries at points of a viewport, `perPoint` queries at each so that coarse browser
 * clocks still resolve them (Firefox and Safari round `performance.now` to a millisecond or
 * more): each point's time is its queries' time divided by their number. Returns milliseconds per
 * query, one value per point.
 *
 * @param points - Points of the viewport, in CSS pixels from its top left.
 * @param perPoint - Queries at each point: a whole number of at least 1, not checked.
 * @throws `Error` when the host is not in a window.
 */
export declare function timePicks(host: BenchmarkHost, viewportId: Id, points: readonly (readonly [number, number])[], perPoint: number): number[];
//# sourceMappingURL=measure.d.ts.map