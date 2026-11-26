import Lungo

/-!
Named spaces: several workspaces kept in one store, one of them shown at a time, each saved under
a key of its own as it changes. This model decides what a name may be, and what switching to
another space, saving the space shown under a new name and resetting or removing a space do at
each step: a switch never leaves the space shown with changes that were neither saved nor given up
by the person, a space is opened only once, the space shown changes only when another was opened,
and nothing is done while another change of space is under way. The package does the storing, the
restoring and the asking.
-/
namespace Swf.Spaces

/-! ## Names -/

/-- A character JavaScript's `trim` removes: white space and line terminators. -/
def jsSpace (c : Char) : Bool :=
  let v := c.val
  v = 0x9 || v = 0xA || v = 0xB || v = 0xC || v = 0xD || v = 0x20 || v = 0xA0 || v = 0x1680 ||
    (0x2000 ≤ v && v ≤ 0x200A) || v = 0x2028 || v = 0x2029 || v = 0x202F || v = 0x205F ||
    v = 0x3000 || v = 0xFEFF

/-- The UTF-16 code units of characters. -/
def utf16Units (cs : List Char) : Nat := (cs.map fun c => if c.val > 0xFFFF then 2 else 1).sum

/-- A string's length as JavaScript counts it, in UTF-16 code units. -/
def utf16Length (s : String) : Nat := utf16Units s.toList

/-- The longest name a space can have, in UTF-16 code units. -/
def maxNameLength : Nat := 80

/-- Why a name cannot name a space. -/
inductive NameIssue where
  /-- There is no name: none given, or only spaces. -/
  | missing
  /-- It starts or ends with spaces. -/
  | padded
  /-- It is longer than `max` characters. -/
  | tooLong (max : Nat)

/-- Why characters cannot name a space, or none when they can. -/
def nameIssueOf (cs : List Char) : Option NameIssue :=
  if cs.all jsSpace then some .missing
  else if cs.head?.any jsSpace || cs.getLast?.any jsSpace then some .padded
  else if utf16Units cs > maxNameLength then some (.tooLong maxNameLength)
  else none

/-- Why a name cannot name a space, or none when it can; `none` stands for a name that is not a
string. -/
def spacesNameIssue (name : Option String) : Option NameIssue :=
  match name with
  | none => some .missing
  | some s => nameIssueOf s.toList

/-! ## Changing the space shown -/

/-- How the space shown is saved: as the store holds it, changed since, being saved, or not saved
by the last save, which failed. -/
inductive SaverState where
  | clean
  | dirty
  | saving
  | failed
deriving DecidableEq

/-- Where a change of space stands. -/
inductive Phase where
  /-- Nothing is under way. -/
  | idle
  /-- The space shown is being saved before `target` is opened. -/
  | saving (target : String)
  /-- The space shown could not be saved: the person is asked whether to open `target` anyway,
  giving up its unsaved changes, or to stay. -/
  | asking (target : String)
  /-- `target` is being opened in place of the space shown. -/
  | opening (target : String)
  /-- What is shown is being stored as the new space `name`. -/
  | forking (name : String)
  /-- The space shown, `name`, is being put back as it was seeded. -/
  | resetting (name : String)
deriving DecidableEq

/-- The spaces. -/
structure SpacesMachine where
  /-- The space shown: none until the first is opened. -/
  active : Option String
  phase : Phase
  /-- The spaces are disposed: nothing more is done. -/
  disposed : Bool
deriving DecidableEq

/-- What happens to the spaces. -/
inductive SpacesEvent where
  /-- The person asks to show `target`. `known`: it is one of the spaces (stored or seeded).
  `on`: saving is on. `saver`: how the space shown is saved. -/
  | request (target : String) (known : Bool) (on : Bool) (saver : SaverState)
  /-- The save of the space shown, before a switch, ended. -/
  | saved (ok : Bool)
  /-- The person answered: `discard` opens the target, giving up the unsaved changes. -/
  | answer (discard : Bool)
  /-- Opening the target ended: restored, or not (nothing changed). -/
  | opened (ok : Bool)
  /-- The person asks to keep what is shown as the space `name`, replacing a space of the person's
  of that name once stored. `issue`: the name cannot name a space. `taken`: a seeded space has the
  name, which is the host's and never saved over. `on`: saving is on. -/
  | fork (name : String) (issue : Bool) (taken : Bool) (on : Bool)
  /-- Storing the new space ended. -/
  | forked (ok : Bool)
  /-- The person asks to reset or remove `name`. `seeded`: it is one the host seeds. `stored`:
  the store holds it. `on`: saving is on. -/
  | remove (name : String) (seeded : Bool) (stored : Bool) (on : Bool)
  /-- Putting the space shown back as it was seeded ended. -/
  | reset (ok : Bool)
  /-- The person asks to delete every stored space. `on`: saving is on. -/
  | clear (on : Bool)
  /-- The spaces are disposed. -/
  | dispose

