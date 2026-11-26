# Changelog of @swf/persistence

Each release of @swf/persistence and what it changed for those who use it. Versions follow semantic
versioning: before 1.0.0, a minor version may change the public API incompatibly and a patch
version never does; from 1.0.0, only a major version does.

## 0.1.0

The first release. Versioned, canonical workspace snapshots with a published JSON Schema and a validator that matches it, policy parameters and opaque extension state with size limits, two-phase restore with format migrations, a replaceable storage interface with in-memory, Web Storage and IndexedDB stores, and the save state machine.

Named spaces: `createSpaces` keeps several workspaces in one store, each under `space/<name>`, one
shown at a time and switched in one call. A switch saves the space shown first and restores the
other with the workspace's history started afresh; when that save fails it asks (`asking`) until
`answer` switches without saving or stays. Seeded spaces are made by the host until they are
stored; `saveAs`, `remove` (a seeded space is reset) and `clear` keep the store in step, and
`spaceNameIssue`, `spaceKey` and `spaceOfKey` name and key the spaces. `persistence.restore` takes
`history: 'fresh'`, passed to the workspace, to start its history afresh with the restored scene.
