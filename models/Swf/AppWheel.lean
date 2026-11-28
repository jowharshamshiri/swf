import Lungo

/-!
The navigation's wheel bursts. The wheel over a window's title bar, its frame or a picture of its
content brings it nearer along the floor or sends it farther, and a scroll sideways over the
background turns the workspace round the camera while that is what a drag on the background turns.
A burst of wheel ticks carrying one thing one way is one gesture: it is shown as it goes and
committed once, when the wheel rests, when other input comes, or when another window, or the same
one another way, is wheeled; cancelling it leaves everything where it was. This model decides each
step: the burst under way after it, and what the application does, in order (show the burst,
commit it, discard it). The application measures how far each tick turns the wheel, moves the
window by the room's wheel pace, or turns the workspace by the view's angle a pixel, for the
burst's turn in all, and keeps the timer.
-/
namespace Swf.AppWheel

/-- What a burst carries. -/
inductive Carries where
  /-- A window, nearer or farther along the floor. -/
  | floor
  /-- The workspace (its orbit root), round the camera. -/
  | orbit
deriving DecidableEq

/-- A burst under way: the node it carries, what way, and how far the wheel has turned over it in
all, in pixels (down or right, positive). -/
structure Burst where
  /-- The node the burst carries: a window, or the workspace's orbit root. -/
  nodeId : String
  /-- What way it carries it. -/
  carries : Carries
  /-- How far the ticks so far have turned the wheel, in pixels (down or right, positive). -/
  turned : Float

/-- Whether a tick carrying `nodeId` that way goes on with burst `b`. -/
def Burst.continues (b : Burst) (nodeId : String) (carries : Carries) : Bool :=
  b.nodeId == nodeId && b.carries == carries

/-- What happens to a burst. -/
inductive WheelEvent where
  /-- A wheel tick carrying node `nodeId` that way, turning the wheel `delta` pixels (down or
  right, positive). -/
  | tick (nodeId : String) (carries : Carries) (delta : Float)
  /-- The wheel rested, or other input came: the burst ends as it is. -/
  | settle
  /-- The burst is cancelled (Escape, or its node went away): nothing of it is kept. -/
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

/-- A step, or the refusal of a tick that moves its node by no finite amount. -/
inductive WheelOutcome where
  /-- The step. -/
  | step (s : WheelStep)
  /-- The tick's delta is not a finite number. -/
  | invalidDelta

/-- The step a wheel event takes from the burst under way. -/
def wheelStep (current : Option Burst) (event : WheelEvent) : WheelOutcome :=
  match event with
  | .tick nodeId carries delta =>
    if !delta.isFinite then .invalidDelta
    else
      match current with
      | none => .step ⟨some ⟨nodeId, carries, delta⟩, [.show ⟨nodeId, carries, delta⟩]⟩
      | some b =>
        if b.continues nodeId carries then
          .step ⟨some ⟨nodeId, carries, b.turned + delta⟩, [.show ⟨nodeId, carries, b.turned + delta⟩]⟩
        else .step ⟨some ⟨nodeId, carries, delta⟩, [.commit b, .show ⟨nodeId, carries, delta⟩]⟩
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
theorem tick_refused_iff_not_finite (current : Option Burst) (nodeId : String) (carries : Carries)
    (delta : Float) :
    wheelStep current (.tick nodeId carries delta) = .invalidDelta ↔ delta.isFinite = false := by
  cases h : delta.isFinite
  · simp [wheelStep, h]
  · cases current with
    | none => simp [wheelStep, h]
    | some b => by_cases hb : b.continues nodeId carries <;> simp [wheelStep, h, hb]

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
  | tick nodeId carries delta =>
    cases hf : delta.isFinite
    · simp [wheelStep, hf] at h
    · cases current with
      | none =>
        simp [wheelStep, hf] at h
        subst h
        simp at hc
      | some c =>
        by_cases hb : c.continues nodeId carries
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

/-- Ticks carrying the same node the same way add up: the burst shown is the burst under way after
the step, and its turn is what it was plus the tick's. -/
@[lungo_claim "lungo.law" subject wheelStep]
theorem ticks_add_up (b : Burst) (delta : Float) (s : WheelStep) (hf : delta.isFinite = true)
    (h : wheelStep (some b) (.tick b.nodeId b.carries delta) = .step s) :
    s.burst = some ⟨b.nodeId, b.carries, b.turned + delta⟩ ∧
      s.actions = [.show ⟨b.nodeId, b.carries, b.turned + delta⟩] := by
  simp [wheelStep, hf, Burst.continues] at h
  subst h
  exact ⟨rfl, rfl⟩

/-- Whatever is shown is the burst under way after the step. -/
@[lungo_claim "lungo.law" subject wheelStep]
theorem shows_the_burst_under_way (current : Option Burst) (event : WheelEvent) (s : WheelStep)
    (b : Burst) (h : wheelStep current event = .step s) (hs : WheelAction.show b ∈ s.actions) :
    s.burst = some b := by
  cases event with
  | tick nodeId carries delta =>
    cases hf : delta.isFinite
    · simp [wheelStep, hf] at h
    · cases current with
      | none =>
        simp [wheelStep, hf] at h
        subst h
        simp at hs
        rw [hs]
      | some c =>
        by_cases hb : c.continues nodeId carries
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
