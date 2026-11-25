# 0005. Atomic, revisioned transactions with undo as a new commit

- **Status:** Accepted
- **Date:** 2026-11-20
- **Requirements:** FR-020 to FR-032, BR-001 to BR-009, NFR-011, NFR-012

## Context

Hosts, policies, gestures and restores all change the scene, sometimes from inside each other's
event listeners. Partial changes, lost updates and undo that rewrites history make layouts
unpredictable and impossible to persist consistently.

## Decision

The scene changes only by transactions: a list of typed commands that commits as one revision or
not at all, with a typed error naming the failing path. Committed state is immutable. A
transaction may name the revision it expects (`CONFLICT` otherwise) and an idempotency key (a
repeat replays the first result; reuse for different commands is refused). Required constraints
resolve before optional ones and must all hold afterwards. Undo and redo restore the exact
recorded records as a new commit, never re-running constraints, and refuse with `CONFLICT` when a
later change would be overwritten. Cameras and viewports are view state: they commit revisions
but are not undone. A change requested from inside an event listener is queued until the
delivery ends. Previews apply on top of the committed scene and never commit by themselves.

## Alternatives

- **Mutable records with change events.** Simple to start; gives no atomicity, no conflict
  detection and no reliable undo.
- **Undo by inverse commands.** Inverses of constrained moves can land somewhere else than where
  the change started.
- **Undoable view changes.** Undo would turn the camera back, which users do not expect of
  undoing a layout change.

## Consequences

Every commit is one `transaction.committed` event with the commands it applied; operation traces
and diagnostics are built on that. The admission, replay and history rules are a proved Lean model
(`Swf.Kernel`).

## Migration impact

Changing commit semantics changes every host's error handling and every policy's assumptions: a
new major version of `@swf/core`.
