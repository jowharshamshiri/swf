import { createRandom } from '@swf/math';
import { describe, expect, inject, it } from 'vitest';
import { commands } from 'vitest/browser';
import type {
  BenchmarkHost,
  Fixture,
  FixtureSize,
  FrameAnalysis,
  Growth,
  Summary,
} from '../src/index.js';
import {
  analyseFrames,
  createBenchmarkHost,
  growthExponent,
  layoutViewports,
  meetsFrameBudget,
  planFixture,
  recordControl,
  recordFrames,
  recordPicks,
  recordPreviewLatency,
  PAGE,
  STANDARD,
  STRESS,
  summarize,
  timePicks,
} from '../src/index.js';

/**
 * The performance benchmark (§26.1, QA-010): the standard and stress fixtures on the 1920×1080
 * page, each measured in five trials: cold creation (NFR-007), retained heap (NFR-006), hit queries
 * (NFR-003), and 60-second scenarios after a warm-up, turning the camera by dragging the
 * background and dragging a window by its frame with a real mouse (NFR-001, NFR-004), and one
 * window's move as the scene grows (NFR-008). It writes what it measured, with the environment and
 * the method, as JSON for each browser and fixture.
 */

declare module 'vitest' {
  export interface ProvidedContext {
    swfBench: {
      readonly trials: number;
      readonly warmupMs: number;
      readonly trialMs: number;
      readonly seed: number;
    };
  }
}

declare module 'vitest/browser' {
  interface BrowserCommands {
    heap: () => Promise<{ used: number; embedder: number | null } | null>;
    environment: () => Promise<Record<string, unknown>>;
    record: (name: string, text: string) => Promise<void>;
    sweep: (options: {
      x: number;
      y: number;
      amplitude: number;
      periodMs: number;
      durationMs: number;
      stepMs?: number;
      axis?: 'x' | 'y';
    }) => Promise<{ moves: number; durationMs: number }>;
  }
}

const settings = inject('swfBench');
const POINTER_STEP_MS = 8;
/** How long the control moves its element each trial. */
const CONTROL_MS = 10_000;
const PICK_POINTS = 500;
const PICKS_PER_POINT = 20;
/** The most pointer moves waiting to be shown at once that still counts as a bounded queue. */
const MAX_PENDING = 16;

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));

/** The page's own facts: what draws it, its pixel ratio and how finely it tells time. */
function pageFacts() {
  const gl = document.createElement('canvas').getContext('webgl');
  const info = gl?.getExtension('WEBGL_debug_renderer_info') ?? null;
  const renderer: string | null =
    gl === null
      ? null
      : String(gl.getParameter(info === null ? gl.RENDERER : info.UNMASKED_RENDERER_WEBGL));
  let resolution = Infinity;
  for (let i = 0; i < 2000; i++) {
    const a = performance.now();
    let b = performance.now();
    while (b === a) {
      b = performance.now();
    }
    resolution = Math.min(resolution, b - a);
  }
  return {
    gpu: renderer,
    devicePixelRatio: window.devicePixelRatio,
    inner: { width: window.innerWidth, height: window.innerHeight },
    timerResolutionMs: resolution,
    crossOriginIsolated: window.crossOriginIsolated,
  };
}

let root: HTMLElement | null = null;
/** Takes the page's viewports away. */
function clear(): void {
  root?.remove();
  root = null;
}
async function present(fixture: Fixture): Promise<BenchmarkHost> {
  clear();
  root = document.createElement('div');
  root.style.setProperty('position', 'absolute');
  root.style.setProperty('inset', '0');
  document.body.append(root);
  const host = await createBenchmarkHost({ fixture, containers: layoutViewports(root, fixture) });
  await host.settled();
  return host;
}

