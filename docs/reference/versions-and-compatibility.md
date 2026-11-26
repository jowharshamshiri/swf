# Versions and compatibility

## Package versions

Each package has its own version, following semantic versioning:

| Change                                                                                                                                                    | Before 1.0.0   | From 1.0.0 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ---------- |
| A public declaration removed or changed incompatibly, a contract's rules made stricter, an error code's meaning changed, a snapshot format no longer read | minor          | major      |
| A public declaration added, a contract's rules relaxed, a new snapshot format read                                                                        | minor or patch | minor      |
| A defect fixed with no change to any public declaration                                                                                                   | patch          | patch      |

The public API is what each package's entry point exports and the documented behaviour of each
declaration; anything else (internal module paths, an error's `message` wording, the order of
fields in a report) may change in any version.

## Releases and refs

A release is the repository's commit tagged `v<version>`, with the repository's version
(`version.txt`). Each package of it is a git ref of its own, `<folder>/v<version>` with the
package's version (`core/v0.1.0`), whose commit holds exactly the package as npm packs it; a host
installs a package by the repository's git URL and that ref. A package whose version is unchanged
keeps its ref, and its files, from the release that made it. A released ref never moves.

A package requires each sibling by the sibling's ref of its own release, that is at exactly the
version released with it. Install the packages a host uses from one release: a package of another
release requiring a sibling at another version gets its own copy of that sibling, and two copies
of a package in one page do not work together.

Each package's `CHANGELOG.md` says what each version changed for those who use it.

## Contract versions

Contracts that modules implement carry their own versions, independent of the packages':

- adapters declare `apiVersion` (`ADAPTER_API_VERSION`), and renderers, compositors and
  projections the contract version their registry checks;
- adapters, renderers, compositors, projections, policies and geometry kinds are named
  `<name>/<version>`: a saved layout names them, so an implementation whose meaning changes takes a
  new version in its ID.

A registry refuses a module of a contract version it does not implement, naming both versions.

## Snapshot formats

A snapshot names its format, such as `swf.workspace/1`.

- **Reading.** A release reads its current format and every older format it has a migration
  chain from ([Migrate](../how-to/migrate.md)). A format is read for as long as its fixtures in
  `packages/persistence/fixtures/` are kept, and dropping one is an incompatible change.
- **Writing.** A release writes only its current format.
- **Newer formats.** A snapshot of a format newer than the release reads is refused with
  `SNAPSHOT_INVALID`, naming the format in `details.sourceVersion`, and changes nothing: the
  stored text is left as it was for a newer release to read.
- **Extensions' state** carries its own version, migrated by the extension; state of a version
  the extension does not read is kept unchanged and saved again as it was.

Each release's `COMPATIBILITY.md` lists the formats it reads and writes.

## Runtimes

The browsers and runtimes each release supports, and was checked in, are in its
`COMPATIBILITY.md`; the policy is in [Browser support](browser-support.md). The packages are
ES2022 modules and need Node.js 24 or later outside a browser. Their declarations compile under
TypeScript's strictest options with the TypeScript version the release names.
