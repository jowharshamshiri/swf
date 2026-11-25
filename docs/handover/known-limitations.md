# Known limitations

What SWF does not do, or does not do yet. Each item says why and what a host can do meanwhile.

## By design

- **Live content is not warped exactly.** A browser cannot bend arbitrary interactive DOM; in a
  curved view a live element is exact at its corners and approximate in between, and says so.
  Content that must look exact in a curve is drawn by the geometry backend instead.
- **Live and drawn content occlude by layers**, not per pixel: the browser has no depth test
  between an element and a canvas.
- **The platform pointer cannot be moved.** The wrapped cursor is drawn by the page and stops at
  the screen's edge.
- **No trust model.** SWF does not sandbox content or the modules a host loads; the host and the
  browser decide what runs.
- **Content is outside the accessibility guarantee.** The reference application's controls meet
  WCAG 2.2 AA; what a window shows is the host's.

## Not yet done

- **Publishing.** The packages are not on a registry: their scope, licence and registry wait on
  the owner's decision. They are `private` and `UNLICENSED` until then.
- **Safari.** The suites run in Playwright's WebKit on Linux, which is not Safari; Safari itself
  is checked once the suites run on macOS.
- **Firefox's performance on Windows.** The Windows test guests run Firefox without a desktop
  session, so it composites in software and has no system focus there; its verdicts come from a
  Linux desktop.
- **The models' generated declarations are documented less than the rest of the API.** lungo
  does not yet carry the Lean models' docstrings into the TypeScript it generates, writes no
  documentation for the descriptor functions and fields, and types `leanTypes` with `any`. The API
  reference check exempts exactly that generated file, and reports how much on every run.
- **Development tools with moderate advisories.** `npm audit` reports moderate advisories in the
  linting tools (minimatch through `eslint` 10.14.0 and `typescript-eslint` 8.72.1, fixed by
  `eslint` 10.15.0 and `typescript-eslint` 8.73.0; the documentation generator `typedoc` 0.28.20
  reaches the same minimatch advisory, and no release of it is fixed yet) and in the reference
  application's UI kit's own test runner (`vitest` 4.1.0, a development tool of the kit, installed
  in its folder because the kit is linked from a checkout, never part of what a host installs). The
  tools are taken at the fixed versions once those are two weeks old; nothing a host installs is
  affected.

## Defects found, to be fixed

These were found while documenting the API; the JSDoc states today's behaviour.

- **A throwing host callback escapes a transaction.** If a constraint's `appliesTo` or the
  workspace's `createId` throws, `transaction()` throws instead of returning a rejection (a
  throwing `resolve` is a `CONSTRAINT_REJECTED` rejection), and an operation queued from a
  listener whose run throws leaves its `completion` unsettled.
- **Restore does not limit surface geometry's size**, which transactions do (`maxParamsBytes`).
- **`Table.fromMap`** wraps the caller's map without copying it, so that map can still change the
  table.
- **Resizing a surface whose geometry kind was unregistered** is refused unless the same command
  gives a new geometry, with the error's path under `bounds.kind`.
- **Representation policy IDs** follow a stricter pattern than every other versioned ID (lower
  case only, no `_`).
- **A host's `causeId`** reaches the `transaction.*` and `transform.preview` events, not the
  entity events of a commit, which carry the transaction's own ID.
- **The presenter**: an `open` that fails while starting leaves the viewport registered, so
  opening the same ID again is refused as already open; a backend handoff ignores a refused hide
  of a surface it keeps hidden; and `restore()` on a viewport already on its first backend
  reports a failed switch where nothing failed.
- **Persistence**: text nested hundreds of thousands of levels deep overflows the stack while
  locating its syntax error, so `restore` rejects instead of resolving `rejected`; a policy's or
  extension's `watch` that throws leaves it registered with no way to unregister; a policy's
  asynchronous `restore` is neither awaited nor timed out; option checks written as `key in` accept
  names an object inherits (`constructor`, `toString`); the Web Storage store's read-back and its
  removal of the old slot can fail with an untyped error, the second reporting a committed save as
  failed; and a migration step that returns nothing fails with a `TypeError` instead of
  `MIGRATION_FAILED`.
- **Backends and tools**: the layered renderer does not release its sessions when it fails to
  prepare, nor its drawn session when releasing its live one fails; the benchmark's latency
  recorder can add to what `stop()` returned, its resource probe keeps observers alive while
  installed, and its host leaves what it made undisposed when a later step fails; the conformance
  frame source drops the rest of a flush after a request throws, and the backend suite releases
  sessions only on success; diagnostics' option errors name no path.
- **Interaction and surfaces**: a keymap given to `createInteractionRouter` may name an unknown
  command (which `configure` refuses); `settings.steps` changes only the default keymap; an input
  adapter whose `connect` returns no function stays connected when its registration fails; a
  listener subscribed after `dispose` is accepted and never called; during `replaceBinding` the
  binding context carries the old binding's generation; and `replaceBinding` checks single
  ownership only against the surface's own viewports.
- **The reference application's models and the arbitration model**: the wrapped cursor accepts a
  pointer position that is not finite and wraps it to one that is not a number; a disposed
  workspaces machine still answers a save or an adoption; moving a window's last surface out plans
  to remove the window even when it holds other nodes, which a merge refuses; gesture bids and hits
  are ordered by priority and distance without checking those numbers are finite; and a backend
  handoff may be begun again while one is under way, restarting it.