/** A point of the first viewport the router finds as `want`, scanning out from its centre. */
function findPoint(
  host: BenchmarkHost,
  want: (pick: ReturnType<BenchmarkHost['router']['pick']>) => boolean,
): [number, number] {
  const main = host.viewports[0];
  if (main === undefined) {
    throw new Error('no viewport');
  }
  const { width, height, id } = main.fixture;
  for (let r = 0; r < Math.max(width, height) / 2; r += 4) {
    for (let a = 0; a < 16; a++) {
      const x = Math.round(width / 2 + r * Math.cos((a * Math.PI) / 8));
      const y = Math.round(height / 2 + r * Math.sin((a * Math.PI) / 8));
      if (x > 0 && y > 0 && x < width && y < height && want(host.router.pick(id, x, y))) {
        return [x, y];
      }
    }
  }
  throw new Error('no such point in the view');
}

interface ScenarioTrial {
  readonly frames: FrameAnalysis;
  /** Pointer moves made, and how long the drag swept: whole periods of its sine. */
  readonly moves: number;
  readonly sweptMs: number;
  readonly picks: Summary | null;
  /** Frame boundaries the presenter waited through, out of budget (AN-001). */
  readonly presenterSkipped: number;
  readonly presentedFrames: number;
  /** How long the presenter took over each frame it presented, in milliseconds (AN-001). */
  readonly presenterMs: Summary | null;
  readonly latency?: Summary;
  readonly unshown?: number;
  readonly maxPending?: number;
}

/**
 * Runs a drag for the warm-up and then the trial, measuring only the trial. Each drag presses
 * where `locate` finds the place to press then: the warm-up leaves the camera or the window
 * somewhere else.
 */
async function dragTrial(
  host: BenchmarkHost,
  locate: () => [number, number],
  sweep: { amplitude: number; periodMs: number },
  latencyOf: string | null,
): Promise<ScenarioTrial> {
  const main = host.viewports[0];
  if (main === undefined) {
    throw new Error('no viewport');
  }
  if (settings.warmupMs > 0) {
    const [wx, wy] = locate();
    await commands.sweep({
      x: wx,
      y: wy,
      ...sweep,
      durationMs: settings.warmupMs,
      stepMs: POINTER_STEP_MS,
    });
  }
  await nextFrame();
  const [x, y] = locate();
  let presentedFrames = 0;
  let presenterSkipped = 0;
  const presenterMs: number[] = [];
  const stopFrames = host.presenter.subscribe((event) => {
    if (event.type === 'frame' && event.viewportId === main.fixture.id) {
      presentedFrames += 1;
      presenterSkipped += event.metrics.skipped;
      presenterMs.push(event.metrics.durationMs);
    }
  });
  const frames = recordFrames(window);
  const picks = recordPicks(host);
  const latency = latencyOf === null ? null : recordPreviewLatency(host, latencyOf);
  const swept = await commands.sweep({
    x,
    y,
    ...sweep,
    durationMs: settings.trialMs,
    stepMs: POINTER_STEP_MS,
  });
  const stamps = frames.stop();
  const pickTimes = picks.stop();
  // The frame after release shows the last preview, committed.
  await nextFrame();
  await nextFrame();
  const shown = latency?.stop() ?? null;
  stopFrames();
  return {
    frames: analyseFrames(stamps),
    moves: swept.moves,
    sweptMs: swept.durationMs,
    picks: pickTimes.length === 0 ? null : summarize(pickTimes),
    presenterSkipped,
    presentedFrames,
    presenterMs: presenterMs.length === 0 ? null : summarize(presenterMs),
    ...(shown === null
      ? {}
      : {
          latency: summarize(shown.latencies),
          unshown: shown.unshown,
          maxPending: shown.maxPending,
        }),
  };
}

/** The windows ahead of the first viewport's camera at a size, for the growth measure. */
function growthAt(size: FixtureSize): Fixture {
  return planFixture(size, settings.seed);
}

