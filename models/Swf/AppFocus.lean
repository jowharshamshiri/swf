import Lungo

/-!
The reference application's focus: how the view moves into a focus, between focused windows and
out of it.

The view moves by a transition: the view is committed at once, and for a short while the
application shows it moving there from what was shown, frame by frame, then shows the committed
view itself. A transition starts only when what the view frames changes (its mode, or the window a
focus frames) and motion is allowed. While one is under way, the application fitting the view
(to a new size, say) only moves where it goes; any other change of the view, or the operator taking
the view in hand, ends it at once. A transition's time runs from the first frame that shows it, so
the frame that lays the new view out, however long it takes, never cuts it short. Times are whole
milliseconds of a monotonic clock.
-/
namespace Swf.AppFocus

/-- What a view frames: its mode, and the window it frames when it frames one (a focus). -/
structure Framing where
  mode : String
  framed : Option String
deriving DecidableEq, Repr

/-- Where a transition stands: none under way, one due to be shown from the next frame, or one
shown since a time. -/
inductive Phase where
  | idle
  | due
  | running (began : Nat)
deriving DecidableEq, Repr

/-- The transition: what the committed view was last framed for, where the transition stands, and
how long one lasts. -/
structure Transition where
  framing : Framing
  phase : Phase
  duration : Nat
deriving DecidableEq, Repr

/-- Whether a transition is under way: due or shown. -/
def Phase.underWay : Phase → Bool
  | .idle => false
  | _ => true

/-- What happens to the view. -/
inductive TransitionEvent where
  /-- A commit, with what the view frames after it, whether it changed the view (a camera or a
  projection), whether it is the application fitting the view rather than the operator changing
  it, and whether motion is allowed. -/
  | commit (framing : Framing) (viewChanged : Bool) (fitted : Bool) (motion : Bool)
  /-- A frame is about to be shown. -/
  | frame (time : Nat)
  /-- The operator took the view in hand. -/
  | interrupt
deriving DecidableEq, Repr

/-- What the application does. -/
inductive TransitionAction where
  /-- Nothing. -/
  | none
  /-- Start a transition from what is shown now to the committed view. -/
  | start
  /-- End the transition under way: show the committed view at once. -/
  | jump
  /-- Show the transition this many milliseconds along. -/
  | progress (elapsed : Nat)
  /-- The transition has run its course: show the committed view. -/
  | finish
deriving DecidableEq, Repr

/-- The transition after an event, and what the application does. -/
structure TransitionAnswer where
  transition : Transition
  action : TransitionAction
deriving DecidableEq, Repr

/-- The transition after an event. A commit that changes the view moves it to what the view frames
then: by a transition when that differs from what it framed and motion is allowed; on with the one
under way when the application only fitted the view; at once otherwise, ending any under way. A
commit that leaves the view as it was keeps what it framed, unless it changed the mode, so the
frame a refocus commits next still moves. A due transition is shown from the next frame on. -/
def transitionStep (t : Transition) : TransitionEvent → TransitionAnswer
  | .commit framing viewChanged fitted motion =>
    if viewChanged then
      if framing ≠ t.framing ∧ motion = true ∧ 0 < t.duration then
        ⟨{ t with framing, phase := .due }, .start⟩
      else if framing = t.framing ∧ fitted = true ∧ t.phase.underWay then ⟨t, .none⟩
      else
        ⟨{ t with framing, phase := .idle }, if t.phase.underWay then .jump else .none⟩
    else if framing.mode ≠ t.framing.mode then
      ⟨{ t with framing }, .none⟩
    else ⟨t, .none⟩
  | .frame time =>
    match t.phase with
    | .idle => ⟨t, .none⟩
    | .due =>
      if 0 < t.duration then ⟨{ t with phase := .running time }, .progress 0⟩
      else ⟨{ t with phase := .idle }, .finish⟩
    | .running began =>
      if t.duration ≤ time - began then ⟨{ t with phase := .idle }, .finish⟩
      else ⟨t, .progress (time - began)⟩
  | .interrupt =>
    if t.phase.underWay then ⟨{ t with phase := .idle }, .jump⟩ else ⟨t, .none⟩

/-! ## Invariants -/

