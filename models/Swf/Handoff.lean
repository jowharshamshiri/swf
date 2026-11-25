import Lungo

/-!
A viewport's backend handoff (spec §13.5): `active → preparing → validating → swapping →
active(new)`; a failure before the swap leaves the previous backend as it was, a failure during it
rolls back with the retained old resources, and when no backend works and the previous one is gone
the viewport is `presentation-degraded` while the scene stays usable. The presenter prepares,
plans, renders and moves; this model decides each state, what happens to each attached surface,
what a rollback does for each surface step carried out, and how a handoff ends.
-/
namespace Swf.Handoff

/-- Where a presented viewport is in its backend handoff. -/
inductive ViewportState where
  /-- A candidate backend's renderer and compositor are being prepared. -/
  | preparing
  /-- The scene is being planned with the candidate, and its live content checked as movable. -/
  | validating
  /-- The view is being rebuilt in the candidate and its live content moved into it. -/
  | swapping
  /-- A backend is active: frames are planned and presented. -/
  | active
  /-- No backend works and the previous one is gone (`presentation-degraded`): nothing is
  presented, while the scene stays usable. -/
  | degraded
  /-- The viewport is disposed and takes no event. -/
  | disposed
deriving DecidableEq

/-- What happens in a viewport's backend handoff. -/
inductive HandoffEvent where
  /-- A handoff to a candidate backend starts. -/
  | begin
  /-- The candidate's renderer and compositor are prepared. -/
  | prepared
  /-- The scene is planned with the candidate and its live content can move. -/
  | validated
  /-- The view is rebuilt in the candidate and the live content moved into it. -/
  | swapped
  /-- The viewport is disposed. -/
  | dispose

/-- The state after an event, or none when the event does not follow from the state: the stages go
in order, and a disposed viewport takes no event. -/
def handoffStep (s : ViewportState) (e : HandoffEvent) : Option ViewportState :=
  match s, e with
  | .disposed, _ => none
  | _, .dispose => some .disposed
  | .preparing, .prepared => some .validating
  | .validating, .validated => some .swapping
  | .swapping, .swapped => some .active
  | _, .begin => some .preparing
  | _, _ => none

/-- What validating decides for a surface attached in the viewport, from whether the previous
backend still works and whether its endpoint can be detached safely. -/
inductive Validation where
  /-- It can move. -/
  | movable
  /-- It cannot move while the previous backend works: the handoff is refused. -/
  | refuse
  /-- The previous backend is gone: it stays attached, hidden, shown by a proxy. -/
  | strand

/-- Whether a surface attached in the viewport lets the handoff go on: `movable` when its endpoint
allows safe detachment; otherwise `refuse` while the previous backend still works, and `strand`
only when it is gone. -/
def validateSurface (oldUsable safeDetach : Bool) : Validation :=
  if safeDetach then .movable else if oldUsable then .refuse else .strand

/-- What swapping does with a surface attached in the viewport. -/
inductive SwapAction where
  /-- Move its attachment into the new backend's target. -/
  | move
  /-- Leave it attached, hidden: it cannot leave without safe detachment. -/
  | keepHidden
  /-- Release its attachment: it is not live in the new view. -/
  | release

/-- What swapping does with a surface attached in the viewport: `move` when it is live in the new
view; otherwise `keepHidden` when validation stranded it, and `release` when it did not. -/
def swapSurface (live stranded : Bool) : SwapAction :=
  if live then .move else if stranded then .keepHidden else .release

/-- What a failed handoff's rollback does for a surface whose swap step was carried out. -/
inductive SwapUndo where
  /-- Nothing: the step left its attachment as it was, or there is no previous target to go back
  to. -/
  | nothing
  /-- Move its attachment back into the previous backend's target. -/
  | moveBack
  /-- Present it again in the previous backend's target, and hide it again when it was hidden. -/
  | represent
  /-- Show it again: it stayed attached, only hidden. -/
  | reveal
deriving DecidableEq

/-- How a surface's swap step ends. -/
inductive SwapStep where
  /-- The runtime refused it: the handoff fails, and every step recorded so far is undone. -/
  | rollback
  /-- It was carried out, and a rollback does `undo` for it. -/
  | done (undo : SwapUndo)
deriving DecidableEq

/-- How a surface's swap step ends, from its action, whether the runtime carried it out, whether
the surface was shown here, and whether the previous backend has a target for it: a refused step
of any action rolls the handoff back; a move is moved back and a release presented again, each
into the previous target when there is one; a surface kept hidden is shown again when it was
shown. -/
def swapStep (action : SwapAction) (accepted visible hadTarget : Bool) : SwapStep :=
  if !accepted then .rollback
  else
    match action with
    | .move => .done (if hadTarget then .moveBack else .nothing)
    | .keepHidden => .done (if visible then .reveal else .nothing)
    | .release => .done (if hadTarget then .represent else .nothing)

/-- What trying a handoff's candidates came to. -/
inductive Attempt where
  /-- There was no candidate to try. -/
  | untried
  /-- Every candidate tried failed. `restored` is whether their rollbacks put back every surface
  their swap steps had moved, hidden or released: false when an undo step failed for a surface
  that no later rollback put back. -/
  | failed (restored : Bool)
  /-- A candidate worked. -/
  | worked

/-- How a handoff ends: on a backend that works with nothing failed, on the previous backend after
every candidate failed, or degraded. -/
inductive Settlement where
  /-- The viewport is on a backend that works and nothing failed: a candidate that worked, or the
  previous backend when there was no candidate to try. -/
  | switched
  /-- Every candidate tried failed; the previous backend still works and stays active. `restored`
  is false when a rollback could not put a surface back, and the handoff then names each such
  surface. -/
  | kept (restored : Bool)
  /-- No backend works: the viewport is degraded. -/
  | degraded
deriving DecidableEq

/-- How a handoff ends: `switched` when a candidate worked, or when there was none to try and the
previous backend works; `kept` when candidates were tried, all failed, and the previous backend
works, saying whether their rollbacks put every surface back; and `degraded` exactly when no
backend works at all, whatever the rollbacks left, since degrading hides every surface still in
the previous backend's resources and releases those whose endpoint allows it. -/
def settle (attempt : Attempt) (oldUsable : Bool) : Settlement :=
  match attempt with
  | .worked => .switched
  | .untried => if oldUsable then .switched else .degraded
  | .failed restored => if oldUsable then .kept restored else .degraded

/-- The state a settlement leaves the viewport in. -/
def Settlement.state : Settlement → ViewportState
  | .switched | .kept _ => .active
  | .degraded => .degraded

/-- The state a settlement leaves the viewport in: active on a backend, or degraded. -/
def settledState (s : Settlement) : ViewportState := s.state

/-- Frames are planned and presented only while a backend is active. -/
def viewportPresents (s : ViewportState) : Bool := s = .active

/-- A viewport takes work until it is disposed. -/
def viewportAdmits (s : ViewportState) : Bool := s ≠ .disposed

/-- A frame asked for answers that the viewport is degraded when it is, or when it has no backend. -/
def viewportDegraded (s : ViewportState) (hasBackend : Bool) : Bool := s = .degraded || !hasBackend

/-! ## Invariants -/

/-- The stages go in order: a viewport is validating only after preparing, swapping only after
validating, and active by a handoff only after swapping. -/
@[lungo_claim "lungo.law" subject handoffStep]
theorem stage_order (s : ViewportState) (e : HandoffEvent) :
    (handoffStep s e = some .validating → s = .preparing ∧ e = .prepared) ∧
      (handoffStep s e = some .swapping → s = .validating ∧ e = .validated) ∧
      (handoffStep s e = some .active → s = .swapping ∧ e = .swapped) := by
  cases s <;> cases e <;> simp [handoffStep]

/-- A disposed viewport takes no event, and any other can be disposed or start a handoff. -/
@[lungo_claim "lungo.law" subject handoffStep]
theorem disposed_final (s : ViewportState) (e : HandoffEvent) :
    handoffStep .disposed e = none ∧
      (s ≠ .disposed → handoffStep s .dispose = some .disposed ∧ handoffStep s .begin = some .preparing) := by
  cases s <;> cases e <;> simp [handoffStep]

/-- While the previous backend works, a surface that cannot be detached safely refuses the handoff
rather than being stranded; it is stranded only when the previous backend is gone. -/
@[lungo_claim "lungo.law" subject validateSurface]
theorem strand_only_when_old_gone (oldUsable safeDetach : Bool) :
    (validateSurface oldUsable safeDetach = .strand ↔ oldUsable = false ∧ safeDetach = false) ∧
      (validateSurface oldUsable safeDetach = .refuse ↔ oldUsable = true ∧ safeDetach = false) := by
  cases oldUsable <;> cases safeDetach <;> simp [validateSurface]

/-- Live content moves into the new backend; stranded content stays attached and hidden; everything
else is released. -/
@[lungo_claim "lungo.law" subject swapSurface]
theorem swap_moves_live (live stranded : Bool) :
    (live = true → swapSurface live stranded = .move) ∧
      (live = false → stranded = true → swapSurface live stranded = .keepHidden) ∧
      (live = false → stranded = false → swapSurface live stranded = .release) := by
  cases live <;> cases stranded <;> simp [swapSurface]

/-- A refused swap step fails the handoff whatever its action, a surface kept hidden included. -/
@[lungo_claim "lungo.law" subject swapStep]
theorem refused_step_rolls_back (action : SwapAction) (visible hadTarget : Bool) :
    swapStep action false visible hadTarget = .rollback := by
  simp [swapStep]

/-- Every swap step carried out records what puts its surface back as it was: a move is moved back
and a release presented again whenever the previous backend has a target for it, and a surface
kept hidden is shown again exactly when it was shown. Nothing is recorded only for a step that
changed nothing, or one with no previous target to go back to. -/
@[lungo_claim "lungo.law" subject swapStep]
theorem carried_out_step_is_undone (visible hadTarget : Bool) :
    swapStep .move true visible hadTarget =
        .done (if hadTarget then .moveBack else .nothing) ∧
      swapStep .release true visible hadTarget =
        .done (if hadTarget then .represent else .nothing) ∧
      (swapStep .keepHidden true visible hadTarget = .done .reveal ↔ visible = true) ∧
      (swapStep .keepHidden true visible hadTarget = .done .nothing ↔ visible = false) := by
  cases visible <;> cases hadTarget <;> simp [swapStep]

/-- A handoff degrades the viewport exactly when no candidate worked and the previous backend is
gone; it answers `kept`, the settlement that reports a failure while a backend still works, only
when candidates were tried and all failed, carrying what their rollbacks restored; and with
nothing to try it leaves a previous backend that works active, with nothing failed. -/
@[lungo_claim "lungo.law" subject settle]
theorem settles_truthfully (attempt : Attempt) (oldUsable : Bool) :
    (settle attempt oldUsable = .degraded ↔ attempt ≠ .worked ∧ oldUsable = false) ∧
      (∀ restored, settle attempt oldUsable = .kept restored ↔
        attempt = .failed restored ∧ oldUsable = true) ∧
      (attempt = .untried → oldUsable = true → settle attempt oldUsable = .switched) ∧
      (oldUsable = true → (settle attempt oldUsable).state = .active) := by
  cases attempt <;> cases oldUsable <;> simp [settle, Settlement.state]

/-- A failed undo is never lost: when every candidate failed and the previous backend still works,
the handoff keeps it and says whether every surface was put back, so a rollback that could not put
one back is reported as unrestored, never as kept and restored. Where the previous backend is gone
the viewport degrades, which hides every surface still in the previous resources (releasing those
whose endpoint allows it), so there a failed undo changes nothing. -/
@[lungo_claim "lungo.law" subject settle]
theorem failed_undo_is_reported (restored oldUsable : Bool) :
    (oldUsable = true → settle (.failed restored) oldUsable = .kept restored) ∧
      (settle (.failed restored) oldUsable = .kept true → restored = true) ∧
      (oldUsable = false → settle (.failed restored) oldUsable = .degraded) := by
  cases restored <;> cases oldUsable <;> simp [settle]

@[lungo_claim "lungo.decides" subject viewportPresents]
theorem presents_iff_active (s : ViewportState) : viewportPresents s = true ↔ s = .active := by
  simp [viewportPresents]

@[lungo_claim "lungo.decides" subject viewportAdmits]
theorem admits_until_disposed (s : ViewportState) : viewportAdmits s = true ↔ s ≠ .disposed := by
  simp [viewportAdmits]

@[lungo_claim "lungo.decides" subject viewportDegraded]
theorem degraded_iff (s : ViewportState) (hasBackend : Bool) :
    viewportDegraded s hasBackend = true ↔ s = .degraded ∨ hasBackend = false := by
  cases hasBackend <;> simp [viewportDegraded]

@[lungo_claim "lungo.law" subject settledState]
theorem settled_state (s : Settlement) :
    (settledState s = .active ↔ s ≠ .degraded) ∧ (settledState s = .degraded ↔ s = .degraded) := by
  cases s <;> simp [settledState, Settlement.state]

end Swf.Handoff
