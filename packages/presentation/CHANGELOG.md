# Changelog of @swf/presentation

Each release of @swf/presentation and what it changed for those who use it. Versions follow semantic
versioning: before 1.0.0, a minor version may change the public API incompatibly and a patch
version never does; from 1.0.0, only a major version does.

## 0.1.0

The first release. The contracts between the scene and whatever draws it. What renderers, compositors and projections advertise; how each surface's presentation is negotiated from their capabilities; how a viewport's representation policy shows a surface in full, as a compact preview or by its label alone; the fragments a view is made of; the stages from a committed scene to a presented frame; and the presenter, which runs those stages frame by frame within a budget, delivers advisory hints, and hands viewports between backends transactionally. It depends on no concrete renderer or compositor.

A representation policy's ID is checked against core's `VERSIONED_ID`, as every other versioned
ID is, so upper case and `_` are accepted (`Host.Depth_A/1`), and a refusal says what a versioned
ID looks like.

A backend handoff contains every host failure. A candidate whose loss cannot be watched fails in
`swapping` and releases every session it made; a loss watch whose stop throws is a `backend.failed`
event of the `releasing` phase, and the backend is released all the same. A rollback checks each
undo step and goes on past a refused one: a `kept` outcome names each surface it could not put
back in `unrestored` (`UnrestoredSurface`), and the failed candidate's error lists their IDs in
`details.unrestored`. A handoff a viewport begins on its own (a loss, an unregistration, a
preferred backend registered again) that fails is kept as a `BACKGROUND_FAILED` diagnostic, never
an unhandled rejection, and a function `showDegraded` returned that throws is kept as `HOST_THREW`
and never called again. Degrading releases the previous backend even when hiding a surface is
refused or `showDegraded` throws.
