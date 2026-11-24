import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

const PACKAGES = [
  'math',
  'core',
  'surfaces',
  'presentation',
  'projections',
  'interaction',
  'backend-dom',
  'backend-geometry',
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
 * Builds one self-contained page: the script and styles are inlined into index.html, so the
 * application runs from any static host or straight from the file, offline, with nothing to fetch.
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

export default defineConfig({
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
  },
  plugins: [singleFile()],
});
