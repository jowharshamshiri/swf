import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (pkg) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

// Tests run against each package's TypeScript source, so they need no prior build.
export default defineConfig({
  resolve: {
    alias: {
      '@swf/math': source('math'),
      '@swf/core': source('core'),
      '@swf/surfaces': source('surfaces'),
      '@swf/presentation': source('presentation'),
      '@swf/projections': source('projections'),
      '@swf/interaction': source('interaction'),
      '@swf/backend-dom': source('backend-dom'),
      '@swf/backend-geometry': source('backend-geometry'),
      '@swf/conformance': source('conformance'),
      '@swf/diagnostics': source('diagnostics'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // Browser tests need a real browser: `npm run test:browser`.
    exclude: ['packages/*/test/**/*.browser.test.ts'],
  },
});