/-- Why an event is refused. -/
inductive SpacesRefusal where
  /-- The spaces are disposed. -/
  | disposed
  /-- Saving is off: the spaces cannot change. -/
  | off
  /-- No space has the name. -/
  | unknown
  /-- Another change of space is under way. -/
  | busy
  /-- The name cannot name a space. -/
  | badName
  /-- A seeded space has the name: it is never saved over. -/
  | taken
  /-- The space shown cannot be removed: only a seeded one, which is reset. -/
  | shown
  /-- The event does not belong to the change under way: the caller's mistake. -/
  | unexpected
deriving DecidableEq

/-- What the package does for an event. -/
structure SpacesStep where
  next : SpacesMachine
  /-- Save the space shown now. -/
  save : Bool
  /-- Ask the person whether to open the target, giving up the unsaved changes. -/
  ask : Bool
  /-- Open this space in place of the one shown, starting its history afresh. -/
  openTarget : Option String
  /-- Store what is shown as this new space. -/
  store : Option String
  /-- Put the space shown back as it was seeded, its stored state deleted. -/
  reseed : Bool
  /-- Delete the stored space of this name. -/
  delete : Option String
  /-- Delete every stored space; the space shown stays shown, as not saved. -/
  wipe : Bool
  /-- The space shown is now `next.active`: save under its key from now on. -/
  adopt : Bool
  /-- Why the event is refused, if it is. -/
  refusal : Option SpacesRefusal

/-- Nothing to do. -/
def SpacesStep.quiet (m : SpacesMachine) : SpacesStep :=
  { next := m, save := false, ask := false, openTarget := none, store := none, reseed := false,
    delete := none, wipe := false, adopt := false, refusal := none }

/-- The event is refused and nothing changes. -/
def SpacesStep.refuse (m : SpacesMachine) (r : SpacesRefusal) : SpacesStep :=
  { SpacesStep.quiet m with refusal := some r }

/-- Begins opening `target`. -/
def beginOpen (m : SpacesMachine) (target : String) : SpacesStep :=
  { SpacesStep.quiet { m with phase := .opening target } with openTarget := some target }

