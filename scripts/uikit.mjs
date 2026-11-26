import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * Whether this checkout has the UI kit the reference application (`apps/reference`) is built
 * from, and what to say when it has not. The kit comes from the git submodule `wsb`, whose
 * repository is not public: a clone without access to it checks and builds every package and the
 * examples, and leaves the reference application out, saying so.
 */

const ROOT = path.resolve(import.meta.dirname, '..');

/** The kit's manifest, present when the `wsb` submodule is checked out. */
const MANIFEST = path.join(ROOT, 'wsb/wsb/daemon/uikit/package.json');

/** Whether the reference application's UI kit is in this checkout. */
export function uikitPresent() {
  return existsSync(MANIFEST);
}

/** What a checkout without the kit is told. */
export const UIKIT_MISSING =
  'The reference application (apps/reference) is built from the wsb UI kit, which comes from the ' +
  'git submodule wsb (https://github.com/jowharshamshiri/wsb). That repository is not public, ' +
  'and this checkout does not have it: with access to it, run `git submodule update --init wsb` ' +
  'and then `npm install`.';

/** What the package checks say when they leave the reference application out. */
export const UIKIT_SKIPPED = `${UIKIT_MISSING} Until then the reference application, the navigation controls (ui/navigation) and the navigation host (examples/navigation-host) are skipped; every framework package and the other examples are checked.`;

/** Set in the environment of a process whose parent has said the kit is missing already. */
export const UIKIT_SAID = 'SWF_UIKIT_SKIP_SAID';

/**
 * Whether the kit is present; when it is not, says once in this process that the reference
 * application is skipped. The test and lint configurations ask this.
 */
export function withReferenceApp() {
  const present = uikitPresent();
  const said = Symbol.for('swf.uikit.skipped');
  if (!present && globalThis[said] !== true && process.env[UIKIT_SAID] !== '1') {
    globalThis[said] = true;
    process.stderr.write(`${UIKIT_SKIPPED}\n`);
  }
  return present;
}
