import Lungo

/-!
The snapshot save machine (spec §13.4): `clean → dirty → saving → clean` on an acknowledgement of
the revision saved, `saving → dirty` when the workspace changed meanwhile, `saving → failed` on a
storage error, which keeps what the store held before and leaves the workspace unsaved. The saver
captures and stores; this model decides each state, what a save expects the store to hold, and
which acknowledgements count.
-/
namespace Swf.Save

inductive SaveState where
  | clean
  | dirty
  | saving
  | failed
deriving DecidableEq

/-- Where saving is, what the store holds of this workspace (the revision it acknowledged and the
change count that snapshot reflects), and the workspace's change count now. -/
structure SaveMachine where
  state : SaveState
  savedRevision : Option Nat
  savedChanges : Option Int
  changes : Int

/-- A saver opened on a store that holds `savedRevision`/`savedChanges` (or nothing) of a workspace
at change count `changes`: clean exactly when the store holds what the workspace shows. -/
def saveOpen (savedRevision : Option Nat) (savedChanges : Option Int) (changes : Int) : SaveMachine :=
  { state := if savedChanges = some changes then .clean else .dirty, savedRevision, savedChanges,
    changes }

/-- The workspace changed; its change count is now `changes`. -/
def saveChanged (m : SaveMachine) (changes : Int) : SaveMachine :=
  { m with state := if m.state = .clean then .dirty else m.state, changes }

/-- A save asked for at change count `changes`: none when the store already holds what the workspace
shows (nothing to do), else the machine saving, which expects the store to hold `savedRevision`. -/
def saveBegin (m : SaveMachine) (changes : Int) : Option SaveMachine :=
  if m.savedChanges = some changes then none else some { m with state := .saving, changes }

/-- What the store answered a save of the snapshot at `revision`, captured at change count
`captured`, now that the workspace is at change count `changes`. -/
inductive SaveAnswer where
  /-- It acknowledged; `confirmed` says whether for exactly the key and revision saved. -/
  | acknowledged (confirmed : Bool) (revision : Nat)
  /-- It failed. -/
  | failed

/-- Why an acknowledgement does not count. -/
inductive AckRefusal where
  /-- Not of the key and revision saved. -/
  | mismatch
  /-- Of a revision older than the one the store already acknowledged. -/
  | older

structure SaveEnd where
  next : SaveMachine
  refused : Option AckRefusal

def saveEnd (m : SaveMachine) (captured changes : Int) (a : SaveAnswer) : SaveEnd :=
  let failed := fun r => ⟨{ m with state := .failed, changes }, r⟩
  match a with
  | .failed => failed none
  | .acknowledged false _ => failed (some .mismatch)
  | .acknowledged true revision =>
    if m.savedRevision.any (revision < ·) then failed (some .older)
    else
      ⟨{ state := if changes = captured then .clean else .dirty, savedRevision := some revision,
          savedChanges := some captured, changes }, none⟩

/-! ## Invariants -/

/-- Clean means the store holds exactly what the workspace shows. -/
def Consistent (m : SaveMachine) : Prop := m.state = .clean → m.savedChanges = some m.changes

/-- A saver opens consistent, clean exactly when the store holds what the workspace shows. -/
@[lungo_claim "lungo.law" subject saveOpen]
theorem open_clean_iff_saved (r : Option Nat) (s : Option Int) (c : Int) :
    Consistent (saveOpen r s c) ∧ ((saveOpen r s c).state = .clean ↔ s = some c) := by
  constructor
  · intro h; simp only [saveOpen] at *; split at h <;> simp_all
  · simp only [saveOpen]; split <;> simp_all

