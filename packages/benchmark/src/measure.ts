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
  /**
   * Stops recording and returns the frames' timestamps, in milliseconds by the window's frame
   * clock, oldest first: the recorder's own array, the same on every call.
   */
  stop(): readonly number[];
}

/**
 * Starts recording the timestamp of every animation frame of `view`, from the next one, by
 * requesting one frame after another. The caller must call {@link FrameRecorder.stop}, which ends
 * the requests.
 */
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
export async function recordControl(
  parent: HTMLElement,
  size: { readonly width: number; readonly height: number },
  durationMs: number,
): Promise<readonly number[]> {
  const document = parent.ownerDocument;
  const view = document.defaultView;
  if (view === null) {
    throw new Error('the parent element is not in a window');
  }
  const page = document.createElement('div');
  const box = document.createElement('div');
  for (const [element, styles] of [
    [
      page,
      {
        position: 'absolute',
        left: '0',
        top: '0',
        width: `${String(size.width)}px`,
        height: `${String(size.height)}px`,
        overflow: 'hidden',
      },
    ],
    [
      box,
      {
        position: 'absolute',
        left: '0',
        top: '0',
        width: '400px',
        height: '300px',
        background: '#dde4ee',
        font: '14px sans-serif',
      },
    ],
  ] as const) {
    for (const [property, value] of Object.entries(styles)) {
      element.style.setProperty(property, value);
    }
  }
  box.textContent = 'control';
  page.append(box);
  parent.append(page);
  const frames = recordFrames(view);
  const started = view.performance.now();
  await new Promise<void>((resolve) => {
    const move = (time: number) => {
      const t = time - started;
      const x = (size.width - 400) * (0.5 + 0.5 * Math.sin((2 * Math.PI * t) / 2000));
      box.style.setProperty(
        'transform',
        `translate(${x.toFixed(2)}px, ${String(size.height / 3)}px)`,
      );
      if (t < durationMs) {
        view.requestAnimationFrame(move);
      } else {
        resolve();
      }
    };
    view.requestAnimationFrame(move);
  });
  const stamps = frames.stop();
  page.remove();
  return stamps;
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

/** Records preview latency until stopped. */
export interface PreviewRecorder {
  /**
   * Stops listening to the host's input and frames and returns what was found. Moves shown by
   * the last presented frame are added to `latencies` when the frame after it begins, which may
   * be after `stop`.
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
  /**
   * Stops recording and returns each hit query's time, in milliseconds, in dispatch order: the
   * recorder's own array, the same on every call.
   */
  stop(): readonly number[];
}

/**
 * Starts recording the time of every hit query the host's router makes for pointer input, as the
 * router timed it. The caller must call {@link PickRecorder.stop}, which stops observing input.
 */
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
 *
 * @param points - Points of the viewport, in CSS pixels from its top left.
 * @param perPoint - Queries at each point: a whole number of at least 1, not checked.
 * @throws `Error` when the host is not in a window.
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
