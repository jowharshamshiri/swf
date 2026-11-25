import type { Transform3D } from '@swf/math';
import type { InputIntent } from '@swf/interaction';
import type { PresenterEvent } from '@swf/presentation';
import { describe, expect, it } from 'vitest';
import type { BenchmarkHost } from '../src/index.js';
import { recordFrames, recordPicks, recordPreviewLatency } from '../src/index.js';

const place = (x: number): Transform3D => ({
  position: [x, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
});

/**
 * A window whose animation frames run when the test says, and a host on it presenting one window
 * `w` in viewport `ahead`: what the recorder reads of a host, driven by the test.
 */
function stage() {
  const frames = new Map<number, (time: number) => void>();
  let next = 1;
  const view = {
    requestAnimationFrame(callback: (time: number) => void): number {
      const id = next++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number): void {
      frames.delete(id);
    },
  };
  const committed = place(0);
  let presented = committed;
  let shown = committed;
  const inputs = new Set<(intent: InputIntent) => void>();
  const presenterListeners = new Set<(event: PresenterEvent) => void>();
  const nodes = (transform: Transform3D) => new Map([['w', { transform }]]);
  const host = {
    viewports: [
      {
        fixture: { id: 'ahead' },
        container: { ownerDocument: { defaultView: view } },
        viewport: { lastFrame: () => ({ frame: { scene: { nodes: nodes(shown) } } }) },
      },
    ],
    workspace: {
      getPresented: () => ({ nodes: nodes(presented) }),
      getState: () => ({ nodes: nodes(committed) }),
    },
    observeInput(listener: (intent: InputIntent) => void) {
      inputs.add(listener);
      return () => inputs.delete(listener);
    },
    presenter: {
      subscribe(listener: (event: PresenterEvent) => void) {
        presenterListeners.add(listener);
        return () => presenterListeners.delete(listener);
      },
    },
  } as unknown as BenchmarkHost;
  return {
    host,
    /** Pending animation frames. */
    get frames() {
      return frames.size;
    },
    /** A pointer move at `at` that previews the window at `x`. */
    move(at: number, x: number) {
      presented = place(x);
      for (const listener of inputs) {
        listener({ kind: 'pointer', phase: 'move', timestamp: at } as InputIntent);
      }
    },
    /** A pointer move dispatched, its hit query timed at `ms`. */
    pick(ms: number) {
      for (const listener of inputs) {
        (listener as (intent: InputIntent, result: unknown) => void)(
          { kind: 'pointer', phase: 'down', timestamp: 0 } as InputIntent,
          { pick: { ms } },
        );
      }
    },
    /** The window. */
    view: view as unknown as Window,
    /** The presenter presents the window where the last move put it. */
    present() {
      shown = presented;
      for (const listener of presenterListeners) {
        listener({ type: 'frame', viewportId: 'ahead' } as PresenterEvent);
      }
    },
    /** The next animation frame begins at `time`. */
    frame(time: number) {
      const due = [...frames.values()];
      frames.clear();
      for (const run of due) {
        run(time);
      }
    },
  };
}

describe('preview latency recording', () => {
  it('measures a move from its event to the frame after the one that showed it', () => {
    const s = stage();
    const recorder = recordPreviewLatency(s.host, 'w');
    s.move(10, 1);
    s.present();
    s.frame(26);
    expect(recorder.stop()).toEqual({ latencies: [16], unshown: 0, maxPending: 1 });
  });

  it('returns from stop a final, frozen result that no frame still to come changes', () => {
    const s = stage();
    const recorder = recordPreviewLatency(s.host, 'w');
    s.move(10, 1);
    s.present();
    // Shown, but the frame after it has not begun: its latency is not known when stopped.
    const found = recorder.stop();
    expect(found).toEqual({ latencies: [], unshown: 1, maxPending: 1 });
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found.latencies)).toBe(true);
    // The recorder requests no more frames once stopped, and nothing it requested runs.
    expect(s.frames).toBe(0);
    s.frame(26);
    expect(found.latencies).toEqual([]);
    expect(recorder.stop()).toBe(found);
  });
});

describe('frame and hit-query recording', () => {
  it('stops requesting frames when stopped, and returns a final, frozen record', () => {
    const s = stage();
    const recorder = recordFrames(s.view);
    s.frame(16);
    s.frame(32);
    const stamps = recorder.stop();
    expect(stamps).toEqual([16, 32]);
    expect(Object.isFrozen(stamps)).toBe(true);
    expect(s.frames).toBe(0);
    expect(recorder.stop()).toBe(stamps);
  });

  it('returns a final, frozen record of hit queries when stopped', () => {
    const s = stage();
    const recorder = recordPicks(s.host);
    s.pick(0.5);
    const times = recorder.stop();
    s.pick(0.7);
    expect(times).toEqual([0.5]);
    expect(Object.isFrozen(times)).toBe(true);
    expect(recorder.stop()).toBe(times);
  });
});
