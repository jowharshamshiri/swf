import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import console from 'node:console';
import process from 'node:process';
import { gzipSync } from 'node:zlib';
import { rolldown } from 'rolldown';
import { uikitPresent } from './uikit.mjs';

/**
 * Bundles every published package as an application would and holds it to its budget.
 *
 * For each package, from its built `dist/` (run `npm run build:packages` first):
 * - its size: everything it exports, bundled and minified for the browser with the other
 *   `@swf/*` packages and its third-party dependencies left external, so the figure is the
 *   package's own code; measured minified and gzip-compressed;
 * - that it tree-shakes: importing it for nothing leaves nothing in the bundle, so a host pays
 *   only for what it uses. The one package declared to have a side effect, `@swf/models`, keeps
 *   its program's loading and nothing else.
 *
 * The navigation controls (`ui/`) are Svelte components on the wsb UI kit, shipped as source a
 * host's bundler compiles: where the kit is in the checkout, each is compiled for the browser as a
 * host's build does and measured the same way, with Svelte, the kit and the framework's packages
 * left external; without the kit it is left out, as the reference application is.
 *
 * `size-budgets.json` holds each package's budget (gzip bytes) and its recorded sizes. Every run
 * prints each package's sizes and the difference from the recorded ones; it fails when a package
 * is over its budget, does not tree-shake, or is missing from the file.
 *
 *   npm run size                 # measure, compare and enforce
 *   npm run size -- --record     # also write the measured sizes as the recorded ones
 *   npm run size -- --verify     # also fail when a measured size differs from the recorded one
 *
 * A budget is raised only deliberately, in `size-budgets.json`, never by --record.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const BUDGETS = path.join(ROOT, 'size-budgets.json');
const USAGE = 'usage: npm run size [-- --record | --verify]';

/** What a bare import of a package may keep: the packages that declare side effects. */
const DECLARED_SIDE_EFFECT = /^import\s*\{\s*BrowserWasi as \w+\s*\}\s*from\s*"lungo-ts\/wasi\.js"/;

const argv = process.argv.slice(2);
const record = argv.includes('--record');
const verify = argv.includes('--verify');
const unknown = argv.find((a) => a !== '--record' && a !== '--verify');
if (unknown !== undefined || (record && verify)) {
  console.error(unknown === undefined ? USAGE : `unknown argument "${unknown}"\n${USAGE}`);
  process.exit(2);
}

const { workspaces } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const withKit = uikitPresent();
const packages = [];
for (const workspace of workspaces.filter(
  (w) => w.startsWith('packages/') || (withKit && w.startsWith('ui/')),
)) {
  const manifest = JSON.parse(await readFile(path.join(ROOT, workspace, 'package.json'), 'utf8'));
  packages.push({
    name: manifest.name,
    sideEffects: manifest.sideEffects,
    svelte: workspace.startsWith('ui/'),
  });
}

const budgets = JSON.parse(await readFile(BUDGETS, 'utf8'));
const problems = [];
for (const name of Object.keys(budgets)) {
  if (!packages.some((p) => p.name === name) && !(name.endsWith('-ui') && !withKit)) {
    problems.push(`size-budgets.json names ${name}, which is not a published package`);
  }
}

/**
 * Compiles a Svelte package's sources as a host's build does: components and rune modules for the
 * browser, TypeScript stripped, its styles kept with its code.
 */
async function sveltePlugin() {
  const { compile, compileModule } = await import('svelte/compiler');
  const ts = (await import('typescript')).default;
  const strip = (code, fileName) =>
    ts.transpileModule(code, {
      fileName,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        verbatimModuleSyntax: true,
      },
    }).outputText;
  return {
    name: 'swf-size-svelte',
    transform(code, id) {
      if (id.endsWith('.svelte')) {
        return compile(code, { filename: id, generate: 'client', css: 'injected' }).js.code;
      }
      if (/\.svelte\.(?:ts|js)$/.test(id)) {
        const js = id.endsWith('.ts') ? strip(code, id) : code;
        return compileModule(js, { filename: id, generate: 'client' }).js.code;
      }
      return null;
    },
  };
}

