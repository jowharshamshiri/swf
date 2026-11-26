import type { SwfError } from '@swf/core';
import type { FrameSource } from '@swf/presentation';
/**
 * Frame boundaries at a window's animation frames, for a presenter and for the workspace's preview
 * coalescing: give both the same source, so a preview the workspace announces at a frame is
 * presented in that very frame. Every call requested before a frame runs in it, and so does every
 * call those calls request (a second round): the presenter's frame follows the announcement that
 * asked for it, before the browser paints. Calls the second round requests wait for the next
 * frame, so no work repeats within a frame without end. A hidden tab gets no animation frames, so
 * work waits there, coalesced, and resumes from the latest state when the tab shows again. A call
 * that throws does not stop the others: its error is reported to the window once they have run.
 *
 * At most one animation frame is requested at a time. Each `request` returns a function that
 * cancels that call (safe to call twice); once every call waiting is cancelled, the frame is
 * cancelled too. The source holds nothing else and needs no disposal.
 */
export declare function animationFrames(view: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame' | 'queueMicrotask'>): FrameSource;
/**
 * Shows, in a viewport's container, that the viewport presents nothing and why: a status line of
 * text (`role="status"`), marked with the error's code in {@link DOM_ATTRIBUTES}`.degraded`, for
 * a presenter's `showDegraded`. The message is inserted as text, never markup. Returns what
 * removes the line again; the container stays the caller's.
 *
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` when the container is not an element.
 */
export declare function showDegraded(container: unknown, error: SwfError): () => void;
//# sourceMappingURL=host.d.ts.map