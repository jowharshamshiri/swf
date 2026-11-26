import Lungo

/-!
The reference application's timed window-finding task. The operator picks how they will navigate
and starts a run; the task names a window to find, one behind the camera whenever there is one, and
never the window already selected. The run counts the operator's presses and keys, and ends the
moment the named window is selected, by whatever route, recording which window, how it was
navigated to, how long it took and how many actions. The records are kept, in the order made, so
the ways of navigating can be compared. Times are whole milliseconds of a monotonic clock; the
application measures them and says which way the camera faces.
-/
namespace Swf.AppChallenge

/-- A window the task could name. -/
structure ChallengeCandidate where
  id : String
  /-- Whether it is behind the camera: more than a quarter turn from where the camera faces. -/
  behind : Bool

/-- The windows other than the selected one. -/
def openOf (candidates : Array ChallengeCandidate) (selected : Option String) : Array ChallengeCandidate :=
  candidates.filter (fun c => some c.id != selected)

/-- The windows other than the selected one that are behind the camera. -/
def behindOf (candidates : Array ChallengeCandidate) (selected : Option String) : Array ChallengeCandidate :=
  (openOf candidates selected).filter (·.behind)

/-- The windows a run may name: every one but the one selected, and of those only the ones behind
the camera when any are. -/
def challengePool (candidates : Array ChallengeCandidate) (selected : Option String) : Array ChallengeCandidate :=
  if (behindOf candidates selected).isEmpty then openOf candidates selected
  else behindOf candidates selected

