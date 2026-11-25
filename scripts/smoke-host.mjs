import { spawnSync } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

/**
 * Checks packages installed in a host project as a host uses them: their declarations compile
 * under the strictest options with every library's declarations checked, and each package loads
 * in Node.js; a scene commits, is saved, and restores the same in another workspace. Throws,
 * saying what failed, otherwise.
 *
 * The release runs it on a project that installed the release's tarballs. On its own:
 *
 *   node scripts/smoke-host.mjs <host project>
 *
 * checks every `@swf/*` package installed in `<host project>/node_modules`.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const TSC = path.join(ROOT, 'node_modules/typescript/bin/tsc');

function must(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${path.basename(args[0])} failed in ${cwd} (exit ${String(result.status)}):\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

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

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const dir = process.argv[2];
  if (dir === undefined || process.argv.length > 3) {
    process.stderr.write('usage: node scripts/smoke-host.mjs <host project>\n');
    process.exit(2);
  }
  const host = path.resolve(dir);
  const names = (await readdir(path.join(host, 'node_modules/@swf'))).map((n) => `@swf/${n}`);
  process.stdout.write(await smokeHost(host, names));
}