/** The bundle of a one-line entry module, minified for the browser, with `own` bundled alone. */
async function bundle(own, entry, svelte = false) {
  const build = await rolldown({
    input: 'swf-size-entry',
    platform: 'browser',
    logLevel: 'silent',
    // Every bare specifier but the package measured: the other packages and third-party code.
    external: (id) =>
      id !== own && id !== 'swf-size-entry' && !id.startsWith('.') && !path.isAbsolute(id),
    plugins: [
      {
        name: 'swf-size-entry',
        resolveId: (id) => (id === 'swf-size-entry' ? id : null),
        load: (id) => (id === 'swf-size-entry' ? entry : null),
      },
      ...(svelte ? [await sveltePlugin()] : []),
    ],
  });
  try {
    const { output } = await build.generate({ format: 'esm', minify: true });
    return output.map((chunk) => (chunk.type === 'chunk' ? chunk.code : '')).join('');
  } finally {
    await build.close();
  }
}

const signed = (n) => (n > 0 ? `+${String(n)}` : String(n));
const rows = [];
for (const { name, sideEffects, svelte } of packages) {
  const entry = budgets[name];
  if (entry === undefined) {
    problems.push(`${name} has no budget in size-budgets.json`);
    continue;
  }
  if (typeof entry.budget !== 'number' || !(entry.budget > 0)) {
    problems.push(`size-budgets.json: ${name}.budget must be a positive number of gzip bytes`);
    continue;
  }
  const full = await bundle(name, `export * from '${name}';`, svelte);
  const minified = Buffer.byteLength(full);
  const gzip = gzipSync(full, { level: 9 }).length;

  const bare = (await bundle(name, `import '${name}';`, svelte)).trim();
  const declared = sideEffects !== false;
  const shakes = bare === '' || (declared && DECLARED_SIDE_EFFECT.test(bare));
  if (!shakes) {
    problems.push(
      `${name} does not tree-shake: importing it for nothing keeps ${String(Buffer.byteLength(bare))} bytes (${bare.slice(0, 120)}...)`,
    );
  }
  if (sideEffects === undefined) {
    problems.push(`${name} must declare sideEffects in its package.json`);
  }
  if (gzip > entry.budget) {
    problems.push(
      `${name} is ${String(gzip)} gzip bytes, over its budget of ${String(entry.budget)} by ${String(gzip - entry.budget)}`,
    );
  }
  const recorded = entry.recorded;
  if (verify && (recorded?.minified !== minified || recorded.gzip !== gzip)) {
    problems.push(
      `${name} measures ${String(minified)}/${String(gzip)} bytes (minified/gzip) but size-budgets.json records ${String(recorded?.minified)}/${String(recorded?.gzip)}: run npm run size -- --record and commit it`,
    );
  }
  rows.push({
    name,
    minified,
    gzip,
    budget: entry.budget,
    delta:
      recorded === undefined
        ? 'new'
        : `${signed(minified - recorded.minified)} / ${signed(gzip - recorded.gzip)}`,
    shakes,
  });
  if (record) entry.recorded = { minified, gzip };
}

const width = Math.max(...rows.map((r) => r.name.length));
console.log(
  `${'package'.padEnd(width)}  ${'minified'.padStart(9)}  ${'gzip'.padStart(7)}  ${'budget'.padStart(7)}  ${'used'.padStart(5)}  tree-shakes  change since recorded (minified / gzip)`,
);
for (const r of rows) {
  console.log(
    `${r.name.padEnd(width)}  ${String(r.minified).padStart(9)}  ${String(r.gzip).padStart(7)}  ${String(r.budget).padStart(7)}  ${`${String(Math.round((100 * r.gzip) / r.budget))}%`.padStart(5)}  ${(r.shakes ? 'yes' : 'NO').padEnd(11)}  ${r.delta}`,
  );
}

if (problems.length > 0) {
  console.error(`\nBundle size check failed:`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
if (record) {
  await writeFile(BUDGETS, `${JSON.stringify(budgets, null, 2)}\n`);
  console.log('\nRecorded the measured sizes in size-budgets.json.');
}