/-- The window a run names, by a draw the application makes: the draw picks one of the pool, round
its size. None when there is no window to name. -/
def challengeTarget (candidates : Array ChallengeCandidate) (selected : Option String) (draw : Nat) :
    Option String :=
  let pool := challengePool candidates selected
  if h : 0 < pool.size then some (pool[draw % pool.size]'(Nat.mod_lt _ h)).id else none

/-- A run under way. -/
structure ChallengeRun where
  target : String
  /-- How the operator navigates in it, by the method's ID. -/
  method : String
  startedAt : Nat
  actions : Nat
deriving DecidableEq

/-- A finished run. -/
structure ChallengeRecord where
  target : String
  method : String
  /-- How long it took, in milliseconds. -/
  ms : Nat
  actions : Nat
deriving DecidableEq

/-- The task: the run under way, if any, and every run finished. -/
structure ChallengeTask where
  run : Option ChallengeRun
  records : Array ChallengeRecord
deriving DecidableEq

/-- What happens to the task. -/
inductive ChallengeEvent where
  /-- A run starts, naming a window, in place of any under way. -/
  | start (target method : String) (time : Nat)
  /-- The operator pressed or keyed something. -/
  | act
  /-- A window was selected. -/
  | selected (id : String) (time : Nat)
  /-- The run under way is given up. -/
  | cancel
  /-- The records are forgotten. -/
  | clear

/-- The task after an event, or why the event cannot be taken. -/
inductive ChallengeAnswer where
  /-- The task now, and the record a run just finished with, if one did. -/
  | next (task : ChallengeTask) (found : Option ChallengeRecord)
  /-- There is no run to give up. -/
  | notRunning
  /-- The named window was selected before the run started, by the clock given: a clock that runs
  backwards. -/
  | timeBackwards
deriving DecidableEq

/-- The task after an event. Presses and selections while no run is under way change nothing: the
operator uses the application between runs. -/
def challengeStep (task : ChallengeTask) : ChallengeEvent → ChallengeAnswer
  | .start target method time =>
    .next { task with run := some { target, method, startedAt := time, actions := 0 } } none
  | .act =>
    match task.run with
    | none => .next task none
    | some r => .next { task with run := some { r with actions := r.actions + 1 } } none
  | .selected id time =>
    match task.run with
    | none => .next task none
    | some r =>
      if id != r.target then .next task none
      else if time < r.startedAt then .timeBackwards
      else
        let record : ChallengeRecord :=
          { target := r.target, method := r.method, ms := time - r.startedAt, actions := r.actions }
        .next { run := none, records := task.records.push record } (some record)
  | .cancel =>
    match task.run with
    | none => .notRunning
    | some _ => .next { task with run := none } none
  | .clear => .next { task with records := #[] } none

/-! ## Invariants -/

theorem mem_openOf (candidates : Array ChallengeCandidate) (selected : Option String) (c : ChallengeCandidate) :
    c ∈ openOf candidates selected ↔ c ∈ candidates ∧ some c.id ≠ selected := by
  simp [openOf, Array.mem_filter]

theorem mem_behindOf (candidates : Array ChallengeCandidate) (selected : Option String) (c : ChallengeCandidate) :
    c ∈ behindOf candidates selected ↔ (c ∈ candidates ∧ some c.id ≠ selected) ∧ c.behind = true := by
  simp only [behindOf, Array.mem_filter, mem_openOf]

theorem nonempty_of_mem {xs : Array ChallengeCandidate} {c : ChallengeCandidate} (h : c ∈ xs) : xs.isEmpty = false := by
  cases he : xs.isEmpty
  · rfl
  · rw [Array.isEmpty_iff] at he
    subst he
    simp at h

theorem mem_pool (candidates : Array ChallengeCandidate) (selected : Option String) (c : ChallengeCandidate)
    (h : c ∈ challengePool candidates selected) : c ∈ candidates ∧ some c.id ≠ selected := by
  unfold challengePool at h
  split at h
  · exact (mem_openOf candidates selected c).mp h
  · exact ((mem_behindOf candidates selected c).mp h).1

/-- A run names one of the windows, never the one already selected. -/
@[lungo_claim "lungo.law" subject challengeTarget]
theorem target_is_an_unselected_candidate (candidates : Array ChallengeCandidate) (selected : Option String)
    (draw : Nat) (id : String) (h : challengeTarget candidates selected draw = some id) :
    ∃ c ∈ candidates, c.id = id ∧ some id ≠ selected := by
  unfold challengeTarget at h
  simp only at h
  split at h
  · rename_i hp
    simp only [Option.some.injEq] at h
    have hm := mem_pool candidates selected _ (Array.getElem_mem (Nat.mod_lt draw hp))
    exact ⟨_, hm.1, h, h ▸ hm.2⟩
  · cases h

/-- A run names a window behind the camera whenever one other than the selected window is. -/
@[lungo_claim "lungo.law" subject challengeTarget]
theorem prefers_behind (candidates : Array ChallengeCandidate) (selected : Option String) (draw : Nat)
    (b : ChallengeCandidate) (hb : b ∈ candidates) (hbb : b.behind = true) (hbs : some b.id ≠ selected) :
    ∃ c ∈ candidates, challengeTarget candidates selected draw = some c.id ∧ c.behind = true := by
  have hb' : b ∈ behindOf candidates selected :=
    (mem_behindOf candidates selected b).mpr ⟨⟨hb, hbs⟩, hbb⟩
  have hpool : challengePool candidates selected = behindOf candidates selected := by
    unfold challengePool
    rw [nonempty_of_mem hb']
    rfl
  have hsize : 0 < (challengePool candidates selected).size := by
    rw [hpool]
    exact Array.size_pos_of_mem hb'
  have hall : ∀ c ∈ challengePool candidates selected, c.behind = true := by
    rw [hpool]
    intro c hc
    exact ((mem_behindOf candidates selected c).mp hc).2
  refine ⟨(challengePool candidates selected)[draw % (challengePool candidates selected).size]'
    (Nat.mod_lt _ hsize), ?_, ?_, ?_⟩
  · exact (mem_pool candidates selected _ (Array.getElem_mem _)).1
  · simp [challengeTarget, hsize]
  · exact hall _ (Array.getElem_mem _)

/-- There is no window to name only when every window is the selected one. -/
@[lungo_claim "lungo.law" subject challengeTarget]
theorem names_one_when_any (candidates : Array ChallengeCandidate) (selected : Option String) (draw : Nat)
    (c : ChallengeCandidate) (hc : c ∈ candidates) (hcs : some c.id ≠ selected) :
    (challengeTarget candidates selected draw).isSome = true := by
  have hopen : c ∈ openOf candidates selected := (mem_openOf candidates selected c).mpr ⟨hc, hcs⟩
  have hsize : 0 < (challengePool candidates selected).size := by
    unfold challengePool
    split
    · exact Array.size_pos_of_mem hopen
    · rename_i hne
      rw [Array.isEmpty_iff] at hne
      cases hz : (behindOf candidates selected).size
      · exact absurd (Array.eq_empty_of_size_eq_zero hz) hne
      · exact Nat.succ_pos _
  simp [challengeTarget, hsize]

/-- A run ends only when the window it names is selected, and its record says how long it took
from the start and how many actions it counted. -/
@[lungo_claim "lungo.law" subject challengeStep]
theorem found_only_on_target (task task' : ChallengeTask) (id : String) (time : Nat) (r : ChallengeRecord)
    (h : challengeStep task (.selected id time) = .next task' (some r)) :
    ∃ run, task.run = some run ∧ id = run.target ∧ run.startedAt ≤ time ∧
      r = { target := run.target, method := run.method, ms := time - run.startedAt,
            actions := run.actions } ∧
      task' = { run := none, records := task.records.push r } := by
  simp only [challengeStep] at h
  split at h
  · cases h
  · rename_i run hrun
    split at h
    · cases h
    · rename_i hid
      split at h
      · cases h
      · rename_i ht
        simp only [ChallengeAnswer.next.injEq, Option.some.injEq] at h
        obtain ⟨h1, h2⟩ := h
        simp only [bne_iff_ne, ne_eq, Decidable.not_not] at hid
        exact ⟨run, hrun, hid, Nat.le_of_not_lt ht, h2.symm, by rw [← h1, h2]⟩

/-- Every event but `clear` keeps the records made, and only a finished run adds one: the records
are never rewritten. -/
@[lungo_claim "lungo.law" subject challengeStep]
theorem records_only_grow (task task' : ChallengeTask) (e : ChallengeEvent) (found : Option ChallengeRecord)
    (he : e ≠ .clear) (h : challengeStep task e = .next task' found) :
    task'.records = match found with
      | none => task.records
      | some r => task.records.push r := by
  cases e with
  | start => simp only [challengeStep, ChallengeAnswer.next.injEq] at h; obtain ⟨rfl, rfl⟩ := h; rfl
  | act =>
    simp only [challengeStep] at h
    split at h <;> simp only [ChallengeAnswer.next.injEq] at h <;> obtain ⟨rfl, rfl⟩ := h <;> rfl
  | selected id time =>
    simp only [challengeStep] at h
    split at h
    · simp only [ChallengeAnswer.next.injEq] at h; obtain ⟨rfl, rfl⟩ := h; rfl
    · split at h
      · simp only [ChallengeAnswer.next.injEq] at h; obtain ⟨rfl, rfl⟩ := h; rfl
      · split at h
        · cases h
        · simp only [ChallengeAnswer.next.injEq] at h; obtain ⟨rfl, rfl⟩ := h; rfl
  | cancel =>
    simp only [challengeStep] at h
    split at h
    · cases h
    · simp only [ChallengeAnswer.next.injEq] at h; obtain ⟨rfl, rfl⟩ := h; rfl
  | clear => exact absurd rfl he

/-- Selecting another window, or anything while no run is under way, changes nothing. -/
@[lungo_claim "lungo.law" subject challengeStep]
theorem other_selection_changes_nothing (task : ChallengeTask) (id : String) (time : Nat)
    (h : ∀ r, task.run = some r → id ≠ r.target) :
    challengeStep task (.selected id time) = .next task none := by
  simp only [challengeStep]
  split
  · rfl
  · rename_i r hr
    have := h r hr
    simp [this]

end Swf.AppChallenge
