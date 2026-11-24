import type { Id } from '@swf/core';
import type { Transform3D } from '@swf/math';
import type { BenchmarkHost } from './host.js';

/**
 * Measures taken in the page while a benchmark scenario runs: animation-frame timestamps
 * (NFR-001), the time from each pointer event to the frame that shows its preview (NFR-004), and
 * the router's hit queries (NFR-003).
 */

/** Records the timestamp of every animation frame until stopped. */
export interface FrameRecorder {
  stop(): readonly number[];
}

export function recordFrames(view: Window): FrameRecorder {
  const stamps: number[] = [];
  let running = true;
  const tick = (time: number) => {
    if (!running) {
      return;
    }
    stamps.push(time);
    view.requestAnimationFrame(tick);
  };
  view.requestAnimationFrame(tick);
  return {
    stop() {
      running = false;
      return stamps;
    },
  };
}

/** What a preview-latency recording found. */
export interface PreviewLatency {
  /** For each pointer move shown, milliseconds from its event to the frame after it was drawn. */
  readonly latencies: readonly number[];
  /** Pointer moves never shown before the recording stopped. */
  readonly unshown: number;
  /** The most pointer moves waiting to be shown at once. */
  readonly maxPending: number;
}

export interface PreviewRecorder {
  stop(): PreviewLatency;
}

/**
 * Records how long each pointer move over the host's first viewport takes to become visible while
 * it previews a window's move: from the event's own timestamp (when the browser received the
 * input, as the DOM input device passes it on) to the start of the animation frame after the one
 * whose presentation showed the window where that move put it, or somewhere a later move put it.
 * That next frame begins once the presented one is painted, so the measure includes the paint.
 */
export function recordPreviewLatency(host: BenchmarkHost, nodeId: Id): PreviewRecorder {
  const main = host.viewports[0];
  if (main === undefined) {
    throw new Error('the host has no viewport');
  }
  const view = main.container.ownerDocument.defaultView;
  if (view === null) {
    throw new Error('the host is not in a window');
  }
  /** Pointer moves not yet shown: when each happened, and the place it previewed. */
  const pending: { readonly at: number; readonly place: Transform3D }[] = [];
  const latencies: number[] = [];
  let maxPending = 0;
  // Observed as the router returns, the preview this move made is in place.
  const stopInput = host.observeInput((intent) => {
    if (intent.kind !== 'pointer' || intent.phase !== 'move') {
      return;
    }
    const place = host.workspace.getPresented().nodes.get(nodeId)?.transform;
    const committed = host.workspace.getState().nodes.get(nodeId)?.transform;
    if (place === undefined || place === committed) {
      return; // no preview of the window is open: this move previews nothing
    }
    pending.push({ at: intent.timestamp, place });
    maxPending = Math.max(maxPending, pending.length);
  });
  const stopFrames = host.presenter.subscribe((event) => {
    if (event.type !== 'frame' || event.viewportId !== main.fixture.id) {
      return;
    }
    const shown = main.viewport.lastFrame()?.frame.scene.nodes.get(nodeId)?.transform;
    const index = pending.findLastIndex((p) => p.place === shown);
    if (index < 0) {
      return;
    }
    const done = pending.splice(0, index + 1);
    view.requestAnimationFrame((painted) => {
      for (const p of done) {
        latencies.push(painted - p.at);
      }
    });
  });
  return {
    stop() {
      stopInput();
      stopFrames();
      return Object.freeze({ latencies, unshown: pending.length, maxPending });
    },
  };
}

/** The router's hit queries for pointer input, as it timed them. */
export interface PickRecorder {
  stop(): readonly number[];
}

export function recordPicks(host: BenchmarkHost): PickRecorder {
  const times: number[] = [];
  const stop = host.observeInput((intent, result) => {
    if (intent.kind === 'pointer' && result.pick !== null) {
      times.push(result.pick.ms);
    }
  });
  return {
    stop() {
      stop();
      return times;
    },
  };
}

/**
 * Times hit queries at points of a viewport, `perPoint` queries at each so that coarse browser
 * clocks still resolve them (Firefox and Safari round `performance.now` to a millisecond or
 * more): each point's time is its queries' time divided by their number. Returns milliseconds per
 * query, one value per point.
 */
export function timePicks(
  host: BenchmarkHost,
  viewportId: Id,
  points: readonly (readonly [number, number])[],
  perPoint: number,
): number[] {
  const view = host.viewports[0]?.container.ownerDocument.defaultView;
  if (view === null || view === undefined) {
    throw new Error('the host is not in a window');
  }
  return points.map(([x, y]) => {
    const started = view.performance.now();
    for (let i = 0; i < perPoint; i++) {
      host.router.pick(viewportId, x, y);
    }
    return (view.performance.now() - started) / perPoint;
  });
}
