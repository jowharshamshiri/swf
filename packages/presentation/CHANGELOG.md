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

A viewport's handoff state follows the handoff model through every candidate: when a candidate
fails, the viewport is back on the previous backend (`active`, or `presentation-degraded` when that
no longer works) before `backend.failed` is sent and the next candidate is begun, where before it
stayed in the stage that failed. A handoff is never begun while one is under way.

Windows are drawn as cards: each surface lies on its window's card, a flat, upright rectangle at the
window's projected centre (ADR 0015). A `ProjectedFragment` carries its `card`, its `scale` and its
`representation`, and no corners; `cardScale`, `windowCard`, `CARD_PIXELS_PER_UNIT`, `COMPACT_CARD`
and `LABEL_CARD` give the card rules. A `ViewProjector` projects with the viewport's representation
policy, which may give a card's scale outright (`RepresentationPolicy.scaleOf`, `cardScaleFor`);
`FrameInput` no longer takes the policy. A `ProjectionProfile` no longer declares a `mapping`: a card
is never bent, so negotiation asks only for transforms that scale it (`affine-2d` or more) to present
content exactly or natively, and a renderer declares a handle kind `exact` only with such transforms.