/-- What the package does for an event while the spaces are not disposed. A request, a fork and
a removal are taken only while nothing else is under way. A request for the space shown changes
nothing; for a space that is not one, it is refused; while saving is off, it is refused once a
space is shown. The first space is opened at once; another is opened at once when the space shown
is saved, and otherwise the space shown is saved first. A save that succeeded opens the target;
one that failed asks the person, whose answer opens the target or stays. Opening the target shows
it, or, when it failed, leaves the space shown as it was. A fork needs saving on, a space shown and
a valid name that is not a seeded space's; once stored, that space is shown. Removing the space shown is
refused unless it is seeded, when it is reset; removing another deletes it when stored, and does
nothing for a seeded space that was never stored. Clearing needs saving on and deletes every stored
space. -/
def liveStep (m : SpacesMachine) (e : SpacesEvent) : SpacesStep :=
  match e with
  | .request target known on saver =>
    if m.phase ≠ .idle then SpacesStep.refuse m .busy
    else if m.active = some target then SpacesStep.quiet m
    else if !known then SpacesStep.refuse m .unknown
    else match m.active with
      | none => beginOpen m target
      | some _ =>
        if !on then SpacesStep.refuse m .off
        else if saver = .clean then beginOpen m target
        else { SpacesStep.quiet { m with phase := .saving target } with save := true }
  | .saved ok =>
    match m.phase with
    | .saving target =>
      if ok then beginOpen m target
      else { SpacesStep.quiet { m with phase := .asking target } with ask := true }
    | _ => SpacesStep.refuse m .unexpected
  | .answer discard =>
    match m.phase with
    | .asking target =>
      if discard then beginOpen m target else SpacesStep.quiet { m with phase := .idle }
    | _ => SpacesStep.refuse m .unexpected
  | .opened ok =>
    match m.phase with
    | .opening target =>
      if ok then { SpacesStep.quiet { m with phase := .idle, active := some target } with adopt := true }
      else SpacesStep.quiet { m with phase := .idle }
    | _ => SpacesStep.refuse m .unexpected
  | .fork name issue taken on =>
    if m.phase ≠ .idle then SpacesStep.refuse m .busy
    else if m.active = none then SpacesStep.refuse m .unexpected
    else if !on then SpacesStep.refuse m .off
    else if issue then SpacesStep.refuse m .badName
    else if taken then SpacesStep.refuse m .taken
    else { SpacesStep.quiet { m with phase := .forking name } with store := some name }
  | .forked ok =>
    match m.phase with
    | .forking name =>
      if ok then { SpacesStep.quiet { m with phase := .idle, active := some name } with adopt := true }
      else SpacesStep.quiet { m with phase := .idle }
    | _ => SpacesStep.refuse m .unexpected
  | .remove name seeded stored on =>
    if m.phase ≠ .idle then SpacesStep.refuse m .busy
    else if !on then SpacesStep.refuse m .off
    else if !seeded && !stored then SpacesStep.refuse m .unknown
    else if m.active = some name then
      if seeded then { SpacesStep.quiet { m with phase := .resetting name } with reseed := true }
      else SpacesStep.refuse m .shown
    else if stored then { SpacesStep.quiet m with delete := some name }
    else SpacesStep.quiet m
  | .reset ok =>
    match m.phase with
    | .resetting _ =>
      if ok then { SpacesStep.quiet { m with phase := .idle } with adopt := true }
      else SpacesStep.quiet { m with phase := .idle }
    | _ => SpacesStep.refuse m .unexpected
  | .clear on =>
    if m.phase ≠ .idle then SpacesStep.refuse m .busy
    else if !on then SpacesStep.refuse m .off
    else { SpacesStep.quiet m with wipe := true }
  | .dispose => SpacesStep.quiet { m with disposed := true }

/-- What the package does for an event: as `liveStep` decides until the spaces are disposed, after
which every event but disposal is refused, and disposal again changes nothing. -/
def spacesStep (m : SpacesMachine) (e : SpacesEvent) : SpacesStep :=
  if m.disposed then
    match e with
    | .dispose => SpacesStep.quiet m
    | _ => SpacesStep.refuse m .disposed
  else liveStep m e

/-- The spaces before any is shown. -/
def spacesInitial : SpacesMachine := { active := none, phase := .idle, disposed := false }

/-! ## Invariants -/

theorem nameIssueOf_none (cs : List Char) :
    nameIssueOf cs = none ↔
      cs ≠ [] ∧ cs.head?.any jsSpace = false ∧ cs.getLast?.any jsSpace = false ∧
        utf16Units cs ≤ maxNameLength := by
  cases cs with
  | nil => simp [nameIssueOf]
  | cons c cs =>
    unfold nameIssueOf
    constructor
    · intro h
      split at h
      · cases h
      · split at h
        · cases h
        · rename_i h2
          split at h
          · cases h
          · rename_i h3
            simp only [Bool.or_eq_true, not_or, Bool.not_eq_true] at h2
            exact ⟨by simp, h2.1, h2.2, by omega⟩
    · rintro ⟨-, h1, h2, h3⟩
      have ha : (c :: cs).all jsSpace = false := by
        simp only [List.head?_cons, Option.any_some] at h1
        simp [h1]
      simp only [ha, h1, h2, Bool.or_false, Bool.false_eq_true, ite_false]
      split
      · omega
      · rfl

