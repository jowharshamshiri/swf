import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArguments, vitest } from './browsers.mjs';

/**
 * Runs the performance benchmark (§26.1) in each browser in turn, one at a time so that no run
 * competes with another for the machine, and writes what each measured as
 * `<out>/<engine>-<fixture>.json`, with `<out>/benchmark.md`: every browser's measures by median,
 * 95th percentile and maximum over its trials, with the environment and the method (AN-010).
 * Exits non-zero when a run failed or the standard fixture missed a budget.
 *
 *   npm run bench -- --out <folder> [--browsers chromium,firefox,webkit]
 *
 * SWF_CHROMIUM_CHANNEL and SWF_FIREFOX_CHANNEL run installed stable browsers; SWF_BENCH_TRIALS,
 * SWF_BENCH_WARMUP_MS, SWF_BENCH_TRIAL_MS and SWF_BENCH_SEED change the method (see
 * vitest.bench.config.mjs), and the report says what they were.
 */

const USAGE = 'usage: npm run bench -- --out <folder> [--browsers chromium,firefox,webkit]';
const { out, browsers } = parseArguments(process.argv.slice(2), USAGE);
await mkdir(out, { recursive: true });

const codes = {};
for (const browser of browsers) {
  codes[browser] = await vitest(browser, ['--config', 'vitest.bench.config.mjs'], {
    SWF_RECORD_DIR: out,
  });
}

const results = [];
for (const name of (await readdir(out))
  .filter((f) => /^[a-z]+-(standard|stress)\.json$/.test(f))
  .sort()) {
  results.push(JSON.parse(await readFile(path.join(out, name), 'utf8')));
}

const ms = (v) => (v === null || v === undefined ? '–' : `${v.toFixed(2)} ms`);
const pct = (v) => `${(100 * v).toFixed(1)}%`;
const mib = (v) => `${(v / 1048576).toFixed(2)} MiB`;
const triple = (s, unit = ms) =>
  s === null || s === undefined ? '–' : `${unit(s.median)} / ${unit(s.p95)} / ${unit(s.max)}`;
/** The median, p95 and max over trials of one number each trial gave. */
const across = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q) => sorted[Math.max(1, Math.ceil(q * sorted.length)) - 1];
  return sorted.length === 0 ? null : { median: at(0.5), p95: at(0.95), max: sorted.at(-1) };
};
const verdict = (v) =>
  v === undefined ? '–' : v.pass === null ? 'not measurable' : v.pass ? 'met' : 'MISSED';

