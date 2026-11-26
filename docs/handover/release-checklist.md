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
  - [ ] every package's version, changelog section, sibling pins and licence were in order, and
        every ref carries the repository's `LICENSE` and `NOTICE`,
        and every development tool is pinned exactly;
  - [ ] `npm run check` passed (models, formatting, types, lint, tests, sizes, builds);
  - [ ] the bundle sizes equal those recorded, within budget, every package tree-shaking;
  - [ ] the API reference has no undocumented public declaration and no `any`;
  - [ ] every package's ref holds exactly its tarball's files and requires its siblings by their
        refs, and a version already released kept its files;
  - [ ] the packages installed by git URL in a fresh host compile strictly and run;
  - [ ] a host's install has no known vulnerability, and the development tools none high or
        critical.
- [ ] `sha256sum -c SHA256SUMS` passes in `release/<version>/`.
- [ ] `RELEASE-NOTES.md`, `COMPATIBILITY.md` and `dependencies/inventory.md` read correctly.

## Publish

Packages go to no package registry: they are released as git refs of this repository.

- [ ] The release's package refs are pushed from `release/<version>/git`.
- [ ] The release's commit is tagged `v<version>` and the tag pushed.
- [ ] A package installed by its git URL in an empty project locks the commit `release.json` names.
- [ ] The reference application's `reference-app/index.html` is deployed, and the previous
      release's is kept for a rollback.

## After

- [ ] The release folder is kept with its evidence.
- [ ] Rollback is known: the previous release's package refs and page, and its `COMPATIBILITY.md`'s
      snapshot formats ([Roll a release back](../how-to/release.md#roll-a-release-back)).
