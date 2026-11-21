import type { SwfError } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type { FrameSource } from '@swf/presentation';
import { DOM_ATTRIBUTES } from './renderer.js';

/**
 * Frame boundaries at a window's animation frames, for a presenter and for the workspace's
 * preview coalescing. A hidden tab gets no animation frames, so work waits there, coalesced, and
 * resumes from the latest state when the tab shows again.
 */
export function animationFrames(
  view: Pick<Window, 'requestAnimationFrame' | 'cancelAnimationFrame'>,
): FrameSource {
  return Object.freeze({
    request(run: () => unknown): () => void {
      const id = view.requestAnimationFrame(() => {
        run();
      });
      return () => {
        view.cancelAnimationFrame(id);
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
  notice.textContent = `Presentation unavailable: ${error.message}`;
  container.append(notice);
  return () => {
    notice.remove();
  };
}