const lines = ['# Performance benchmark', ''];
for (const r of results) {
  const env = r.environment;
  const m = r.measures;
  lines.push(
    `## ${env.browser.engine} ${env.browser.version}: ${r.fixture.name} fixture`,
    '',
    `${String(r.fixture.windows)} windows, ${String(r.fixture.surfaces)} surfaces, ${String(r.fixture.groups)} nested groups, ${String(r.fixture.viewports.length)} viewports, seed ${String(r.fixture.seed)}; ${r.date}.`,
    '',
    '**Environment.** ' +
      `${env.machine.os} (${env.machine.platform} ${env.machine.arch}), ${env.machine.cpu ?? 'unknown CPU'}, ${String(env.machine.cores)} cores, ${mib(env.machine.memoryBytes)} memory; ` +
      `GPU ${String(env.page.gpu)}; page ${String(env.page.inner.width)}×${String(env.page.inner.height)} at ${String(env.page.devicePixelRatio)}×, ` +
      `timer resolution ${(env.page.timerResolutionMs * 1000).toFixed(0)} µs, cross-origin isolated ${String(env.page.crossOriginIsolated)}; ` +
      `${env.browser.userAgent}; Node ${env.tools.node}, Playwright ${env.tools.playwright}, Vitest ${env.tools.vitest}.`,
    '',
    `**Method.** ${String(r.method.trials)} trials; each scenario ${String(r.method.trialMs / 1000)} s after a ${String(r.method.warmupMs / 1000)} s warm-up, the real mouse moved every ${String(r.method.pointer.stepMs)} ms in ${r.method.pointer.sweeps} (the camera turned by ${String(r.method.pointer.rotation.amplitudePx)} px each way every ${String(r.method.pointer.rotation.periodMs / 1000)} s, a window dragged ${String(r.method.pointer.drag.amplitudePx)} px each way every ${String(r.method.pointer.drag.periodMs / 1000)} s). Frames: ${r.method.frames}. Latency: ${r.method.latency}. Heap: ${r.method.heap}. Hit queries: ${String(r.method.picks.points)} points × ${String(r.method.picks.perPoint)} queries each. Growth: one window moved ${String(r.method.growth.moves)} times at ${r.method.growth.sizes.join(', ')} windows.`,
    '',
    '| Measure | median / p95 / max over trials |',
    '| --- | --- |',
    `| Cold creation to first frames (NFR-007) | ${triple(m.cold.summary)} |`,
    `| Retained heap of the presented fixture (NFR-006) | ${m.heap === null ? 'not measurable: the engine reports no heap' : triple(m.heap.summary, mib)} |`,
    `| Hit query p95 per trial (NFR-003) | ${triple(across(m.picks.trials.map((t) => t.p95)))} |`,
    `| Camera turn: intervals in budget per trial (NFR-001) | ${triple(across(m.rotation.trials.map((t) => t.frames.withinBudget)), pct)} |`,
    `| Camera turn: frame interval p95 per trial | ${triple(across(m.rotation.trials.map((t) => t.frames.intervals.p95)))} |`,
    `| Camera turn: frames skipped per trial | ${triple(across(m.rotation.trials.map((t) => t.frames.skipped)), String)} |`,
    `| Camera turn: presenter time per frame, p95 per trial | ${triple(across(m.rotation.trials.flatMap((t) => (t.presenterMs === null ? [] : [t.presenterMs.p95]))))} |`,
    `| Window drag: intervals in budget per trial (NFR-001) | ${triple(across(m.drag.trials.map((t) => t.frames.withinBudget)), pct)} |`,
    `| Window drag: frame interval p95 per trial | ${triple(across(m.drag.trials.map((t) => t.frames.intervals.p95)))} |`,
    `| Window drag: frames skipped per trial | ${triple(across(m.drag.trials.map((t) => t.frames.skipped)), String)} |`,
    `| Window drag: presenter time per frame, p95 per trial | ${triple(across(m.drag.trials.flatMap((t) => (t.presenterMs === null ? [] : [t.presenterMs.p95]))))} |`,
    `| Input to visible preview, p95 per trial (NFR-004) | ${triple(across(m.drag.trials.map((t) => t.latency.p95)))} |`,
    `| Input to visible preview, max per trial | ${triple(across(m.drag.trials.map((t) => t.latency.max)))} |`,
    `| Pointer moves waiting at most, per trial | ${triple(across(m.drag.trials.map((t) => t.maxPending)), String)} |`,
    `| One window's move: growth exponent, transaction / frame (NFR-008) | ${m.growth.exponents.transaction.toFixed(2)} / ${m.growth.exponents.frame.toFixed(2)} |`,
    `| One window's move: frame cost at ${m.growth.frame.map((g) => String(g.n)).join(' / ')} windows | ${m.growth.frame.map((g) => ms(g.cost)).join(' / ')} |`,
    '',
    '| Target | Verdict |',
    '| --- | --- |',
    ...Object.entries(r.verdicts).map(([id, v]) => `| ${id}: ${v.target} | ${verdict(v)} |`),
    '',
  );
}
lines.push('## Runs', '', ...browsers.map((b) => `- ${b}: exit ${String(codes[b])}`), '');
await writeFile(path.join(out, 'benchmark.md'), `${lines.join('\n')}\n`);
process.stdout.write(`recorded in ${out}\n`);

const missed = results.some((r) => Object.values(r.verdicts).some((v) => v.pass === false));
process.exit(Object.values(codes).some((c) => c !== 0) || missed ? 1 : 0);
