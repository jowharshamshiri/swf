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
 * The declaration files are read from each package's `dist/`, so the packages are built first
 * (`npm run build:packages`).
 *
 * One exception is declared, and reported on every run: the declarations of the program lungo
 * generates into `packages/models/program/` carry no JSDoc for their descriptor functions and
 * fields, and type `leanTypes` with `any`, because lungo's TypeScript generator writes them so.
 * The Lean models' own docstrings are where they are documented; they reach the generated
 * declarations once lungo carries them across, and this exception is then removed.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const GENERATED = '@swf/models/program/';
const GENERATED_FILE = path.join(ROOT, 'packages/models/program/index.d.ts');
const GENERATED_ANY = 'leanTypes';

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

const failures = [];
let excepted = 0;
for (const { level, text } of logger.messages) {
  if (level < LogLevel.Warn) continue;
  if (
    level === LogLevel.Warn &&
    text.includes(`defined in ${GENERATED}`) &&
    /does not have any documentation/.test(text)
  ) {
    excepted += 1;
    continue;
  }
  failures.push(text);
}
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
console.log(
  `Declared exception: ${String(excepted)} undocumented declarations and the any in ${GENERATED_ANY}, in the program lungo generates (packages/models/program/).`,
);

/**
 * Every `any` a published declaration file states: each package's `dist/**\/*.d.ts`, and the
 * generated program's declarations outside `leanTypes`.
 */
async function anyInDeclarations() {
  const require = createRequire(path.join(ROOT, 'package.json'));
  const ts = require('typescript');
  const { workspaces } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const files = [];
  for (const workspace of workspaces.filter((w) => w.startsWith('packages/'))) {
    const dist = path.join(ROOT, workspace, 'dist');
    let entries;
    try {
      entries = await readdir(dist, { recursive: true });
    } catch (error) {
      return [
        `${workspace} has no dist/ (${String(error.code)}): run npm run build:packages first`,
      ];
    }
    files.push(...entries.filter((f) => f.endsWith('.d.ts')).map((f) => path.join(dist, f)));
  }
  files.push(GENERATED_FILE);

  const found = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node, within) => {
      const name =
        ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) ? node.name.text : within;
      if (node.kind === ts.SyntaxKind.AnyKeyword) {
        if (!(file === GENERATED_FILE && name === GENERATED_ANY)) {
          const { line, character } = source.getLineAndCharacterOfPosition(node.getStart());
          found.push(
            `${path.relative(ROOT, file)}:${String(line + 1)}:${String(character + 1)} states any`,
          );
        }
      }
      ts.forEachChild(node, (child) => {
        visit(child, name);
      });
    };
    visit(source, undefined);
  }
  return found;
}
