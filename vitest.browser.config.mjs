import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { withReferenceApp } from './scripts/uikit.mjs';
import {
  browserInstances,
  headless,
  emulate,
  heap,
  mouse,
  pen,
  touch,
  wheel,
} from './vitest.browsers.mjs';
import nodeConfig from './vitest.config.mjs';

// The reference application's shell is Svelte, built from the wsb UI kit; a checkout without the
// kit runs the packages' browser suites alone, saying so.
const withApp = withReferenceApp();

// Browser tests run in real browsers through Playwright: `browserInstances` says which.
export default defineConfig({
  resolve: nodeConfig.resolve,
  plugins: nodeConfig.plugins,
  test: {
    include: [
      'packages/*/test/**/*.browser.test.ts',
      ...(withApp
        ? [
            'apps/*/test/**/*.browser.test.ts',
            'ui/*/test/**/*.browser.test.ts',
            'examples/*/test/**/*.browser.test.ts',
          ]
        : []),
    ],
    // One file at a time: the suites drive the browser's real mouse and keyboard, which its pages
    // share. Run side by side, a page taking input takes the foreground from another, and Firefox
    // then drops that page's pointer capture in the middle of a drag (seen as drags cancelled at
    // random in stable Firefox; none in five runs of the suites one file at a time).
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: headless(),
      // Room for an 800 × 400 view and more.
      viewport: { width: 1280, height: 900 },
      provider: playwright(),
      commands: { mouse, heap, emulate, wheel, touch, pen },
      instances: browserInstances(),
    },
  },
});
