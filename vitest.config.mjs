import { fileURLToPath, URL } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';
import { withReferenceApp } from './scripts/uikit.mjs';

// The reference application and the navigation controls need the wsb UI kit; without it, their
// tests are left out, saying so.
const withApp = withReferenceApp();
// The navigation controls are Svelte components on the kit: a test that imports their package
// compiles them, as a host's build does.
const plugins = withApp ? [svelte(), (await import('@wsb/uikit/vite')).uikit()] : [];

const source = (pkg) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

/** The tests that time work against a budget (a p95 in milliseconds). */
const TIMED = [
  'packages/core/test/performance.test.ts',
  'packages/interaction/test/benchmark.test.ts',
];

// Tests run against each package's TypeScript source, so they need no prior build.
export default defineConfig({
  plugins,
  resolve: {
    alias: {
      '@swf/math': source('math'),
      '@swf/models': source('models'),
      '@swf/core': source('core'),
      '@swf/surfaces': source('surfaces'),
      '@swf/presentation': source('presentation'),
      '@swf/projections': source('projections'),
      '@swf/interaction': source('interaction'),
      '@swf/backend-dom': source('backend-dom'),
      '@swf/backend-geometry': source('backend-geometry'),
      '@swf/conformance': source('conformance'),
      '@swf/diagnostics': source('diagnostics'),
      '@swf/persistence': source('persistence'),
      '@swf/navigation': source('navigation'),
      '@swf/benchmark': source('benchmark'),
      '@swf/navigation-ui': fileURLToPath(new URL('./ui/navigation/src/index.ts', import.meta.url)),
    },
  },
  test: {
    // The kit and its icons ship as source a bundler resolves: the tests compile them as one does.
    ...(withApp ? { server: { deps: { inline: [/@wsb\/uikit/, /lucide-svelte/] } } } : {}),
    // Browser tests need a real browser: `npm run test:browser`.
    exclude: ['**/*.browser.test.ts', '**/*.build.test.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'units',
          include: [
            'packages/*/test/**/*.test.ts',
            ...(withApp ? ['apps/*/test/**/*.test.ts', 'ui/*/test/**/*.test.ts'] : []),
            'examples/test/**/*.test.ts',
            'scripts/test/**/*.test.mjs',
          ],
          exclude: ['**/*.browser.test.ts', '**/*.build.test.ts', ...TIMED],
        },
      },
      {
        // The tests that hold work to a time run after the rest, one file at a time: beside the
        // other files' workers they measure the machine's contention, not the work.
        extends: true,
        test: {
          name: 'timed',
          include: TIMED,
          fileParallelism: false,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
