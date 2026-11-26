# 0013. Packages released as git refs of the repository, installed by git URL

- **Status:** Accepted; supersedes [0009](0009-independent-versions-with-exact-sibling-pins.md)
- **Date:** 2026-11-26
- **Requirements:** DLV-001, DLV-013, ENV-007, NFR-028, SEC-015

## Context

Each package is installed on its own and needs its own version; the packages are developed,
tested and released together. They are not put on a package registry: the repository is public,
and hosts reference it by its git URL. npm installs a git dependency from the root of the commit
it names, while this repository's commits hold the whole workspace, whose root is not a package
a host can use, and npm has no way to name a folder within a git dependency.

## Decision

Each package has its own semantic version and changelog. A release is built by `npm run release`
from a committed tree, after the full check, the size and documentation gates, browser
conformance and the benchmark. For each package it makes a git ref, `<folder>/v<version>`
(`core/v0.1.0`), naming a commit whose tree is exactly the package as npm packs it, built output
included, and requiring each sibling package by the sibling's ref of the release. A host installs
a package by the repository's git URL and its ref, and npm fetches the siblings by theirs; the
host's lock records each commit. A version keeps its ref: a release in which a package's version
is unchanged reuses its ref, and refuses the package if its files differ. The release checks that
every ref holds exactly its tarball's files and requires its siblings by their refs, installs
every package by git URL in a fresh host, compiles and runs a program on them, inventories and
audits what that host installed, and writes the compatibility matrix and release notes. Publishing
pushes the refs and tags the release commit `v<version>`; a pushed ref never moves. Every package
stays `private`, so it is never put on a registry by mistake. Every development tool is pinned to
an exact version.

## Alternatives

- **A package registry.** Not wanted: the repository is the one place a host gets the framework
  from.
- **Tarballs attached to a tagged release of the hosting service.** Installs by URL, but by a
  download URL of one hosting service rather than the repository's git URL, and siblings would
  need those URLs too.
- **Built output committed on the main branch, installed by the release tag.** npm would install
  the workspace's root, which is no package; the main branch would also carry generated files.
- **One version for every package.** A patch to one package would release them all again.

## Consequences

A host's lock pins each package to a commit, and a reinstall gets the very same files. Mixing
packages of different releases installs separate copies of a sibling, which do not work together,
so the documentation says to install a host's packages from one release. The refs are commits
outside the main branch's history, one per package version.

## Migration impact

Moving to a registry later would change how hosts declare their dependencies (names and versions
in place of git URLs); the package names and their contents stay as they are.
