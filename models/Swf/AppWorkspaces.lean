import Lungo

/-!
The reference application's workspaces in local storage: the workspace saved as it changes, so the
next visit restores it; named workspaces saved and opened on request; and import from a file. This
model decides what a name may be, when a save is scheduled, started or refused, which stored visit
is restored and which older ones go once this visit is stored, when a named workspace is saved,
and which files an import reads. The application does the storing, the restoring and the timing.
-/
namespace Swf.AppWorkspaces

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

/-- The longest name a workspace can have, in UTF-16 code units. -/
def maxNameLength : Nat := 80

/-- Why a name cannot name a workspace. -/
inductive NameIssue where
  /-- There is no name: none given, or only spaces. -/
  | missing
  /-- It starts or ends with spaces. -/
  | padded
  /-- It is longer than `max` characters. -/
  | tooLong (max : Nat)

/-- Why characters cannot name a workspace, or none when they can. -/
def nameIssueOf (cs : List Char) : Option NameIssue :=
  if cs.all jsSpace then some .missing
  else if cs.head?.any jsSpace || cs.getLast?.any jsSpace then some .padded
  else if utf16Units cs > maxNameLength then some (.tooLong maxNameLength)
  else none

/-- Why a name cannot name a workspace, or none when it can; `none` stands for a name that is not
a string. -/
def workspacesNameIssue (name : Option String) : Option NameIssue :=
  match name with
  | none => some .missing
  | some s => nameIssueOf s.toList

/-! ## Saving as the workspace changes -/

/-- How the saver stands: saved, changed since, saving, or failed to save. -/
inductive SaverState where
  /-- The store holds what the workspace shows. -/
  | clean
  /-- The workspace changed since it was saved. -/
  | dirty
  /-- A save is in flight. -/
  | saving
  /-- The last save failed. -/
  | failed
deriving DecidableEq

/-- How saving the workspace as it changes stands. -/
structure WorkspacesMachine where
  /-- The workspace is saved as it changes. -/
  autosave : Bool
  /-- A save is scheduled: the timer is running. -/
  pending : Bool
  /-- The workspaces are disposed: nothing more is scheduled. -/
  disposed : Bool
deriving DecidableEq

/-- What happens to the workspaces' saving. -/
inductive WorkspacesEvent where
  /-- Saving as the workspace changes is turned on or off; `saver` is how the saver stands. -/
  | setAutosave (on : Bool) (saver : SaverState)
  /-- The workspace, its policies or the host's state changed. -/
  | changed
  /-- The scheduled save's time came. -/
  | fired
  /-- The operator asks to save now. -/
  | saveNow
  /-- Every saved layout was deleted: the workspace on screen counts as unsaved, a visit afresh. -/
  | cleared
  /-- A restore of the saved visit ended, restoring it or not. -/
  | restored (ok : Bool)
  /-- The workspaces are disposed: a scheduled save is stopped. -/
  | dispose

/-- What the application does for an event. -/
structure WorkspacesStep where
  /-- The machine after the event. -/
  next : WorkspacesMachine
  /-- Stop the running timer. -/
  cancelTimer : Bool
  /-- Start the timer for a save. -/
  startTimer : Bool
  /-- Save the workspace now. -/
  save : Bool
  /-- Go on saving under the restored visit's key, as saved at its revision. -/
  adopt : Bool
  /-- Tell the listeners how saving stands. -/
  announce : Bool
  /-- Why the event is refused, if it is. -/
  refusal : Option String

/-- Nothing to do. -/
def WorkspacesStep.quiet (m : WorkspacesMachine) : WorkspacesStep :=
  { next := m, cancelTimer := false, startTimer := false, save := false, adopt := false,
    announce := false, refusal := none }

/-- A save scheduled afresh, while saving is on and the workspaces are not disposed. -/
def schedule (m : WorkspacesMachine) : WorkspacesStep :=
  if m.autosave && !m.disposed then
    { next := { m with pending := true }, cancelTimer := m.pending, startTimer := true, save := false,
      adopt := false, announce := false, refusal := none }
  else WorkspacesStep.quiet m

