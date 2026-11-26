import Lungo

/-!
The reference application's spaces in local storage, around the framework's named spaces
(`Swf.Spaces`): the space shown saved as it changes, import from a file, and the spaces made of
what the application stored before it kept spaces. This model decides when a save is scheduled,
started or refused, which files an import reads, and which stored entries of the earlier kind
become which spaces. The application does the storing, the restoring and the timing.
-/
namespace Swf.AppWorkspaces

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
  /-- Every saved layout was deleted: the workspace on screen counts as unsaved. -/
  | cleared
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
  /-- Tell the listeners how saving stands. -/
  announce : Bool
  /-- Why the event is refused, if it is. -/
  refusal : Option String

/-- Nothing to do. -/
def WorkspacesStep.quiet (m : WorkspacesMachine) : WorkspacesStep :=
  { next := m, cancelTimer := false, startTimer := false, save := false, announce := false,
    refusal := none }

/-- A save scheduled afresh, while saving is on. -/
def schedule (m : WorkspacesMachine) : WorkspacesStep :=
  if m.autosave then
    { next := { m with pending := true }, cancelTimer := m.pending, startTimer := true, save := false,
      announce := false, refusal := none }
  else WorkspacesStep.quiet m

/-- Why disposed workspaces refuse an event. -/
def disposedRefusal : String := "the workspaces are disposed"

/-- What the application does for an event while the workspaces are not disposed. Turning saving
on announces it and schedules a save when the saver is not clean; turning it off announces it and
stops a scheduled save. A change schedules a save afresh, restarting the timer. The scheduled time
saves once. Saving now is refused while saving is off (`saving is off`), and otherwise saves at
once, stopping a scheduled save. Clearing every saved layout announces it and schedules a save.
Disposal stops a scheduled save. -/
def liveStep (m : WorkspacesMachine) (e : WorkspacesEvent) : WorkspacesStep :=
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
  | .dispose =>
    { (WorkspacesStep.quiet { m with pending := false, disposed := true }) with cancelTimer := m.pending }

/-- What the application does for an event: as `liveStep` decides until the workspaces are
disposed. Disposed workspaces refuse every event (`the workspaces are disposed`) and do nothing for
it: nothing is scheduled, saved or announced. Disposing them again is done already, and
changes nothing. -/
def workspacesStep (m : WorkspacesMachine) (e : WorkspacesEvent) : WorkspacesStep :=
  if m.disposed then
    match e with
    | .dispose => WorkspacesStep.quiet m
    | _ => { (WorkspacesStep.quiet m) with refusal := some disposedRefusal }
  else liveStep m e

/-! ## The entries stored before spaces -/

/-- The visit to take among the stored ones (key and start time): the one started last, the first
listed of those started at the same time. -/
def workspacesNewest (visits : Array (String × Int)) : Option String :=
  (visits.toList.foldl (fun best v =>
    match best with
    | none => some v
    | some b => if v.2 > b.2 then some v else some b) none).map (·.1)

/-- Keeps an entry (key, name, time) for its name: in place of the one kept for the name when it
is newer, after the others when none is kept for the name yet. -/
def keepNewest (acc : List (String × String × Int)) (e : String × String × Int) :
    List (String × String × Int) :=
  if acc.any (·.2.1 == e.2.1) then
    acc.map (fun a => if a.2.1 == e.2.1 && e.2.2 > a.2.2 then e else a)
  else acc ++ [e]

/-- The newest named save (key, name, time) of each name, in the order the names first appear. -/
def newestByName (named : List (String × String × Int)) : List (String × String × Int) :=
  named.foldl keepNewest []

