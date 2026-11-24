import { defineConfig } from 'vitest/config';

// Tests of the reference application as built and served: they build it, run its dev server and
// open it in Chromium through Playwright (`npx playwright install chromium` once).
export default defineConfig({
  test: {
    include: ['apps/*/test/**/*.build.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
