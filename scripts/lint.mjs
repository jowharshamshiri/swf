import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { UIKIT_SAID, withReferenceApp } from './uikit.mjs';

/**
 * Lints the repository with ESLint, each workspace in an ESLint process of its own and the rest of
 * the repository in one more, a few at a time.
 *
 *   npm run lint
 *
 * Type-aware linting builds one TypeScript program for each tsconfig it meets and keeps every one
 * for the whole run, so one process over the whole repository needs the memory of all of them at
 * once (2.3 to 2.6 GB of heap with twenty-one), past Node's default heap on a machine of 16 GB.
 * One process a workspace needs only that workspace's programs (the reference application's, the
 * largest, peaks at 1.2 GB), however many workspaces there are. Arguments are passed to every
 * ESLint run (`npm run lint -- --fix`).
 */

const ROOT = path.resolve(import.meta.dirname, '..');
// Said once here, when the kit is missing, rather than by every run.
withReferenceApp();
const ESLINT = path.join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');
/** Runs at once: each holds its workspace's programs. */
const AT_ONCE = Math.max(1, Math.min(3, os.availableParallelism() - 1));

const { workspaces } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const within = (outer, inner) => inner !== outer && inner.startsWith(`${outer}/`);
/** Each workspace without the workspaces inside it, then everything outside every workspace. */
const runs = [
  ...workspaces.map((workspace) => [
    workspace,
    ...workspaces
      .filter((other) => within(workspace, other))
      .flatMap((other) => ['--ignore-pattern', `${other}/**`]),
  ]),
  ['.', ...workspaces.flatMap((workspace) => ['--ignore-pattern', `${workspace}/**`])],
];

/** One ESLint run: its exit code and everything it printed. */
function lint(args) {
  return new Promise((resolve, reject) => {
    // A workspace the configuration leaves out (one built on the kit, in a checkout without it)
    // matches nothing, which is no failure.
    const flags = ['--no-error-on-unmatched-pattern', ...process.argv.slice(2)];
    const child = spawn(process.execPath, [ESLINT, ...args, ...flags], {
      cwd: ROOT,
      env: { ...process.env, [UIKIT_SAID]: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code: code ?? 1, signal, output }));
  });
}

const results = new Array(runs.length);
let next = 0;
await Promise.all(
  Array.from({ length: AT_ONCE }, async () => {
    while (next < runs.length) {
      const index = next;
      next += 1;
      results[index] = await lint(runs[index]);
    }
  }),
);

let failed = 0;
runs.forEach((args, i) => {
  const { code, signal, output } = results[i];
  if (output.trim() !== '') {
    process.stdout.write(output);
  }
  if (code !== 0) {
    failed += 1;
    process.stderr.write(
      `lint: ${args[0]} failed (${signal === null ? `exit ${String(code)}` : `signal ${signal}`})\n`,
    );
  }
});
process.exit(failed === 0 ? 0 : 1);
