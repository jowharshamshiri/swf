/**
 * Counts what code running in a window holds of the browser: event listeners, observations by
 * resize, mutation and intersection observers, requested animation frames and pending timers. It
 * wraps the window's own registration functions, so it sees every registration made after it is
 * installed, by any code, and the counts compare a moment before a workspace is created with a
 * moment after it is disposed (NFR-010, AN-008).
 *
 * A listener counts while its target is the window, the document, or an element in the document:
 * one on an element that was removed and dropped goes with the element, and holds nothing. The
 * probe holds what it follows only weakly, so it keeps no target, listener or observer alive that
 * the page has let go.
 */
/** What the window's code holds, at one moment. */
export interface ResourceCounts {
    /** Event listeners added and not removed, on live targets. */
    readonly listeners: number;
    /** Targets observed by observers that are not disconnected, on live targets. */
    readonly observations: number;
    /** Animation frames requested and neither run nor cancelled. */
    readonly frames: number;
    /** Timeouts set and neither run nor cleared, and intervals not cleared. */
    readonly timers: number;
}
/**
 * A probe installed in a window, counting what the window's code holds. The caller owns it and
 * must call {@link ResourceProbe.dispose} to give the window its own functions back.
 */
export interface ResourceProbe {
    /**
     * What the window's code holds now, counting only what was registered since the probe was
     * installed. A new frozen object on every call.
     */
    counts(): ResourceCounts;
    /**
     * Puts the window's own functions back and lets another probe be installed. Registrations made
     * meanwhile keep working; they are no longer followed, so counts read afterwards are stale.
     * Safe to call twice.
     */
    dispose(): void;
}
/**
 * The window a probe is installed in: a browser window with its globals, whose
 * `EventTarget.prototype`, observers, animation frames and timers the probe wraps.
 */
export type ProbedWindow = Window & typeof globalThis;
/**
 * Installs a probe in a window: it replaces the window's `addEventListener` and
 * `removeEventListener` (on `EventTarget.prototype`), its `ResizeObserver`, `MutationObserver`
 * and `IntersectionObserver` (those it has), `requestAnimationFrame`, `cancelAnimationFrame`,
 * `setTimeout`, `clearTimeout`, `setInterval` and `clearInterval` with versions that count
 * and then call the originals. While installed, `setTimeout` takes only a function and throws
 * `TypeError` for code given as text. The caller owns the probe and disposes it.
 *
 * @throws `Error` when one is installed there already: two would count each registration twice.
 */
export declare function createResourceProbe(view: ProbedWindow): ResourceProbe;
//# sourceMappingURL=probe.d.ts.map