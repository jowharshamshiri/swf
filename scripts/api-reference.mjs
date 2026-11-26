import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import console from 'node:console';
import process from 'node:process';
import {
  Application,
  Logger,
  LogLevel,
  PackageJsonReader,
  TSConfigReader,
  TypeDocReader,
} from 'typedoc';

/**
 * Generates the API reference of every published package into `api-reference/` (HTML) and checks
 * the public surface it is generated from: every exported declaration, member and signature has
 * JSDoc, every type a public declaration names is exported, every `{@link}` resolves, and no
 * public declaration file states `any`. Exits non-zero, naming each problem, when one fails.
 *
 *   npm run api-reference            # check, then write api-reference/
 *   npm run api-reference -- --check # check only
 *
 * The declaration files checked for `any` are every `.d.ts` a package publishes (the folders its
 * `files` lists: `dist/`, and the program lungo generates for `@swf/models`), so the packages
 * are built first (`npm run build:packages`).
 */

const ROOT = path.resolve(import.meta.dirname, '..');

const checkOnly = process.argv.slice(2).includes('--check');
for (const argument of process.argv.slice(2)) {
  if (argument !== '--check') {
    console.error(`unknown argument ${argument}; usage: npm run api-reference [-- --check]`);
    process.exit(2);
  }
}

/** Collects every message typedoc logs, so the gate decides which ones fail it. */
class CollectingLogger extends Logger {
  /** @type {{ level: number, text: string }[]} */
  messages = [];
  log(message, level) {
    super.log(message, level);
    this.messages.push({ level, text: message });
  }
}

const logger = new CollectingLogger();
const app = await Application.bootstrapWithPlugins(
  { options: path.join(ROOT, 'typedoc.json'), emit: checkOnly ? 'none' : 'docs' },
  [new TypeDocReader(), new PackageJsonReader(), new TSConfigReader()],
);
app.logger = logger;
logger.level = LogLevel.Warn;

const project = await app.convert();
if (project) app.validate(project);

const failures = logger.messages.filter((m) => m.level >= LogLevel.Warn).map((m) => m.text);
if (!project) failures.push('typedoc could not convert the packages');

failures.push(...(await anyInDeclarations()));

if (failures.length > 0) {
  console.error(`The public API fails ${String(failures.length)} check(s):`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

if (!checkOnly) await app.generateOutputs(project);
console.log(
  `Public API: every declaration documented and typed without any${checkOnly ? '' : '; reference written to api-reference/'}.`,
);

/** Every `any` a published declaration file states: each `.d.ts` in the folders a package ships. */
async function anyInDeclarations() {
  const require = createRequire(path.join(ROOT, 'package.json'));
  const ts = require('typescript');
  const { workspaces } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const files = [];
  for (const workspace of workspaces.filter((w) => w.startsWith('packages/'))) {
    const manifest = JSON.parse(await readFile(path.join(ROOT, workspace, 'package.json'), 'utf8'));
    for (const shipped of manifest.files) {
      const folder = path.join(ROOT, workspace, shipped);
      let entries;
      try {
        entries = await readdir(folder, { recursive: true });
      } catch (error) {
        // A file the package ships (its changelog), or one the release adds to it (its licence and
        // notice): no declarations to read. Only the built output must be there.
        if (error.code === 'ENOTDIR' || (error.code === 'ENOENT' && shipped !== 'dist')) continue;
        return [
          `${workspace} has no ${shipped}/ (${String(error.code)}): run npm run build:packages first`,
        ];
      }
      files.push(...entries.filter((f) => f.endsWith('.d.ts')).map((f) => path.join(folder, f)));
    }
  }

  const found = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        const { line, character } = source.getLineAndCharacterOfPosition(node.getStart());
        found.push(
          `${path.relative(ROOT, file)}:${String(line + 1)}:${String(character + 1)} states any`,
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}