/-- Which entries stored before spaces become which spaces, as (key, space): the newest visit
(key, start time) becomes `visitSpace`, the space shown by default, and the newest named save
(key, name, time) of each name the space of that name, unless the visit took the name. A space
already stored (`stored`) is never written over. Every entry of the earlier kind is deleted once
these spaces are stored. -/
def workspacesMigration (visits : Array (String × Int)) (named : Array (String × String × Int))
    (visitSpace : String) (stored : Array String) : Array (String × String) :=
  let visit : List (String × String) :=
    match workspacesNewest visits with
    | some k => if stored.toList.contains visitSpace then [] else [(k, visitSpace)]
    | none => []
  let taken := stored.toList ++ visit.map (·.2)
  let kept := (newestByName named.toList).filter (fun e => !taken.contains e.2.1)
  (visit ++ kept.map (fun e => (e.1, e.2.1))).toArray

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
      cases saver <;> simp_all [workspacesStep, liveStep, schedule, WorkspacesStep.quiet]
  | changed =>
    cases ha : m.autosave <;> cases hd : m.disposed <;> cases hp : m.pending <;>
      simp_all [workspacesStep, liveStep, schedule, WorkspacesStep.quiet]
  | fired =>
    cases ha : m.autosave <;> cases hd : m.disposed <;> cases hp : m.pending <;>
      simp_all [workspacesStep, liveStep, WorkspacesStep.quiet]
  | saveNow =>
    cases ha : m.autosave <;> cases hd : m.disposed <;> cases hp : m.pending <;>
      simp_all [workspacesStep, liveStep, WorkspacesStep.quiet]
  | cleared =>
    cases ha : m.autosave <;> cases hd : m.disposed <;> cases hp : m.pending <;>
      simp_all [workspacesStep, liveStep, schedule, WorkspacesStep.quiet]
  | dispose =>
    cases hd : m.disposed <;> cases hp : m.pending <;>
      simp_all [workspacesStep, liveStep, WorkspacesStep.quiet]

/-- Turning saving on schedules a save only when there is something unsaved; turned on with the
workspace saved, nothing is saved until it changes. -/
@[lungo_claim "lungo.law" subject workspacesStep]
theorem autosave_only_when_dirty (m : WorkspacesMachine) (saver : SaverState)
    (ho : m.autosave = false) (hd : m.disposed = false) :
    (workspacesStep m (.setAutosave true saver)).startTimer = true ↔ saver ≠ .clean := by
  by_cases hs : saver = .clean <;> simp [workspacesStep, liveStep, schedule, WorkspacesStep.quiet, ho, hd, hs]

/-- Turning saving off stops a scheduled save. -/
@[lungo_claim "lungo.law" subject workspacesStep]
theorem off_cancels_scheduled_save (m : WorkspacesMachine) (saver : SaverState)
    (ho : m.autosave = true) (hd : m.disposed = false) :
    (workspacesStep m (.setAutosave false saver)).next.pending = false ∧
      (workspacesStep m (.setAutosave false saver)).cancelTimer = m.pending := by
  simp [workspacesStep, liveStep, WorkspacesStep.quiet, ho, hd]

/-- Saving on request is refused while saving is off, and saves nothing. -/
@[lungo_claim "lungo.law" subject workspacesStep]
theorem save_now_needs_autosave (m : WorkspacesMachine) (ho : m.autosave = false)
    (hd : m.disposed = false) :
    (workspacesStep m .saveNow).refusal = some "saving is off" ∧
      (workspacesStep m .saveNow).save = false := by
  simp [workspacesStep, liveStep, WorkspacesStep.quiet, ho, hd]

/-- Disposed workspaces refuse every event but disposal, which is done already: each leaves the
machine as it is, and nothing is scheduled, stopped, saved or announced. So a disposed machine
never saves on request. -/
@[lungo_claim "lungo.law" subject workspacesStep]
theorem disposed_refuses_events (m : WorkspacesMachine) (e : WorkspacesEvent)
    (hd : m.disposed = true) :
    workspacesStep m e =
      match e with
      | .dispose => WorkspacesStep.quiet m
      | _ => { (WorkspacesStep.quiet m) with refusal := some disposedRefusal } := by
  cases e <;> simp [workspacesStep, hd]

