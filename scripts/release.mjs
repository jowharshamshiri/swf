import { spawn } from 'node:child_process';
import console from 'node:console';
import { createHash } from 'node:crypto';
import { createWriteStream, rmSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { installHost, smokeHost } from './smoke-host.mjs';

/**
 * Builds a versioned release of every published package from the committed tree, into
 * `release/<version>/`, where `<version>` is the repository's version (version.txt):
 *
 * - `packages/`: each package's tarball, as `npm pack` makes it;
 * - `release.json`: the commit, the tools, and each package's version, tarball, size, SHA-256
 *   and npm integrity (SHA-512);
 * - `RELEASE-NOTES.md`: each package's changelog section for its version, with the
 *   compatibility matrix and the checks the release passed;
 * - `COMPATIBILITY.md`: each package's version and what it requires, the browsers it was
 *   checked in, Node.js, TypeScript and the snapshot formats it reads and writes;
 * - `dependencies/`: the inventory of everything a host installs with the packages
 *   (`inventory.md`, and `sbom.cdx.json` in CycloneDX), the development tools, and the
 *   vulnerability audits of both;
 * - `api-reference/`: the generated API reference;
 * - `reference-app/`: the reference application's static page, ready to deploy;
 * - `quality/`: the local check's log, the bundle sizes, and the browser conformance and
 *   performance benchmark records given to it;
 * - `SHA256SUMS`: the SHA-256 of every file above.
 *
 *   npm run release -- --conformance <folder> --bench <folder>
 *
 * `--conformance` and `--bench` are the folders `npm run conformance` and `npm run bench` wrote
 * for this commit, after it was made. The release refuses: a tree with uncommitted changes; a
 * package whose changelog has no section for its version, whose sibling packages are not required
 * at exactly their versions, or whose dependencies are not pinned to exact versions; a record
 * dated before the commit; a failing check; sizes that differ from those recorded; a conformance
 * record with a failed or missing scenario;
 * a benchmark that missed a budget on the standard fixture; any known vulnerability in what a
 * host installs; and a high or critical one in the development tools. Nothing is published:
 * publishing the tarballs is a separate step (docs/how-to/release.md).
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const USAGE = 'usage: npm run release -- --conformance <folder> --bench <folder>';

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

/** The arguments: both record folders, resolved. */
function parse(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag !== '--conformance' && flag !== '--bench')
      fail(`unknown argument "${flag}"\n${USAGE}`);
    if (value === undefined || value.startsWith('--')) fail(`${flag} needs a folder\n${USAGE}`);
    args[flag.slice(2)] = path.resolve(value);
  }
  if (args.conformance === undefined || args.bench === undefined) fail(USAGE);
  return args;
}

/**
 * Runs a command; resolves to its exit code and its output, which is also shown, and appended to
 * `log` when one is given.
 */
function run(command, args, { cwd = ROOT, log, quiet = false, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const take = (chunk) => {
      output += chunk;
      if (!quiet) process.stdout.write(chunk);
      log?.write(chunk);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, output });
    });
  });
}

/** Runs a command that must succeed. */
async function must(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    if (options.quiet) process.stderr.write(result.output);
    fail(`${command} ${args.join(' ')} exited ${String(result.code)}`);
  }
  return result.output;
}

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const exact = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const sha = (algorithm, data, encoding) => createHash(algorithm).update(data).digest(encoding);

const args = parse(process.argv.slice(2));

// --- Preconditions --------------------------------------------------------------------------

const status = await must('git', ['status', '--porcelain'], { quiet: true });
if (status.trim() !== '') {
  fail(`the tree has uncommitted changes; a release is built from a commit:\n${status}`);
}
const commit = (await must('git', ['rev-parse', 'HEAD'], { quiet: true })).trim();
// When the commit was made: evidence recorded before it cannot be evidence for it.
const committed = Date.parse(
  (await must('git', ['show', '-s', '--format=%cI', 'HEAD'], { quiet: true })).trim(),
);
/** Whether a record's date is no earlier than the commit's. */
const recordedAfter = (date) => Number.isFinite(Date.parse(date)) && Date.parse(date) >= committed;
const version = (await readFile(path.join(ROOT, 'version.txt'), 'utf8')).trim();
const root = await json(path.join(ROOT, 'package.json'));
if (root.version !== version) {
  fail(`package.json says ${String(root.version)} but version.txt says ${version}`);
}
const out = path.join(ROOT, 'release', version);
if (
  await stat(out).then(
    () => true,
    () => false,
  )
) {
  fail(`${path.relative(ROOT, out)} exists: a release is built once per version`);
}

