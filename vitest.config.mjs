import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (pkg) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

// Tests run against each package's TypeScript source, so they need no prior build.
export default defineConfig({
  resolve: {
    alias: {
      '@swf/math': source('math'),
      '@swf/core': source('core'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
  },
});
