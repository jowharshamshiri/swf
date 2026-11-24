import Lungo

/-!
Gestures (spec §13.3) and the keyboard hold. A pressed target's gesture goes `idle → pending →
dragging → committed → idle`, or from `pending` or `dragging` to `cancelled → idle`; the commit is
made once, a failed one cancels, and a release from a pointer no gesture holds is ignored. A node
can also be held from the keyboard, one at a time, and put down once. The router picks, runs the
policies' handlers and previews; this model decides where each intent goes and each phase.
-/
namespace Swf.Gesture

inductive PointerPhase where
  | down
  | move
  | up
  | cancel

/-- Where a pointer sample goes, from whether a gesture holds (has captured) the pointer. -/
inductive PointerRoute where
  /-- A press: picked and offered to the policies. -/
  | press
  /-- A press of a pointer still held: its release was lost, so its gesture is cancelled first. -/
  | pressAfterLost
  | move
  | release
  /-- The platform took the pointer away: its gesture is cancelled. -/
  | lost
  /-- A sample of a pointer no gesture holds (one ended or cancelled): ignored. -/
  | ignore
deriving DecidableEq

def pointerRoute (phase : PointerPhase) (captured : Bool) : PointerRoute :=
  match phase, captured with
  | .down, false => .press
  | .down, true => .pressAfterLost
  | .move, true => .move
  | .up, true => .release
  | .cancel, true => .lost
  | _, false => .ignore

/-- What a press landed on. -/
inductive PressPick where
  | hit
  | background
  /-- Outside the view, or on nothing that can be picked. -/
  | none

inductive Region where
  | content
  | chrome
  | resizeHandle
  | background
  | modalOverlay

/-- What a press is decided from. -/
structure PressFacts where
  pick : PressPick
  region : Region
  /-- A takeover is active, or its modifier is held: content presses may be claimed. -/
  takeover : Bool
  /-- The target is shown by a proxy, whose input is the framework's. -/
  proxy : Bool
  /-- The target is already in a gesture (a pointer's or a keyboard hold). -/
  busy : Bool

inductive PressRoute where
  /-- Not the framework's: nothing there. -/
  | ignore
  /-- A modal blocks it: consumed, acted on by nothing. -/
  | blocked
  /-- Live content keeps its input. -/
  | native
  /-- One gesture per target: consumed, joining nothing. -/
  | busy
  /-- Offered to the policies' claims. -/
  | claim
deriving DecidableEq

def pressRoute (f : PressFacts) : PressRoute :=
  match f.pick, f.region with
  | .none, _ => .ignore
  | _, .modalOverlay => .blocked
  | _, .content => if !f.takeover && !f.proxy then .native else if f.busy then .busy else .claim
  | _, _ => if f.busy then .busy else .claim

/-- A pressed pointer moved this far from where it went down: whether that is beyond the slop, past
which a press becomes a drag. -/
def beyondSlop (distance slop : Float) : Bool := distance > slop

inductive GesturePhase where
  | idle
  | pending
  | dragging
  | committed
  | cancelled
deriving DecidableEq

/-- How a gesture's handler finished. -/
inductive Finish where
  | committed
  /-- Nothing to commit (it was put back where it was). -/
  | unchanged
  /-- Its commit was rejected, or it was cancelled. -/
  | rejected

inductive GestureEvent where
  /-- Some policy claimed the press. -/
  | claimed
  /-- A node is picked up from the keyboard: its gesture runs at once. -/
  | held
  /-- A pointer moved beyond the slop; `winner` says whether a drag claim wins the arena. -/
  | movedBeyond (winner : Bool)
  /-- The pointers were released before any drag; `winner` says whether a tap claim wins. -/
  | releasedPending (winner : Bool)
  /-- The running gesture's handler finished. -/
  | finished (f : Finish)
  /-- The gesture is cancelled (Escape, capture lost, its target gone, the view disposed…). -/
  | cancel
  /-- The arena is ended: its pointers released. -/
  | ended

/-- The phase after an event, or none when the event does not follow from the phase. A press no
policy wants, a drag or tap no claim wins, and a finish with nothing to commit end the gesture
(back to `idle`). -/
def gestureStep (p : GesturePhase) (e : GestureEvent) : Option GesturePhase :=
  match p, e with
  | .idle, .claimed => some .pending
  | .idle, .held => some .dragging
  | .pending, .movedBeyond true => some .dragging
  | .pending, .movedBeyond false => some .idle
  | .pending, .releasedPending true => some .dragging
  | .pending, .releasedPending false => some .idle
  | .dragging, .finished .committed => some .committed
  | .dragging, .finished .unchanged => some .idle
  | .dragging, .finished .rejected => some .cancelled
  | .pending, .cancel => some .idle
  | .dragging, .cancel => some .cancelled
  | .committed, .ended => some .idle
  | .cancelled, .ended => some .idle
  | .idle, .ended => some .idle
  | _, _ => none

/-- The keys that put a held node down, pressed with no modifier. -/
def putDownKey (key : String) : Bool := key = "Enter" || key = " "

inductive KeyPhase where
  | down
  | up

/-- What a key decides from. -/
structure KeyFacts where
  phase : KeyPhase
  key : String
  /-- Keyboard focus is in live content, which keeps its keys. -/
  inContent : Bool
  /-- Any gesture is running or pending. -/
  gestures : Bool
  /-- A node is held from the keyboard. -/
  holding : Bool
  /-- Shift, Ctrl, Alt or Meta is held. -/
  modified : Bool

inductive KeyRoute where
  /-- Escape: every gesture is cancelled. -/
  | cancelAll
  | native
  /-- Key releases run nothing. -/
  | ignoreRelease
  /-- The held node is put down. -/
  | putDown
  /-- The key map decides. -/
  | keymap
deriving DecidableEq

def keyRoute (k : KeyFacts) : KeyRoute :=
  match k.phase with
  | .down =>
    if k.key = "Escape" && k.gestures then .cancelAll
    else if k.inContent then .native
    else if k.holding && !k.modified && putDownKey k.key then .putDown
    else .keymap
  | .up => if k.inContent then .native else .ignoreRelease

/-- Picking up a node from the keyboard. -/
inductive HoldGate where
  /-- A node is already held: one at a time. -/
  | alreadyHolding
  /-- The viewport is not there. -/
  | unknownViewport
  /-- The node is not there, or archived. -/
  | unknownNode
  /-- The node is in a pointer's gesture. -/
  | busy
  | hold
deriving DecidableEq

def holdGate (holding viewportKnown nodeActive inGesture : Bool) : HoldGate :=
  if holding then .alreadyHolding
  else if !viewportKnown then .unknownViewport
  else if !nodeActive then .unknownNode
  else if inGesture then .busy
  else .hold

/-! ## Invariants -/

/-- A sample of a pointer no gesture holds is ignored, unless it is a new press: a late release
from an old pointer never reaches a gesture. -/
@[lungo_claim "lungo.law" subject pointerRoute]
theorem late_pointer_ignored (phase : PointerPhase) :
    pointerRoute phase false = .ignore ↔ phase ≠ .down := by
  cases phase <;> simp [pointerRoute]

/-- A held pointer pressed again lost its release: its gesture is cancelled before the new press. -/
@[lungo_claim "lungo.law" subject pointerRoute]
theorem repress_cancels_lost (phase : PointerPhase) :
    pointerRoute phase true = .pressAfterLost ↔ phase = .down := by
  cases phase <;> simp [pointerRoute]

/-- Only a press on something pickable, outside a modal, and not on live content keeping its input,
reaches the policies; one on a target already in a gesture is consumed and joins nothing. -/
@[lungo_claim "lungo.law" subject pressRoute]
theorem press_claims_only_free_targets (f : PressFacts) (h : pressRoute f = .claim) :
    f.busy = false ∧ (f.pick = .hit ∨ f.pick = .background) ∧
      (f.region = .content → f.takeover = true ∨ f.proxy = true) := by
  obtain ⟨pick, region, takeover, proxy, busy⟩ := f
  cases pick <;> cases region <;> cases takeover <;> cases proxy <;> cases busy <;>
    simp_all [pressRoute]

/-- A gesture commits at most once: a committed gesture takes no other finish, nor a cancel, and
only ends. -/
@[lungo_claim "lungo.law" subject gestureStep]
theorem commit_at_most_once (e : GestureEvent) :
    (gestureStep .committed e).isSome = true ↔ e = .ended := by
  cases e <;> simp [gestureStep] <;> rename_i x <;> cases x <;> simp [gestureStep]

/-- A gesture commits only from `dragging`, by a finish that committed; a rejected commit cancels. -/
@[lungo_claim "lungo.law" subject gestureStep]
theorem commit_only_by_finish (p : GesturePhase) (e : GestureEvent)
    (h : gestureStep p e = some .committed) : p = .dragging ∧ e = .finished .committed := by
  cases p <;> cases e <;> simp_all [gestureStep] <;> rename_i x <;> cases x <;> simp_all

@[lungo_claim "lungo.law" subject gestureStep]
theorem failed_commit_cancels : gestureStep .dragging (.finished .rejected) = some .cancelled := rfl

/-- `cancelled` is entered only from `dragging` (a cancelled pending press is simply forgotten), and
every ended gesture returns to `idle`. -/
@[lungo_claim "lungo.law" subject gestureStep]
theorem every_end_returns_idle (p : GesturePhase) (e : GestureEvent) :
    (gestureStep p e = some .cancelled → p = .dragging) ∧
      gestureStep .committed .ended = some .idle ∧ gestureStep .cancelled .ended = some .idle := by
  refine ⟨fun h => ?_, rfl, rfl⟩
  cases p <;> cases e <;> simp_all [gestureStep] <;> rename_i x <;> cases x <;> simp_all

/-- A press drags only beyond the slop. -/
@[lungo_claim "lungo.decides" subject beyondSlop]
theorem beyond_slop_iff (distance slop : Float) :
    beyondSlop distance slop = true ↔ distance > slop := by
  simp [beyondSlop]

/-- Escape cancels every gesture whatever has focus; otherwise live content keeps its keys; a held
node is put down by Enter or Space with no modifier. -/
@[lungo_claim "lungo.law" subject keyRoute]
theorem key_routes (k : KeyFacts) :
    (k.phase = .down → k.key = "Escape" → k.gestures = true → keyRoute k = .cancelAll) ∧
      (keyRoute k = .putDown →
        k.holding = true ∧ k.modified = false ∧ (k.key = "Enter" ∨ k.key = " ") ∧ k.inContent = false) := by
  obtain ⟨phase, key, inContent, gestures, holding, modified⟩ := k
  simp only
  constructor
  · rintro rfl rfl rfl; simp [keyRoute]
  · cases phase <;> cases inContent <;> cases holding <;> cases modified <;> cases gestures <;>
      by_cases hE : key = "Escape" <;> by_cases hP : putDownKey key = true <;>
      simp_all [keyRoute] <;> simp_all [putDownKey]

/-- One node is held at a time, only an active one, and never one already in a pointer's gesture. -/
@[lungo_claim "lungo.law" subject holdGate]
theorem one_hold_at_a_time (holding viewportKnown nodeActive inGesture : Bool) :
    (holding = true → holdGate holding viewportKnown nodeActive inGesture = .alreadyHolding) ∧
      (holdGate holding viewportKnown nodeActive inGesture = .hold ↔
        holding = false ∧ viewportKnown = true ∧ nodeActive = true ∧ inGesture = false) := by
  cases holding <;> cases viewportKnown <;> cases nodeActive <;> cases inGesture <;> simp [holdGate]

end Swf.Gesture
