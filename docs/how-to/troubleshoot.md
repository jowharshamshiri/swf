# Troubleshoot

Start from what is seen, find the cause from what the framework reports, and fix it where it
arises. Every failure carries an error envelope: a stable `code`, a readable `message`, the
`path` of the failing input where there is one, and whether it is `retryable`
(every code is described on `SwfErrorCode` in the [API reference](../reference/api.md)).

## Collect what the framework knows

```ts
import { createDiagnostics, createOperationTrace, exportDiagnostics } from '@swf/diagnostics';

const diagnostics = createDiagnostics({
  workspace,
  runtime: surfaces,
  presenter,
  registry: presentation,
});
const trace = createOperationTrace({ workspace });
// … reproduce the problem …
const report = diagnostics.read();
const shared = exportDiagnostics({
  report,
  scene: workspace.getState(),
  trace,
  exportedAt: Date.now(),
});
```

The report gives each viewport's backend and capabilities, the fallbacks chosen and why, frame
measures, each adapter type's bindings and failures, scene density, resources held and the last
errors. The trace replays the operations in order. The export leaves out labels, binding keys and
the host's data unless they are disclosed, so it can be attached to a bug report
([Diagnostics](../../README.md#diagnostics)). In the reference application the developer panel
shows the same.

## A transaction is refused

Read `result.error`: `code` says what kind of refusal, `path` which command and field.

| Code                  | Usual cause                                                                                                                      | Fix                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `INVALID_INPUT`       | A field of the wrong type, an unknown field, a non-finite number, a rotation not of unit length, an ID in use, a hierarchy cycle | Correct the field `path` names. Rotations within 1e-6 of unit length are accepted and normalized. |
| `UNKNOWN_ENTITY`      | A command names a node, surface, camera or viewport that was deleted or never created                                            | Read the current state before building commands.                                                  |
| `CONFLICT`            | `expectedRevision` is behind, or an undo would overwrite a later change                                                          | Read the state again and retry (`retryable` is true).                                             |
| `LOCKED`              | An operator (`source: 'user'`) moves, resizes, reparents or deletes a locked node                                                | Unlock it first, or act as the host (`source: 'host'`).                                           |
| `CONSTRAINT_REJECTED` | A required constraint cannot be satisfied; `details.constraintId` names it                                                       | Change the proposal or the constraint.                                                            |
| `WORKSPACE_DISPOSED`  | The workspace was disposed                                                                                                       | Do not keep references past disposal.                                                             |

A transaction applies every command or none: after a refusal the scene is exactly as before.

## The view is blank

- **The container has no size.** The presenter fills the container it is given; a container laid
  out at zero width or height shows nothing. Give it a size, and patch the viewport's `size`
  when it changes.
- **The viewport is degraded.** A status line in the container says why (`Backend unavailable`
  and the reason). No backend in `backends` could be prepared: register the renderer and the
  compositor the list names, and check `diagnostics.read()` for the error.
- **The windows are behind the camera or outside the view.** Windows at the camera's position or
  behind a narrow view are not shown. Place them along -Z from the camera, or turn the camera.
- **Nothing was presented yet.** A viewport presents at the next frame boundary after a change.
  In a hidden tab there are no animation frames; `view.update()` presents at once.

## A surface shows a stand-in instead of its content

The stand-in says why ([Presenting](../../README.md#presenting)):

| Says          | Cause                                                       | Fix                                                                                      |
| ------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pending`     | The adapter has not answered yet                            | Wait; check `bindingTimeoutMs` and that `resolve` settles.                               |
| `unbound`     | No binding key, or the adapter answered `null` for it       | Check the key the surface carries and what the adapter knows.                            |
| `unsupported` | No adapter is registered for the surface's `adapterTypeId`  | Register it ([Load modules on demand](load-modules-on-demand.md)).                       |
| `unavailable` | `resolve` or `attach` failed, retryably                     | Read the surface's `error` in `surfaces.get(id)`; it binds again on `surfaces.bind(id)`. |
| `failed`      | The binding failed for good                                 | As above, and fix the adapter.                                                           |
| `elsewhere`   | A single-owner endpoint is live in another view or fragment | Expected: one element can be in one place.                                               |

A surface beyond `maxLive` in a viewport, or one a representation policy shows `compact` or
`label`, is drawn as a proxy by design and says nothing.

## Input does not reach the content, or reaches it when it should not

- Presses over live content go to the content unless the takeover modifier (Alt) is held or
  `router.setTakeover(true)` is in force. If content gets no input, check that no takeover is
  stuck on and that a modal is not set (`router.setModal`).
- If a window cannot be dragged, check its flags (`draggable`, `locked`) and that the press is
  on its frame, not its content.
- Content in a cross-origin frame gets its input from the browser alone; the framework never
  synthesizes events into it.
- `dispatch` answers `consumed`: an intent not consumed is the host's to deliver natively.

## A drag ends on its own

`gesture.ended` names the reason: Escape, a lost pointer capture, the target or viewport deleted,
a rejected commit, the host's `cancel()`, an invalidated preview or disposal. Each restores the
state before the drag. A lost capture usually means another page or frame took the pointer.

## A save or restore fails

- `QUOTA_EXCEEDED`: the store is full, or a snapshot or extension is over its size limit
  (`limits`). The store keeps its last good snapshot.
- `STORAGE_FAILED`: the store could not write; nothing it held changed. Retry.
- `CONFLICT`: another tab saved a newer revision under the same key. Load it, or save under
  another key.
- `SNAPSHOT_INVALID`: the text is not a valid snapshot. `path` names the failing field; for text
  that is not JSON, `details.line` and `details.column` say where it breaks.
- `SNAPSHOT_INVALID` with `details.sourceVersion` naming a format this release does not read:
  the snapshot was saved by a newer release, or in a format with no migration step
  ([Migrate](migrate.md)). `MIGRATION_FAILED`: a migration step threw or wrote the wrong format.
- An extension's failure (`EXTENSION_FAILED`) is reported in the capture's `failures` or the
  restore's outcome; the layout itself is still saved or restored.

## Frames are slow

`diagnostics.read()` gives each viewport's last and longest frame, the fragments drawn and the
writes made. Reduce what is live (`maxLive`), give background viewports `priority: 'background'`
so they wait while the frame budget is spent, and give drawables a `revision` so unchanged ones
are not redrawn. `npm run bench` measures the framework on fixed fixtures to compare against.
