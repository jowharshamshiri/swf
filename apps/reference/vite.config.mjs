import { fileURLToPath, URL } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { UIKIT_MISSING, uikitPresent } from '../../scripts/uikit.mjs';

// The application is built from the wsb UI kit: without it there is nothing to build.
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
  'diagnostics',
  'persistence',
  'navigation',
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
// The navigation controls, by their public entry point, as a host takes them.
alias['@swf/navigation-ui'] = fileURLToPath(
  new URL('../../ui/navigation/src/index.ts', import.meta.url),
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

/**
 * What each mode's build carries, beyond the application itself:
 * - the debug overlay (ENV-005): the developer panel, its tools and the diagnostics package;
 * - the experiment panel: each of the eight capabilities turned on and off, alone or combined.
 * Development and staging carry both; production the experiment panel alone; `everyday` neither,
 * a production build with every capability on and the everyday controls (the view's switcher and
 * sliders, the radar, the inspector, the command list). Any other mode is refused, naming it.
 */
const MODES = Object.freeze({
  development: { developer: true, experiments: true },
  staging: { developer: true, experiments: true },
  production: { developer: false, experiments: true },
  everyday: { developer: false, experiments: false },
});

/** What a mode's build carries, or an error naming the mode when it is none of {@link MODES}. */
function carried(mode) {
  if (!Object.hasOwn(MODES, mode)) {
    throw new Error(
      `the reference application has no build mode "${mode}"; its modes are ${Object.keys(MODES).join(', ')}`,
    );
  }
  return MODES[mode];
}

/**
 * A module the build fills with a view or with none: `export const <name>` is the view's
 * component where the mode carries it, null where it does not, so nothing of a view left out
 * reaches the bundle. `from` is the view's own file, or the package and the component it exports.
 */
function optionalView(module, name, from, carries) {
  const resolved = `\0${module}`;
  const view =
    'file' in from
      ? `export { default as ${name} } from ${JSON.stringify(fileURLToPath(new URL(from.file, import.meta.url)))};`
      : `export { ${from.component} as ${name} } from ${JSON.stringify(from.package)};`;
  return {
    name: `swf-optional-${name}`,
    resolveId: (id) => (id === module ? resolved : null),
    load: (id) => (id !== resolved ? null : carries ? view : `export const ${name} = null;`),
  };
}

export default defineConfig(({ mode }) => {
  const carries = carried(mode);
  return {
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
    plugins: [
      svelte(),
      uikit(),
      optionalView(
        'virtual:reference/debug',
        'developer',
        { file: './src/shell/DeveloperView.svelte' },
        carries.developer,
      ),
      optionalView(
        'virtual:reference/experiments',
        'experiments',
        { package: '@swf/navigation-ui', component: 'ExperimentPanel' },
        carries.experiments,
      ),
      singleFile(),
    ],
  };
});
