import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { UIKIT_SKIPPED, uikitPresent } from './uikit.mjs';

/**
 * The local check, in order: the models match their proofs, formatting, the packages' build,
 * their bundle sizes and their packed install, types, lint, the API reference, every test, and the
 * builds of the reference application and the navigation host. Stops at the first step that fails.
 *
 *   npm run check
 *
 * The reference application, the navigation controls and the navigation host are built from the
 * wsb UI kit, whose repository is not public. A checkout without it checks every framework package
 * and the other examples, leaves those three out, and says so before and after.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const withApp = uikitPresent();
const { workspaces } = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const steps = [
  ['run', 'models:verify'],
  ['run', 'format:check'],
  ['run', 'build:packages'],
  ['run', 'size'],
  ['run', 'smoke:packages'],
  withApp
    ? ['run', 'typecheck']
    : [
        'run',
        'typecheck',
        ...workspaces
          .filter(
            (w) =>
              w !== 'apps/reference' && w !== 'examples/navigation-host' && !w.startsWith('ui/'),
          )
          .flatMap((w) => ['--workspace', w]),
      ],
  ['run', 'lint'],
  ['run', 'api-reference', '--', '--check'],
  ['run', 'test'],
  ...(withApp
    ? [
        ['run', 'build', '--workspace', '@swf/reference'],
        ['run', 'build', '--workspace', '@swf/example-navigation-host'],
      ]
    : []),
];

if (!withApp) process.stderr.write(`${UIKIT_SKIPPED}\n\n`);
for (const step of steps) {
  process.stdout.write(`\n> npm ${step.join(' ')}\n`);
  const result = spawnSync('npm', step, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    process.stderr.write(`\ncheck: npm ${step.join(' ')} failed (exit ${String(result.status)})\n`);
    process.exit(result.status ?? 1);
  }
}
process.stdout.write(
  withApp
    ? '\ncheck: every step passed.\n'
    : '\ncheck: every step passed for the framework packages and the other examples; the reference application, the navigation controls and the navigation host were skipped (see above).\n',
);
