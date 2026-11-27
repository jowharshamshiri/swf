# Migrate

Three things move forward independently: the snapshot format layouts are saved in, the state each
extension saves, and the packages a host is built on.

## Bring older layouts forward

A snapshot names its format (`swf.workspace/2` is the current one). `@swf/persistence` reads every
format it has
a migration chain from, and writes only the current one. `persistence.restore` and
`persistence.import` migrate a snapshot on a copy, validate the result, and only then replace
the scene. A format no chain leads from is refused with `SNAPSHOT_INVALID`, and a step that
throws or writes the wrong format with `MIGRATION_FAILED`; either names the snapshot's format in
`details.sourceVersion` and changes nothing. The outcome of a restore lists the format the snapshot was in and every step taken, with
its warnings.

To read a layout format of the host's own (a format from before it used SWF, say), add a
migration step that turns it into the first SWF format:

```ts
const persistence = createPersistence({
  workspace: workspace.persistence(),
  migrations: [
    {
      from: 'my-app.layout/3',
      to: 'swf.workspace/1',
      migrate: (old) => ({ document: convertLayout(old), warnings: [] }),
    },
  ],
});
```

Each step reads one format and writes the next on a copy of its own; the steps must form a chain
without cycles. Saved layouts are rewritten in the current format the next time they are saved:
keep the old text if the host may need to go back
([Release the packages](release.md#roll-a-release-back)).

The framework's own steps are in `SNAPSHOT_MIGRATIONS`: from `swf.workspace/1` to
`swf.workspace/2`, which stands every window and surface upright (the room draws each window as a
flat card) and names each one it stood upright in a warning. When the framework adds a snapshot
format, its step joins them, and the fixtures
of every older format it still reads (`packages/persistence/fixtures/`) must restore and write
back unchanged; the release's compatibility matrix lists the formats each release reads.

## Bring an extension's state forward

An extension saves its state under its namespace with a `version` of its own. When it changes its
state's shape, it raises `version` and adds `migrate`:

```ts
persistence.registerExtension({
  namespace: 'host.pins',
  version: 2,
  capture: () => ({ pinned: pins.list(), order: pins.order() }),
  restore: (data) => pins.load(data),
  migrate: (data, fromVersion) =>
    fromVersion === 1 ? { pinned: data.pinned, order: 'added' } : data,
});
```

A snapshot holding an older version is migrated on a copy before `restore` sees it. A snapshot
holding a newer version than the extension reads, or an older one with no `migrate`, is reported
in the outcome, and the state from the snapshot is held unchanged and saved again as it was, so a
newer page can still read it.

## Move a host to newer packages

1. Read each package's `CHANGELOG.md` for every version between the two. Before 1.0.0 a minor
   version may change the public API incompatibly; a patch version never does.
2. Install all the packages of the new release together: each requires its siblings at exactly
   the versions released with it.
3. Rebuild against the new declarations: the compiler names every changed signature.
4. Run the host's conformance checks (`@swf/conformance`) for its adapters and backends.
5. Restore a saved layout of each format the host has in the field; the release's
   `COMPATIBILITY.md` says which formats it reads.
