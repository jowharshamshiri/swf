# Release checklist

Tick each step for every release. [Release the packages](../how-to/release.md) explains each.

## Prepare

- [ ] The release commit is on the main branch, and the tree is clean.
- [ ] Each changed package's `version` is raised by semantic versioning, with a `## <version>`
      section in its `CHANGELOG.md` saying what changed for those who use it.
- [ ] Every sibling, the reference application and the examples require each package at exactly
      its new version; `npm install` has updated the lock.
- [ ] A change to a public contract or a closed decision has its architecture decision record.
- [ ] A new snapshot format has its migration step and the fixtures of the format before it.

## Evidence for that commit

- [ ] `npm run conformance -- --out <folder>` passed every scenario in Chromium, Firefox and
      WebKit.
- [ ] `npm run bench -- --out <folder>` on the verdict machines (Chrome on the `windows-gpu`
      mg-test plan's guest; Firefox and WebKit on a Linux desktop) missed no budget, with full
      trials.

## Build

- [ ] `npm run release -- --conformance <folder> --bench <folder>` finished, which means:
  - [ ] every package's version, changelog section, sibling pins and licence field were in order,
        and every development tool is pinned exactly;
  - [ ] `npm run check` passed (models, formatting, types, lint, tests, sizes, builds);
  - [ ] the bundle sizes equal those recorded, within budget, every package tree-shaking;
  - [ ] the API reference has no undocumented public declaration and no `any`;
  - [ ] the tarballs installed in a fresh host compile strictly and run;
  - [ ] a host's install has no known vulnerability, and the development tools none high or
        critical.
- [ ] `sha256sum -c SHA256SUMS` passes in `release/<version>/`.
- [ ] `RELEASE-NOTES.md`, `COMPATIBILITY.md` and `dependencies/inventory.md` read correctly.

## Publish

Waiting on the owner's choice of registry, package scope and licence. Until then the packages are
`private` and `UNLICENSED`, and the steps below are not taken.

- [ ] The packages' names, `license` and `private` reflect the owner's choice, released again.
- [ ] Each tarball of the release is published, in dependency order, never a fresh pack.
- [ ] Each published package's integrity equals `release.json`'s.
- [ ] The commit is tagged `v<version>`.
- [ ] The reference application's `reference-app/index.html` is deployed, and the previous
      release's is kept for a rollback.

## After

- [ ] The release folder is kept with its evidence.
- [ ] Rollback is known: the previous release's tarballs and page, and its `COMPATIBILITY.md`'s
      snapshot formats ([Roll a release back](../how-to/release.md#roll-a-release-back)).
