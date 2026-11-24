import Lungo
import Swf.Json

/-!
The view-mode switch: which view mode a viewport is in, and the view it was entered from. A
transition says which mode comes next and which view settings to put back; the caller turns that
into one view-state commit. World transforms are never part of it.
-/
namespace Swf.ViewMode

/-- A unit quaternion, as the camera's rotation. -/
structure Quat where
  x : Float
  y : Float
  z : Float
  w : Float

/-- A projection kind's versioned ID and its configuration. -/
structure ProjectionSetting where
  id : String
  config : Json

/-- A viewport's view settings, as they were when a mode was entered. -/
structure ViewSettings where
  mode : String
  projection : ProjectionSetting
  camera : Quat

/-- The mode the viewport is in, and the view it was entered from: where going back returns to.
`origin` is none when there is none to return to (the first mode, or one reached by going back). -/
structure ModeMachine where
  mode : String
  origin : Option ViewSettings

inductive ModeEvent where
  /-- Switch to a mode; switching to the mode the viewport is in enters it again. -/
  | switch (to : String)
  /-- Leave the mode for the view it was entered from. -/
  | back

inductive ModeTransition where
  /-- The machine after the event, the mode the viewport switches to, the projection to show it
  with when it is the one the view was in before (going back), and the camera rotation to put
  back. -/
  | next (machine : ModeMachine) (mode : String) (projection : Option ProjectionSetting) (camera : Option Quat)
  | refused (reason : String)

/-- The machine of a viewport first shown in `mode`. -/
def initial (mode : String) : ModeMachine := { mode, origin := none }

/-- The machine after the viewport's record says it is in `recorded`, by whatever route: none when
it stays as it is (the record shows the mode it is in), else that mode with no view to go back
to. -/
def observed (m : ModeMachine) (recorded : String) : Option ModeMachine :=
  if m.mode = recorded then none else some (initial recorded)

/-- The next state for an event, from the view the viewport shows now and whether the mode being
left restores the view (leaving it by any route puts the camera back as it was when the mode was
entered). Switching remembers the view it leaves (or, leaving a mode that restores the view, the
view that mode was entered from, since that is the view put back); going back returns to the
remembered view and forgets it. -/
def transition (m : ModeMachine) (e : ModeEvent) (current : ViewSettings) (leavingRestores : Bool) : ModeTransition :=
  if current.mode ≠ m.mode then
    .refused s!"the viewport shows the {current.mode} mode, but the machine is in the {m.mode} mode"
  else
    match e with
    | .back =>
      match m.origin with
      | none => .refused s!"the {m.mode} mode was not entered from another view"
      | some v =>
        .next (initial v.mode) v.mode (some v.projection) (if leavingRestores then some v.camera else none)
    | .switch to =>
      if to = m.mode then
        -- Entered again: the view it was first entered from stays the one to go back to.
        .next m to none none
      else
        let restored := if leavingRestores then m.origin else none
        let left := restored.getD current
        .next { mode := to, origin := some left } to none (restored.map (·.camera))

/-! ## Invariants -/

/-- A transition is refused whenever the viewport shows another mode than the machine is in. -/
@[lungo_claim "lungo.law" subject transition]
theorem mismatch_refused (m : ModeMachine) (e : ModeEvent) (current : ViewSettings) (r : Bool)
    (h : current.mode ≠ m.mode) : ∃ reason, transition m e current r = .refused reason := by
  simp [transition, h]

/-- Going back returns to the view the mode was entered from, with its projection, puts the
camera back exactly when the mode left restores the view, and leaves nothing to go back to. -/
@[lungo_claim "lungo.law" subject transition]
theorem back_restores_entry_view (m : ModeMachine) (v current : ViewSettings) (r : Bool)
    (hm : current.mode = m.mode) (ho : m.origin = some v) :
    transition m .back current r =
      .next (initial v.mode) v.mode (some v.projection) (if r then some v.camera else none) := by
  simp [transition, hm, ho]

/-- Going back from a mode not entered from another view is refused. -/
@[lungo_claim "lungo.law" subject transition]
theorem back_without_origin_refused (m : ModeMachine) (current : ViewSettings) (r : Bool)
    (ho : m.origin = none) : ∃ reason, transition m .back current r = .refused reason := by
  by_cases hm : current.mode = m.mode <;> simp [transition, hm, ho]

/-- Entering the mode the viewport is in again keeps the view to go back to, and changes neither
the projection nor the camera. -/
@[lungo_claim "lungo.law" subject transition]
theorem reenter_keeps_origin (m : ModeMachine) (current : ViewSettings) (r : Bool)
    (hm : current.mode = m.mode) : transition m (.switch m.mode) current r = .next m m.mode none none := by
  simp [transition, hm]

/-- Switching to another mode remembers the view left: the one the current mode was entered
from when the current mode restores the view and has one, else the view shown now; and the
camera is put back exactly in the first case. -/
@[lungo_claim "lungo.law" subject transition]
theorem switch_remembers_view_left (m : ModeMachine) (current : ViewSettings) (to : String) (r : Bool)
    (hm : current.mode = m.mode) (ht : to ≠ m.mode) :
    transition m (.switch to) current r =
      .next { mode := to, origin := some ((if r then m.origin else none).getD current) } to none
        ((if r then m.origin else none).map (·.camera)) := by
  simp [transition, hm, ht]

/-- Every transition that is not refused puts the machine in the mode the viewport switches to. -/
@[lungo_claim "lungo.law" subject transition]
theorem next_mode_consistent (m m' : ModeMachine) (e : ModeEvent) (current : ViewSettings) (r : Bool)
    (mode : String) (p : Option ProjectionSetting) (c : Option Quat)
    (h : transition m e current r = .next m' mode p c) : m'.mode = mode := by
  unfold transition at h
  split at h
  · cases h
  · cases e with
    | back =>
      cases ho : m.origin with
      | none => simp [ho] at h
      | some v => simp [ho] at h; obtain ⟨rfl, rfl, -⟩ := h; rfl
    | switch to =>
      by_cases ht : to = m.mode
      · subst ht; simp at h; obtain ⟨rfl, rfl, -⟩ := h; rfl
      · simp [ht] at h; obtain ⟨rfl, rfl, -⟩ := h; rfl

/-- A machine observed in the mode it is in stays as it is; observed in another, it is in that
mode with nothing to go back to. -/
@[lungo_claim "lungo.law" subject observed]
theorem observed_follows_record (m : ModeMachine) (recorded : String) :
    observed m m.mode = none ∧
      (m.mode ≠ recorded → observed m recorded = some { mode := recorded, origin := none }) := by
  refine ⟨by simp [observed], fun h => by simp [observed, h, initial]⟩

end Swf.ViewMode