/-- What the application does for an event. Turning saving on announces it and schedules a save
when the saver is not clean; turning it off announces it and stops a scheduled save. A change
schedules a save afresh, restarting the timer. The scheduled time saves once. Saving now is
refused while saving is off (`saving is off`), and otherwise saves at once, stopping a scheduled
save. Clearing every saved layout announces it and schedules a save. A restore that restored the
visit adopts its key and announces it; one that did not changes nothing. Disposal stops a scheduled
save. A save is scheduled, and the timer started, only while saving is on and the workspaces are
not disposed. -/
def workspacesStep (m : WorkspacesMachine) (e : WorkspacesEvent) : WorkspacesStep :=
  match e with
  | .setAutosave on saver =>
    if m.autosave = on then WorkspacesStep.quiet m
    else if on then
      let m' := { m with autosave := true }
      if saver = .clean then { (WorkspacesStep.quiet m') with announce := true }
      else { (schedule m') with announce := true }
    else
      { (WorkspacesStep.quiet { m with autosave := false, pending := false }) with
        cancelTimer := m.pending, announce := true }
  | .changed => schedule m
  | .fired =>
    if m.pending then { (WorkspacesStep.quiet { m with pending := false }) with save := true }
    else WorkspacesStep.quiet m
  | .saveNow =>
    if !m.autosave then { (WorkspacesStep.quiet m) with refusal := some "saving is off" }
    else
      { (WorkspacesStep.quiet { m with pending := false }) with cancelTimer := m.pending, save := true }
  | .cleared => { (schedule m) with announce := true }
  | .restored ok =>
    if ok then { (WorkspacesStep.quiet m) with adopt := true, announce := true }
    else WorkspacesStep.quiet m
  | .dispose =>
    { (WorkspacesStep.quiet { m with pending := false, disposed := true }) with cancelTimer := m.pending }

/-! ## Stored visits and named saves -/

/-- The visit to restore among the stored ones (key and start time): the one started last, the
first listed of those started at the same time. -/
def workspacesNewest (visits : Array (String × Int)) : Option String :=
  (visits.toList.foldl (fun best v =>
    match best with
    | none => some v
    | some b => if v.2 > b.2 then some v else some b) none).map (·.1)

/-- The visits to remove once this visit (`current`) is stored: every other one. -/
def workspacesStale (current : String) (visits : Array String) : Array String :=
  visits.filter (· != current)

/-- When a named workspace saved at `now` is saved, given when its older saves were: `now`, or
just after the latest older save, so each save of a name has a time (and a key) of its own. -/
def workspacesSavedAt (now : Int) (older : Array Int) : Int :=
  older.toList.foldl (fun t o => if o ≥ t then o + 1 else t) now

/-! ## Import -/

/-- Why a file cannot be imported. -/
inductive ImportIssue where
  /-- A workspace file is a `.json` file. -/
  | notJson
  /-- A workspace file is text. -/
  | notText

/-- The ASCII lower case of a character. -/
def asciiLower (c : Char) : Char := if 'A' ≤ c && c ≤ 'Z' then Char.ofNat (c.toNat + 32) else c

/-- Whether a file name ends in `.json`, in any case. -/
def jsonName (name : String) : Bool :=
  (name.toList.reverse.take 5).map asciiLower = ".json".toList.reverse

/-- Why a file cannot be imported, or none when it is read: its name (none when it is not a
string) must end in `.json`, and its content must be text. -/
def workspacesImportIssue (fileName : Option String) (isText : Bool) : Option ImportIssue :=
  match fileName with
  | some name => if !jsonName name then some .notJson else if !isText then some .notText else none
  | none => some .notJson

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
@[lungo_claim "lungo.law" subject workspacesNameIssue]
theorem name_valid (name : Option String) :
    workspacesNameIssue name = none ↔
      ∃ s, name = some s ∧ s.toList ≠ [] ∧ s.toList.head?.any jsSpace = false ∧
        s.toList.getLast?.any jsSpace = false ∧ utf16Length s ≤ maxNameLength := by
  cases name with
  | none => simp [workspacesNameIssue]
  | some s =>
    simp only [workspacesNameIssue, utf16Length, Option.some.injEq, exists_eq_left']
    exact nameIssueOf_none s.toList

/-- Background saves are scheduled only while saving is on and the workspaces are not disposed. -/
def WorkspacesMachine.Coherent (m : WorkspacesMachine) : Prop :=
  m.pending = true → m.autosave = true ∧ m.disposed = false

/-- Every event keeps background saves scheduled only while saving is on and the workspaces are
not disposed, and starts the timer only then. -/
@[lungo_claim "lungo.law" subject workspacesStep]
theorem timer_only_while_saving (m : WorkspacesMachine) (e : WorkspacesEvent) (hm : m.Coherent) :
    (workspacesStep m e).next.Coherent ∧
      ((workspacesStep m e).startTimer = true →
        (workspacesStep m e).next.autosave = true ∧ (workspacesStep m e).next.disposed = false) := by
  unfold WorkspacesMachine.Coherent at *
  cases e with
  | setAutosave on saver =>
    cases ha : m.autosave <;> cases on <;> cases hd : m.disposed <;> cases hp : m.pending <;>
      cases saver <;> simp_all [workspacesStep, schedule, WorkspacesStep.quiet]
  | changed =>
    cases ha : m.autosave <;> cases hd : m.disposed <;> cases hp : m.pending <;>
      simp_all [workspacesStep, schedule, WorkspacesStep.quiet]
  | fired =>
    cases ha : m.autosave <;> cases hd : m.disposed <;> cases hp : m.pending <;>
      simp_all [workspacesStep, WorkspacesStep.quiet]
  | saveNow =>
    cases ha : m.autosave <;> cases hd : m.disposed <;> cases hp : m.pending <;>
      simp_all [workspacesStep, WorkspacesStep.quiet]
  | cleared =>
    cases ha : m.autosave <;> cases hd : m.disposed <;> cases hp : m.pending <;>
      simp_all [workspacesStep, schedule, WorkspacesStep.quiet]
  | restored ok =>
    cases ok <;> simp_all [workspacesStep, WorkspacesStep.quiet]
  | dispose => simp [workspacesStep, WorkspacesStep.quiet]

/-- Turning saving on schedules a save only when there is something unsaved; turned on with the
workspace saved, nothing is saved until it changes. -/
@[lungo_claim "lungo.law" subject workspacesStep]
theorem autosave_only_when_dirty (m : WorkspacesMachine) (saver : SaverState)
    (ho : m.autosave = false) (hd : m.disposed = false) :
    (workspacesStep m (.setAutosave true saver)).startTimer = true ↔ saver ≠ .clean := by
  by_cases hs : saver = .clean <;> simp [workspacesStep, schedule, WorkspacesStep.quiet, ho, hd, hs]

/-- Turning saving off stops a scheduled save. -/
@[lungo_claim "lungo.law" subject workspacesStep]
theorem off_cancels_scheduled_save (m : WorkspacesMachine) (saver : SaverState)
    (ho : m.autosave = true) :
    (workspacesStep m (.setAutosave false saver)).next.pending = false ∧
      (workspacesStep m (.setAutosave false saver)).cancelTimer = m.pending := by
  simp [workspacesStep, WorkspacesStep.quiet, ho]

/-- Saving on request is refused while saving is off, and saves nothing. -/
@[lungo_claim "lungo.law" subject workspacesStep]
theorem save_now_needs_autosave (m : WorkspacesMachine) (ho : m.autosave = false) :
    (workspacesStep m .saveNow).refusal = some "saving is off" ∧
      (workspacesStep m .saveNow).save = false := by
  simp [workspacesStep, WorkspacesStep.quiet, ho]

/-- A restore that did not restore changes nothing of saving: the visit goes on under its own
key, as it was. Only a restored visit is saved under the restored one's key. -/
@[lungo_claim "lungo.law" subject workspacesStep]
theorem restore_atomic (m : WorkspacesMachine) :
    workspacesStep m (.restored false) = WorkspacesStep.quiet m ∧
      (workspacesStep m (.restored true)).adopt = true ∧
      (workspacesStep m (.restored true)).next = m := by
  simp [workspacesStep, WorkspacesStep.quiet]

/-- Disposed workspaces schedule nothing and save nothing in the background. -/
@[lungo_claim "lungo.law" subject workspacesStep]
theorem disposed_schedules_nothing (m : WorkspacesMachine) (e : WorkspacesEvent)
    (hd : m.disposed = true) : (workspacesStep m e).startTimer = false := by
  cases e with
  | setAutosave on saver =>
    cases ha : m.autosave <;> cases on <;> cases saver <;>
      simp_all [workspacesStep, schedule, WorkspacesStep.quiet]
  | restored ok => cases ok <;> simp_all [workspacesStep, WorkspacesStep.quiet]
  | _ =>
    cases ha : m.autosave <;> cases hp : m.pending <;>
      simp_all [workspacesStep, schedule, WorkspacesStep.quiet]

theorem foldl_newest (vs : List (String × Int)) (init : Option (String × Int)) (r : String × Int)
    (h : vs.foldl (fun best v =>
      match best with
      | none => some v
      | some b => if v.2 > b.2 then some v else some b) init = some r) :
    (init = some r ∨ r ∈ vs) ∧ (∀ b, init = some b → b.2 ≤ r.2) ∧ ∀ v ∈ vs, v.2 ≤ r.2 := by
  induction vs generalizing init with
  | nil => simp at h; subst h; simp
  | cons x xs ih =>
    simp only [List.foldl_cons] at h
    obtain ⟨hm, hi, hx⟩ := ih _ h
    cases init with
    | none =>
      simp only at hm hi
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
      simp only at hm hi
      by_cases hs : x.2 > a.2
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

/-- The visit restored is a stored one started no earlier than any other; with no visit stored,
none is restored. -/
@[lungo_claim "lungo.law" subject workspacesNewest]
theorem newest_is_latest (visits : Array (String × Int)) (key : String)
    (h : workspacesNewest visits = some key) :
    ∃ v ∈ visits.toList, v.1 = key ∧ ∀ w ∈ visits.toList, w.2 ≤ v.2 := by
  unfold workspacesNewest at h
  rw [Option.map_eq_some_iff] at h
  obtain ⟨r, hr, rfl⟩ := h
  obtain ⟨hm, -, hx⟩ := foldl_newest _ none r hr
  exact ⟨r, by simpa using hm, rfl, hx⟩

/-- A visit is restored whenever one is stored, and none when none is. -/
@[lungo_claim "lungo.law" subject workspacesNewest]
theorem restores_when_stored (visits : Array (String × Int)) :
    (workspacesNewest visits).isSome = true ↔ visits.size > 0 := by
  unfold workspacesNewest
  rcases visits with ⟨vs⟩
  cases vs with
  | nil => simp
  | cons v vs =>
    simp only [List.foldl_cons, Option.isSome_map, List.size_toArray, List.length_cons]
    have : ∀ (ws : List (String × Int)) (b : String × Int), ∃ r, ws.foldl (fun best v =>
        match best with
        | none => some v
        | some b => if v.2 > b.2 then some v else some b) (some b) = some r := by
      intro ws
      induction ws with
      | nil => exact fun b => ⟨b, rfl⟩
      | cons w ws ih =>
        intro b
        simp only [List.foldl_cons]
        split
        · exact ih w
        · exact ih b
    obtain ⟨r, hr⟩ := this vs v
    simp [hr]

/-- Once this visit is stored, every other stored visit goes, and this one stays. -/
@[lungo_claim "lungo.law" subject workspacesStale]
theorem stale_is_every_other_visit (current : String) (visits : Array String) (k : String) :
    k ∈ workspacesStale current visits ↔ k ∈ visits ∧ k ≠ current := by
  simp [workspacesStale]

theorem savedAt_fold (older : List Int) (now : Int) :
    let r := older.foldl (fun t o => if o ≥ t then o + 1 else t) now
    now ≤ r ∧ (∀ o ∈ older, o < r) ∧ (r = now ∨ ∃ o ∈ older, r = o + 1) := by
  induction older generalizing now with
  | nil => simp
  | cons x xs ih =>
    simp only [List.foldl_cons]
    by_cases hx : x ≥ now
    · simp only [hx, ite_true]
      obtain ⟨h1, h3, h2⟩ := ih (x + 1)
      refine ⟨by omega, ?_, ?_⟩
      · intro o ho
        simp at ho
        rcases ho with rfl | ho
        · omega
        · exact h3 o ho
      rcases h2 with h2 | ⟨o, ho, h2⟩
      · exact .inr ⟨x, by simp, h2⟩
      · exact .inr ⟨o, by simp [ho], h2⟩
    · simp only [hx, ite_false]
      obtain ⟨h1, h3, h2⟩ := ih now
      refine ⟨h1, ?_, ?_⟩
      · intro o ho
        simp at ho
        rcases ho with rfl | ho
        · omega
        · exact h3 o ho
      rcases h2 with h2 | ⟨o, ho, h2⟩
      · exact .inl h2
      · exact .inr ⟨o, by simp [ho], h2⟩

/-- A named save's time is after every older save of the name and not before `now`, and it is
the first such time: `now`, or just after an older save. -/
@[lungo_claim "lungo.law" subject workspacesSavedAt]
theorem saved_at_fresh (now : Int) (older : Array Int) :
    now ≤ workspacesSavedAt now older ∧ (∀ o ∈ older.toList, o < workspacesSavedAt now older) ∧
      (workspacesSavedAt now older = now ∨ ∃ o ∈ older.toList, workspacesSavedAt now older = o + 1) :=
  savedAt_fold older.toList now

/-- Only a text file whose name ends in `.json` (in any case) is read. -/
@[lungo_claim "lungo.law" subject workspacesImportIssue]
theorem import_needs_json_text (fileName : Option String) (isText : Bool) :
    workspacesImportIssue fileName isText = none ↔
      ∃ name, fileName = some name ∧ jsonName name = true ∧ isText = true := by
  cases fileName with
  | none => simp [workspacesImportIssue]
  | some name =>
    cases hj : jsonName name <;> cases isText <;> simp [workspacesImportIssue, hj]

end Swf.AppWorkspaces
