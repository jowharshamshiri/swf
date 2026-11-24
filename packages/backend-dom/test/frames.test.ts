import { describe, expect, it } from 'vitest';
import { animationFrames } from '../src/index.js';

/** A window whose animation frames come only when the test runs them. */
function fakeWindow() {
  const callbacks = new Map<number, FrameRequestCallback>();
  const microtasks: (() => void)[] = [];
  let next = 1;
  return {
    callbacks,
    microtasks,
    view: {
      requestAnimationFrame(callback: FrameRequestCallback): number {
        const id = next++;
        callbacks.set(id, callback);
        return id;
      },
      cancelAnimationFrame(id: number): void {
        callbacks.delete(id);
      },
      queueMicrotask(callback: () => void): void {
        microtasks.push(callback);
      },
    },
    /** Runs the frame: every callback requested before it, as a browser does. */
    frame(time = 0): void {
      const due = [...callbacks.entries()];
      callbacks.clear();
      for (const [, callback] of due) {
        callback(time);
      }
    },
  };
}

describe('animation frames as a frame source (FR-143, NFR-004, NFR-009)', () => {
  it('runs what was requested before a frame, and what those calls request, in that frame', () => {
    const w = fakeWindow();
    const frames = animationFrames(w.view);
    const ran: string[] = [];
    frames.request(() => {
      ran.push('announce');
      frames.request(() => ran.push('present'));
    });
    expect(w.callbacks.size).toBe(1);
    w.frame();
    expect(ran).toEqual(['announce', 'present']);
    expect(w.callbacks.size).toBe(0);
  });

  it('leaves what the second round requests for the next frame, so nothing repeats without end', () => {
    const w = fakeWindow();
    const frames = animationFrames(w.view);
    let runs = 0;
    const again = () => {
      runs += 1;
      frames.request(again);
    };
    frames.request(again);
    w.frame();
    expect(runs).toBe(2);
    expect(w.callbacks.size).toBe(1);
    w.frame();
    expect(runs).toBe(4);
  });

  it('asks the window for one frame however many calls wait for it, and none once all are cancelled', () => {
    const w = fakeWindow();
    const frames = animationFrames(w.view);
    const ran: number[] = [];
    const cancels = [1, 2, 3].map((n) => frames.request(() => ran.push(n)));
    expect(w.callbacks.size).toBe(1);
    cancels[1]?.();
    w.frame();
    expect(ran).toEqual([1, 3]);
    const cancel = frames.request(() => ran.push(4));
    expect(w.callbacks.size).toBe(1);
    cancel();
    expect(w.callbacks.size).toBe(0);
    w.frame();
    expect(ran).toEqual([1, 3]);
  });

  it('runs every call even when one throws, and reports the error afterwards', () => {
    const w = fakeWindow();
    const frames = animationFrames(w.view);
    const ran: string[] = [];
    frames.request(() => {
      throw new Error('broken frame work');
    });
    frames.request(() => ran.push('after'));
    w.frame();
    expect(ran).toEqual(['after']);
    expect(w.microtasks).toHaveLength(1);
    expect(() => w.microtasks[0]?.()).toThrow('broken frame work');
  });
});