async function measure(name: 'standard' | 'stress', size: FixtureSize) {
  const fixture = planFixture(size, settings.seed);
  const environment: Record<string, unknown> = {
    ...(await commands.environment()),
    page: pageFacts(),
  };
  const cold: number[] = [];
  const heap: number[] = [];
  const pickTrials: Summary[] = [];
  const control: FrameAnalysis[] = [];
  const rotation: ScenarioTrial[] = [];
  const drag: ScenarioTrial[] = [];
  for (let trial = 0; trial < settings.trials; trial++) {
    clear();
    await nextFrame();
    // The control: what this browser on this machine gives a page that moves one element.
    control.push(analyseFrames(await recordControl(document.body, PAGE, CONTROL_MS)));
    const before = await commands.heap();
    // NFR-007: a cold scene, from an empty workspace to every viewport's first frame presented.
    const started = performance.now();
    const host = await present(fixture);
    cold.push(performance.now() - started);
    const after = await commands.heap();
    if (before !== null && after !== null) {
      heap.push(after.used + (after.embedder ?? 0) - before.used - (before.embedder ?? 0));
    }
    // NFR-003: hit queries at points spread over the first viewport, the same every trial.
    const main = host.viewports[0];
    if (main === undefined) {
      throw new Error('no viewport');
    }
    const random = createRandom(settings.seed + trial);
    const points = Array.from({ length: PICK_POINTS }, (): [number, number] => [
      random.range(0, main.fixture.width),
      random.range(0, main.fixture.height),
    ]);
    pickTrials.push(summarize(timePicks(host, main.fixture.id, points, PICKS_PER_POINT)));
    // NFR-001: the camera turned by dragging the background, back and forth.
    const background = () => findPoint(host, (p) => p.kind === 'background');
    rotation.push(await dragTrial(host, background, { amplitude: 300, periodMs: 4000 }, null));
    // NFR-001 and NFR-004: a window dragged by its frame, its preview following the pointer.
    const grabbable = (p: ReturnType<BenchmarkHost['router']['pick']>) =>
      p.kind === 'hit' && p.region === 'chrome' && p.target.edge === null && !p.ambiguous;
    const first = host.router.pick(main.fixture.id, ...findPoint(host, grabbable));
    if (first.kind !== 'hit') {
      throw new Error('no window frame to grab');
    }
    const grabbed = first.target.nodeId;
    const frame = () =>
      findPoint(host, (p) => grabbable(p) && p.kind === 'hit' && p.target.nodeId === grabbed);
    const history = host.workspace.history().length;
    drag.push(await dragTrial(host, frame, { amplitude: 150, periodMs: 2000 }, grabbed));
    // Each drag (the warm-up's and the trial's) is one commit, never one per move.
    expect(host.workspace.history().length - history).toBe(settings.warmupMs > 0 ? 2 : 1);
    await host.dispose();
  }
  clear();

  // NFR-008: one window's move as the scene grows, a mean over forty moves at each size.
  const growth: { transaction: Growth[]; frame: Growth[] } = { transaction: [], frame: [] };
  for (const windows of [125, 250, 500, 1000]) {
    const grown = growthAt({ windows, surfaces: windows * 1.2, groups: size.groups });
    const host = await present(grown);
    const main = host.viewports[0];
    const ahead = grown.windows.find((w) => Math.abs(w.heading) < 10 && Math.abs(w.y) < 0.2);
    if (main === undefined || ahead === undefined) {
      throw new Error('no window ahead');
    }
    const tx: number[] = [];
    const fr: number[] = [];
    for (let i = 0; i < 40; i++) {
      const node = host.workspace.getState().nodes.get(ahead.id);
      if (node === undefined) {
        throw new Error(`no ${ahead.id}`);
      }
      const [px, py, pz] = node.transform.position;
      const turn = i % 2 === 0 ? 0.02 : -0.02;
      const position = [
        Math.cos(turn) * px - Math.sin(turn) * pz,
        py,
        Math.sin(turn) * px + Math.cos(turn) * pz,
      ] as const;
      const t0 = performance.now();
      host.workspace.dispatch(
        { type: 'node.patch', id: ahead.id, transform: { ...node.transform, position } },
        { source: 'user' },
      );
      const t1 = performance.now();
      await main.viewport.update();
      fr.push(performance.now() - t1);
      tx.push(t1 - t0);
    }
    growth.transaction.push({ n: windows, cost: Math.max(1e-3, summarize(tx).mean) });
    growth.frame.push({ n: windows, cost: Math.max(1e-3, summarize(fr).mean) });
    await host.dispose();
    clear();
  }

  const every = <T>(values: readonly T[], ok: (v: T) => boolean) => values.every(ok);
  const exponents = {
    transaction: growthExponent(growth.transaction),
    frame: growthExponent(growth.frame),
  };
  // The standard fixture is held to the budgets; the stress fixture records how far it degrades
  // (§26.1), held only to bounded, sub-quadratic growth (NFR-008).
  const growthVerdict = {
    target: 'one window’s move grows less than quadratically with the scene (exponent under 1.5)',
    pass: exponents.transaction < 1.5 && exponents.frame < 1.5,
  };
  const verdicts =
    name === 'stress'
      ? { 'NFR-008': growthVerdict }
      : {
          'NFR-001': {
            target:
              'at least 95% of frame intervals one 60 Hz frame (16.7 ms), at the 60 Hz rate, while turning the camera and dragging, in every trial',
            pass:
              every(rotation, (t) => meetsFrameBudget(t.frames)) &&
              every(drag, (t) => meetsFrameBudget(t.frames)),
          },
          'NFR-003': {
            target: 'hit query p95 under 2 ms, in every trial',
            pass: every(pickTrials, (summary) => summary.p95 < 2),
          },
          'NFR-004': {
            target: `input to visible preview p95 under 50 ms in every trial, at most ${String(MAX_PENDING)} moves waiting at once`,
            pass: every(
              drag,
              (t) => (t.latency?.p95 ?? Infinity) < 50 && (t.maxPending ?? Infinity) <= MAX_PENDING,
            ),
          },
          'NFR-006': {
            target: 'retained heap of the presented fixture under 32 MiB',
            pass: heap.length === 0 ? null : every(heap, (b) => b < 32 * 1024 * 1024),
          },
          'NFR-007': {
            target: 'cold creation to every viewport’s first frame within 1 s, in every trial',
            pass: every(cold, (ms) => ms < 1000),
          },
          'NFR-008': growthVerdict,
        };
  const result = {
    schema: 'swf.benchmark/1',
    date: new Date().toISOString(),
    fixture: { name, ...size, seed: settings.seed, viewports: fixture.viewports },
    environment,
    method: {
      trials: settings.trials,
      warmupMs: settings.warmupMs,
      trialMs: settings.trialMs,
      page: { width: 1920, height: 1080 },
      pointer: {
        sweeps:
          'whole periods of a sine, at least as long as the warm-up or the trial, released where pressed',
        stepMs: POINTER_STEP_MS,
        rotation: { amplitudePx: 300, periodMs: 4000 },
        drag: { amplitudePx: 150, periodMs: 2000 },
      },
      picks: { points: PICK_POINTS, perPoint: PICKS_PER_POINT },
      growth: { sizes: [125, 250, 500, 1000], moves: 40 },
      frames:
        'animation-frame timestamps; an interval is in budget when it is one display frame (under 1.5 × 16.7 ms), and the median interval must be within 1 ms of 16.7 ms; skipped = whole budgets an interval spans, less one; histogram in 1 ms bins',
      latency:
        'pointer event timeStamp to the start of the animation frame after the presented frame that shows its preview',
      heap: 'Chromium only: V8 and embedder heap after two forced collections, with the host presented, less before it',
      control: `each trial first moves one plain 400×300 element across the page every animation frame for ${String(CONTROL_MS / 1000)} s, with no framework: what the browser on this machine gives a page at all`,
    },
    measures: {
      cold: { trials: cold, summary: summarize(cold) },
      heap: heap.length === 0 ? null : { trials: heap, summary: summarize(heap) },
      picks: { trials: pickTrials },
      control: { trials: control },
      rotation: { trials: rotation },
      drag: { trials: drag },
      growth: { ...growth, exponents },
    },
    verdicts,
  };
  const engine = String((environment['browser'] as { engine?: string } | undefined)?.engine);
  await commands.record(`${engine}-${name}.json`, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

describe('the performance benchmark (§26.1, QA-010)', () => {
  it('measures the standard fixture', async () => {
    const result = await measure('standard', STANDARD);
    expect(result.measures.cold.trials).toHaveLength(settings.trials);
  });

  it('measures the stress fixture', async () => {
    const result = await measure('stress', STRESS);
    expect(result.measures.cold.trials).toHaveLength(settings.trials);
  });
});
