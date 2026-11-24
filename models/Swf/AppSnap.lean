import Lungo
import Swf.Order
import Swf.AppFeatures

/-!
The reference application's magnetic positioning, decided around the camera. Windows in a
panorama stand around the viewer, so where a window is means its heading and elevation seen from
the camera, and how far away it is; the application measures that (the geometry), and this model
decides the snap. A window being moved snaps, within the thresholds, to the windows beside it:
- an edge within the snap distance of a neighbour's facing edge (short of it or over it) goes to
  that edge, leaving the padding between them: the linear threshold, in world units at the moving
  window's distance;
- its centre's heading or elevation to a neighbour's, or its elevation to the horizon: the angular
  threshold, in degrees.
Each axis takes the nearest snap on it; at the same distance edges win over line-ups, line-ups
over the horizon, and then the first found. Only neighbours side by side with the window snap:
those whose distance from the camera is within a quarter of its own; farther ones lie behind it.
-/
namespace Swf.AppSnap

open Swf.Order (floatKey magnitudeKey)
open Swf.AppFeatures (SnapSettings)

/-- A window as seen from the camera: its centre's heading (to the right) and elevation, in
radians, its distance in world units, and its angular half width and half height. -/
structure SnapSeen where
  heading : Float
  elevation : Float
  distance : Float
  halfWidth : Float
  halfHeight : Float
deriving Inhabited

/-- A window the moving one may snap to. -/
structure SnapNeighbour where
  id : String
  seen : SnapSeen
deriving Inhabited

/-- The moving window's edge. -/
inductive SnapSide where
  | left
  | right
  | top
  | bottom
deriving DecidableEq

/-- What a centre lines up along. -/
inductive SnapLine where
  | heading
  | elevation
deriving DecidableEq

/-- What the moving window lines up with; a neighbour is named by its place in the neighbours. -/
inductive SnapConstraint where
  | edge (side : SnapSide) (neighbour : Nat)
  | align (line : SnapLine) (neighbour : Nat)
  | horizon
deriving DecidableEq

/-- Which snap wins a tie of distance: edges, then line-ups, then the horizon. -/
def SnapConstraint.rank : SnapConstraint → Nat
  | .edge .. => 0
  | .align .. => 1
  | .horizon => 2

/-- A snap on one axis: how far to turn the window, in radians, and why. -/
structure SnapCandidate where
  delta : Float
  constraint : SnapConstraint

/-- The axis a snap turns the window along: across (heading) or down (elevation). -/
inductive SnapAxis where
  | across
  | down
deriving DecidableEq

