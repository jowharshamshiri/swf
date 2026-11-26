# Changelog of @swf/core

Each release of @swf/core and what it changed for those who use it. Versions follow semantic
versioning: before 1.0.0, a minor version may change the public API incompatibly and a patch
version never does; from 1.0.0, only a major version does.

## 0.1.0

The first release. The scene kernel. Spatial nodes and their hierarchy, surface associations with their geometry, cameras and viewports, constraints, atomic revisioned transactions, previews, undo and redo, idempotency keys, typed events and the workspace lifecycle. It needs no DOM, renderer or UI framework.

A host callback that throws or answers what it may not inside a transaction, preview, undo, redo
or restore (a constraint's `appliesTo` or `resolve`, a geometry provider's `validate`, a projection
kind's `configIssue`, the workspace's `createId`, `now` or `timer`) rejects the operation, naming
the callback and what it threw or answered, and leaves the workspace unchanged; before, an
`appliesTo`, `createId` or clock that threw escaped the call as an exception. An operation queued
from a listener always settles its `completion`, which is rejected only when the operation
itself throws, and the operations queued after it still run. The clock is read once as each
operation begins, so every event of one operation carries the same `timestamp`, and a
diagnostic carries the time of the event it concerns. A `frameBoundary` that throws makes the
held preview events go out at once and is recorded as the new `FRAME_BOUNDARY_THREW`
diagnostic. `cancelPreview` throws, and `dispose()` returns a rejected promise without disposing,
when the workspace's clock fails.

A restored snapshot's surface geometry is held to the workspace's `maxParamsBytes` limit, as a
transaction's is: params over it are refused with `SNAPSHOT_INVALID` at the geometry's `params`,
and a transaction's refusal now names the limit (`more than the maxParamsBytes limit of …`).
Resizing a surface checks its geometry against the new bounds and, when it does not fit, refuses
with the path of `bounds`; resizing a surface whose geometry kind is no longer registered is
refused there too, since its geometry cannot be checked, unless the same command gives a new
geometry. A table never changes once made: a `TableDraft` copies the entries it is given, and
`Table` has no factory that wraps a caller's map. Presence checks read a value's own fields only:
a geometry's `params`, a projection's `config` and a rebind's `bindingKey` inherited from a
prototype count as missing, a snapshot's flag must be the snapshot's own, and a `geometryLimits`
entry named after a prototype member (`constructor`, `toString`, `__proto__`) is refused as an
unknown limit.

A host's `causeId` is carried as `causationId` on every event of a commit, its entity events
included, for a transaction, an undo, a redo and a restore alike; before, the entity events
carried the transaction's own ID, as they still do when no `causeId` is given. A preview's
`causeId` is carried on the `preview.cancelled` that ends it however it ends, as on its
`transform.preview` events; before, only the disposal's `preview.cancelled` carried it.