/-- Disposed workspaces schedule nothing and save nothing, in the background or on request. -/
@[lungo_claim "lungo.law" subject workspacesStep]
theorem disposed_schedules_nothing (m : WorkspacesMachine) (e : WorkspacesEvent)
    (hd : m.disposed = true) :
    (workspacesStep m e).startTimer = false ∧ (workspacesStep m e).save = false := by
  rw [disposed_refuses_events m e hd]
  cases e <;> simp [WorkspacesStep.quiet]

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

/-- The visit taken is a stored one started no earlier than any other; with no visit stored, none
is taken. -/
@[lungo_claim "lungo.law" subject workspacesNewest]
theorem newest_is_latest (visits : Array (String × Int)) (key : String)
    (h : workspacesNewest visits = some key) :
    ∃ v ∈ visits.toList, v.1 = key ∧ ∀ w ∈ visits.toList, w.2 ≤ v.2 := by
  unfold workspacesNewest at h
  rw [Option.map_eq_some_iff] at h
  obtain ⟨r, hr, rfl⟩ := h
  obtain ⟨hm, -, hx⟩ := foldl_newest _ none r hr
  exact ⟨r, by simpa using hm, rfl, hx⟩

/-- A visit is taken whenever one is stored, and none when none is. -/
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

theorem keepNewest_mem (acc : List (String × String × Int)) (e x : String × String × Int)
    (h : x ∈ keepNewest acc e) : x ∈ acc ∨ x = e := by
  unfold keepNewest at h
  split at h
  · simp only [List.mem_map] at h
    obtain ⟨a, ha, hx⟩ := h
    split at hx
    · exact .inr hx.symm
    · exact .inl (hx ▸ ha)
  · simp at h
    exact h

theorem keepNewest_names (acc : List (String × String × Int)) (e : String × String × Int)
    (h : (acc.map (·.2.1)).Nodup) : ((keepNewest acc e).map (·.2.1)).Nodup := by
  unfold keepNewest
  split
  · rename_i hany
    have : (acc.map (fun a => if a.2.1 == e.2.1 && e.2.2 > a.2.2 then e else a)).map (·.2.1) =
        acc.map (·.2.1) := by
      rw [List.map_map]
      apply List.map_congr_left
      intro a _
      simp only [Function.comp_apply]
      split
      · rename_i hc
        simp only [Bool.and_eq_true, beq_iff_eq, decide_eq_true_eq] at hc
        exact hc.1.symm
      · rfl
    rw [this]; exact h
  · rename_i hany
    simp only [List.any_eq_true, beq_iff_eq, not_exists, not_and] at hany
    rw [List.map_append, List.nodup_append]
    refine ⟨h, by simp, ?_⟩
    intro a ha b hb
    simp only [List.mem_map] at ha
    simp only [List.map_cons, List.map_nil, List.mem_singleton] at hb
    obtain ⟨x, hx, rfl⟩ := ha
    subst hb
    exact hany x hx

theorem newestByName_props (l acc : List (String × String × Int)) (S : List (String × String × Int))
    (hacc : ∀ x ∈ acc, x ∈ S) (hl : ∀ x ∈ l, x ∈ S) (hn : (acc.map (·.2.1)).Nodup) :
    (∀ x ∈ l.foldl keepNewest acc, x ∈ S) ∧ ((l.foldl keepNewest acc).map (·.2.1)).Nodup := by
  induction l generalizing acc with
  | nil => exact ⟨hacc, hn⟩
  | cons y ys ih =>
    simp only [List.foldl_cons]
    apply ih
    · intro x hx
      rcases keepNewest_mem acc y x hx with h | h
      · exact hacc x h
      · exact h ▸ hl y (by simp)
    · intro x hx; exact hl x (by simp [hx])
    · exact keepNewest_names acc y hn

