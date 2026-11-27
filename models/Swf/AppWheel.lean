import Lungo

/-!
The reference application's wheel bursts. With the depth modifier held, the wheel over a window
brings it nearer along the floor or sends it farther; a burst of wheel ticks over one window is one
gesture: it is
shown as it goes and committed once, when the wheel rests, when other input comes, or when another
window is wheeled; cancelling it leaves the window where it was. This model decides each step:
the burst under way after it, and what the application does, in order (show the burst, commit it,
discard it). The application measures how far each tick turns the wheel, moves the window by the
room's wheel pace for the burst's turn in all, and keeps the timer.
-/
namespace Swf.AppWheel

/-- A burst under way: the window it moves, and how far the wheel has turned over it in all, in
pixels (turned down, positive: farther along the floor). -/
structure Burst where
  /-- The window the burst moves. -/
  nodeId : String
  /-- How far the ticks so far have turned the wheel, in pixels (down positive). -/
  turned : Float

/-- What happens to a burst. -/
inductive WheelEvent where
  /-- A wheel tick over window `nodeId`, turning the wheel `delta` pixels (down positive). -/
  | tick (nodeId : String) (delta : Float)
  /-- The wheel rested, or other input came: the burst ends as it is. -/
  | settle
  /-- The burst is cancelled (Escape, or its window went away): nothing of it is kept. -/
  | cancel

/-- What the application does. -/
inductive WheelAction where
  /-- Show `burst` as a preview, in place of what was shown. -/
  | show (burst : Burst)
  /-- Commit `burst` as one undoable change, ending what was shown. -/
  | commit (burst : Burst)
  /-- Discard what was shown. -/
  | discard

/-- The burst under way after a step, and what the application does, in order. -/
structure WheelStep where
  /-- The burst under way after the step, if one is. -/
  burst : Option Burst
  /-- What to do, in order. -/
  actions : List WheelAction

/-- A step, or the refusal of a tick that moves the window by no finite amount. -/
inductive WheelOutcome where
  /-- The step. -/
  | step (s : WheelStep)
  /-- The tick's delta is not a finite number. -/
  | invalidDelta

/-- The step a wheel event takes from the burst under way. -/
def wheelStep (current : Option Burst) (event : WheelEvent) : WheelOutcome :=
  match event with
  | .tick nodeId delta =>
    if !delta.isFinite then .invalidDelta
    else
      match current with
      | none => .step ⟨some ⟨nodeId, delta⟩, [.show ⟨nodeId, delta⟩]⟩
      | some b =>
        if b.nodeId = nodeId then .step ⟨some ⟨nodeId, b.turned + delta⟩, [.show ⟨nodeId, b.turned + delta⟩]⟩
        else .step ⟨some ⟨nodeId, delta⟩, [.commit b, .show ⟨nodeId, delta⟩]⟩
  | .settle =>
    match current with
    | none => .step ⟨none, []⟩
    | some b => .step ⟨none, [.commit b]⟩
  | .cancel =>
    match current with
    | none => .step ⟨none, []⟩
    | some _ => .step ⟨none, [.discard]⟩

/-! ## Invariants -/

/-- A tick is refused exactly when its delta is not finite. -/
@[lungo_claim "lungo.law" subject wheelStep]
theorem tick_refused_iff_not_finite (current : Option Burst) (nodeId : String) (delta : Float) :
    wheelStep current (.tick nodeId delta) = .invalidDelta ↔ delta.isFinite = false := by
  cases h : delta.isFinite
  · simp [wheelStep, h]
  · cases current with
    | none => simp [wheelStep, h]
    | some b => by_cases hb : b.nodeId = nodeId <;> simp [wheelStep, h, hb]

/-- Settling or cancelling leaves no burst under way. -/
@[lungo_claim "lungo.law" subject wheelStep]
theorem ends_leave_no_burst (current : Option Burst) (event : WheelEvent) (s : WheelStep)
    (he : event = .settle ∨ event = .cancel) (h : wheelStep current event = .step s) :
    s.burst = none := by
  rcases he with rfl | rfl <;> cases current <;> simp [wheelStep] at h <;> subst h <;> rfl

/-- Only the burst under way is ever committed, never by a cancellation, and before anything else
is shown. -/
@[lungo_claim "lungo.law" subject wheelStep]
theorem commits_only_the_burst_under_way (current : Option Burst) (event : WheelEvent)
    (s : WheelStep) (b : Burst) (h : wheelStep current event = .step s)
    (hc : WheelAction.commit b ∈ s.actions) :
    current = some b ∧ event ≠ .cancel ∧ s.actions.head? = some (.commit b) := by
  cases event with
  | tick nodeId delta =>
    cases hf : delta.isFinite
    · simp [wheelStep, hf] at h
    · cases current with
      | none =>
        simp [wheelStep, hf] at h
        subst h
        simp at hc
      | some c =>
        by_cases hb : c.nodeId = nodeId
        · simp [wheelStep, hf, hb] at h
          subst h
          simp at hc
        · simp [wheelStep, hf, hb] at h
          subst h
          simp at hc
          subst hc
          exact ⟨rfl, by simp, rfl⟩
  | settle =>
    cases current with
    | none =>
      simp [wheelStep] at h
      subst h
      simp at hc
    | some c =>
      simp [wheelStep] at h
      subst h
      simp at hc
      subst hc
      exact ⟨rfl, by simp, rfl⟩
  | cancel =>
    cases current <;> simp [wheelStep] at h <;> subst h <;> simp at hc

/-- Ticks over the same window add up: the burst shown is the burst under way after the step, and
its turn is what it was plus the tick's. -/
@[lungo_claim "lungo.law" subject wheelStep]
theorem ticks_add_up (b : Burst) (delta : Float) (s : WheelStep) (hf : delta.isFinite = true)
    (h : wheelStep (some b) (.tick b.nodeId delta) = .step s) :
    s.burst = some ⟨b.nodeId, b.turned + delta⟩ ∧ s.actions = [.show ⟨b.nodeId, b.turned + delta⟩] := by
  simp [wheelStep, hf] at h
  subst h
  exact ⟨rfl, rfl⟩

/-- Whatever is shown is the burst under way after the step. -/
@[lungo_claim "lungo.law" subject wheelStep]
theorem shows_the_burst_under_way (current : Option Burst) (event : WheelEvent) (s : WheelStep)
    (b : Burst) (h : wheelStep current event = .step s) (hs : WheelAction.show b ∈ s.actions) :
    s.burst = some b := by
  cases event with
  | tick nodeId delta =>
    cases hf : delta.isFinite
    · simp [wheelStep, hf] at h
    · cases current with
      | none =>
        simp [wheelStep, hf] at h
        subst h
        simp at hs
        rw [hs]
      | some c =>
        by_cases hb : c.nodeId = nodeId
        · simp [wheelStep, hf, hb] at h
          subst h
          simp at hs
          rw [hs]
        · simp [wheelStep, hf, hb] at h
          subst h
          simp at hs
          rw [hs]
  | settle => cases current <;> simp [wheelStep] at h <;> subst h <;> simp at hs
  | cancel => cases current <;> simp [wheelStep] at h <;> subst h <;> simp at hs

end Swf.AppWheel
