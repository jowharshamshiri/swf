import { fileURLToPath, URL } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { uikit } from '@wsb/uikit/vite';
import { defineConfig } from 'vite';

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
  'diagnostics',
  'persistence',
];

/**
 * The framework's packages, each by its public entry point, so the application sees exactly what
 * any host sees, and edits to a package reload the application in development.
 */
const alias = Object.fromEntries(
  PACKAGES.map((pkg) => [
    `@swf/${pkg}`,
    fileURLToPath(new URL(`../../packages/${pkg}/src/index.ts`, import.meta.url)),
  ]),
);

/** Text safe to put inside an inline script or style element. */
const inlineSafe = (code, tag) => code.replaceAll(`</${tag}`, `<\\/${tag}`);

/**
 * Builds one self-contained page: the script and styles, with the kit's faces in them, are inlined
 * into index.html, so the application runs from any static host or straight from the file, offline,
 * with nothing to fetch.
 */
function singleFile() {
  return {
    name: 'swf-single-file',
    enforce: 'post',
    apply: 'build',
    generateBundle(_options, bundle) {
      const page = bundle['index.html'];
      if (page?.type !== 'asset') {
        throw new Error('the build has no index.html');
      }
      let html = String(page.source);
      for (const [name, item] of Object.entries(bundle)) {
        if (item.type === 'chunk') {
          const tag = new RegExp(`<script type="module" crossorigin src="[^"]*${name}"></script>`);
          if (!tag.test(html)) {
            throw new Error(`index.html does not load the chunk ${name}`);
          }
          html = html.replace(
            tag,
            () => `<script type="module">${inlineSafe(item.code, 'script')}</script>`,
          );
          Reflect.deleteProperty(bundle, name);
        } else if (name.endsWith('.css')) {
          const tag = new RegExp(`<link rel="stylesheet" crossorigin href="[^"]*${name}">`);
          if (!tag.test(html)) {
            throw new Error(`index.html does not load the stylesheet ${name}`);
          }
          html = html.replace(
            tag,
            () => `<style>${inlineSafe(String(item.source), 'style')}</style>`,
          );
          Reflect.deleteProperty(bundle, name);
        }
      }
      page.source = html;
      const left = Object.keys(bundle).filter((name) => name !== 'index.html');
      if (left.length > 0) {
        throw new Error(`the build left files that the page would fetch: ${left.join(', ')}`);
      }
    },
  };
}

/** The module that says which debug overlay the build carries. */
const DEBUG_MODULE = 'virtual:reference/debug';

/**
 * The debug overlay (ENV-005): staging builds and development carry the developer panel;
 * production builds get a module holding none, so nothing of the panel, its tools or the diagnostics
 * package reaches their bundle.
 */
function debugOverlay(mode) {
  const resolved = `\0${DEBUG_MODULE}`;
  const view = fileURLToPath(new URL('./src/shell/DeveloperView.svelte', import.meta.url));
  return {
    name: 'swf-debug-overlay',
    resolveId: (id) => (id === DEBUG_MODULE ? resolved : null),
    load: (id) =>
      id !== resolved
        ? null
        : mode === 'production'
          ? 'export const developer = null;'
          : `export { default as developer } from ${JSON.stringify(view)};`,
  };
}

export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  resolve: { alias },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    modulePreload: false,
    cssCodeSplit: false,
    sourcemap: false,
    // The kit's faces too: a page opened from the file may load nothing else.
    assetsInlineLimit: () => true,
    // One chunk: the models program loads its WebAssembly host (and, under Node only, Node's
    // modules) through dynamic imports, which a page opened from the file must not fetch.
    rolldownOptions: { output: { codeSplitting: false } },
  },
  plugins: [svelte(), uikit(), debugOverlay(mode), singleFile()],
}));
