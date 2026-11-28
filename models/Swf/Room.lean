import Lungo
import Swf.Order

/-!
The room every window stands in. The camera is at the room's centre, on its floor's level: a
window's place is its heading round the centre (radians, increasing to the right, 0 straight
ahead of the room), its distance from the centre along the floor, and its height above the
camera's level, both in world units. Every window shares the one floor, the one height scale and
the one horizon; how high a window looks (its elevation) is only derived, from its height and its
distance along the floor.

A window stays inside the room: no nearer the centre than its nearest floor distance, no farther
than its farthest, and between its lowest and highest heights. Moving a window by a pointer turns
its heading by the pointer's motion across the view, as the view maps headings to pixels, and
raises or lowers it by a fixed height for each pixel up or down, whatever its distance, so one
pixel is the same height near and far. Held with Shift, the motion up or down moves it along the
floor instead, nearer or farther; the wheel does too, by a factor per notch. A window dropped on the
floor plan stands where it was dropped, kept inside the room.

Numbers are compared by their order keys (`Swf.Order.floatKey`), which order finite doubles as
the numbers do.
-/
namespace Swf.Room

open Swf.Order (floatKey)

/-- A window's place in the room. -/
structure RoomPlace where
  /-- Its heading round the room's centre, in radians, increasing to the right. -/
  heading : Float
  /-- Its distance from the centre along the floor, in world units. -/
  floor : Float
  /-- Its height above the camera's level, in world units. -/
  height : Float
deriving Inhabited

/-- How far a window may stand from the centre and how high: inside these, in world units. -/
structure RoomLimits where
  /-- The nearest distance along the floor. -/
  nearest : Float
  /-- The farthest distance along the floor. -/
  farthest : Float
  /-- The lowest height. -/
  lowest : Float
  /-- The highest height. -/
  highest : Float
deriving Inhabited

/-- How a pointer's motion moves a window: per pixel, and per wheel notch. -/
structure RoomPace where
  /-- World units of height for each pixel up or down. -/
  heightPerPixel : Float
  /-- World units along the floor for each pixel up or down, Shift held. -/
  floorPerPixel : Float
  /-- The wheel's factor on the floor distance for each pixel it scrolls, as an exponent. -/
  floorPerWheel : Float
deriving Inhabited

/-- A value kept within `[lo, hi]`, by order keys; `lo` itself for anything below it, `hi` for
anything above, the value otherwise. -/
def keepWithin (v lo hi : Float) : Float :=
  if floatKey v < floatKey lo then lo else if floatKey hi < floatKey v then hi else v

/-- A heading turned into `(-π, π]`. -/
def wrapHeading (a : Float) : Float := Float.atan2 (Float.sin a) (Float.cos a)

/-- A place kept inside the room: its floor distance and height within the limits, its heading
wrapped. -/
def keepInRoom (l : RoomLimits) (p : RoomPlace) : RoomPlace :=
  { heading := wrapHeading p.heading,
    floor := keepWithin p.floor l.nearest l.farthest,
    height := keepWithin p.height l.lowest l.highest }

