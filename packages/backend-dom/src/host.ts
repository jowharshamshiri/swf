import type { SwfError } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type { FrameSource } from '@swf/presentation';
import { DOM_ATTRIBUTES } from './renderer.js';

/**
 * Frame boundaries at a window's animation frames, for a presenter and for the workspace's preview
 * coalescing: give both the same source, so a preview the workspace announces at a frame is
 * presented in that very frame. Every call requested before a frame runs in it, and so does every
 * call those calls request (a second round): the presenter's frame follows the announcement that
 * asked for it, before the browser paints. Calls the second round requests wait for the next
 * frame, so no work repeats within a frame without end. A hidden tab gets no animation frames, so
 * work waits there, coalesced, and resumes from the latest state when the tab shows again. A call
 * that throws does not stop the others: its error is reported to the window once they have run.
 */
export function animationFrames(
  view: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame' | 'queueMicrotask'>,
): FrameSource {
  interface Call {
    readonly run: () => unknown;
    cancelled: boolean;
  }
  let queue: Call[] = [];
  let frame: number | null = null;
  let running = false;
  const schedule = () => {
    if (frame === null && !running && queue.some((call) => !call.cancelled)) {
      frame = view.requestAnimationFrame(drain);
    }
  };
  const drain = () => {
    frame = null;
    running = true;
    const errors: unknown[] = [];
    try {
      for (let round = 0; round < 2 && queue.length > 0; round++) {
        const calls = queue;
        queue = [];
        for (const call of calls) {
          if (!call.cancelled) {
            call.cancelled = true;
            try {
              call.run();
            } catch (error) {
              errors.push(error);
            }
          }
        }
      }
    } finally {
      running = false;
      schedule();
    }
    for (const error of errors) {
      view.queueMicrotask(() => {
        throw error;
      });
    }
  };
  return Object.freeze({
    request(run: () => unknown): () => void {
      const call: Call = { run, cancelled: false };
      queue.push(call);
      schedule();
      return () => {
        call.cancelled = true;
        if (frame !== null && queue.every((c) => c.cancelled)) {
          view.cancelAnimationFrame(frame);
          frame = null;
          queue = [];
        }
      };
    },
  });
}

/**
 * Shows, in a viewport's container, that the viewport presents nothing and why: a status line of
 * text, marked with the error's code, for a presenter's `showDegraded`. Returns what removes it.
 * Throws {@link SwfFailure} (`INVALID_INPUT`) when the container is not an element.
 */
export function showDegraded(container: unknown, error: SwfError): () => void {
  if (typeof HTMLElement === 'undefined' || !(container instanceof HTMLElement)) {
    throw new SwfFailure(
      makeError('INVALID_INPUT', 'a degraded viewport can only be shown in an element container'),
    );
  }
  const notice = container.ownerDocument.createElement('div');
  notice.setAttribute('role', 'status');
  notice.setAttribute(DOM_ATTRIBUTES.degraded, error.code);
  // The message is text, never markup.
  notice.textContent = `Backend unavailable: ${error.message}`;
  container.append(notice);
  return () => {
    notice.remove();
  };
}
