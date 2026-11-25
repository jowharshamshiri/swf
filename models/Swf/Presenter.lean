import Lungo

/-!
The presenter's viewports, by ID: a viewport is opening while it starts on its first backend, open
once it started, and gone again when it is disposed, whether it started or not. A viewport whose
start failed is disposed, so its ID is free and can be opened again; only an open viewport is
listed. The presenter starts, presents and disposes; this model decides which IDs it admits and
lists.
-/
namespace Swf.Presenter

/-- Where a viewport ID is in the presenter. -/
inductive Slot where
  /-- No viewport with this ID is open or opening: it can be opened. -/
  | absent
  /-- A viewport with this ID is starting on its first backend. -/
  | opening
  /-- A viewport with this ID started and is presented. -/
  | open
deriving DecidableEq

/-- What happens to a viewport ID in the presenter. -/
inductive SlotEvent where
  /-- A viewport is opened with this ID. -/
  | open
  /-- Its viewport started: on a backend that works, or degraded. -/
  | started
  /-- Its viewport is disposed: once open, or because its start failed. -/
  | closed

/-- The slot after an event, or none when the event does not follow: an ID is opened only while
nothing holds it, a viewport starts only while opening, and closing frees the ID whether the
viewport started or not. -/
def slotStep (s : Slot) (e : SlotEvent) : Option Slot :=
  match s, e with
  | .absent, .open => some .opening
  | .opening, .started => some .open
  | .opening, .closed => some .absent
  | .open, .closed => some .absent
  | _, _ => none

/-- Whether the presenter lists a viewport in this slot: only once it started. -/
def slotListed (s : Slot) : Bool := s = .open

/-! ## Invariants -/

/-- One viewport per ID: an ID is opened exactly when nothing holds it, and a viewport starts only
while it is opening. -/
@[lungo_claim "lungo.law" subject slotStep]
theorem open_once (s : Slot) :
    ((slotStep s .open).isSome ↔ s = .absent) ∧ ((slotStep s .started).isSome ↔ s = .opening) := by
  cases s <;> simp [slotStep]

/-- A failed open leaves nothing behind: a viewport disposed while it is still opening frees its
ID, which can then be opened again; so does disposing an open viewport. -/
@[lungo_claim "lungo.law" subject slotStep]
theorem failed_open_frees_id :
    slotStep .opening .closed = some .absent ∧ slotStep .open .closed = some .absent ∧
      slotStep .absent .open = some .opening := by
  simp [slotStep]

/-- Only a viewport that started is listed: one still opening, or gone, is not. -/
@[lungo_claim "lungo.decides" subject slotListed]
theorem listed_iff_open (s : Slot) : slotListed s = true ↔ s = .open := by
  simp [slotListed]

end Swf.Presenter
