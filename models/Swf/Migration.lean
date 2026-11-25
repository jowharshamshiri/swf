import Lungo

/-!
Snapshot migration planning: which steps of the snapshot format bring a document of one format to
the current one. Each step reads one format and writes another; the first step (in the order
given: a host's own before the built-in ones) that reads a format is the one taken. The plan ends at
the current format, or at the format no step leads on from, or that the plan reached before (a
cycle). The persistence layer runs the planned steps on copies, checks that each wrote the format it
declares, and fails at the step where the plan ends short.
-/
namespace Swf.Migration

/-- The first step (by position) reading format `v`. -/
def stepFrom (steps : Array (String × String)) (v : String) : Option Nat :=
  (List.range steps.size).find? fun i => (steps[i]!).1 == v

def planFrom (steps : Array (String × String)) (current : String) :
    Nat → String → List String → List Nat × Option String
  | 0, v, _ => ([], some v)
  | fuel + 1, v, seen =>
    if v = current then ([], none)
    else if v ∈ seen then ([], some v)
    else match stepFrom steps v with
      | none => ([], some v)
      | some i =>
        let rest := planFrom steps current fuel (steps[i]!).2 (v :: seen)
        (i :: rest.1, rest.2)

/-- The steps to take, in order, and where the plan ends short: none when it reaches the current
format, else the format no step leads on from (or that it reached twice). -/
structure MigrationPlan where
  /-- The positions of the steps to take, in the order to take them: each reads the format the
  one before wrote. -/
  steps : List Nat
  /-- `none` when the plan reaches the current format; else the format where it ends short. -/
  blocked : Option String

/-- Plans the migration of a snapshot in format `source` to format `current`, given the steps as
(format read, format written) pairs in the order they are tried. Each step taken is the first that
reads the format reached. The plan ends at the current format (`blocked` is `none`), or at a format
no step reads or one it reached before (`blocked` names it). A snapshot already in the current
format takes no step; a format no step reads is blocked at once; no format is migrated from twice. -/
def migrationPlan (steps : Array (String × String)) (source current : String) : MigrationPlan :=
  let r := planFrom steps current (steps.size + 1) source []
  { steps := r.1, blocked := r.2 }

/-! ## Invariants -/

/-- `is` leads from format `v` to format `w`: each step reads the format the one before wrote. -/
inductive Chains (steps : Array (String × String)) : String → List Nat → String → Prop where
  | done (v : String) : Chains steps v [] v
  | step (v w : String) (i : Nat) (is : List Nat) :
      i < steps.size → (steps[i]!).1 = v → Chains steps (steps[i]!).2 is w → Chains steps v (i :: is) w

theorem stepFrom_some {steps : Array (String × String)} {v : String} {i : Nat}
    (h : stepFrom steps v = some i) : i < steps.size ∧ (steps[i]!).1 = v := by
  simp only [stepFrom, List.find?_eq_some_iff_append] at h
  obtain ⟨hp, as, bs, heq, _⟩ := h
  have hm : i ∈ List.range steps.size := by rw [heq]; simp
  exact ⟨List.mem_range.mp hm, by simpa using hp⟩

theorem planFrom_chains (steps : Array (String × String)) (current : String) :
    ∀ fuel v seen, ∃ w, Chains steps v (planFrom steps current fuel v seen).1 w ∧
      ((planFrom steps current fuel v seen).2 = none → w = current) ∧
      (∀ b, (planFrom steps current fuel v seen).2 = some b → b = w) ∧
      (∀ i ∈ (planFrom steps current fuel v seen).1, (steps[i]!).1 ∉ seen) ∧
      ((planFrom steps current fuel v seen).1.map (fun i => (steps[i]!).1)).Nodup := by
  intro fuel
  induction fuel with
  | zero => intro v seen; exact ⟨v, .done v, by simp [planFrom], by simp [planFrom], by simp [planFrom],
      by simp [planFrom]⟩
  | succ fuel ih =>
    intro v seen
    by_cases hc : v = current
    · exact ⟨v, by simp [planFrom, hc]; exact .done _, by simp [planFrom, hc],
        by simp [planFrom, hc], by simp [planFrom, hc], by simp [planFrom, hc]⟩
    by_cases hs : v ∈ seen
    · exact ⟨v, by simp [planFrom, hc, hs]; exact .done _, by simp [planFrom, hc, hs],
        by simp [planFrom, hc, hs], by simp [planFrom, hc, hs], by simp [planFrom, hc, hs]⟩
    cases hf : stepFrom steps v with
    | none =>
      exact ⟨v, by simp [planFrom, hc, hs, hf]; exact .done _, by simp [planFrom, hc, hs, hf],
        by simp [planFrom, hc, hs, hf], by simp [planFrom, hc, hs, hf], by simp [planFrom, hc, hs, hf]⟩
    | some i =>
      obtain ⟨hi, hv⟩ := stepFrom_some hf
      obtain ⟨w, hw, hn, hb, hseen, hnd⟩ := ih (steps[i]!).2 (v :: seen)
      refine ⟨w, ?_, ?_, ?_, ?_, ?_⟩
      · simp only [planFrom, hc, hs, hf, ite_false]; exact .step v w i _ hi hv hw
      · simp only [planFrom, hc, hs, hf, ite_false]; exact hn
      · simp only [planFrom, hc, hs, hf, ite_false]; exact hb
      · simp only [planFrom, hc, hs, hf, ite_false]
        intro j hj
        cases List.mem_cons.mp hj with
        | inl e => subst e; rw [hv]; exact hs
        | inr hj => exact fun hm => hseen j hj (List.mem_cons_of_mem _ hm)
      · simp only [planFrom, hc, hs, hf, ite_false, List.map_cons]
        refine List.nodup_cons.mpr ⟨?_, hnd⟩
        rw [hv]
        intro hm
        obtain ⟨j, hj, he⟩ := List.mem_map.mp hm
        exact hseen j hj (by rw [he]; exact List.mem_cons_self)

/-- The plan's steps lead from the snapshot's format, each reading what the one before wrote, to
the current format when nothing blocks it, and otherwise to the format where it is blocked. -/
@[lungo_claim "lungo.law" subject migrationPlan]
theorem plan_chains (steps : Array (String × String)) (source current : String) :
    ∃ w, Chains steps source (migrationPlan steps source current).steps w ∧
      ((migrationPlan steps source current).blocked = none → w = current) ∧
      (∀ b, (migrationPlan steps source current).blocked = some b → b = w) := by
  obtain ⟨w, h1, h2, h3, -, -⟩ := planFrom_chains steps current (steps.size + 1) source []
  exact ⟨w, h1, h2, h3⟩

/-- No format is migrated from twice: the plan never runs in a cycle. -/
@[lungo_claim "lungo.law" subject migrationPlan]
theorem plan_no_revisit (steps : Array (String × String)) (source current : String) :
    ((migrationPlan steps source current).steps.map (fun i => (steps[i]!).1)).Nodup := by
  obtain ⟨-, -, -, -, -, h⟩ := planFrom_chains steps current (steps.size + 1) source []
  exact h

/-- A snapshot already in the current format is not migrated. -/
@[lungo_claim "lungo.law" subject migrationPlan]
theorem current_untouched (steps : Array (String × String)) (current : String) :
    migrationPlan steps current current = { steps := [], blocked := none } := by
  simp [migrationPlan, planFrom]

/-- A format that is not the current one and that no step reads is refused at once. -/
@[lungo_claim "lungo.law" subject migrationPlan]
theorem unknown_refused (steps : Array (String × String)) (source current : String)
    (hc : source ≠ current) (hn : stepFrom steps source = none) :
    migrationPlan steps source current = { steps := [], blocked := some source } := by
  simp [migrationPlan, planFrom, hc, hn]

/-- Each step taken is the first, in the order given, that reads the format reached. -/
@[lungo_claim "lungo.law" subject migrationPlan]
theorem plan_first_match (steps : Array (String × String)) (source current : String) (i : Nat)
    (hc : source ≠ current) (h : stepFrom steps source = some i) :
    (migrationPlan steps source current).steps.head? = some i ∧
      ∀ j < i, (steps[j]!).1 ≠ source := by
  refine ⟨by simp [migrationPlan, planFrom, hc, h], ?_⟩
  simp only [stepFrom, List.find?_eq_some_iff_getElem] at h
  obtain ⟨_, k, hk, hki, hbefore⟩ := h
  simp only [List.getElem_range] at hki
  subst hki
  intro j hj hjs
  have := hbefore j hj
  simp_all

end Swf.Migration
