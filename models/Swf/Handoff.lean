import Lungo

/-!
A viewport's backend handoff (spec §13.5): `active → preparing → validating → swapping →
active(new)`; a failure before the swap leaves the previous backend as it was, a failure during it
rolls back with the retained old resources, and when no backend works and the previous one is gone
the viewport is `presentation-degraded` while the scene stays usable. The presenter prepares,
plans, renders and moves; this model decides each state, what happens to each attached surface,
and how a handoff that found no backend ends.
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

/-- How a handoff that tried every candidate ends: on the first that worked; else the previous
backend, kept active, when it still works; else degraded. -/
inductive Settlement where
  /-- A candidate worked and is active. -/
  | switched
  /-- No candidate worked; the previous backend still works and stays active. -/
  | kept
  /-- No backend works: the viewport is degraded. -/
  | degraded
deriving DecidableEq

/-- How a handoff ends: `switched` when any candidate worked; otherwise `kept` when the previous
backend still works, and `degraded` exactly when no backend works at all. -/
def settle (anyWorked oldUsable : Bool) : Settlement :=
  if anyWorked then .switched else if oldUsable then .kept else .degraded

/-- The state a settlement leaves the viewport in. -/
def Settlement.state : Settlement → ViewportState
  | .switched | .kept => .active
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

/-- A handoff that found no backend leaves the previous one active when it works, and degrades the
viewport exactly when no backend works at all. -/
@[lungo_claim "lungo.law" subject settle]
theorem degraded_only_without_backend (anyWorked oldUsable : Bool) :
    (settle anyWorked oldUsable = .degraded ↔ anyWorked = false ∧ oldUsable = false) ∧
      (anyWorked = false → oldUsable = true → (settle anyWorked oldUsable).state = .active) := by
  cases anyWorked <;> cases oldUsable <;> simp [settle, Settlement.state]

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