const problems = [];
for (const [name, range] of Object.entries(root.devDependencies)) {
  if (!exact.test(range))
    problems.push(`devDependency ${name} is "${range}", not an exact version`);
}
const packages = [];
for (const workspace of root.workspaces.filter((w) => w.startsWith('packages/'))) {
  const dir = path.join(ROOT, workspace);
  const manifest = await json(path.join(dir, 'package.json'));
  packages.push({ dir, workspace, manifest });
}
const versions = new Map(packages.map((p) => [p.manifest.name, p.manifest.version]));
const notes = new Map();
for (const { dir, manifest } of packages) {
  const { name } = manifest;
  if (!exact.test(manifest.version)) problems.push(`${name} has version "${manifest.version}"`);
  if (typeof manifest.license !== 'string') problems.push(`${name} declares no license`);
  if (manifest.sideEffects === undefined) problems.push(`${name} declares no sideEffects`);
  if (!manifest.files.includes('CHANGELOG.md')) problems.push(`${name} does not ship CHANGELOG.md`);
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    if (versions.has(dep)) {
      if (range !== versions.get(dep)) {
        problems.push(`${name} requires ${dep} "${range}", not its version ${versions.get(dep)}`);
      }
    } else if (!exact.test(range)) {
      problems.push(`${name} requires ${dep} "${range}", not an exact version`);
    }
  }
  const changelog = await readFile(path.join(dir, 'CHANGELOG.md'), 'utf8').catch(() => null);
  const section = changelog
    ?.split(/^## /m)
    .find((s) => s.split('\n', 1)[0].trim() === manifest.version);
  if (section === undefined) {
    problems.push(`${name}'s CHANGELOG.md has no "## ${manifest.version}" section`);
  } else {
    notes.set(name, section.slice(section.indexOf('\n') + 1).trim());
  }
}

const conformance = await json(path.join(args.conformance, 'conformance.json')).catch((error) =>
  fail(`cannot read ${args.conformance}/conformance.json: ${error.message}`),
);
if (!recordedAfter(conformance.date)) {
  problems.push(
    `the conformance record is dated ${String(conformance.date)}, before the commit it would vouch for`,
  );
}
for (const b of conformance.browsers) {
  const bad = b.scenarios.filter((s) => s.status !== 'passed').map((s) => s.scenario);
  if (b.exitCode !== 0 || bad.length > 0) {
    problems.push(
      `conformance in ${b.browser} ${b.version}: exit ${String(b.exitCode)}${bad.length > 0 ? `, scenarios ${bad.join(', ')} not passed` : ''}`,
    );
  }
}
const benchFiles = (await readdir(args.bench)).filter((f) =>
  /^[a-z]+-(standard|stress)\.json$/.test(f),
);
if (benchFiles.length === 0) problems.push(`${args.bench} holds no benchmark record`);
const bench = [];
for (const file of benchFiles.sort()) {
  const record = await json(path.join(args.bench, file));
  bench.push(record);
  if (!recordedAfter(record.date)) {
    problems.push(
      `benchmark ${file} is dated ${String(record.date)}, before the commit it would vouch for`,
    );
  }
  for (const [id, v] of Object.entries(record.verdicts)) {
    if (v.pass === false) {
      problems.push(`benchmark ${file}: ${id} (${v.target}) missed`);
    }
  }
}

if (problems.length > 0) fail(`not releasable:\n  ${problems.join('\n  ')}`);

// --- Checks ---------------------------------------------------------------------------------

