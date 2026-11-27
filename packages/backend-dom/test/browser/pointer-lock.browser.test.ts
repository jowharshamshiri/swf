import type { DispatchResult, InputIntent, PointerIntent } from '@swf/interaction';
import { SwfFailure } from '@swf/core';
import { afterEach, describe, expect, it } from 'vitest';
import { commands, server, userEvent } from 'vitest/browser';
import type { DomInput, PointerLockChange } from '../../src/index.js';
import { createDomInput } from '../../src/index.js';
import { pageOf } from './fixture.js';

/**
 * Whether the browser locks a pointer to an element soon after a press. Playwright's Chromium and
 * Firefox do; its WebKit offers the lock but refuses it outside the press itself.
 */
const LOCKS = server.browser !== 'webkit';

/**
 * Makes the platform refuse to lock the pointer to `element`, as a browser does that will not take
 * it (its promise rejected with `NotAllowedError`, and `pointerlockerror` on the document), where
 * this browser would otherwise grant it. Returns what puts the platform's own lock back.
 */
function refusingLocks(element: HTMLElement): () => void {
  if (!LOCKS) {
    return () => undefined;
  }
  Object.defineProperty(element, 'requestPointerLock', {
    configurable: true,
    value: () => {
      queueMicrotask(() => document.dispatchEvent(new Event('pointerlockerror')));
      return Promise.reject(new DOMException('The pointer lock was refused', 'NotAllowedError'));
    },
  });
  return () => {
    delete (element as { requestPointerLock?: unknown }).requestPointerLock;
  };
}

const answer = (consumed: boolean): DispatchResult => ({
  consumed,
  route: consumed ? 'gesture' : 'native',
  region: null,
  target: null,
  gestureId: null,
  operation: null,
  reason: null,
  pick: null,
});

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  if (document.pointerLockElement !== null) {
    document.exitPointerLock();
  }
});

/** A view's root on the page, its DOM input connected to a framework that takes every press. */
function view(): {
  root: HTMLElement;
  input: DomInput;
  seen: PointerIntent[];
  changes: PointerLockChange[];
  disconnect: () => void;
} {
  const root = document.createElement('div');
  root.style.setProperty('position', 'absolute');
  root.style.setProperty('left', '0');
  root.style.setProperty('top', '0');
  root.style.setProperty('width', '400px');
  root.style.setProperty('height', '300px');
  document.body.append(root);
  const input = createDomInput({ root, viewportId: 'v', events: () => () => undefined });
  const seen: PointerIntent[] = [];
  const changes: PointerLockChange[] = [];
  const stopChanges = input.pointerLock.subscribe((change) => changes.push(change));
  let connected = true;
  const stopInput = input.connect((intent: InputIntent) => {
    if (intent.kind === 'pointer') {
      seen.push(intent);
    }
    return answer(intent.kind === 'pointer');
  });
  const disconnect = () => {
    if (connected) {
      connected = false;
      stopInput();
    }
  };
  cleanup = () => {
    disconnect();
    stopChanges();
    root.remove();
  };
  return { root, input, seen, changes, disconnect };
}