/-- Every space made comes from an entry stored before spaces: the newest visit, as `visitSpace`,
or a named save, as the space of its name. -/
@[lungo_claim "lungo.law" subject workspacesMigration]
theorem migration_from_entries (visits : Array (String × Int))
    (named : Array (String × String × Int)) (visitSpace : String) (stored : Array String)
    (p : String × String) (h : p ∈ workspacesMigration visits named visitSpace stored) :
    (p.2 = visitSpace ∧ workspacesNewest visits = some p.1) ∨ ∃ t, (p.1, p.2, t) ∈ named := by
  unfold workspacesMigration at h
  simp only [List.mem_toArray, List.mem_append, List.mem_map, List.mem_filter] at h
  rcases h with h | ⟨e, ⟨he, -⟩, rfl⟩
  · left
    split at h
    · rename_i k hk
      split at h
      · simp at h
      · simp at h; subst h; exact ⟨rfl, hk⟩
    · simp at h
  · right
    have := (newestByName_props named.toList [] named.toList (by simp) (fun _ h => h) (by simp)).1
      e he
    exact ⟨e.2.2, by simpa using this⟩

/-- No space already stored is written over. -/
@[lungo_claim "lungo.law" subject workspacesMigration]
theorem migration_keeps_stored (visits : Array (String × Int))
    (named : Array (String × String × Int)) (visitSpace : String) (stored : Array String)
    (p : String × String) (h : p ∈ workspacesMigration visits named visitSpace stored) :
    p.2 ∉ stored.toList := by
  unfold workspacesMigration at h
  simp only [List.mem_toArray, List.mem_append, List.mem_map, List.mem_filter] at h
  rcases h with h | ⟨e, ⟨-, hf⟩, rfl⟩
  · split at h
    · split at h
      · simp at h
      · rename_i hs
        simp at h; subst h; simpa using hs
    · simp at h
  · simp only [List.contains_append, Bool.not_eq_true',
      Bool.or_eq_false_iff] at hf
    simpa using hf.1

/-- Each space is made at most once. -/
@[lungo_claim "lungo.law" subject workspacesMigration]
theorem migration_one_per_space (visits : Array (String × Int))
    (named : Array (String × String × Int)) (visitSpace : String) (stored : Array String) :
    ((workspacesMigration visits named visitSpace stored).toList.map (·.2)).Nodup := by
  unfold workspacesMigration
  have hn := (newestByName_props named.toList [] named.toList (by simp) (fun _ h => h)
    (by simp)).2
  simp only [List.map_append, List.map_map]
  generalize hv : (match workspacesNewest visits with
    | some k => if stored.toList.contains visitSpace then [] else [(k, visitSpace)]
    | none => ([] : List (String × String))) = visit
  have hvlen : visit = [] ∨ ∃ k, visit = [(k, visitSpace)] := by
    subst hv; split
    · split
      · exact .inl rfl
      · exact .inr ⟨_, rfl⟩
    · exact .inl rfl
  rw [List.nodup_append]
  refine ⟨?_, ?_, ?_⟩
  · rcases hvlen with rfl | ⟨k, rfl⟩ <;> simp
  · simp only [Function.comp_def]
    exact List.Nodup.sublist (List.filter_sublist.map _) hn
  · intro a ha b hb hab
    simp only [List.mem_map, List.mem_filter, Function.comp_apply] at ha hb
    obtain ⟨x, hx, rfl⟩ := ha
    obtain ⟨e, ⟨-, hf⟩, rfl⟩ := hb
    simp only [List.contains_append, Bool.not_eq_true',
      Bool.or_eq_false_iff] at hf
    have : (visit.map (·.2)).contains e.2.1 = true := by
      simp only [List.elem_eq_mem, decide_eq_true_eq]
      exact List.mem_map.mpr ⟨x, hx, hab⟩
    rw [this] at hf; simp at hf

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
