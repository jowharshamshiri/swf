import { svelte } from '@sveltejs/vite-plugin-svelte';
import { playwright } from '@vitest/browser-playwright';
import { uikit } from '@wsb/uikit/vite';
import { defineConfig } from 'vitest/config';
import { browserInstances, emulate, heap, mouse } from './vitest.browsers.mjs';
import nodeConfig from './vitest.config.mjs';

// Browser tests run in real browsers through Playwright: `browserInstances` says which.
export default defineConfig({
  resolve: nodeConfig.resolve,
  // The reference application's shell is Svelte, built from the kit.
  plugins: [svelte(), uikit()],
  test: {
    include: ['packages/*/test/**/*.browser.test.ts', 'apps/*/test/**/*.browser.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      // Room for an 800 × 400 view and more.
      viewport: { width: 1280, height: 900 },
      provider: playwright(),
      commands: { mouse, heap, emulate },
      instances: browserInstances(),
    },
  },
});
