import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { chromium, firefox, webkit } from 'playwright';

/**
 * What the conformance and benchmark runners share: their arguments, the browsers they run, each
 * browser's own version, the machine, and running Vitest once per browser.
 */

const ENGINES = { chromium, firefox, webkit };
export const KNOWN = Object.keys(ENGINES);

/**
 * `--out <folder>` (required, made if missing) and `--browsers a,b` (default all three, or what
 * SWF_BROWSERS says). Exits with a message naming the argument at fault.
 */
export function parseArguments(argv, usage) {
  const args = { out: null, browsers: (process.env.SWF_BROWSERS ?? KNOWN.join(',')).split(',') };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (
      (flag === '--out' || flag === '--browsers') &&
      (value === undefined || value.startsWith('--'))
    ) {
      fail(`${flag} needs a value\n${usage}`);
    }
    if (flag === '--out') {
      args.out = path.resolve(value);
      i += 1;
    } else if (flag === '--browsers') {
      args.browsers = value.split(',');
      i += 1;
    } else {
      fail(`unknown argument "${flag}"\n${usage}`);
    }
  }
  args.browsers = args.browsers.map((b) => b.trim()).filter((b) => b !== '');
  const unknown = args.browsers.find((b) => !KNOWN.includes(b));
  if (unknown !== undefined || args.browsers.length === 0) {
    fail(`--browsers must list some of ${KNOWN.join(', ')} (got "${args.browsers.join(',')}")`);
  }
  if (args.out === null) {
    fail(`--out is required\n${usage}`);
  }
  return args;
}

export function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/** The channel a browser runs as, from SWF_CHROMIUM_CHANNEL or SWF_FIREFOX_CHANNEL; '' for Playwright's own build. */
export function channelOf(browser) {
  return (
    { chromium: process.env.SWF_CHROMIUM_CHANNEL, firefox: process.env.SWF_FIREFOX_CHANNEL }[
      browser
    ] ?? ''
  );
}

/** A browser's name and version as it runs, launched once and closed. */
export async function browserVersion(browser) {
  const channel = channelOf(browser);
  const launched = await ENGINES[browser].launch(channel === '' ? {} : { channel });
  try {
    return { browser, channel: channel === '' ? null : channel, version: launched.version() };
  } finally {
    await launched.close();
  }
}

/** The machine a run is made on. */
export function machine() {
  const cpus = os.cpus();
  return {
    os: `${os.type()} ${os.release()}`,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus[0]?.model ?? null,
    cores: cpus.length,
    memoryBytes: os.totalmem(),
    node: process.version,
  };
}

/** Runs Vitest with `args` for one browser; resolves to its exit code. */
export function vitest(browser, args, env = {}) {
  return new Promise((resolve, reject) => {
    const bin = path.join('node_modules', 'vitest', 'vitest.mjs');
    const child = spawn(process.execPath, [bin, 'run', ...args], {
      stdio: 'inherit',
      env: { ...process.env, ...env, SWF_BROWSERS: browser },
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      resolve(signal === null ? (code ?? 1) : 1);
    });
  });
}
