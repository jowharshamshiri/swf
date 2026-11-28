# Changelog of @swf/models

Each release of @swf/models and what it changed for those who use it. Versions follow semantic
versioning: before 1.0.0, a minor version may change the public API incompatibly and a patch
version never does; from 1.0.0, only a major version does.

## 0.1.0

The first release. The framework's and the reference application's state machines and decision logic, written in Lean with their invariants proved, and compiled by lungo into one WebAssembly program that this package loads once when it is first imported. Only the packages that decide something through it depend on it.

The models refuse input they cannot decide on. `wrapPointerStep` answers `invalidX` for a pointer
place that is not finite. `workspacesStep` refuses every event once the workspaces are disposed,
saving now among them, and takes a second disposal as done.
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

`experimentPlan` gives the reference application's experiments: the modules each turns on (the
capability it isolates alone, or all eight), and the view it sets up from what the scene offers
(focus only on a window there is, drags turning the workspace only while a group is designated,
the whole circle for seamless 360°). `experimentOf` names the experiment a combination of the
modules' switches is, or none for a custom combination.

`handoffStep` begins a handoff only from `active` or `degraded`, refusing a `begin` while one is
under way, and takes the new `failed` event, which returns a handoff under way to the previous
backend: `active` when it still works, `degraded` otherwise. `viewportOpened` is the state a
viewport opens in, `degraded`, with no backend yet.

`wheelTurn` says how far a wheel turned from its scroll's deltas: `deltaY`, or `deltaX` when
`deltaY` is zero, so a wheel the platform turned sideways reads as it does upright.

`wheelRoute` says where a wheel goes: to the press held in its viewport whenever one is, pending
or running, whatever is under it and whatever modifier is held, so nothing else changes the scene
in the middle of a gesture; with no press held, by what is under it and the depth modifier.

`commit` takes a restore that starts the history afresh (`fresh`), emptying both stacks and
recording nothing, and says so (`clearUndo`). `Swf.Spaces` decides named spaces: `spacesNameIssue`,
`spacesInitial` and `spacesStep`, which opens another space only once the space shown is saved or
its changes are given up. `workspacesMigration` decides which entries the reference application
stored before spaces become which spaces; the visit and named-save decisions it replaces
(`workspacesNameIssue`, `workspacesNewest`, `workspacesStale`, `workspacesSavedAt` and the
`restored` event of `workspacesStep`) are gone.

`Swf.Room` decides where windows stand in the room: places and their limits, the drag, the wheel, a
drop on the floor plan and the derived elevation. `Swf.AppSpacing` keeps a window put on a spoke
clear of its neighbours. `Swf.Fallback` no longer weighs whether a projection is nonlinear: exact
and native presentation need transforms that scale a card (`cards_need_scaling`). A wheel burst
counts the wheel's turn in pixels (`Burst.turned`).

`Swf.Arbitration` knows a window's title bar (`HitRegion.titleBar`): a title bar is never occluded,
orders before every other hit of the same priority however near (`titleBar_before`), and a surface
under its own window's title bar does not count (`titleBar_covers_own_surface`). `Swf.Gesture`'s
`Region` has the title bar too.

`Swf.Gesture.selectionOnPress` decides the selection after a press on a window: the window alone,
unless it is already among the selected (claims `pressed_selected`, `changed_iff_not_selected`).

`Swf.AppFocus.doublePress` decides a double press on a window: it closes the focus on the window in
focus and focuses any other (claims `leaves_iff_focused`, `focuses_the_pressed`).

`Swf.Gesture.pointerRoute` takes a pointer leaving the view and routes a pointer no gesture holds
as hovering (`hover`, `unhover`; `hovers_only_free`), and `hoverShows` says what a press would do
where it hovers, from `pressRoute` itself (`shows_what_a_press_does`).

`Swf.Gesture.wheelRoute` takes what is under the wheel, whether it is a picture, Ctrl and a sideways
scroll, and routes the wheel over a window's title bar, frame or picture to move it, over live
content always to the content, and over the background to turn or zoom the view
(`depth_move_iff`, `content_keeps_the_wheel`, `background_turns_and_zooms`). `Swf.AppWheel`'s bursts
carry a window along the floor or the workspace round the camera (`Carries`).

`Swf.Arbitration` orders a window in front before every other window's hits of the same priority,
title bars included, and never marks it occluded (`Hit.front`, `front_before`).