/** Motion of the locked pointer, as the platform reports it, at the place the lock froze. */
function lockedMotion(root: HTMLElement, pointerId: number, dx: number, dy: number): void {
  root.dispatchEvent(
    new PointerEvent('pointermove', {
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      buttons: 1,
      clientX: 390,
      clientY: 100,
      movementX: dx,
      movementY: dy,
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  );
}

describe('the pointer lock on a view (FR-107, FR-123)', () => {
  it.runIf(LOCKS)(
    'locks a pressed pointer to the view, keeps its drag through the capture the lock takes, and reports its motion',
    async () => {
      const { root, input, seen, changes } = view();
      expect(input.pointerLock.available).toBe(true);
      const [x, y] = pageOf(root, 100, 100);
      await commands.mouse('move', x, y);
      await commands.mouse('down', x, y);
      await commands.mouse('move', x + 290, y);
      const pointerId = seen[0]?.pointerId ?? -1;
      expect(root.hasPointerCapture(pointerId)).toBe(true);
      // Not locked yet: no motion is reported.
      expect(seen.every((i) => i.movement === undefined)).toBe(true);
      input.pointerLock.request();
      // Answered after the call, never during it.
      expect(changes).toEqual([]);
      await expect.poll(() => changes).toEqual(['locked']);
      expect(document.pointerLockElement).toBe(root);
      // Asking again while it is held is refused.
      expect(() => {
        input.pointerLock.request();
      }).toThrow(SwfFailure);
      // The lock took the capture: that is no loss of the pointer, which is not cancelled.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(seen.filter((i) => i.phase === 'cancel')).toEqual([]);
      lockedMotion(root, pointerId, 30, -5);
      expect(seen.at(-1)).toMatchObject({ phase: 'move', pointerId, movement: { x: 30, y: -5 } });
      await commands.mouse('release', 0, 0);
      await expect.poll(() => seen.some((i) => i.phase === 'up')).toBe(true);
      // Nothing cancelled the drag before its release.
      const up = seen.findIndex((i) => i.phase === 'up');
      expect(seen.slice(0, up).filter((i) => i.phase === 'cancel')).toEqual([]);
      input.pointerLock.exit();
      await expect.poll(() => changes).toEqual(['locked', 'unlocked']);
      expect(document.pointerLockElement).toBeNull();
    },
  );

  it.runIf(LOCKS)('lets the lock go when it is taken off the device', async () => {
    const { root, input, changes, disconnect } = view();
    const [x, y] = pageOf(root, 100, 100);
    await commands.mouse('move', x, y);
    await commands.mouse('down', x, y);
    input.pointerLock.request();
    await expect.poll(() => changes).toEqual(['locked']);
    disconnect();
    expect(changes).toEqual(['locked', 'unlocked']);
    await expect.poll(() => document.pointerLockElement).toBeNull();
    await commands.mouse('release', 0, 0);
    // Not connected, it asks for nothing.
    expect(() => {
      input.pointerLock.request();
    }).toThrow(/not connected/);
  });

  it.runIf(LOCKS)('reports a lock the browser ends on Escape as ended', async () => {
    const { root, input, changes } = view();
    const [x, y] = pageOf(root, 100, 100);
    await commands.mouse('move', x, y);
    await commands.mouse('down', x, y);
    input.pointerLock.request();
    await expect.poll(() => changes).toEqual(['locked']);
    await userEvent.keyboard('{Escape}');
    await commands.mouse('release', 0, 0);
    // The browser lets the lock go itself, or the page's Escape does: either way it ends.
    if (document.pointerLockElement !== null) {
      input.pointerLock.exit();
    }
    await expect.poll(() => changes).toEqual(['locked', 'unlocked']);
  });

  it('says the browser refused a lock it would not take, after asking, once', async () => {
    const { root, input, seen, changes } = view();
    const restore = refusingLocks(root);
    expect(input.pointerLock.available).toBe(true);
    const [x, y] = pageOf(root, 100, 100);
    await commands.mouse('move', x, y);
    await commands.mouse('down', x, y);
    await commands.mouse('move', x + 20, y);
    input.pointerLock.request();
    expect(changes).toEqual([]);
    await expect.poll(() => changes).toEqual(['refused']);
    expect(document.pointerLockElement).toBeNull();
    // Refused, it may be asked again; the pointer stays captured, its drag going on.
    expect(root.hasPointerCapture(seen[0]?.pointerId ?? -1)).toBe(true);
    await commands.mouse('up', x + 20, y);
    // Nothing cancelled the drag before its release.
    const up = seen.findIndex((i) => i.phase === 'up');
    expect(up).toBeGreaterThan(0);
    expect(seen.slice(0, up).filter((i) => i.phase === 'cancel')).toEqual([]);
    expect(changes).toEqual(['refused']);
    restore();
  });
});
