import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { browserVersion, machine, parseArguments, vitest } from './browsers.mjs';

/**
 * Runs the browser suites in each browser in turn and records, per browser, every test and how it
 * ended, with each of the end-to-end acceptance scenarios (§33.2) gathered from the tests that
 * name it: `<out>/<browser>-tests.json` (Vitest's own report), `<out>/<browser>-failures.json`
 * (each failed test with its errors' messages), `<out>/conformance.json` and
 * `<out>/conformance.md`. Exits non-zero when any test failed or any scenario has no test.
 *
 *   npm run conformance -- --out <folder> [--browsers chromium,firefox,webkit]
 *
 * SWF_CHROMIUM_CHANNEL and SWF_FIREFOX_CHANNEL run installed stable browsers (`chrome`,
 * `moz-firefox`) in place of Playwright's own builds.
 */

const USAGE = 'usage: npm run conformance -- --out <folder> [--browsers chromium,firefox,webkit]';
const SCENARIOS = Array.from({ length: 10 }, (_, i) => i + 1);

const { out, browsers } = parseArguments(process.argv.slice(2), USAGE);
await mkdir(out, { recursive: true });

const runs = [];
for (const browser of browsers) {
  const report = path.join(out, `${browser}-tests.json`);
  const failuresFile = path.join(out, `${browser}-failures.json`);
  const code = await vitest(
    browser,
    [
      '--config',
      'vitest.browser.config.mjs',
      '--reporter=default',
      '--reporter=json',
      `--outputFile.json=${report}`,
      '--reporter=./scripts/failures-reporter.mjs',
    ],
    { SWF_FAILURES_FILE: failuresFile },
  );
  const json = JSON.parse(await readFile(report, 'utf8'));
  const failures = JSON.parse(await readFile(failuresFile, 'utf8'));
  const tests = json.testResults.flatMap((file) =>
    file.assertionResults.map((t) => ({
      file: path.relative(process.cwd(), file.name),
      name: t.fullName,
      status: t.status,
    })),
  );
  runs.push({ ...(await browserVersion(browser)), exitCode: code, tests, failures });
}

/** The tests of a scenario: those whose names say `§33.2 scenario <n>`. */
const ofScenario = (tests, n) =>
  tests.filter((t) => new RegExp(`§33\\.2 scenario ${String(n)}(?!\\d)`).test(t.name));

const record = {
  date: new Date().toISOString(),
  machine: machine(),
  browsers: runs.map((run) => {
    const counts = run.tests.reduce((c, t) => ({ ...c, [t.status]: (c[t.status] ?? 0) + 1 }), {});
    return {
      browser: run.browser,
      channel: run.channel,
      version: run.version,
      exitCode: run.exitCode,
      counts,
      failures: run.failures,
      scenarios: SCENARIOS.map((n) => {
        const tests = ofScenario(run.tests, n);
        return {
          scenario: n,
          status:
            tests.length === 0
              ? 'missing'
              : tests.every((t) => t.status === 'passed')
                ? 'passed'
                : 'failed',
          tests,
        };
      }),
    };
  }),
};
await writeFile(path.join(out, 'conformance.json'), `${JSON.stringify(record, null, 2)}\n`);

const lines = [
  '# Browser conformance',
  '',
  `Recorded ${record.date} on ${record.machine.os} (${record.machine.arch}), ${record.machine.cpu ?? 'unknown CPU'}, ${String(record.machine.cores)} cores, Node ${record.machine.node}.`,
  '',
  '## End-to-end acceptance scenarios (§33.2)',
  '',
  `| Scenario | ${record.browsers.map((b) => `${b.browser}${b.channel === null ? '' : ` (${b.channel})`} ${b.version}`).join(' | ')} |`,
  `| --- | ${record.browsers.map(() => '---').join(' | ')} |`,
  ...SCENARIOS.map(
    (n) =>
      `| ${String(n)} | ${record.browsers
        .map((b) => {
          const s = b.scenarios[n - 1];
          return `${s.status} (${String(s.tests.length)} test${s.tests.length === 1 ? '' : 's'})`;
        })
        .join(' | ')} |`,
  ),
  '',
  '## Every browser test',
  '',
  ...record.browsers.map(
    (b) =>
      `- ${b.browser} ${b.version}: ${Object.entries(b.counts)
        .map(([status, n]) => `${String(n)} ${status}`)
        .join(', ')} (exit ${String(b.exitCode)})`,
  ),
  '',
  '## Failures',
  '',
  ...(record.browsers.every((b) => b.failures.length === 0)
    ? ['None.', '']
    : record.browsers.flatMap((b) =>
        b.failures.flatMap((f) => [
          `- ${b.browser} ${b.version}: ${f.file}: ${f.name}`,
          ...f.errors.map((e) => `  - ${e.message.split('\n')[0] ?? ''}`),
        ]),
      )),
  '',
  '## Tests by scenario',
  '',
  ...SCENARIOS.flatMap((n) => [
    `### Scenario ${String(n)}`,
    '',
    ...(record.browsers[0]?.scenarios[n - 1]?.tests ?? []).map((t) => `- ${t.file}: ${t.name}`),
    '',
  ]),
];
await writeFile(path.join(out, 'conformance.md'), `${lines.join('\n')}\n`);
process.stdout.write(`recorded in ${out}\n`);

const failed = record.browsers.some(
  (b) => b.exitCode !== 0 || b.scenarios.some((s) => s.status !== 'passed'),
);
process.exit(failed ? 1 : 0);
