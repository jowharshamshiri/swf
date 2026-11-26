import { defineConfig } from 'vitest/config';
import { withReferenceApp } from './scripts/uikit.mjs';

const withApp = withReferenceApp();

// Tests of the reference application as built and served: they build it, run its dev server and
// open it through Playwright, in Chromium, and the dev server's page also in Firefox and WebKit
// (`npx playwright install --with-deps chromium firefox webkit` once).
export default defineConfig({
  test: {
    include: [
      ...(withApp ? ['apps/*/test/**/*.build.test.ts'] : []),
      'examples/test/**/*.build.test.ts',
    ],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
