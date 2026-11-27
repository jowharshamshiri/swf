import { readFileSync } from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import {
  browserInstances,
  headless,
  environment,
  heap,
  mouse,
  record,
  sweep,
} from './vitest.browsers.mjs';
import nodeConfig from './vitest.config.mjs';

/**
 * The performance benchmark (§26.1): run by `npm run bench`, one browser at a time, on a 1920×1080
 * page. SWF_RECORD_DIR is where each browser's results are written. SWF_BENCH_TRIALS,
 * SWF_BENCH_WARMUP_MS and SWF_BENCH_TRIAL_MS shorten a run for trying it out (defaults 5, 4000
 * and 60000, the benchmark's own: whole periods of both drags); SWF_BENCH_SEED picks the fixture's seed (default 1).
 * `bench-budgets.json` holds the stress fixture's pacing floors.
 */
function whole(name, fallback, min) {
  const text = process.env[name];
  const value = text === undefined || text === '' ? fallback : Number(text);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(
      `${name} must be a whole number of at least ${String(min)} (got "${String(text)}")`,
    );
  }
  return value;
}

/** The engines the benchmark runs in, as each names itself in a run's environment. */
const ENGINES = ['chromium', 'firefox', 'webkit'];

/**
 * The stress fixture's pacing floors from `bench-budgets.json`: for each engine, the least share
 * of frame intervals one display frame, in whole percent, while turning the camera and while
 * dragging a window. Every engine and both measures must be given, each a whole number from 0
 * to 100; anything else is refused, naming the field.
 */
function pacingFloors() {
  const file = new URL('./bench-budgets.json', import.meta.url);
  const budgets = JSON.parse(readFileSync(file, 'utf8'));
  const stress = budgets?.stress;
  if (typeof stress !== 'object' || stress === null) {
    throw new Error('bench-budgets.json must give stress, the stress fixture’s pacing floors');
  }
  for (const key of Object.keys(stress)) {
    if (!ENGINES.includes(key)) {
      throw new Error(`bench-budgets.json stress.${key} names no engine the benchmark runs in`);
    }
  }
  return Object.fromEntries(
    ENGINES.map((engine) => {
      const floors = stress[engine];
      if (typeof floors !== 'object' || floors === null) {
        throw new Error(`bench-budgets.json stress.${engine} must give the engine’s floors`);
      }
      for (const measure of ['cameraTurn', 'windowDrag']) {
        const value = floors[measure];
        if (!Number.isInteger(value) || value < 0 || value > 100) {
          throw new Error(
            `bench-budgets.json stress.${engine}.${measure} must be a whole percent from 0 to 100 (got ${JSON.stringify(value)})`,
          );
        }
      }
      return [engine, { cameraTurn: floors.cameraTurn, windowDrag: floors.windowDrag }];
    }),
  );
}

export default defineConfig({
  resolve: nodeConfig.resolve,
  // The page is cross-origin isolated, so every engine gives its finest timer.
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  test: {
    include: ['packages/benchmark/bench/**/*.bench.ts'],
    testTimeout: 3_600_000,
    fileParallelism: false,
    provide: {
      swfBench: {
        trials: whole('SWF_BENCH_TRIALS', 5, 1),
        warmupMs: whole('SWF_BENCH_WARMUP_MS', 4000, 0),
        trialMs: whole('SWF_BENCH_TRIAL_MS', 60_000, 1000),
        seed: whole('SWF_BENCH_SEED', 1, 0),
        pacing: pacingFloors(),
      },
    },
    browser: {
      enabled: true,
      headless: headless(),
      viewport: { width: 1920, height: 1080 },
      provider: playwright(),
      commands: { mouse, sweep, heap, environment, record },
      instances: browserInstances(),
    },
  },
});