/-- How finely the room reads a distance or a height back from a point: a trillionth of a world
unit, finer than any place a window is put at or any motion moves it by, and hundreds of times
coarser than the rounding a point's coordinates carry once a place has been turned into them
(a few units in the last place of a double near the room's 13.5, through a heading's sine and
cosine and the windows' groups). -/
def readSteps : Float := 1e12

/-- A distance or height read to the room's precision: the nearest trillionth of a unit. A value
already on that grid reads as itself (the integer and the power of ten are exact, so the quotient
is the double nearest the value). -/
def readToPrecision (v : Float) : Float := Float.round (v * readSteps) / readSteps

/-- The place of a point of the room, `x` to the right, `y` up and `z` toward the viewer as the
room starts (straight ahead is `-z`), its distance along the floor and its height read to the
room's precision, kept inside the room: a window put at a place, a wall included, reads back at
that place, not at the rounding its coordinates carry. -/
def placeOf (l : RoomLimits) (x y z : Float) : RoomPlace :=
  keepInRoom l
    { heading := Float.atan2 x (-z),
      floor := readToPrecision (Float.sqrt (x * x + z * z)),
      height := readToPrecision y }

/-- A point of the room relative to its centre, in world units: `x` to the right, `y` up, `z`
toward the viewer as the room starts (straight ahead is `-z`). -/
structure RoomPoint where
  /-- To the right. -/
  x : Float
  /-- Up. -/
  y : Float
  /-- Toward the viewer. -/
  z : Float
deriving Inhabited

/-- Where a place stands in the room. -/
def pointOf (p : RoomPlace) : RoomPoint :=
  { x := p.floor * Float.sin p.heading, y := p.height, z := -(p.floor * Float.cos p.heading) }

/-- How high a place looks from the camera: its elevation above the horizon, in radians, from its
height and its distance along the floor (a place at the centre looks level with the camera's
up, never through it). -/
def elevationOf (p : RoomPlace) : Float :=
  Float.atan2 p.height (if floatKey p.floor < floatKey 0.01 then 0.01 else p.floor)

/-- A pointer's motion over the view since a window was taken: across and down in pixels, the
view's width in pixels and its horizontal field of view in radians, and whether Shift moves it
along the floor. -/
structure RoomDrag where
  /-- Where the window stood when it was taken. -/
  start : RoomPlace
  /-- Pixels to the right since it was taken. -/
  dx : Float
  /-- Pixels down since it was taken. -/
  dy : Float
  /-- The view's width, in pixels. -/
  width : Float
  /-- The view's horizontal field of view, in radians. -/
  fieldOfView : Float
  /-- Shift is held: up and down move it along the floor. -/
  alongFloor : Bool
deriving Inhabited

/-- The heading a drag turns a window to: by the motion across, at the view's angle per pixel. -/
def dragHeading (d : RoomDrag) : Float :=
  d.start.heading + d.dx / d.width * d.fieldOfView

/-- Where a drag puts a window: turned by the motion across; raised or lowered by the motion down
(a fixed height a pixel), or, Shift held, moved along the floor by it; kept inside the room. -/
def dragStep (l : RoomLimits) (pace : RoomPace) (d : RoomDrag) : RoomPlace :=
  if d.alongFloor then
    keepInRoom l { heading := dragHeading d, floor := d.start.floor + d.dy * pace.floorPerPixel,
                   height := d.start.height }
  else
    keepInRoom l { heading := dragHeading d, floor := d.start.floor,
                   height := d.start.height - d.dy * pace.heightPerPixel }

/-- Where the wheel puts a window: nearer or farther along the floor by a factor for the pixels it
scrolls (down is farther), its heading and height kept, inside the room. -/
def wheelOnFloor (l : RoomLimits) (pace : RoomPace) (p : RoomPlace) (deltaY : Float) : RoomPlace :=
  keepInRoom l { p with floor := p.floor * Float.exp (deltaY * pace.floorPerWheel) }

/-- Where a window dropped on the floor plan stands: at the point of the floor it was dropped on
(`x` to the right, `z` toward the viewer), at its own height, inside the room. -/
def floorDrop (l : RoomLimits) (p : RoomPlace) (x z : Float) : RoomPlace :=
  placeOf l x p.height z

/-! ## Invariants -/

/-- The limits are in order: the nearest no farther than the farthest, the lowest no higher than
the highest. -/
def RoomLimits.ordered (l : RoomLimits) : Prop :=
  floatKey l.nearest ≤ floatKey l.farthest ∧ floatKey l.lowest ≤ floatKey l.highest

/-- A place inside the room: its floor distance and height within the limits. -/
def RoomLimits.holds (l : RoomLimits) (p : RoomPlace) : Prop :=
  floatKey l.nearest ≤ floatKey p.floor ∧ floatKey p.floor ≤ floatKey l.farthest ∧
    floatKey l.lowest ≤ floatKey p.height ∧ floatKey p.height ≤ floatKey l.highest

theorem keepWithin_within (v lo hi : Float) (h : floatKey lo ≤ floatKey hi) :
    floatKey lo ≤ floatKey (keepWithin v lo hi) ∧ floatKey (keepWithin v lo hi) ≤ floatKey hi := by
  unfold keepWithin
  split
  · exact ⟨Int.le_refl _, h⟩
  · rename_i h1
    split
    · exact ⟨h, Int.le_refl _⟩
    · rename_i h2
      exact ⟨Int.not_lt.mp h1, Int.not_lt.mp h2⟩

/-- A place kept inside the room is inside it. -/
@[lungo_claim "lungo.law" subject keepInRoom]
theorem keepInRoom_holds (l : RoomLimits) (p : RoomPlace) (h : l.ordered) :
    l.holds (keepInRoom l p) := by
  have f := keepWithin_within p.floor l.nearest l.farthest h.1
  have g := keepWithin_within p.height l.lowest l.highest h.2
  exact ⟨f.1, f.2, g.1, g.2⟩

/-- A window a drag moves stays inside the room. -/
@[lungo_claim "lungo.law" subject dragStep]
theorem drag_stays_in_room (l : RoomLimits) (pace : RoomPace) (d : RoomDrag) (h : l.ordered) :
    l.holds (dragStep l pace d) := by
  unfold dragStep
  split <;> exact keepInRoom_holds l _ h

/-- A window the wheel moves stays inside the room. -/
@[lungo_claim "lungo.law" subject wheelOnFloor]
theorem wheel_stays_in_room (l : RoomLimits) (pace : RoomPace) (p : RoomPlace) (deltaY : Float)
    (h : l.ordered) : l.holds (wheelOnFloor l pace p deltaY) :=
  keepInRoom_holds l _ h

/-- A window dropped on the floor plan stands inside the room. -/
@[lungo_claim "lungo.law" subject floorDrop]
theorem drop_stays_in_room (l : RoomLimits) (p : RoomPlace) (x z : Float) (h : l.ordered) :
    l.holds (floorDrop l p x z) :=
  keepInRoom_holds l _ h

/-- A point's place is read to the room's precision before it is kept inside the room: its
distance along the floor and its height are the room's readings, not the coordinates' rounding. -/
@[lungo_claim "lungo.law" subject placeOf]
theorem place_read_to_precision (l : RoomLimits) (x y z : Float) :
    placeOf l x y z = keepInRoom l
      { heading := Float.atan2 x (-z),
        floor := readToPrecision (Float.sqrt (x * x + z * z)),
        height := readToPrecision y } := rfl

/-- Every point of the room has its place inside it. -/
@[lungo_claim "lungo.law" subject placeOf]
theorem place_in_room (l : RoomLimits) (x y z : Float) (h : l.ordered) :
    l.holds (placeOf l x y z) :=
  keepInRoom_holds l _ h

/-- A pixel up or down is the same height whatever the window's distance: two windows at the same
height and heading, at any floor distances, are raised or lowered alike by the same motion. -/
@[lungo_claim "lungo.law" subject dragStep]
theorem height_per_pixel_whatever_the_distance (l : RoomLimits) (pace : RoomPace) (d : RoomDrag)
    (r : Float) :
    (dragStep l pace { d with start := { d.start with floor := r } }).height =
      (dragStep l pace d).height := by
  unfold dragStep
  split <;> rfl

/-- A drag turns a window by the motion across alone, at the view's angle per pixel, whatever its
distance and height. -/
@[lungo_claim "lungo.law" subject dragStep]
theorem heading_by_motion_across (l : RoomLimits) (pace : RoomPace) (d : RoomDrag) :
    (dragStep l pace d).heading = wrapHeading (d.start.heading + d.dx / d.width * d.fieldOfView) := by
  unfold dragStep
  split <;> rfl

/-- Held with Shift, a drag moves a window along the floor and keeps its height (inside the
room). -/
@[lungo_claim "lungo.law" subject dragStep]
theorem along_the_floor_keeps_the_height (l : RoomLimits) (pace : RoomPace) (d : RoomDrag)
    (h : d.alongFloor = true) :
    (dragStep l pace d).height = keepWithin d.start.height l.lowest l.highest := by
  simp [dragStep, h, keepInRoom]

/-- Without Shift, a drag keeps a window's floor distance (inside the room). -/
@[lungo_claim "lungo.law" subject dragStep]
theorem across_and_up_keeps_the_floor (l : RoomLimits) (pace : RoomPace) (d : RoomDrag)
    (h : d.alongFloor = false) :
    (dragStep l pace d).floor = keepWithin d.start.floor l.nearest l.farthest := by
  simp [dragStep, h, keepInRoom]

/-- The wheel keeps a window's heading and height. -/
@[lungo_claim "lungo.law" subject wheelOnFloor]
theorem wheel_keeps_heading_and_height (l : RoomLimits) (pace : RoomPace) (p : RoomPlace)
    (deltaY : Float) :
    (wheelOnFloor l pace p deltaY).heading = wrapHeading p.heading ∧
      (wheelOnFloor l pace p deltaY).height = keepWithin p.height l.lowest l.highest := by
  simp [wheelOnFloor, keepInRoom]

/-- How high a place looks depends on its height and its distance along the floor alone, never on
its heading: every window shares the one horizon. -/
@[lungo_claim "lungo.law" subject elevationOf]
theorem elevation_whatever_the_heading (p : RoomPlace) (a : Float) :
    elevationOf { p with heading := a } = elevationOf p := rfl

/-- A place stands at its own height, whatever its heading and floor distance: the room has one
height scale. -/
@[lungo_claim "lungo.law" subject pointOf]
theorem point_at_its_height (p : RoomPlace) : (pointOf p).y = p.height := rfl

end Swf.Room
