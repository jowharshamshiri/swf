# Changelog of @swf/models

Each release of @swf/models and what it changed for those who use it. Versions follow semantic
versioning: before 1.0.0, a minor version may change the public API incompatibly and a patch
version never does; from 1.0.0, only a major version does.

## 0.1.0

The first release. The framework's and the reference application's state machines and decision logic, written in Lean with their invariants proved, and compiled by lungo into one WebAssembly program that this package loads once when it is first imported. Only the packages that decide something through it depend on it.

The models refuse input they cannot decide on. `wrapPointerStep` answers `invalidX` for a pointer
place that is not finite. `workspacesStep` refuses every event once the workspaces are disposed,
saving now and adopting a restored visit among them, and takes a second disposal as done.
`bestBid` answers a `BidOutcome` (`winner`, `noBid`, or `invalidPriority` naming the first bid
whose priority is not finite), and `pickOrder` a `PickOutcome` (`ordered`, `invalidTolerance`, or
`invalidHit` naming the hit and the field that is not finite). `compositionPlan` refuses to move
the last surface out of a window that holds other nodes, as it refuses to merge that window, for
the same reason. `surfaceStep` announces a step exactly when it changes the state or the handle
fails.

`guideStep` advances the reference application's guided scenarios, starting each at its first
step and ticking a step off only when its condition holds while it is due, in order, never undone.
`challengeTarget` names the window a timed window-finding run asks for, never the selected one and
behind the camera whenever one is, and `challengeStep` counts a run's actions, ends it only when
that window is selected, and keeps its record.

`handoffStep` begins a handoff only from `active` or `degraded`, refusing a `begin` while one is
under way, and takes the new `failed` event, which returns a handoff under way to the previous
backend: `active` when it still works, `degraded` otherwise. `viewportOpened` is the state a
viewport opens in, `degraded`, with no backend yet.