// A release that stops part-way is no release: its folder goes, so the version can be built again.
let complete = false;
process.on('exit', () => {
  if (!complete) rmSync(out, { recursive: true, force: true });
});
await mkdir(path.join(out, 'quality'), { recursive: true });
await mkdir(path.join(out, 'dependencies'), { recursive: true });
const checkLog = createWriteStream(path.join(out, 'quality', 'check.log'));
await must('npm', ['run', 'check'], { log: checkLog });
checkLog.end();
const sizes = await must('npm', ['run', '--silent', 'size', '--', '--verify']);
await writeFile(path.join(out, 'quality', 'bundle-sizes.txt'), sizes);
const reference = await must('npm', ['run', '--silent', 'api-reference']);
await writeFile(path.join(out, 'quality', 'api-reference.txt'), reference);
await cp(path.join(ROOT, 'api-reference'), path.join(out, 'api-reference'), { recursive: true });
await cp(path.join(ROOT, 'apps/reference/dist'), path.join(out, 'reference-app'), {
  recursive: true,
});
await cp(args.conformance, path.join(out, 'quality', 'conformance'), { recursive: true });
await cp(args.bench, path.join(out, 'quality', 'benchmark'), { recursive: true });

// --- Packages -------------------------------------------------------------------------------

const tarballs = path.join(out, 'packages');
await mkdir(tarballs, { recursive: true });
const released = [];
for (const { manifest, workspace } of packages) {
  const packed = JSON.parse(
    await must('npm', ['pack', '--json', '--pack-destination', tarballs, `./${workspace}`], {
      quiet: true,
    }),
  )[0];
  const file = path.join(tarballs, packed.filename);
  const data = await readFile(file);
  const integrity = `sha512-${sha('sha512', data, 'base64')}`;
  if (integrity !== packed.integrity) {
    fail(`${packed.filename}: npm reports ${packed.integrity} but the file hashes to ${integrity}`);
  }
  released.push({
    name: manifest.name,
    version: manifest.version,
    license: manifest.license,
    file: `packages/${packed.filename}`,
    bytes: data.length,
    sha256: sha('sha256', data, 'hex'),
    integrity,
    files: packed.entryCount,
    dependencies: manifest.dependencies ?? {},
  });
}

// --- A host's install: smoke test, inventory and audit --------------------------------------

const host = await installHost(released.map((p) => path.join(out, p.file)));
// Removed however the release ends: a refusal exits the process from inside the steps below.
process.on('exit', () => {
  rmSync(host, { recursive: true, force: true });
});
process.stdout.write(
  await smokeHost(
    host,
    released.map((p) => p.name),
  ),
);

