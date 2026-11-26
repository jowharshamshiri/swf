# 0009. Independent package versions with exact sibling pins, released from one commit

- **Status:** Superseded by [0013](0013-released-as-git-refs.md)
- **Date:** 2026-11-25
- **Requirements:** DLV-001, DLV-013, ENV-007, NFR-028, SEC-015

## Context

Each package is installed on its own, so each needs its own version. The packages are developed
together, tested together and call each other's internals only through public entry points, but
their combinations across releases are not tested.

## Decision

Each package has its own semantic version and changelog, and requires each sibling at exactly
the version released with it. The repository's own version (`version.txt`) names a release. A
release is built by `npm run release` from a committed tree, after the full check, the size and
documentation gates, browser conformance and the benchmark: it packs each package, hashes it
(SHA-256 and npm's SHA-512 integrity), installs the tarballs as a host would and runs a program on
them, inventories and audits everything a host installs, and writes the compatibility matrix and
release notes. Publishing publishes those tarballs, never a fresh pack. Every development tool is
pinned to an exact version.

## Alternatives

- **One version for every package.** Simpler, but a patch to one package would republish all.
- **Ranges between siblings.** Lets a host combine packages from different releases, a
  combination no test ever ran.

## Consequences

A host upgrades the packages of a release together. A release's evidence (conformance, benchmark,
audits, sizes) travels with it in its folder.

## Migration impact

Loosening the pins later is compatible; tightening ranges once loosened is not.
