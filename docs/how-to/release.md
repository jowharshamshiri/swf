# Release the packages

A release is built from one commit on the main branch, after every check has passed, into
`release/<version>/`, where `<version>` is the repository's version (`version.txt`). Packages are
not put on a package registry: each is released as a git ref of this repository, which a host
installs by git URL ([Install the packages](integrate-a-host.md#install-the-packages)). The release
folder holds those refs, the package tarballs with their hashes, the release notes, the compatibility matrix, the
dependency inventory and vulnerability audits, the API reference, the reference application's
static page, and the quality records it was released on. The
[release checklist](../handover/release-checklist.md) lists every step to tick.

## Before: the machine

- Node.js 24 and npm 11 (`.nvmrc`, `packageManager`), with `npm ci` run.
- lungo 1.131.83 and Lean 4.35.0, for `npm run models:verify`
  ([Building and changing the models](../../README.md#building-and-changing-the-models)).
- Playwright's browsers: `npx playwright install --with-deps chromium firefox webkit`.
- Network access to the npm registry, for the vulnerability audits, and read access to this
  repository's remote, to see which package refs are already released.

## 1. Set each package's version and changelog

For each package that changed since its last release:

1. Raise its `version` in its `package.json` by semantic versioning
   ([Versions and compatibility](../reference/versions-and-compatibility.md)).
2. Add a `## <version>` section at the top of its `CHANGELOG.md` saying what changed for those
   who use it.
3. Require it at exactly the new version in every sibling's `dependencies`, and in the
   reference application's and the examples' manifests.

Then `npm install` to update the lock, and commit. A release refuses a package whose changelog
has no section for its version, or whose siblings require another version.

## 2. Record the browser and performance evidence for that commit

```sh
npm run conformance -- --out /path/to/records/conformance
npm run bench -- --out /path/to/records/bench
```

Conformance runs every browser suite in Chromium, Firefox and WebKit and must pass every
acceptance scenario. The benchmark's verdicts count only from the verdict machines: Chrome on the
reference machine (the `windows-gpu` mg-test plan: `mg-test run mg-test.yaml --plan windows-gpu`)
and Firefox and WebKit on a Linux desktop
([Measuring performance](../../README.md#measuring-performance)). Records made with shortened
trials (`SWF_BENCH_TRIALS` and the others) say so in their method and are not release evidence.

## 3. Build the release

```sh
npm run release -- --conformance /path/to/records/conformance --bench /path/to/records/bench
```

It refuses an uncommitted tree, and then:

1. checks every package's version, changelog, pins and licence field, and that every
   development tool is pinned to an exact version;
2. reads the conformance record (every scenario passed in every browser) and the benchmark
   (no budget missed), refusing either if it was recorded before the commit;
3. runs `npm run check` (models, formatting, types, lint, tests, builds), the bundle sizes
   against their recorded values, and the API reference with its documentation gate;
4. makes each package's release ref in `git/`, a repository of the release's own: the ref
   `<folder>/v<version>` (`core/v0.1.0`) names a commit holding exactly the package as npm packs
   it, requiring each sibling package by the sibling's ref. A version whose ref the remote already
   has must hold the same files, and is then reused; other files under a released version are
   refused, naming the package to raise;
5. packs each package from its ref's files and records its size, SHA-256 and npm integrity
   (SHA-512), then checks that every ref holds exactly its tarball's files and requires its
   siblings by their own refs;
6. installs every package by its git URL in a fresh project, as a host would (git reads the
   remote as the release's `git/` until the refs are pushed), compiles a program using every
   package under strict options with every library's declarations checked, and runs it: a scene
   commits, saves and restores the same;
7. writes the inventory of everything that install holds (with a CycloneDX SBOM) and audits it,
   refusing any known vulnerability, and audits the development tools, refusing a high or
   critical one;
8. writes `COMPATIBILITY.md`, `RELEASE-NOTES.md`, `release.json` and `SHA256SUMS`.

Check the result with `sha256sum -c SHA256SUMS` in the release folder, and read
`RELEASE-NOTES.md`.

## 4. Publish

Publishing pushes the release's refs, and tags the release's commit, on this repository's
remote. A pushed ref is what hosts install and must never move, so push only a release that has
passed every step above:

```sh
v=<version>
git --git-dir release/$v/git push https://github.com/jowharshamshiri/swf.git 'refs/tags/*'
git tag v$v "$(node -p "require('./release/$v/release.json').commit")" && git push origin v$v
```

The first command pushes each package's ref (a ref already released is pushed unchanged). Then
check that a host installs from the remote: in an empty project, `npm install` the URL of one
package from `COMPATIBILITY.md`, and compare the commit its lock records with `release.json`.

Every package stays `"private": true`, so npm refuses to publish one to a registry by mistake,
and `"license": "UNLICENSED"` until a licence is chosen.

The reference application's static page (`reference-app/index.html`) is one self-contained file:
deploy it to any static host as it is.

## Roll a release back

**Packages.** A host goes back by installing the previous release's packages by their refs (in
that release's `COMPATIBILITY.md`), together, and `npm install` updates its lock to their
commits. A released ref is never moved or deleted, since hosts' locks name its commit: a bad
release is followed by a fixed one under new versions, and the bad versions are named in the
fixed release's changelogs.

**The reference application.** Deploy the previous release's `reference-app/index.html` in
place of the current one.

**Saved layouts.** A package rolled back reads the snapshot formats its own release reads
(its `COMPATIBILITY.md`). A layout saved by a newer release in a newer format is refused by an
older one with `SNAPSHOT_INVALID` naming the format, and is left as it was in its store. Before a
release that adds a snapshot format, a host that may need to roll back keeps an export of each
layout (`persistence.export`) made by the release it would go back to. An extension's state of
a newer version than the rolled-back extension reads is kept as it was, never lost.
