import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/**
 * Each package is released as a git ref of its own, `<folder>/v<version>` (`core/v0.1.0`): a
 * commit whose tree is exactly the package as npm packs it, requiring each sibling package by the
 * sibling's ref. A host installs a package by the repository's git URL and that ref
 * (`npm install git+https://github.com/<owner>/swf.git#core/v0.1.0`), and npm fetches its siblings
 * by theirs. npm cannot install one package of a workspace from the repository's own commits,
 * which hold the whole workspace; a ref per package can be installed as it is.
 */

/** Runs git in `repo` (a bare repository) and returns its output; throws with git's words. */
function git(repo, args, env = {}) {
  try {
    return execFileSync('git', ['--git-dir', repo, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(
      `git ${args.join(' ')} failed: ${String(error.stderr ?? error.message).trim()}`,
      { cause: error },
    );
  }
}

/** Unpacks an npm tarball into `dir`, as npm would install it. */
function unpack(tarball, dir) {
  execFileSync('tar', ['-xzf', tarball, '-C', dir, '--strip-components=1']);
}

/** The tree of the files in `dir`, written into `repo`'s objects. */
function treeOf(repo, dir, index) {
  git(repo, ['--work-tree', dir, 'add', '--all', '--force', '.'], { GIT_INDEX_FILE: index });
  return git(repo, ['write-tree'], { GIT_INDEX_FILE: index }).trim();
}

/**
 * The repository hosts install from: `url` is what a host writes (`git+https://…/swf.git`), and
 * `fetch` what git reaches. `url` must be a git+https URL ending in `.git`.
 */
export function repositoryOf(url) {
  if (typeof url !== 'string' || !/^git\+https:\/\/[^#]+\.git$/.test(url)) {
    throw new Error(
      `the repository URL must be a git+https URL ending in .git (got ${String(url)})`,
    );
  }
  return { url, fetch: url.slice('git+'.length) };
}

/** A package's release ref: its folder's name and its version. */
export function refOf(workspace, version) {
  return `${path.basename(workspace)}/v${version}`;
}

/** The git URL a host installs a ref by. */
export function urlOf(repository, ref) {
  return `${repository.url}#${ref}`;
}

/**
 * The refs of `names` the repository already has, by name, with their commits; `env` is added to
 * git's environment.
 */
export function publishedRefs(repository, names, env = {}) {
  const wanted = new Set(names);
  const found = new Map();
  const listing = execFileSync('git', ['ls-remote', '--tags', repository.fetch], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  for (const line of listing.split('\n')) {
    const [commit, name] = line.split('\t');
    const ref = name?.startsWith('refs/tags/') ? name.slice('refs/tags/'.length) : null;
    if (ref !== null && commit !== undefined && wanted.has(ref)) found.set(ref, commit);
  }
  return found;
}

/**
 * Makes each package's ref in the bare repository `repo`, from its packed tarball. `packages` are
 * `{ name, version, workspace, tarball }`; `published` the refs the repository already has
 * (`publishedRefs`). A package whose ref is already published must have the very same files:
 * its published commit is reused; other files under a released version are refused, naming it.
 * `env` is added to git's environment. Returns, for each package, its ref, URL, commit, tree and the folder holding its files with
 * the siblings required by their refs.
 */
export async function makeRefs({ repo, repository, packages, published, staging, env = {} }) {
  const refs = new Map(packages.map((p) => [p.name, refOf(p.workspace, p.version)]));
  const made = [];
  for (const p of packages) {
    const ref = refs.get(p.name);
    const dir = path.join(staging, path.basename(p.workspace));
    await mkdir(dir);
    unpack(p.tarball, dir);
    const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (refs.has(dep)) manifest.dependencies[dep] = urlOf(repository, refs.get(dep));
    }
    await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const tree = treeOf(repo, dir, `${dir}.index`);
    let commit = published.get(ref);
    if (commit === undefined) {
      commit = git(repo, ['commit-tree', tree, '-m', `${p.name} ${p.version}`]).trim();
    } else {
      git(repo, ['fetch', '--quiet', repository.fetch, `refs/tags/${ref}:refs/tags/${ref}`], env);
      if (git(repo, ['rev-parse', `${commit}^{tree}`]).trim() !== tree) {
        throw new Error(
          `${p.name} ${p.version} is already released as ${ref} with other files: raise its version and add its changelog section`,
        );
      }
    }
    git(repo, ['tag', '--force', ref, commit]);
    made.push({
      name: p.name,
      version: p.version,
      ref,
      url: urlOf(repository, ref),
      commit,
      tree,
      new: !published.has(ref),
      dir,
      dependencies: manifest.dependencies ?? {},
    });
  }
  // A clone of the repository needs a HEAD; it names the first package's commit.
  const first = made[0];
  if (first !== undefined) git(repo, ['update-ref', '--no-deref', 'HEAD', first.commit]);
  return made;
}

/**
 * Checks each ref as a host reads it: its tree is exactly the files of `tarball` (the package as
 * released beside it), and every sibling it requires is required by that sibling's own ref,
 * which names the commit released for it. `released` are `{ name, ref, url, commit, tarball }`.
 * Throws, naming the ref, otherwise.
 */
export async function verifyRefs({ repo, released, staging }) {
  for (const p of released) {
    const dir = path.join(staging, `verify-${p.ref.replaceAll('/', '-')}`);
    await mkdir(dir);
    unpack(p.tarball, dir);
    const tree = treeOf(repo, dir, `${dir}.index`);
    if (git(repo, ['rev-parse', `refs/tags/${p.ref}^{tree}`]).trim() !== tree) {
      throw new Error(`${p.ref} does not hold exactly the files of ${path.basename(p.tarball)}`);
    }
    const manifest = JSON.parse(git(repo, ['show', `refs/tags/${p.ref}:package.json`]));
    for (const [dep, spec] of Object.entries(manifest.dependencies ?? {})) {
      const sibling = released.find((r) => r.name === dep);
      if (sibling === undefined) continue;
      if (spec !== sibling.url) {
        throw new Error(`${p.ref} requires ${dep} as ${spec}, not by its ref ${sibling.url}`);
      }
      if (git(repo, ['rev-parse', `refs/tags/${sibling.ref}^{commit}`]).trim() !== sibling.commit) {
        throw new Error(`${sibling.ref} is not the commit released for ${dep}`);
      }
    }
  }
}

/**
 * The environment under which git reads `repository` as the local bare repository `repo`, so a
 * host can install the refs by their git URLs before they are pushed.
 */
export function readAs(repository, repo) {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.${pathToFileURL(repo).href}.insteadOf`,
    GIT_CONFIG_VALUE_0: repository.fetch,
  };
}
