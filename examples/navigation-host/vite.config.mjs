import { fileURLToPath, URL } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { UIKIT_MISSING, uikitPresent } from '../../scripts/uikit.mjs';

// The host is built on the wsb UI kit, as the workbench is: without it there is nothing to build.
if (!uikitPresent()) throw new Error(UIKIT_MISSING);
const { uikit } = await import('@wsb/uikit/vite');

const PACKAGES = [
  'math',
  'models',
  'core',
  'surfaces',
  'presentation',
  'projections',
  'interaction',
  'backend-dom',
  'backend-geometry',
  'navigation',
];

/**
 * The framework's packages and its navigation controls, each by its public entry point, so the
 * host sees exactly what any host sees.
 */
const alias = {
  ...Object.fromEntries(
    PACKAGES.map((pkg) => [
      `@swf/${pkg}`,
      fileURLToPath(new URL(`../../packages/${pkg}/src/index.ts`, import.meta.url)),
    ]),
  ),
  '@swf/navigation-ui': fileURLToPath(new URL('../../ui/navigation/src/index.ts', import.meta.url)),
};

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  resolve: { alias },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
  plugins: [svelte(), uikit()],
});