const lock = await json(path.join(host, 'package-lock.json'));
const installed = Object.entries(lock.packages)
  .filter(([where]) => where !== '')
  .map(([where, entry]) => ({
    name: where.slice(where.lastIndexOf('node_modules/') + 'node_modules/'.length),
    version: entry.version,
    license: entry.license ?? null,
    integrity: entry.integrity ?? null,
    from: entry.resolved?.startsWith('file:') ? 'this release' : (entry.resolved ?? null),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));
const sbom = await must('npm', ['sbom', '--sbom-format', 'cyclonedx', '--omit', 'dev'], {
  cwd: host,
  quiet: true,
});
await writeFile(path.join(out, 'dependencies', 'sbom.cdx.json'), sbom);
const hostAudit = await run('npm', ['audit', '--json', '--omit', 'dev'], {
  cwd: host,
  quiet: true,
});
const hostReport = JSON.parse(hostAudit.output);
if (hostReport.error !== undefined)
  fail(`the audit of a host's install failed: ${hostReport.error.summary}`);
await writeFile(path.join(out, 'dependencies', 'audit-host.json'), hostAudit.output);

const devAudit = await run('npm', ['audit', '--json'], { quiet: true });
const devReport = JSON.parse(devAudit.output);
if (devReport.error !== undefined)
  fail(`the audit of the development tools failed: ${devReport.error.summary}`);
await writeFile(path.join(out, 'dependencies', 'audit-development.json'), devAudit.output);

const advisories = (report) =>
  Object.values(report.vulnerabilities ?? {}).map((v) => ({
    name: v.name,
    severity: v.severity,
    range: v.range,
    fix:
      v.fixAvailable === false
        ? null
        : v.fixAvailable === true
          ? 'available'
          : `${v.fixAvailable.name} ${v.fixAvailable.version}${v.fixAvailable.isSemVerMajor ? ' (npm suggests it; a major version change)' : ''}`,
    advisories: v.via.filter((x) => typeof x === 'object').map((x) => `${x.title} (${x.url})`),
  }));
const hostAdvisories = advisories(hostReport);
const devAdvisories = advisories(devReport);
await writeFile(
  path.join(out, 'dependencies', 'inventory.md'),
  inventoryMarkdown(installed, hostAdvisories, devAdvisories),
);
if (hostAdvisories.length > 0) {
  fail(
    `a host's install has known vulnerabilities: ${hostAdvisories.map((a) => `${a.name} (${a.severity})`).join(', ')}`,
  );
}
const serious = devAdvisories.filter((a) => a.severity === 'high' || a.severity === 'critical');
if (serious.length > 0) {
  fail(
    `the development tools have serious vulnerabilities: ${serious.map((a) => `${a.name} (${a.severity})`).join(', ')}`,
  );
}

// --- Compatibility, notes, manifest ---------------------------------------------------------

const persistence = await import(
  pathToFileURL(path.join(host, 'node_modules/@swf/persistence/dist/index.js')).href
);
const formats = {
  writes: persistence.SNAPSHOT_SCHEMA_ID,
  reads: [...persistence.SNAPSHOT_MIGRATIONS.map((m) => m.from), persistence.SNAPSHOT_SCHEMA_ID],
};
const typescript = (await json(path.join(ROOT, 'node_modules/typescript/package.json'))).version;
const compatibility = compatibilityMarkdown({
  released,
  engines: root.engines.node,
  typescript,
  browsers: conformance.browsers,
  formats,
});
await writeFile(path.join(out, 'COMPATIBILITY.md'), compatibility);

const manifest = {
  version,
  commit,
  date: new Date().toISOString(),
  tools: {
    node: process.version,
    npm: (await must('npm', ['--version'], { quiet: true })).trim(),
    typescript,
  },
  packages: released,
  formats,
  browsers: conformance.browsers.map((b) => ({
    browser: b.browser,
    channel: b.channel,
    version: b.version,
  })),
  benchmark: bench.map((r) => ({
    browser: `${r.environment.browser.engine} ${r.environment.browser.version}`,
    fixture: r.fixture.name,
    verdicts: Object.fromEntries(
      Object.entries(r.verdicts).map(([id, v]) => [
        id,
        v.pass === null ? 'not measurable' : v.pass ? 'met' : 'missed',
      ]),
    ),
  })),
  advisories: { host: hostAdvisories, development: devAdvisories },
};
await writeFile(path.join(out, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(path.join(out, 'RELEASE-NOTES.md'), releaseNotes(manifest, notes, compatibility));

// --- Integrity of everything ---------------------------------------------------------------

const every = (await readdir(out, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => path.relative(out, path.join(entry.parentPath, entry.name)))
  .sort();
const sums = [];
for (const file of every) {
  sums.push(
    `${sha('sha256', await readFile(path.join(out, file)), 'hex')}  ${file.split(path.sep).join('/')}`,
  );
}
await writeFile(path.join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`);
complete = true;
console.log(
  `\nReleased ${String(released.length)} packages of ${version} (${commit.slice(0, 12)}) into ${path.relative(ROOT, out)}/.`,
);

// --- Helpers --------------------------------------------------------------------------------

function inventoryMarkdown(installed, host, development) {
  const advisoryLines = (list) =>
    list.length === 0
      ? ['None known.']
      : list.map(
          (a) =>
            `- ${a.name} ${a.range}, ${a.severity}${a.fix === null ? ', no fix published' : `, fixed by ${a.fix}`}${a.advisories.length > 0 ? `: ${a.advisories.join('; ')}` : ''}`,
        );
  return `${[
    `# Dependency inventory of ${version}`,
    '',
    'Everything a host installs with these packages, as npm resolved it from the release tarballs',
    '(`sbom.cdx.json` holds the same in CycloneDX).',
    '',
    '| Package | Version | Licence | Integrity | From |',
    '| --- | --- | --- | --- | --- |',
    ...installed.map(
      (p) =>
        `| ${p.name} | ${p.version} | ${p.license ?? 'not declared'} | ${p.integrity ?? '–'} | ${p.from ?? '–'} |`,
    ),
    '',
    '## Known vulnerabilities in what a host installs',
    '',
    ...advisoryLines(host),
    '',
    '## Known vulnerabilities in the development tools',
    '',
    'The tools that build and check the packages (`npm audit` of the repository), none of which a',
    'host installs. A high or critical one stops a release; the others are listed here.',
    '',
    ...advisoryLines(development),
    '',
  ].join('\n')}`;
}

function compatibilityMarkdown({ released: list, engines, typescript, browsers, formats }) {
  return `${[
    `# Compatibility of ${version}`,
    '',
    '## Packages',
    '',
    'Each package requires its siblings at exactly the versions released with it: install the',
    'packages of one release together.',
    '',
    '| Package | Version | Requires |',
    '| --- | --- | --- |',
    ...list.map(
      (p) =>
        `| ${p.name} | ${p.version} | ${
          Object.entries(p.dependencies)
            .map(([n, v]) => `${n} ${v}`)
            .join(', ') || 'nothing'
        } |`,
    ),
    '',
    '## Runtimes',
    '',
    '| Runtime | Supported | Checked |',
    '| --- | --- | --- |',
    ...browsers.map(
      (b) =>
        `| ${b.browser}${b.channel === null ? '' : ` (${b.channel})`} | current stable | ${b.version}: every conformance scenario passed |`,
    ),
    `| Node.js | ${engines} | ${process.version}: the packages install, compile and run |`,
    `| TypeScript | ${typescript} | the declarations compile under strict options, libraries checked |`,
    '',
    'The packages are ES2022 modules: a bundler or a browser loads them as they are.',
    '',
    '## Snapshot formats',
    '',
    `Writes \`${formats.writes}\`; reads ${formats.reads.map((f) => `\`${f}\``).join(', ')}.`,
    '',
  ].join('\n')}`;
}

function releaseNotes(manifest, sections, compatibility) {
  return `${[
    `# Release ${manifest.version}`,
    '',
    `From commit ${manifest.commit}, built ${manifest.date} with Node.js ${manifest.tools.node},`,
    `npm ${manifest.tools.npm} and TypeScript ${manifest.tools.typescript}.`,
    '',
    '| Package | Version | SHA-256 |',
    '| --- | --- | --- |',
    ...manifest.packages.map((p) => `| ${p.name} | ${p.version} | \`${p.sha256}\` |`),
    '',
    ...manifest.packages.flatMap((p) => [
      `## ${p.name} ${p.version}`,
      '',
      sections.get(p.name),
      '',
    ]),
    '## Checks',
    '',
    '- The local check (`quality/check.log`): models, formatting, types, lint, tests and builds.',
    '- Bundle sizes within budget and tree-shaking (`quality/bundle-sizes.txt`).',
    '- The API reference: every public declaration documented (`quality/api-reference.txt`).',
    `- Browser conformance in ${manifest.browsers.map((b) => `${b.browser} ${b.version}`).join(', ')} (\`quality/conformance/\`).`,
    `- The performance benchmark (\`quality/benchmark/\`): ${manifest.benchmark
      .map(
        (b) =>
          `${b.browser} ${b.fixture}: ${Object.entries(b.verdicts)
            .map(([id, v]) => `${id} ${v}`)
            .join(', ')}`,
      )
      .join('; ')}.`,
    `- No known vulnerability in what a host installs; ${String(manifest.advisories.development.length)} in the development tools (\`dependencies/inventory.md\`).`,
    '- A host install of the tarballs compiles and runs (`smoke`).',
    '',
    compatibility
      .replace(/^# .*\n/, '')
      .replace(/^## /gm, '### ')
      .trim(),
    '',
  ].join('\n')}`;
}
