import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeRefs,
  publishedRefs,
  readAs,
  refOf,
  repositoryOf,
  verifyRefs,
} from '../release-refs.mjs';

/**
 * A release's per-package git refs, made from two packages, `@fixture/alpha` and
 * `@fixture/beta` (which requires alpha), and installed by a host by git URL.
 */

const REPOSITORY = repositoryOf('git+https://git.example/fixture/packages.git');
let work;

beforeEach(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'swf-release-refs-'));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

const git = (args, cwd = work, env = {}) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

/** Packs a fixture package in `packages/<folder>` and returns what `makeRefs` takes of it. */
async function fixture(folder, manifest, source) {
  const dir = path.join(work, 'packages', folder);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(dir, 'index.js'), source);
  const tarballs = path.join(work, 'tarballs');
  await mkdir(tarballs, { recursive: true });
  const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', tarballs, dir], {
      encoding: 'utf8',
    }),
  );
  return {
    name: manifest.name,
    version: manifest.version,
    workspace: `packages/${folder}`,
    tarball: path.join(tarballs, packed.filename),
  };
}

async function packages(alphaSource = 'export const alpha = 1;\n') {
  return [
    await fixture(
      'alpha',
      { name: '@fixture/alpha', version: '1.0.0', type: 'module', exports: './index.js' },
      alphaSource,
    ),
    await fixture(
      'beta',
      {
        name: '@fixture/beta',
        version: '2.0.0',
        type: 'module',
        exports: './index.js',
        dependencies: { '@fixture/alpha': '1.0.0' },
      },
      "import { alpha } from '@fixture/alpha';\nexport const beta = alpha + 1;\n",
    ),
  ];
}

async function bare(name) {
  const repo = path.join(work, name);
  git(['init', '--quiet', '--bare', repo]);
  return repo;
}

async function staging(name) {
  const dir = path.join(work, name);
  await mkdir(dir);
  return dir;
}

/** Turns made refs into what `verifyRefs` checks, with tarballs holding the refs' files. */
async function asReleased(made) {
  const out = await staging('released');
  return made.map((m) => {
    const [packed] = JSON.parse(
      execFileSync('npm', ['pack', '--json', '--pack-destination', out, m.dir], {
        encoding: 'utf8',
      }),
    );
    return { ...m, tarball: path.join(out, packed.filename) };
  });
}

describe('per-package release refs', () => {
  it('make a ref per package holding exactly it, requiring siblings by their refs, which a host installs by git URL', async () => {
    const repo = await bare('refs.git');
    const made = await makeRefs({
      repo,
      repository: REPOSITORY,
      packages: await packages(),
      published: new Map(),
      staging: await staging('staging'),
    });
    expect(made.map((m) => m.ref)).toEqual(['alpha/v1.0.0', 'beta/v2.0.0']);
    expect(made[1].dependencies).toEqual({
      '@fixture/alpha': 'git+https://git.example/fixture/packages.git#alpha/v1.0.0',
    });
    const released = await asReleased(made);
    await verifyRefs({ repo, released, staging: await staging('verify') });

    // A host installs beta alone by its git URL, and npm brings alpha by alpha's ref.
    const host = await staging('host');
    await writeFile(
      path.join(host, 'package.json'),
      JSON.stringify({ name: 'host', version: '1.0.0', private: true, type: 'module' }),
    );
    execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline', made[1].url], {
      cwd: host,
      env: { ...process.env, ...readAs(REPOSITORY, repo) },
      encoding: 'utf8',
    });
    const lock = JSON.parse(await readFile(path.join(host, 'package-lock.json'), 'utf8'));
    expect(lock.packages['node_modules/@fixture/alpha'].resolved).toContain(made[0].commit);
    expect(lock.packages['node_modules/@fixture/beta'].resolved).toContain(made[1].commit);
    const said = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', "import { beta } from '@fixture/beta'; console.log(beta);"],
      { cwd: host, encoding: 'utf8' },
    );
    expect(said.trim()).toBe('2');
  }, 120_000);

  it('refuse a ref whose tree is not exactly its package', async () => {
    const repo = await bare('refs.git');
    const made = await makeRefs({
      repo,
      repository: REPOSITORY,
      packages: await packages(),
      published: new Map(),
      staging: await staging('staging'),
    });
    const released = await asReleased(made);
    // alpha's ref moved to a commit of other files.
    const other = git(['commit-tree', made[1].tree, '-m', 'other'], work, {
      GIT_DIR: repo,
    }).trim();
    git(['tag', '--force', 'alpha/v1.0.0', other], work, { GIT_DIR: repo });
    await expect(verifyRefs({ repo, released, staging: await staging('verify') })).rejects.toThrow(
      'alpha/v1.0.0 does not hold exactly the files of fixture-alpha-1.0.0.tgz',
    );
  }, 60_000);

  it('refuse a sibling required by anything but its own ref of the release', async () => {
    const repo = await bare('refs.git');
    const elsewhere = repositoryOf('git+https://git.example/fixture/elsewhere.git');
    const made = await makeRefs({
      repo,
      repository: elsewhere,
      packages: await packages(),
      published: new Map(),
      staging: await staging('staging'),
    });
    const released = (await asReleased(made)).map((r) => ({
      ...r,
      url: `${REPOSITORY.url}#${r.ref}`,
    }));
    await expect(verifyRefs({ repo, released, staging: await staging('verify') })).rejects.toThrow(
      'beta/v2.0.0 requires @fixture/alpha as git+https://git.example/fixture/elsewhere.git#alpha/v1.0.0, not by its ref',
    );
  }, 60_000);

  it('reuse a released ref with the same files, and refuse a released version with other files', async () => {
    // The repository hosts install from already holds alpha 1.0.0's ref.
    const remote = await bare('remote.git');
    const first = await makeRefs({
      repo: remote,
      repository: REPOSITORY,
      packages: (await packages()).slice(0, 1),
      published: new Map(),
      staging: await staging('first'),
    });
    const env = readAs(REPOSITORY, remote);
    const published = publishedRefs(REPOSITORY, [refOf('packages/alpha', '1.0.0')], env);
    expect(published.get('alpha/v1.0.0')).toBe(first[0].commit);

    await rm(path.join(work, 'packages'), { recursive: true });
    await rm(path.join(work, 'tarballs'), { recursive: true });
    const same = await makeRefs({
      repo: await bare('again.git'),
      repository: REPOSITORY,
      packages: (await packages()).slice(0, 1),
      published,
      env,
      staging: await staging('again'),
    });
    expect(same[0].commit).toBe(first[0].commit);
    expect(same[0].new).toBe(false);

    await rm(path.join(work, 'packages'), { recursive: true });
    await rm(path.join(work, 'tarballs'), { recursive: true });
    await expect(
      makeRefs({
        repo: await bare('changed.git'),
        repository: REPOSITORY,
        packages: (await packages('export const alpha = 10;\n')).slice(0, 1),
        published,
        env,
        staging: await staging('changed'),
      }),
    ).rejects.toThrow(
      '@fixture/alpha 1.0.0 is already released as alpha/v1.0.0 with other files: raise its version',
    );
  }, 120_000);
});
