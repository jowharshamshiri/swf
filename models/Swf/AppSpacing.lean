import Lungo

/-!
The reference application's spacing, after a snap. A window that magnetic positioning has put on a
spoke round the camera is kept clear of the windows standing near that place on the floor: when
another window stands nearer than the spacing to it along the floor, the neighbouring spokes are
tried in turn, one to the left, one to the right, two to the left, and so on, twenty-four in all,
and the window goes to the first that is clear. Where none is clear, it keeps the place its snap
gave it. Its distance along the floor and its height are not changed: only its heading.
-/
namespace Swf.AppSpacing

/-- A point of the floor, relative to the camera: `x` to the right and `z` toward the viewer as
the room starts (straight ahead is `-z`). -/
structure FloorPoint where
  /-- To the right, in world units. -/
  x : Float
  /-- Toward the viewer, in world units. -/
  z : Float
deriving Inhabited

/-- Whether a window `floor` units out along the floor at `heading` (radians, to the right) stands
nearer than `spacing` to any of `others` on the floor. -/
def crowdedAt (spacing : Float) (others : Array FloorPoint) (floor heading : Float) : Bool :=
  others.any fun o =>
    let dx := o.x - floor * Float.sin heading
    let dz := o.z + floor * Float.cos heading
    decide (Float.sqrt (dx * dx + dz * dz) < spacing)

/-- The spokes tried after the snapped one, by how many spokes away: -1, 1, -2, 2, … -12, 12. -/
def offsets : List Int :=
  (List.range 24).map fun k => if k % 2 = 0 then -((k / 2 + 1 : Nat) : Int) else ((k / 2 + 1 : Nat) : Int)

/-- The headings tried, in order: the snapped one first, then each neighbouring spoke. -/
def candidates (spoke heading : Float) : List Float :=
  heading :: offsets.map fun k => heading + Float.ofInt k * spoke

/-- Where a window snapped to the spoke at `heading`, `floor` units out, goes to stand clear of
`others`: the first of `candidates` nearer than `spacing` to none of them, or `heading`
itself when none is. -/
def spacedHeading (spacing spoke : Float) (others : Array FloorPoint) (floor heading : Float) :
    Float :=
  ((candidates spoke heading).find? fun h => !crowdedAt spacing others floor h).getD heading

/-! ## Claims -/

/-- A window already clear of the others stays where its snap put it. -/
@[lungo_claim "lungo.law" subject spacedHeading]
theorem clear_stays (spacing spoke floor heading : Float) (others : Array FloorPoint)
    (h : crowdedAt spacing others floor heading = false) :
    spacedHeading spacing spoke others floor heading = heading := by
  simp [spacedHeading, candidates, h]

/-- A window moved by the spacing is clear of every other window: it is moved only to a place
nearer than the spacing to none of them. -/
@[lungo_claim "lungo.law" subject spacedHeading]
theorem moved_only_clear (spacing spoke floor heading : Float) (others : Array FloorPoint) :
    spacedHeading spacing spoke others floor heading = heading ∨
      crowdedAt spacing others floor (spacedHeading spacing spoke others floor heading) = false := by
  unfold spacedHeading
  cases hf : (candidates spoke heading).find? (fun h => !crowdedAt spacing others floor h) with
  | none => exact Or.inl rfl
  | some h' =>
    right
    have := List.find?_some hf
    simpa using this

/-- A window moved by the spacing stands on one of the tried spokes: the snapped heading or a
whole number of spokes, at most twelve, either way from it. -/
@[lungo_claim "lungo.law" subject spacedHeading]
theorem on_a_tried_spoke (spacing spoke floor heading : Float) (others : Array FloorPoint) :
    spacedHeading spacing spoke others floor heading ∈ candidates spoke heading := by
  unfold spacedHeading
  cases hf : (candidates spoke heading).find? (fun h => !crowdedAt spacing others floor h) with
  | none => simp [candidates]
  | some h' => exact List.mem_of_find?_eq_some hf

end Swf.AppSpacing