/-- A snap the window could take, with how far it is from it (an edge's gap or overlap, or a
line-up's offset) and the threshold within which it takes it. -/
structure SnapOption where
  axis : SnapAxis
  candidate : SnapCandidate
  distance : Float
  threshold : Float

inductive SnapOutcome where
  /-- Nothing to snap to. -/
  | unsnapped
  /-- The snap on each axis, where there is one (at least one is). -/
  | snapped (across : Option SnapCandidate) (down : Option SnapCandidate)
  /-- A number at this field is not finite. -/
  | invalid (field : String)

/-- π, as the double nearest it. -/
def pi : Float := 3.141592653589793

/-- Neighbours whose distance differs by at most this share of the moving window's lie beside it. -/
def sameLayer : Float := 0.25

/-- An angle wrapped to (-π, π]. -/
def wrapAngle (angle : Float) : Float :=
  let turned := angle - 2 * pi * ((angle + pi) / (2 * pi)).floor
  if turned == -pi then pi else turned

/-- The snaps a neighbour offers, in the order they are weighed. -/
def neighbourOptions (m : SnapSeen) (linear pad angular : Float) (index : Nat) (n : SnapSeen) :
    List SnapOption :=
  -- The neighbour's place relative to the moving window's centre heading.
  let h := wrapAngle (n.heading - m.heading)
  let left := h - n.halfWidth
  let right := h + n.halfWidth
  let top := n.elevation + n.halfHeight
  let bottom := n.elevation - n.halfHeight
  let rows := min top (m.elevation + m.halfHeight) - max bottom (m.elevation - m.halfHeight)
  let columns := min right m.halfWidth - max left (-m.halfWidth)
  -- Side by side: the moving window's left edge to the neighbour's right, or its right to the left.
  let leftGap := -m.halfWidth - right
  let rightGap := left - m.halfWidth
  let sides :=
    if rows > 0 then
      [{ axis := .across, candidate := ⟨pad - leftGap, .edge .left index⟩, distance := leftGap,
         threshold := linear },
       { axis := .across, candidate := ⟨rightGap - pad, .edge .right index⟩, distance := rightGap,
         threshold := linear }]
    else []
  -- One above the other: the moving window's bottom edge to the neighbour's top, or its top to the bottom.
  let bottomGap := m.elevation - m.halfHeight - top
  let topGap := bottom - (m.elevation + m.halfHeight)
  let stacked :=
    if columns > 0 then
      [{ axis := .down, candidate := ⟨pad - bottomGap, .edge .bottom index⟩, distance := bottomGap,
         threshold := linear },
       { axis := .down, candidate := ⟨topGap - pad, .edge .top index⟩, distance := topGap,
         threshold := linear }]
    else []
  let level := n.elevation - m.elevation
  sides ++ stacked ++
    [{ axis := .across, candidate := ⟨h, .align .heading index⟩, distance := h, threshold := angular },
     { axis := .down, candidate := ⟨level, .align .elevation index⟩, distance := level,
       threshold := angular }]

/-- Every snap the moving window could take, in the order they are weighed: each neighbour's beside
it (not itself, and not one seen from no distance), then the horizon. -/
def snapOptions (movingId : String) (m : SnapSeen) (neighbours : Array SnapNeighbour)
    (settings : SnapSettings) : List SnapOption :=
  let linear := settings.linear / m.distance
  let pad := settings.padding / m.distance
  let angular := settings.angular * (pi / 180)
  let beside := (List.range neighbours.size).flatMap fun i =>
    let n := neighbours[i]!
    if n.id = movingId || !(n.seen.distance > 0) ||
        (n.seen.distance - m.distance).abs > sameLayer * m.distance then []
    else neighbourOptions m linear pad angular i n.seen
  beside ++
    [{ axis := .down, candidate := ⟨-m.elevation, .horizon⟩, distance := m.elevation,
       threshold := angular }]

/-- A snap is within reach when its distance's magnitude is within the threshold. -/
def SnapOption.reachable (o : SnapOption) : Bool :=
  (magnitudeKey o.distance : Int) ≤ floatKey o.threshold

/-- How a snap weighs against the others: by the magnitude of its turn, then by its rank. Lower
wins. -/
def SnapCandidate.score (c : SnapCandidate) : Nat := magnitudeKey c.delta * 3 + c.constraint.rank

def pickStep (best : Option SnapCandidate) (c : SnapCandidate) : Option SnapCandidate :=
  match best with
  | none => some c
  | some a => if c.score < a.score then some c else some a

/-- The winning snap among candidates: the lowest score, the first of equals. -/
def snapPick (cs : List SnapCandidate) : Option SnapCandidate := cs.foldl pickStep none

/-- The snaps within reach on an axis, in the order they are weighed. -/
def reachableOn (axis : SnapAxis) (os : List SnapOption) : List SnapCandidate :=
  (os.filter fun o => o.axis = axis && o.reachable).map (·.candidate)

/-- The first field whose number is not finite, if any. -/
def snapInvalid (m : SnapSeen) (neighbours : Array SnapNeighbour) (settings : SnapSettings) :
    Option String :=
  let finite (s : SnapSeen) :=
    s.heading.isFinite && s.elevation.isFinite && s.distance.isFinite && s.halfWidth.isFinite &&
      s.halfHeight.isFinite
  if !finite m then some "moving"
  else match (List.range neighbours.size).find? (fun i => !finite neighbours[i]!.seen) with
    | some i => some s!"neighbours[{i}]"
    | none =>
      if !settings.linear.isFinite then some "settings.linear"
      else if !settings.angular.isFinite then some "settings.angular"
      else if !settings.padding.isFinite then some "settings.padding"
      else none

/-- The snap for the moving window (`movingId`, seen as `m`) among `neighbours` (in a stable
order: ties go to the first). A window seen from no distance does not snap. -/
def snapResolve (movingId : String) (m : SnapSeen) (neighbours : Array SnapNeighbour)
    (settings : SnapSettings) : SnapOutcome :=
  match snapInvalid m neighbours settings with
  | some field => .invalid field
  | none =>
    if !(m.distance > 0) then .unsnapped
    else
      let os := snapOptions movingId m neighbours settings
      let across := snapPick (reachableOn .across os)
      let down := snapPick (reachableOn .down os)
      if across.isNone && down.isNone then .unsnapped else .snapped across down

/-! ## Invariants -/

theorem foldl_pick (cs : List SnapCandidate) (init : Option SnapCandidate) (c : SnapCandidate)
    (h : cs.foldl pickStep init = some c) :
    (init = some c ∨ c ∈ cs) ∧ (∀ a, init = some a → c.score ≤ a.score) ∧ ∀ x ∈ cs, c.score ≤ x.score := by
  induction cs generalizing init with
  | nil => simp at h; subst h; simp
  | cons x xs ih =>
    simp only [List.foldl_cons] at h
    obtain ⟨hm, hi, hx⟩ := ih _ h
    cases init with
    | none =>
      simp only [pickStep] at hm hi
      refine ⟨?_, by simp, ?_⟩
      · rcases hm with hm | hm
        · cases hm; simp
        · simp [hm]
      · intro y hy
        simp at hy
        rcases hy with rfl | hy
        · exact hi _ rfl
        · exact hx y hy
    | some a =>
      simp only [pickStep] at hm hi
      by_cases hs : x.score < a.score
      · simp only [hs, ite_true] at hm hi
        have := hi _ rfl
        refine ⟨?_, fun b hb => by cases hb; omega, ?_⟩
        · rcases hm with hm | hm
          · cases hm; simp
          · simp [hm]
        · intro y hy
          simp at hy
          rcases hy with rfl | hy
          · omega
          · exact hx y hy
      · simp only [hs, ite_false] at hm hi
        have := hi _ rfl
        refine ⟨?_, fun b hb => by cases hb; omega, ?_⟩
        · rcases hm with hm | hm
          · exact .inl hm
          · simp [hm]
        · intro y hy
          simp at hy
          rcases hy with rfl | hy
          · omega
          · exact hx y hy

theorem snapPick_some {cs : List SnapCandidate} {c : SnapCandidate} (h : snapPick cs = some c) :
    c ∈ cs ∧ ∀ x ∈ cs, c.score ≤ x.score := by
  obtain ⟨hm, -, hx⟩ := foldl_pick cs none c h
  exact ⟨by simpa using hm, hx⟩

theorem foldl_pick_some (cs : List SnapCandidate) (a : SnapCandidate) :
    ∃ c, cs.foldl pickStep (some a) = some c := by
  induction cs generalizing a with
  | nil => exact ⟨a, rfl⟩
  | cons x xs ih =>
    simp only [List.foldl_cons, pickStep]
    split
    · exact ih x
    · exact ih a

theorem snapPick_none {cs : List SnapCandidate} : snapPick cs = none ↔ cs = [] := by
  cases cs with
  | nil => simp [snapPick]
  | cons x xs =>
    simp only [snapPick, List.foldl_cons, pickStep, reduceCtorEq, iff_false]
    obtain ⟨c, hc⟩ := foldl_pick_some xs x
    simp [hc]

theorem snapResolve_snapped {movingId : String} {m : SnapSeen} {neighbours : Array SnapNeighbour}
    {settings : SnapSettings} {a d : Option SnapCandidate}
    (h : snapResolve movingId m neighbours settings = .snapped a d) :
    a = snapPick (reachableOn .across (snapOptions movingId m neighbours settings)) ∧
      d = snapPick (reachableOn .down (snapOptions movingId m neighbours settings)) := by
  unfold snapResolve at h
  split at h
  · cases h
  · split at h
    · cases h
    · simp only at h
      split at h
      · cases h
      · cases h
        exact ⟨rfl, rfl⟩

/-- A snap is always one of the snaps the window could take on its axis, and one within reach:
its distance's magnitude is within the threshold. -/
@[lungo_claim "lungo.law" subject snapResolve]
theorem snap_is_candidate (movingId : String) (m : SnapSeen) (neighbours : Array SnapNeighbour)
    (settings : SnapSettings) (a d : Option SnapCandidate)
    (h : snapResolve movingId m neighbours settings = .snapped a d) :
    (∀ c, a = some c → ∃ o ∈ snapOptions movingId m neighbours settings,
        o.axis = .across ∧ o.candidate = c ∧ o.reachable = true) ∧
      (∀ c, d = some c → ∃ o ∈ snapOptions movingId m neighbours settings,
        o.axis = .down ∧ o.candidate = c ∧ o.reachable = true) := by
  obtain ⟨ha, hd⟩ := snapResolve_snapped h
  refine ⟨fun c hc => ?_, fun c hc => ?_⟩
  · subst ha
    obtain ⟨hm, -⟩ := snapPick_some hc
    simp only [reachableOn, List.mem_map, List.mem_filter, Bool.and_eq_true, decide_eq_true_eq] at hm
    obtain ⟨o, ⟨ho, hx, hr⟩, rfl⟩ := hm
    exact ⟨o, ho, hx, rfl, hr⟩
  · subst hd
    obtain ⟨hm, -⟩ := snapPick_some hc
    simp only [reachableOn, List.mem_map, List.mem_filter, Bool.and_eq_true, decide_eq_true_eq] at hm
    obtain ⟨o, ⟨ho, hx, hr⟩, rfl⟩ := hm
    exact ⟨o, ho, hx, rfl, hr⟩

/-- A snap's distance is within its threshold, compared as numbers through their order keys. -/
@[lungo_claim "lungo.law" subject snapResolve]
theorem snap_within_threshold (movingId : String) (m : SnapSeen) (neighbours : Array SnapNeighbour)
    (settings : SnapSettings) (a d : Option SnapCandidate)
    (h : snapResolve movingId m neighbours settings = .snapped a d) (c : SnapCandidate)
    (hc : a = some c ∨ d = some c) :
    ∃ o ∈ snapOptions movingId m neighbours settings, o.candidate = c ∧
      (magnitudeKey o.distance : Int) ≤ floatKey o.threshold := by
  obtain ⟨ha, hd⟩ := snap_is_candidate movingId m neighbours settings a d h
  rcases hc with hc | hc
  · obtain ⟨o, ho, -, hx, hr⟩ := ha c hc
    exact ⟨o, ho, hx, by simpa [SnapOption.reachable] using hr⟩
  · obtain ⟨o, ho, -, hx, hr⟩ := hd c hc
    exact ⟨o, ho, hx, by simpa [SnapOption.reachable] using hr⟩

/-- A score orders snaps by the magnitude of their turn, then by rank (edges, line-ups, horizon). -/
theorem score_lt_iff (b c : SnapCandidate) :
    b.score < c.score ↔ magnitudeKey b.delta < magnitudeKey c.delta ∨
      (magnitudeKey b.delta = magnitudeKey c.delta ∧ b.constraint.rank < c.constraint.rank) := by
  have hb : b.constraint.rank < 3 := by cases b.constraint <;> simp [SnapConstraint.rank]
  have hc : c.constraint.rank < 3 := by cases c.constraint <;> simp [SnapConstraint.rank]
  unfold SnapCandidate.score
  constructor
  · intro h
    by_cases hk : magnitudeKey b.delta < magnitudeKey c.delta
    · exact .inl hk
    · right
      have : magnitudeKey b.delta = magnitudeKey c.delta := by
        rcases Nat.lt_or_ge (magnitudeKey c.delta) (magnitudeKey b.delta) with h' | h'
        · have : magnitudeKey c.delta * 3 + 3 ≤ magnitudeKey b.delta * 3 := by omega
          omega
        · omega
      exact ⟨this, by rw [this] at h; omega⟩
  · rintro (h | ⟨h, h'⟩)
    · have : magnitudeKey b.delta * 3 + 3 ≤ magnitudeKey c.delta * 3 := by omega
      omega
    · rw [h]; omega

/-- The nearest snap within reach wins on each axis: no other snap within reach on that axis turns
the window less, and of those that turn it as much, none has a lower rank. -/
@[lungo_claim "lungo.law" subject snapResolve]
theorem nearest_wins (movingId : String) (m : SnapSeen) (neighbours : Array SnapNeighbour)
    (settings : SnapSettings) (a d : Option SnapCandidate)
    (h : snapResolve movingId m neighbours settings = .snapped a d) (c : SnapCandidate)
    (o : SnapOption) (ho : o ∈ snapOptions movingId m neighbours settings) (hr : o.reachable = true)
    (hc : (o.axis = .across ∧ a = some c) ∨ (o.axis = .down ∧ d = some c)) :
    ¬ (magnitudeKey o.candidate.delta < magnitudeKey c.delta ∨
      (magnitudeKey o.candidate.delta = magnitudeKey c.delta ∧
        o.candidate.constraint.rank < c.constraint.rank)) := by
  rw [← score_lt_iff]
  obtain ⟨ha, hd⟩ := snapResolve_snapped h
  have mem : ∀ axis, o.axis = axis → o.candidate ∈ reachableOn axis (snapOptions movingId m neighbours settings) := by
    intro axis hx
    simp only [reachableOn, List.mem_map, List.mem_filter, Bool.and_eq_true, decide_eq_true_eq]
    exact ⟨o, ⟨ho, hx, hr⟩, rfl⟩
  rcases hc with ⟨hx, hc⟩ | ⟨hx, hc⟩
  · subst ha
    have := (snapPick_some hc).2 _ (mem _ hx)
    omega
  · subst hd
    have := (snapPick_some hc).2 _ (mem _ hx)
    omega

/-- With nothing within reach on either axis the window does not snap; a window snaps whenever
something is within reach. -/
@[lungo_claim "lungo.law" subject snapResolve]
theorem unsnapped_iff_nothing_reachable (movingId : String) (m : SnapSeen)
    (neighbours : Array SnapNeighbour) (settings : SnapSettings)
    (hv : snapInvalid m neighbours settings = none) (hd : m.distance > 0) :
    snapResolve movingId m neighbours settings = .unsnapped ↔
      ∀ o ∈ snapOptions movingId m neighbours settings, o.reachable = false := by
  have key : ∀ axis, reachableOn axis (snapOptions movingId m neighbours settings) = [] ↔
      ∀ o ∈ snapOptions movingId m neighbours settings, o.axis = axis → o.reachable = false := by
    intro axis
    simp only [reachableOn, List.map_eq_nil_iff, List.filter_eq_nil_iff, Bool.and_eq_true,
      decide_eq_true_eq, not_and, Bool.not_eq_true]
  unfold snapResolve
  simp only [hv, hd, decide_true, Bool.not_true, Bool.false_eq_true, ite_false]
  constructor
  · intro h o ho
    split at h
    · rename_i hb
      simp only [Bool.and_eq_true, Option.isNone_iff_eq_none] at hb
      have h1 := (key .across).1 (snapPick_none.1 hb.1)
      have h2 := (key .down).1 (snapPick_none.1 hb.2)
      cases hx : o.axis
      · exact h1 o ho hx
      · exact h2 o ho hx
    · cases h
  · intro h
    have h1 := snapPick_none.2 ((key .across).2 fun o ho _ => h o ho)
    have h2 := snapPick_none.2 ((key .down).2 fun o ho _ => h o ho)
    simp [h1, h2]

/-- A window seen from no distance does not snap. -/
@[lungo_claim "lungo.law" subject snapResolve]
theorem unseen_no_snap (movingId : String) (m : SnapSeen) (neighbours : Array SnapNeighbour)
    (settings : SnapSettings) (hv : snapInvalid m neighbours settings = none) (hd : ¬ m.distance > 0) :
    snapResolve movingId m neighbours settings = .unsnapped := by
  simp [snapResolve, hv, hd]

/-- A number that is not finite is refused, naming where it is, before anything is weighed. -/
@[lungo_claim "lungo.law" subject snapResolve]
theorem invalid_input_refused (movingId : String) (m : SnapSeen) (neighbours : Array SnapNeighbour)
    (settings : SnapSettings) (field : String) (hv : snapInvalid m neighbours settings = some field) :
    snapResolve movingId m neighbours settings = .invalid field := by
  simp [snapResolve, hv]

end Swf.AppSnap
