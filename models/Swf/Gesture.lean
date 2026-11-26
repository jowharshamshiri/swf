import Lungo
import Swf.Order

/-!
Gestures (spec §13.3) and the keyboard hold. A pressed target's gesture goes `idle → pending →
dragging → committed → idle`, or from `pending` or `dragging` to `cancelled → idle`; the commit is
made once, a failed one cancels, and a release from a pointer no gesture holds is ignored. A node
can also be held from the keyboard, one at a time, and put down once. The router picks, runs the
policies' handlers and previews; this model decides where each intent goes and each phase.
-/
namespace Swf.Gesture

open Swf.Order (magnitudeKey)

/-- What a pointer sample reports. -/
inductive PointerPhase where
  /-- The pointer went down: a press. -/
  | down
  /-- The pointer moved. -/
  | move
  /-- The pointer was released. -/
  | up
  /-- The platform cancelled the pointer. -/
  | cancel

/-- Where a pointer sample goes, from whether a gesture holds (has captured) the pointer. -/
inductive PointerRoute where
  /-- A press: picked and offered to the policies. -/
  | press
  /-- A press of a pointer still held: its release was lost, so its gesture is cancelled first. -/
  | pressAfterLost
  /-- A move of a held pointer: its gesture follows it. -/
  | move
  /-- A release of a held pointer: its gesture ends the press or drag. -/
  | release
  /-- The platform took the pointer away: its gesture is cancelled. -/
  | lost
  /-- A sample of a pointer no gesture holds (one ended or cancelled): ignored. -/
  | ignore
deriving DecidableEq

/-- Where a pointer sample goes. A press is `press`, or `pressAfterLost` when a gesture still holds
the pointer. A move, release or cancel of a held pointer is `move`, `release` or `lost`; of a
pointer no gesture holds it is `ignore`, so a late release from an old pointer never reaches a
gesture. -/
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
  /-- A node in the view. -/
  | hit
  /-- The view's background: no window. -/
  | background
  /-- Outside the view, or on nothing that can be picked. -/
  | none

/-- What part of the workspace a point is over. -/
inductive Region where
  /-- A surface's content, whose input stays native unless a takeover is active. -/
  | content
  /-- A window's frame, or a surface that only shows something. -/
  | chrome
  /-- The band along a resizable window's edges. -/
  | resizeHandle
  /-- No window. -/
  | background
  /-- Anything outside an active modal, which takes no input. -/
  | modalOverlay

/-- What a press is decided from. -/
structure PressFacts where
  /-- What the press landed on. -/
  pick : PressPick
  /-- The region of what it landed on. -/
  region : Region
  /-- A takeover is active, or its modifier is held: content presses may be claimed. -/
  takeover : Bool
  /-- The target is shown by a proxy, whose input is the framework's. -/
  proxy : Bool
  /-- The target is already in a gesture (a pointer's or a keyboard hold). -/
  busy : Bool

/-- Where a press goes. -/
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

/-- Where a press goes: `ignore` on nothing pickable; `blocked` outside an active modal; `native`
on live content when no takeover is active and the target is not a proxy; otherwise `busy` when
the target is already in a gesture, and `claim` when it is free. Only a press on something
pickable, outside a modal, not on live content keeping its input, and on a free target reaches the
policies. -/
def pressRoute (f : PressFacts) : PressRoute :=
  match f.pick, f.region with
  | .none, _ => .ignore
  | _, .modalOverlay => .blocked
  | _, .content => if !f.takeover && !f.proxy then .native else if f.busy then .busy else .claim
  | _, _ => if f.busy then .busy else .claim

/-- A pressed pointer moved this far from where it went down: whether that is beyond the slop, past
which a press becomes a drag. -/
def beyondSlop (distance slop : Float) : Bool := distance > slop

/-- How far a wheel turned, in CSS pixels, from its scroll's deltas: its vertical delta, or its
horizontal one when the vertical is zero (plus or minus). Browsers on Windows and Linux, and macOS
itself, turn a wheel with Shift held into a sideways scroll, carrying the turn in `deltaX` with
`deltaY` zero, and keep its sign: turned up (away from the user) is negative either way. So a
turn reads the same whichever way the platform delivers it, while a scroll that has a vertical
part, a trackpad's diagonal included, is read by that part alone. -/
def wheelTurn (deltaX deltaY : Float) : Float :=
  if magnitudeKey deltaY = 0 then deltaX else deltaY

/-- What a wheel over a viewport is decided from. -/
structure WheelFacts where
  /-- A press is held in the viewport: a pointer's gesture there is pending or running. -/
  pressed : Bool
  /-- What is under the wheel. -/
  pick : PressPick
  /-- The region of what is under it. -/
  region : Region
  /-- The depth modifier is held. -/
  modifier : Bool

/-- Where a wheel goes. -/
inductive WheelRoute where
  /-- The press held in the viewport takes it: its running gesture may use it (a move takes it as
  depth); whether it does or not, the wheel is consumed and nothing else acts on it. -/
  | press
  /-- Nothing spatial is under it. -/
  | ignore
  /-- A modal blocks it: consumed, acted on by nothing. -/
  | blocked
  /-- Content keeps it: it scrolls the content natively. -/
  | native
  /-- A window's frame or handle without the depth modifier: nothing takes it. -/
  | ignored
  /-- The window under it is moved in depth, as a change of its own. -/
  | depthMove
deriving DecidableEq

/-- Where a wheel goes. While a press is held in the viewport, every wheel there is the press's
(`press`): a gesture is one change, so nothing else may change the scene in the middle of it, and
a gesture with no use for the wheel (a resize, a turn, a pinch, or a press not yet a drag) takes
it as nothing, just as a move takes every wheel as its depth. With no press held,
the wheel goes by what is under it: `ignore` over nothing spatial, `blocked` outside an active
modal, `depthMove` over a window with the depth modifier held, and otherwise `native` over content
and `ignored` over a frame. A keyboard hold holds no press: the wheel goes by what is under it,
and the hold takes a depth move of its own node into itself. -/
def wheelRoute (f : WheelFacts) : WheelRoute :=
  if f.pressed then .press
  else
    match f.pick, f.region with
    | .none, _ => .ignore
    | .background, _ => .ignore
    | .hit, .modalOverlay => .blocked
    | .hit, .content => if f.modifier then .depthMove else .native
    | .hit, _ => if f.modifier then .depthMove else .ignored

/-- Where a pressed target's gesture is. -/
inductive GesturePhase where
  /-- No gesture. -/
  | idle
  /-- A press was claimed; the arena has not yet decided between drag and tap. -/
  | pending
  /-- A gesture runs: a drag, a tap's action or a keyboard hold, previewing what it changes. -/
  | dragging
  /-- The gesture's commit was made, once. -/
  | committed
  /-- The running gesture was cancelled, or its commit rejected; what it previewed is restored. -/
  | cancelled
deriving DecidableEq

/-- How a gesture's handler finished. -/
inductive Finish where
  /-- Its commit was made. -/
  | committed
  /-- Nothing to commit (it was put back where it was). -/
  | unchanged
  /-- Its commit was rejected, or it was cancelled. -/
  | rejected

/-- What happens to a gesture. -/
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

/-- What a key event reports. -/
inductive KeyPhase where
  /-- The key was pressed. -/
  | down
  /-- The key was released. -/
  | up

/-- What a key decides from. -/
structure KeyFacts where
  /-- Whether the key was pressed or released. -/
  phase : KeyPhase
  /-- The key's value, as the platform names it (`Escape`, `Enter`, `" "` for Space). -/
  key : String
  /-- Keyboard focus is in live content, which keeps its keys. -/
  inContent : Bool
  /-- Any gesture is running or pending. -/
  gestures : Bool
  /-- A node is held from the keyboard. -/
  holding : Bool
  /-- Shift, Ctrl, Alt or Meta is held. -/
  modified : Bool

/-- Where a key goes. -/
inductive KeyRoute where
  /-- Escape: every gesture is cancelled. -/
  | cancelAll
  /-- Live content has focus and keeps the key. -/
  | native
  /-- Key releases run nothing. -/
  | ignoreRelease
  /-- The held node is put down. -/
  | putDown
  /-- The key map decides. -/
  | keymap
deriving DecidableEq

/-- Where a key goes. A press of Escape while any gesture runs or is pending cancels every gesture,
whatever has focus. Otherwise live content with focus keeps its keys (`native`); a held node is put
down by Enter or Space with no modifier (`putDown`); any other press goes to the key map, and any
other release is ignored. -/
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
  /-- Admitted: the node is held. -/
  | hold
deriving DecidableEq

/-- Whether a node may be picked up from the keyboard, checked in this order: refused while a node
is already held (`alreadyHolding`), for a viewport that is not there (`unknownViewport`), for a
node that is not there or archived (`unknownNode`), and for one in a pointer's gesture (`busy`);
otherwise `hold`. One node is held at a time, only an active one. -/
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

/-- A wheel's turn is its vertical delta whenever that is not zero, and its horizontal delta when
it is. -/
@[lungo_claim "lungo.law" subject wheelTurn]
theorem wheel_turn_reads (deltaX deltaY : Float) :
    (magnitudeKey deltaY ≠ 0 → wheelTurn deltaX deltaY = deltaY) ∧
      (magnitudeKey deltaY = 0 → wheelTurn deltaX deltaY = deltaX) := by
  constructor <;> intro h <;> simp [wheelTurn, h]

/-- A wheel turned sideways by the platform (its turn in `deltaX`, a zero in `deltaY`) turns as
far, in the same direction, as the same wheel delivered upright (the turn in `deltaY`, a zero in
`deltaX`). -/
@[lungo_claim "lungo.law" subject wheelTurn]
theorem sideways_turns_as_upright (turn zero : Float) (hz : magnitudeKey zero = 0)
    (ht : magnitudeKey turn ≠ 0) : wheelTurn turn zero = wheelTurn zero turn := by
  simp [wheelTurn, hz, ht]

/-- A wheel turns by nothing exactly when neither delta moved. -/
@[lungo_claim "lungo.law" subject wheelTurn]
theorem no_turn_iff_still (deltaX deltaY : Float) :
    magnitudeKey (wheelTurn deltaX deltaY) = 0 ↔
      magnitudeKey deltaX = 0 ∧ magnitudeKey deltaY = 0 := by
  by_cases h : magnitudeKey deltaY = 0 <;> simp [wheelTurn, h]

/-- While a press is held in a viewport, every wheel there is the press's, whatever is under it
and whatever modifier is held: nothing else changes the scene in the middle of a gesture. -/
@[lungo_claim "lungo.law" subject wheelRoute]
theorem pressed_wheel_is_the_press (f : WheelFacts) (h : f.pressed = true) :
    wheelRoute f = .press := by
  simp [wheelRoute, h]

/-- A wheel is the press's only while a press is held. -/
@[lungo_claim "lungo.law" subject wheelRoute]
theorem press_route_only_pressed (f : WheelFacts) :
    wheelRoute f = .press ↔ f.pressed = true := by
  obtain ⟨pressed, pick, region, modifier⟩ := f
  cases pressed <;> cases pick <;> cases region <;> cases modifier <;> simp [wheelRoute]

/-- The wheel moves a window in depth exactly when no press is held in the viewport, a window
outside any active modal is under it, and the depth modifier is held. -/
@[lungo_claim "lungo.law" subject wheelRoute]
theorem depth_move_iff (f : WheelFacts) :
    wheelRoute f = .depthMove ↔
      f.pressed = false ∧ f.pick = .hit ∧ f.region ≠ .modalOverlay ∧ f.modifier = true := by
  obtain ⟨pressed, pick, region, modifier⟩ := f
  cases pressed <;> cases pick <;> cases region <;> cases modifier <;> simp [wheelRoute]

/-- With no press held, a wheel outside an active modal is blocked, and content keeps a wheel
without the depth modifier. -/
@[lungo_claim "lungo.law" subject wheelRoute]
theorem free_wheel_routes (pick : PressPick) (region : Region) (modifier : Bool) :
    wheelRoute ⟨false, .hit, .modalOverlay, modifier⟩ = .blocked ∧
      wheelRoute ⟨false, .hit, .content, false⟩ = .native ∧
      (pick ≠ .hit → wheelRoute ⟨false, pick, region, modifier⟩ = .ignore) := by
  refine ⟨by simp [wheelRoute], by simp [wheelRoute], fun h => ?_⟩
  cases pick <;> simp_all [wheelRoute]

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