/-- A transition starts only on a commit that changes the view to frame something else, with motion
allowed, and is then due to be shown from the next frame. -/
@[lungo_claim "lungo.law" subject transitionStep]
theorem starts_only_on_reframing (t : Transition) (e : TransitionEvent)
    (hs : (transitionStep t e).action = .start) :
    ∃ framing fitted, e = .commit framing true fitted true ∧ framing ≠ t.framing ∧
      (transitionStep t e).transition.phase = .due := by
  cases e with
  | commit framing viewChanged fitted motion =>
    simp only [transitionStep] at hs ⊢
    by_cases hv : viewChanged = true
    · subst hv
      by_cases hc : framing ≠ t.framing ∧ motion = true ∧ 0 < t.duration
      · obtain ⟨hf, hm, hd⟩ := hc
        subst hm
        refine ⟨framing, fitted, rfl, hf, ?_⟩
        simp [hf, hd]
      · simp only [ite_true, hc, ite_false] at hs
        split at hs
        · cases hs
        · split at hs <;> cases hs
    · simp only [hv, Bool.false_eq_true, ite_false] at hs
      split at hs <;> cases hs
  | frame time =>
    simp only [transitionStep] at hs
    split at hs
    · cases hs
    · split at hs <;> cases hs
    · split at hs <;> cases hs
  | interrupt =>
    simp only [transitionStep] at hs
    split at hs <;> cases hs

/-- Without motion, no transition starts: the view goes where it is committed at once. -/
@[lungo_claim "lungo.law" subject transitionStep]
theorem no_motion_no_start (t : Transition) (framing : Framing) (v f : Bool) :
    (transitionStep t (.commit framing v f false)).action ≠ .start := by
  simp only [transitionStep]
  split
  · split
    · rename_i h; exact absurd h.2.1 (by simp)
    · split
      · simp
      · split <;> simp
  · split <;> simp

/-- After a commit that changes the view, the transition knows what the view frames. -/
@[lungo_claim "lungo.law" subject transitionStep]
theorem view_change_reframes (t : Transition) (framing : Framing) (f m : Bool) :
    (transitionStep t (.commit framing true f m)).transition.framing = framing := by
  simp only [transitionStep, ite_true]
  split
  · rfl
  · split
    · rename_i h; exact h.1.symm
    · rfl

/-- The operator changing the view without changing what it frames ends any transition under way:
the view is shown where it was committed at once. -/
@[lungo_claim "lungo.law" subject transitionStep]
theorem operator_change_ends (t : Transition) (m : Bool) :
    (transitionStep t (.commit t.framing true false m)).transition.phase = .idle := by
  simp [transitionStep]

/-- The application fitting the view keeps a transition under way going, to the view as fitted. -/
@[lungo_claim "lungo.law" subject transitionStep]
theorem fitting_keeps_going (t : Transition) (m : Bool) (hr : t.phase.underWay = true) :
    transitionStep t (.commit t.framing true true m) = ⟨t, .none⟩ := by
  simp [transitionStep, hr]

/-- A due transition is shown from the start at the next frame, its time running from then. -/
@[lungo_claim "lungo.law" subject transitionStep]
theorem shown_from_first_frame (t : Transition) (time : Nat) (hd : t.phase = .due)
    (hp : 0 < t.duration) :
    transitionStep t (.frame time) = ⟨{ t with phase := .running time }, .progress 0⟩ := by
  simp [transitionStep, hd, hp]

/-- A transition never outlasts its duration: a frame at or past its end finishes it. -/
@[lungo_claim "lungo.law" subject transitionStep]
theorem finishes_by_duration (t : Transition) (began time : Nat) (hr : t.phase = .running began)
    (ht : began + t.duration ≤ time) :
    transitionStep t (.frame time) = ⟨{ t with phase := .idle }, .finish⟩ := by
  have : t.duration ≤ time - began := by omega
  simp [transitionStep, hr, this]

/-- A frame shows a transition along only short of its end. -/
@[lungo_claim "lungo.law" subject transitionStep]
theorem progress_within (t : Transition) (time elapsed : Nat)
    (h : (transitionStep t (.frame time)).action = .progress elapsed) : elapsed < t.duration := by
  simp only [transitionStep] at h
  split at h
  · cases h
  · split at h
    · cases h; assumption
    · cases h
  · split at h
    · cases h
    · cases h; omega

/-- Taking the view in hand ends any transition under way. -/
@[lungo_claim "lungo.law" subject transitionStep]
theorem interrupt_ends (t : Transition) :
    (transitionStep t .interrupt).transition.phase = .idle := by
  simp only [transitionStep]
  split
  · rfl
  · rename_i h
    cases hp : t.phase <;> simp_all [Phase.underWay]

/-- What a transition lasts never changes. -/
@[lungo_claim "lungo.law" subject transitionStep]
theorem duration_kept (t : Transition) (e : TransitionEvent) :
    (transitionStep t e).transition.duration = t.duration := by
  cases e <;> simp only [transitionStep] <;> repeat (first | split | rfl)

end Swf.AppFocus
