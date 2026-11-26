import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

/**
 * The release-packaging smoke test: the packages as a host gets them. Each package is packed as
 * npm publishes it, the tarballs are installed together in a fresh project, a program using every
 * package is compiled under the strictest options with every library's declarations checked,
 * and it runs in Node.js: every package loads, and a scene commits, is saved, and restores the
 * same in another workspace. Throws, saying what failed, otherwise.
 *
 *   npm run build:packages && npm run smoke:packages
 *
 * `npm run check` runs it after building the packages; the release runs `installHost` and
 * `smokeHost` on its own tarballs.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const TSC = path.join(ROOT, 'node_modules/typescript/bin/tsc');

/** Runs a command that must succeed; returns its output. */
function run(command, args, cwd, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(command)} ${args.join(' ')} failed in ${cwd} (exit ${String(result.status)}):\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

/** Runs a Node.js script that must succeed. */
const must = (args, cwd) => run(process.execPath, args, cwd);

/**
 * A fresh host project in a new temporary folder with the packages `specs` names (tarballs, or
 * git URLs) installed together, as a host installs a release, with `env` added to npm's
 * environment. The caller removes the folder.
 */
export async function installHost(specs, env = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'swf-host-'));
  await writeFile(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'swf-host', version: '0.0.0', private: true, type: 'module' }, null, 2)}\n`,
  );
  run('npm', ['install', '--no-fund', '--no-audit', '--prefer-offline', ...specs], dir, env);
  return dir;
}

/** Checks the packages `names` installed in the host project `dir`; returns what the program said. */
export async function smokeHost(dir, names) {
  await writeFile(
    path.join(dir, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          lib: ['ES2023', 'DOM', 'DOM.Iterable'],
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: [],
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: false,
          outDir: '.',
        },
        files: ['smoke.ts'],
      },
      null,
      2,
    )}\n`,
  );
  const imports = names.map((n, i) => `import * as p${String(i)} from '${n}';`).join('\n');
  await writeFile(
    path.join(dir, 'smoke.ts'),
    `${imports}
import { createWorkspace } from '@swf/core';
import { createPersistence } from '@swf/persistence';

export const loaded: readonly object[] = [${names.map((_, i) => `p${String(i)}`).join(', ')}];

const workspace = createWorkspace({ id: 'smoke' });
const result = workspace.transaction([
  {
    type: 'node.create',
    node: {
      id: 'window',
      kind: 'window',
      bounds: [1.6, 0.9, 0.01],
      transform: { position: [0, 0, -3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      label: 'Window',
    },
  },
  {
    type: 'surface.attach',
    surface: {
      id: 'view',
      ownerNodeId: 'window',
      bindingKey: 'host-view-1',
      adapterTypeId: 'host.view/1',
      bounds: [1.6, 0.9, 0.01],
    },
  },
]);
if (result.status !== 'committed') throw new Error(\`transaction \${result.status}\`);

const persistence = createPersistence({ workspace: workspace.persistence() });
const captured = await persistence.capture();
const text = persistence.export(captured.document);
const restored = createWorkspace({ id: 'restored' });
const back = await createPersistence({ workspace: restored.persistence() }).restore(text);
if (back.status !== 'restored') throw new Error(\`restore \${back.status}\`);
const scene = (w: typeof workspace): string =>
  JSON.stringify({ nodes: w.serialize().nodes, surfaces: w.serialize().surfaces });
if (scene(restored) !== scene(workspace)) throw new Error('the restored scene differs');
for (const module of loaded) {
  if (Object.keys(module).length === 0) throw new Error('a package exports nothing');
}
console.log('smoke: every package loads; a scene commits, saves and restores the same');
`,
  );
  must([TSC, '-p', dir], dir);
  return must([path.join(dir, 'smoke.js')], dir);
}

if (import.meta.main) {
  if (process.argv.length > 2) {
    process.stderr.write('usage: npm run smoke:packages\n');
    process.exit(2);
  }
  const { workspaces } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const packages = workspaces.filter((w) => w.startsWith('packages/'));
  const packed = await mkdtemp(path.join(os.tmpdir(), 'swf-packed-'));
  let host = null;
  try {
    const names = [];
    const tarballs = [];
    for (const workspace of packages) {
      const [result] = JSON.parse(
        run('npm', ['pack', '--json', '--pack-destination', packed, `./${workspace}`], ROOT),
      );
      names.push(result.name);
      tarballs.push(path.join(packed, result.filename));
    }
    host = await installHost(tarballs);
    process.stdout.write(await smokeHost(host, names));
  } finally {
    await rm(packed, { recursive: true, force: true });
    if (host !== null) await rm(host, { recursive: true, force: true });
  }
}