/-- A valid name is a string that does not start or end with a space, has something besides
spaces, and is at most `maxNameLength` UTF-16 code units long. -/
@[lungo_claim "lungo.law" subject spacesNameIssue]
theorem name_valid (name : Option String) :
    spacesNameIssue name = none ↔
      ∃ s, name = some s ∧ s.toList ≠ [] ∧ s.toList.head?.any jsSpace = false ∧
        s.toList.getLast?.any jsSpace = false ∧ utf16Length s ≤ maxNameLength := by
  cases name with
  | none => simp [spacesNameIssue]
  | some s =>
    simp only [spacesNameIssue, utf16Length, Option.some.injEq, exists_eq_left']
    exact nameIssueOf_none s.toList

/-- No unsaved change is lost without the person's word: another space is opened only as the first
space, or when the space shown is saved (it was clean, or the save before the switch succeeded),
or when the person chose to give its changes up. -/
@[lungo_claim "lungo.law" subject spacesStep]
theorem open_only_when_saved_or_given_up (m : SpacesMachine) (e : SpacesEvent) (t : String)
    (h : (spacesStep m e).openTarget = some t) :
    (∃ known on saver, e = .request t known on saver ∧ (m.active = none ∨ saver = .clean)) ∨
      (e = .saved true ∧ m.phase = .saving t) ∨ (e = .answer true ∧ m.phase = .asking t) := by
  unfold spacesStep at h
  split at h
  · split at h <;> simp [SpacesStep.quiet, SpacesStep.refuse] at h
  · cases e with
    | request target known on saver =>
      left
      simp only [liveStep] at h
      split at h
      · simp [SpacesStep.refuse, SpacesStep.quiet] at h
      · split at h
        · simp [SpacesStep.quiet] at h
        · split at h
          · simp [SpacesStep.refuse, SpacesStep.quiet] at h
          · split at h
            · rename_i ha
              simp [beginOpen, SpacesStep.quiet] at h
              exact ⟨known, on, saver, by simp [h], Or.inl ha⟩
            · split at h
              · simp [SpacesStep.refuse, SpacesStep.quiet] at h
              · split at h
                · rename_i hs
                  simp [beginOpen, SpacesStep.quiet] at h
                  exact ⟨known, on, saver, by simp [h], Or.inr hs⟩
                · simp [SpacesStep.quiet] at h
    | saved ok =>
      simp only [liveStep] at h
      split at h
      · rename_i target hp
        split at h
        · rename_i hok
          simp [beginOpen, SpacesStep.quiet] at h
          right; left; exact ⟨by simp [hok], by simp [hp, h]⟩
        · simp [SpacesStep.quiet] at h
      · simp [SpacesStep.refuse, SpacesStep.quiet] at h
    | answer discard =>
      simp only [liveStep] at h
      split at h
      · rename_i target hp
        split at h
        · rename_i hd
          simp [beginOpen, SpacesStep.quiet] at h
          right; right; exact ⟨by simp [hd], by simp [hp, h]⟩
        · simp [SpacesStep.quiet] at h
      · simp [SpacesStep.refuse, SpacesStep.quiet] at h
    | opened ok =>
      simp only [liveStep] at h
      split at h <;> (try split at h) <;> simp [SpacesStep.refuse, SpacesStep.quiet] at h
    | fork name issue taken on =>
      simp only [liveStep] at h
      repeat (first | (split at h) | simp [SpacesStep.refuse, SpacesStep.quiet] at h)
    | forked ok =>
      simp only [liveStep] at h
      split at h <;> (try split at h) <;> simp [SpacesStep.refuse, SpacesStep.quiet] at h
    | remove name seeded stored on =>
      simp only [liveStep] at h
      repeat (first | (split at h) | simp [SpacesStep.refuse, SpacesStep.quiet] at h)
    | reset ok =>
      simp only [liveStep] at h
      split at h <;> (try split at h) <;> simp [SpacesStep.refuse, SpacesStep.quiet] at h
    | clear on =>
      simp only [liveStep] at h
      repeat (first | (split at h) | simp [SpacesStep.refuse, SpacesStep.quiet] at h)
    | dispose => simp [liveStep, SpacesStep.quiet] at h

/-- The space shown changes only when another space was opened or stored, and then to it: a
switch that did not open its target, a refused event, a question and an answer to stay all leave
it as it was. -/
@[lungo_claim "lungo.law" subject spacesStep]
theorem active_changes_only_when_opened (m : SpacesMachine) (e : SpacesEvent)
    (h : (spacesStep m e).next.active ≠ m.active) :
    (∃ t, e = .opened true ∧ m.phase = .opening t ∧ (spacesStep m e).next.active = some t) ∨
      (∃ n, e = .forked true ∧ m.phase = .forking n ∧ (spacesStep m e).next.active = some n) := by
  unfold spacesStep at h ⊢
  split at h
  · split at h <;> simp [SpacesStep.quiet, SpacesStep.refuse] at h
  · rename_i hd
    simp only [hd, Bool.false_eq_true, ite_false]
    cases e with
    | opened ok =>
      simp only [liveStep] at h ⊢
      split at h
      · rename_i t hp
        split at h
        · rename_i hok
          left; exact ⟨t, by simp [hok], hp, by simp [hok, SpacesStep.quiet]⟩
        · simp [SpacesStep.quiet] at h
      · simp [SpacesStep.refuse, SpacesStep.quiet] at h
    | forked ok =>
      simp only [liveStep] at h ⊢
      split at h
      · rename_i n hp
        split at h
        · rename_i hok
          right; exact ⟨n, by simp [hok], hp, by simp [hok, SpacesStep.quiet]⟩
        · simp [SpacesStep.quiet] at h
      · simp [SpacesStep.refuse, SpacesStep.quiet] at h
    | _ =>
      simp only [liveStep] at h
      repeat (first | (split at h) | simp [SpacesStep.refuse, SpacesStep.quiet, beginOpen] at h)

/-- A request for the space shown changes nothing; any request while another change of space is
under way is refused as busy and changes nothing. -/
@[lungo_claim "lungo.law" subject spacesStep]
theorem request_shown_or_busy (m : SpacesMachine) (t : String) (known on : Bool) (saver : SaverState)
    (hd : m.disposed = false) :
    (m.phase = .idle → m.active = some t →
      spacesStep m (.request t known on saver) = SpacesStep.quiet m) ∧
      (m.phase ≠ .idle → spacesStep m (.request t known on saver) = SpacesStep.refuse m .busy) := by
  constructor
  · intro hp ha
    simp [spacesStep, liveStep, hd, hp, ha]
  · intro hp
    simp [spacesStep, liveStep, hd, hp]

/-- While saving is off, the space shown never changes by a request: only the first space is
opened then. -/
@[lungo_claim "lungo.law" subject spacesStep]
theorem off_keeps_space (m : SpacesMachine) (t s : String) (known : Bool) (saver : SaverState)
    (hd : m.disposed = false) (ha : m.active = some s) (hne : s ≠ t) (hp : m.phase = .idle)
    (hk : known = true) :
    spacesStep m (.request t known false saver) = SpacesStep.refuse m .off := by
  simp [spacesStep, liveStep, hd, hp, hk, ha, hne]

/-- A refused event changes nothing and does nothing. -/
@[lungo_claim "lungo.law" subject spacesStep]
theorem refused_changes_nothing (m : SpacesMachine) (e : SpacesEvent) (r : SpacesRefusal)
    (h : (spacesStep m e).refusal = some r) :
    spacesStep m e = SpacesStep.refuse m r := by
  unfold spacesStep at h ⊢
  split at h
  · split at h <;> simp_all [SpacesStep.quiet, SpacesStep.refuse]
  · rename_i hd
    simp only [hd, Bool.false_eq_true, ite_false] at ⊢
    cases e <;> simp only [liveStep] at h ⊢ <;>
      repeat (first | (split at h) | (split) | simp_all [SpacesStep.refuse, SpacesStep.quiet, beginOpen])

/-- Disposed spaces refuse every event but disposal, which is done already: nothing is done. -/
@[lungo_claim "lungo.law" subject spacesStep]
theorem disposed_refuses (m : SpacesMachine) (e : SpacesEvent) (hd : m.disposed = true) :
    spacesStep m e =
      match e with
      | .dispose => SpacesStep.quiet m
      | _ => SpacesStep.refuse m .disposed := by
  cases e <;> simp [spacesStep, hd]

/-- The spaces start with none shown and nothing under way. -/
@[lungo_claim "lungo.law" subject spacesInitial]
theorem initial_idle :
    spacesInitial.active = none ∧ spacesInitial.phase = .idle ∧ spacesInitial.disposed = false := by
  simp [spacesInitial]

end Swf.Spaces
