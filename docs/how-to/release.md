# Release the packages

A release is built from one commit on the main branch, after every check has passed, into
`release/<version>/`, where `<version>` is the repository's version (`version.txt`). It holds
the package tarballs with their hashes, the release notes, the compatibility matrix, the
dependency inventory and vulnerability audits, the API reference, the reference application's
static page, and the quality records it was released on. The
[release checklist](../handover/release-checklist.md) lists every step to tick.

## Before: the machine

- Node.js 24 and npm 11 (`.nvmrc`, `packageManager`), with `npm ci` run.
- lungo 1.127.0 and Lean 4.35.0, for `npm run models:verify`
  ([Building and changing the models](../../README.md#building-and-changing-the-models)).
- Playwright's browsers: `npx playwright install --with-deps chromium firefox webkit`.
- Network access to the npm registry, for the vulnerability audits.

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
   (no budget missed);
3. runs `npm run check` (models, formatting, types, lint, tests, builds), the bundle sizes
   against their recorded values, and the API reference with its documentation gate;
4. packs each package and records its size, SHA-256 and npm integrity (SHA-512);
5. installs the tarballs in a fresh project as a host would, compiles a program using every
   package under strict options with every library's declarations checked, and runs it: a scene
   commits, saves and restores the same;
6. writes the inventory of everything that install holds (with a CycloneDX SBOM) and audits it,
   refusing any known vulnerability, and audits the development tools, refusing a high or
   critical one;
7. writes `COMPATIBILITY.md`, `RELEASE-NOTES.md`, `release.json` and `SHA256SUMS`.

Check the result with `sha256sum -c SHA256SUMS` in the release folder, and read
`RELEASE-NOTES.md`.

## 4. Publish

Publishing makes the packages public and cannot be undone, so it waits on the owner's choice of
registry, package scope and licence. Until then every package is `"private": true` with
`"license": "UNLICENSED"`, and npm refuses to publish it. Once those are chosen:

1. Set each package's `name` to the chosen scope, its `license`, and remove `private`; record
   the change in each changelog and release again.
2. Publish each tarball of the release, never a fresh pack, so what is published is what was
   checked and hashed: `npm publish release/<version>/packages/<tarball> --access public`, in
   dependency order (`@swf/math`, `@swf/models`, `@swf/core`, then the rest).
3. Check each published package's integrity against `release.json`
   (`npm view <name>@<version> dist.integrity`).
4. Tag the commit `v<version>`.

The reference application's static page (`reference-app/index.html`) is one self-contained file:
deploy it to any static host as it is.

## Roll a release back

**Packages.** A host goes back by installing the previous release's packages together, at their
exact versions, from the registry or from that release's tarballs (check them against its
`SHA256SUMS`). On the registry, never unpublish: deprecate the bad versions
(`npm deprecate <name>@<version> "<why>; use <good version>"`) and release the fix as a new
version.

**The reference application.** Deploy the previous release's `reference-app/index.html` in
place of the current one.

**Saved layouts.** A package rolled back reads the snapshot formats its own release reads
(its `COMPATIBILITY.md`). A layout saved by a newer release in a newer format is refused by an
older one with `SNAPSHOT_INVALID` naming the format, and is left as it was in its store. Before a
release that adds a snapshot format, a host that may need to roll back keeps an export of each
layout (`persistence.export`) made by the release it would go back to. An extension's state of
a newer version than the rolled-back extension reads is kept as it was, never lost.