/-- A change makes a clean workspace dirty, leaves every other state as it was, and keeps the
machine consistent. -/
@[lungo_claim "lungo.law" subject saveChanged]
theorem change_dirties (m : SaveMachine) (c : Int) :
    Consistent (saveChanged m c) ∧ (m.state = .clean → (saveChanged m c).state = .dirty) ∧
      (m.state ≠ .clean → (saveChanged m c).state = m.state) := by
  refine ⟨fun hs => ?_, fun hs => by simp [saveChanged, hs], fun hs => by simp [saveChanged, hs]⟩
  simp only [saveChanged] at hs
  split at hs <;> simp_all

/-- A save does nothing when the store holds what the workspace shows, and otherwise saves. -/
@[lungo_claim "lungo.law" subject saveBegin]
theorem save_skips_unchanged (m : SaveMachine) (c : Int) :
    (saveBegin m c = none ↔ m.savedChanges = some c) ∧
      (∀ m', saveBegin m c = some m' → m'.state = .saving ∧ m'.savedRevision = m.savedRevision) := by
  constructor
  · simp only [saveBegin]; split <;> simp_all
  · intro m' h; simp only [saveBegin] at h; split at h <;> simp_all; cases h; simp

/-- An acknowledgement of the revision saved makes the workspace clean when nothing changed
meanwhile and dirty when something did; the store then holds that revision. -/
@[lungo_claim "lungo.law" subject saveEnd]
theorem ack_cleans_or_dirties (m : SaveMachine) (captured changes : Int) (revision : Nat)
    (fresh : ∀ r, m.savedRevision = some r → r ≤ revision) :
    let e := saveEnd m captured changes (.acknowledged true revision)
    e.refused = none ∧ e.next.savedRevision = some revision ∧ e.next.savedChanges = some captured ∧
      (e.next.state = .clean ↔ changes = captured) ∧ Consistent e.next := by
  have hn : ¬ m.savedRevision.any (revision < ·) = true := by
    cases h : m.savedRevision with
    | none => simp
    | some r => have := fresh r h; simp; omega
  simp only [saveEnd, hn, Bool.false_eq_true, ite_false, Consistent]
  refine ⟨trivial, trivial, trivial, ?_, ?_⟩
  · split <;> simp_all
  · intro hs; split at hs <;> simp_all

/-- A failed save, or an acknowledgement that does not count, leaves the store's snapshot as the
saver knew it (revision and change count) and the workspace unsaved. -/
@[lungo_claim "lungo.law" subject saveEnd]
theorem failure_keeps_saved (m : SaveMachine) (captured changes : Int) (a : SaveAnswer)
    (h : (saveEnd m captured changes a).next.state ≠ .clean ∧
      (saveEnd m captured changes a).next.state ≠ .dirty) :
    (saveEnd m captured changes a).next.state = .failed ∧
      (saveEnd m captured changes a).next.savedRevision = m.savedRevision ∧
      (saveEnd m captured changes a).next.savedChanges = m.savedChanges := by
  cases a with
  | failed => simp [saveEnd]
  | acknowledged ok revision =>
    cases ok
    · simp [saveEnd]
    · simp only [saveEnd] at h ⊢
      split at h
      · simp_all
      · split at h <;> simp_all

/-- The revision the store holds never goes back: no acknowledgement of an older revision counts,
so a retry never overwrites a newer one. -/
@[lungo_claim "lungo.law" subject saveEnd]
theorem revision_never_goes_back (m : SaveMachine) (captured changes : Int) (a : SaveAnswer) (r : Nat)
    (h : m.savedRevision = some r) :
    ∃ r', (saveEnd m captured changes a).next.savedRevision = some r' ∧ r ≤ r' := by
  cases a with
  | failed => exact ⟨r, by simp [saveEnd, h], Nat.le_refl r⟩
  | acknowledged ok revision =>
    cases ok
    · exact ⟨r, by simp [saveEnd, h], Nat.le_refl r⟩
    · by_cases hr : revision < r
      · exact ⟨r, by simp [saveEnd, h, hr], Nat.le_refl r⟩
      · exact ⟨revision, by simp [saveEnd, h, hr], by omega⟩

end Swf.Save
