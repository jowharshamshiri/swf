import Lungo
import Swf.Order
import Swf.AppFeatures

/-!
The reference application's semantic depth: each window is represented by how far it is from the
camera, in bands. Nearer than the full band it shows its content; within the compact band, a
compact preview stands for it; beyond, its label alone. The window focus presents is shown in full
whatever its distance. A frame asks once for every window of the scene: the distances in, the
representations out. The distances themselves are geometry, measured by the application.
-/
namespace Swf.AppDepth

open Swf.Order (floatKey)
open Swf.AppFeatures (DepthBands)

/-- How a window is represented. -/
inductive DepthBand where
  /-- Its content, in full. -/
  | full
  /-- A compact preview standing for it. -/
  | compact
  /-- Its label alone. -/
  | label
deriving DecidableEq

/-- The windows of one frame. -/
structure DepthQuery where
  /-- Where the bands end. -/
  bands : DepthBands
  /-- Each window's distance from the camera, in world units. -/
  distances : Array Float
  /-- The window presented in full whatever its distance, by its place in `distances`: the
  focused one, while the focus mode shows it. -/
  focused : Option Nat

/-- The answer for the windows of one frame: their representations, or why none can be given. -/
inductive DepthAnswer where
  /-- Each window's representation, in the order of the distances. -/
  | bands (representations : Array DepthBand)
  /-- A band's end is not a number. -/
  | invalidBands
  /-- The distance at this place is not finite and zero or more. -/
  | invalidDistance (index : Nat)

/-- A distance a window can be at: finite, and not negative. -/
def distanceOk (d : Float) : Bool := d.isFinite && !(d < 0)

/-- The band a distance falls in: a band's end belongs to the next band. -/
def bandAt (b : DepthBands) (d : Float) : DepthBand :=
  if floatKey d < floatKey b.full then .full
  else if floatKey d < floatKey b.compact then .compact
  else .label

/-- The representation of every window of a frame. -/
def depthBands (q : DepthQuery) : DepthAnswer :=
  if q.bands.full.isNaN || q.bands.compact.isNaN then .invalidBands
  else
    match (List.range q.distances.size).find? (fun i => !distanceOk q.distances[i]!) with
    | some i => .invalidDistance i
    | none =>
      .bands (q.distances.mapIdx fun i d => if q.focused = some i then .full else bandAt q.bands d)

/-! ## Invariants -/

/-- How much of a window a band shows, least first. -/
def DepthBand.shown : DepthBand → Nat
  | .label => 0
  | .compact => 1
  | .full => 2

theorem depthBands_bands {q : DepthQuery} {out : Array DepthBand} (h : depthBands q = .bands out) :
    out = q.distances.mapIdx fun i d => if q.focused = some i then .full else bandAt q.bands d := by
  unfold depthBands at h
  split at h
  · cases h
  · split at h
    · cases h
    · cases h; rfl

/-- Every window gets the band its distance falls in, unless it is the one focus presents: full
nearer than the full band's end, a compact preview nearer than the compact band's end, its label
alone beyond. -/
@[lungo_claim "lungo.law" subject depthBands]
theorem band_by_thresholds (q : DepthQuery) (out : Array DepthBand) (h : depthBands q = .bands out)
    (i : Nat) (hi : i < q.distances.size) (hf : q.focused ≠ some i) :
    ∃ hi' : i < out.size,
      (out[i] = .full ↔ floatKey q.distances[i] < floatKey q.bands.full) ∧
      (out[i] = .label ↔
        floatKey q.bands.full ≤ floatKey q.distances[i] ∧
          floatKey q.bands.compact ≤ floatKey q.distances[i]) := by
  have ho := depthBands_bands h
  subst ho
  refine ⟨by simpa using hi, ?_⟩
  simp only [Array.getElem_mapIdx, hf, ite_false, bandAt]
  constructor
  · split <;> simp_all
    split <;> simp_all
  · split
    · simp_all; omega
    · split <;> simp_all <;> omega

/-- The window focus presents is shown in full, whatever its distance. -/
@[lungo_claim "lungo.law" subject depthBands]
theorem focused_full (q : DepthQuery) (out : Array DepthBand) (h : depthBands q = .bands out)
    (i : Nat) (hi : i < q.distances.size) (hf : q.focused = some i) :
    ∃ hi' : i < out.size, out[i] = .full := by
  have ho := depthBands_bands h
  subst ho
  exact ⟨by simpa using hi, by simp [hf]⟩

/-- A frame answers for every window it asks about, in their order. -/
@[lungo_claim "lungo.law" subject depthBands]
theorem one_band_per_window (q : DepthQuery) (out : Array DepthBand) (h : depthBands q = .bands out) :
    out.size = q.distances.size := by
  have ho := depthBands_bands h
  subst ho
  simp

/-- A band never shows more of a farther window. -/
theorem bandAt_monotone (b : DepthBands) (d₁ d₂ : Float) (h : floatKey d₁ ≤ floatKey d₂) :
    (bandAt b d₂).shown ≤ (bandAt b d₁).shown := by
  unfold bandAt
  by_cases h1 : floatKey d₁ < floatKey b.full <;> by_cases h2 : floatKey d₂ < floatKey b.full <;>
    by_cases h3 : floatKey d₁ < floatKey b.compact <;> by_cases h4 : floatKey d₂ < floatKey b.compact <;>
    simp [h1, h2, h3, h4, DepthBand.shown] <;> omega

/-- Farther never shows more: of two windows of a frame (neither the one focus presents), the
farther one shows no more than the nearer one. -/
@[lungo_claim "lungo.law" subject depthBands]
theorem monotone (q : DepthQuery) (out : Array DepthBand) (h : depthBands q = .bands out)
    (i j : Nat) (hi : i < q.distances.size) (hj : j < q.distances.size)
    (hfi : q.focused ≠ some i) (hfj : q.focused ≠ some j)
    (hd : floatKey q.distances[i] ≤ floatKey q.distances[j]) :
    ∃ (hi' : i < out.size) (hj' : j < out.size), out[j].shown ≤ out[i].shown := by
  have ho := depthBands_bands h
  subst ho
  refine ⟨by simpa using hi, by simpa using hj, ?_⟩
  simp only [Array.getElem_mapIdx, hfi, hfj, ite_false]
  exact bandAt_monotone q.bands _ _ hd

/-- A distance that is not finite and zero or more is refused, by its place. -/
@[lungo_claim "lungo.law" subject depthBands]
theorem invalid_distance_refused (q : DepthQuery) (i : Nat)
    (h : depthBands q = .invalidDistance i) : i < q.distances.size ∧ distanceOk q.distances[i]! = false := by
  unfold depthBands at h
  split at h
  · cases h
  · split at h
    · rename_i j hj
      cases h
      have := List.find?_some hj
      have hm := List.mem_of_find?_eq_some hj
      simp_all
    · cases h

/-- Bands whose ends are not numbers are refused. -/
@[lungo_claim "lungo.law" subject depthBands]
theorem invalid_bands_refused (q : DepthQuery) (h : q.bands.full.isNaN || q.bands.compact.isNaN) :
    depthBands q = .invalidBands := by
  simp [depthBands, h]

end Swf.AppDepth
