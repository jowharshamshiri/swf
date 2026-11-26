import Lungo

/-!
The reference application's guided scenarios. A scenario is a short sequence of steps, each a
thing the operator does (select a window, move it behind the camera, open the map); the
application says the step now due and ticks it off once the operator has done it, by any route.
One scenario runs at a time. This model decides how a scenario advances: it starts at its first
step, a step is done only once the application observes its condition holding while it is the step
due, steps are done in order and never undone, and a finished scenario stays finished until another
starts or it is stopped. The conditions themselves are geometry and scene state, read by the
application.
-/
namespace Swf.AppScenarios

/-- A scenario under way. -/
structure Guide where
  /-- Which scenario, by its ID. -/
  scenario : String
  /-- How many steps it has. -/
  steps : Nat
  /-- How many of them are done, in order: the step due is the one at this place. -/
  done : Nat
deriving DecidableEq

/-- What happens to the scenarios. -/
inductive GuideEvent where
  /-- A scenario is started, in place of any under way. -/
  | start (scenario : String) (steps : Nat)
  /-- The application looked at the scene: whether the condition of the step due holds now. -/
  | observe (holds : Bool)
  /-- The scenario under way is stopped. -/
  | stop

/-- The scenario under way after an event, or why the event cannot be taken. -/
inductive GuideAnswer where
  /-- The scenario under way now: none once it is stopped. -/
  | next (guide : Option Guide)
  /-- A scenario of no steps cannot be started: there would be nothing to guide. -/
  | noSteps
  /-- There is no scenario under way to observe or stop. -/
  | notRunning
deriving DecidableEq

/-- Whether every step of a scenario is done. -/
def Guide.finished (g : Guide) : Bool := g.steps ≤ g.done

/-- The scenario under way after an event. -/
def guideStep (current : Option Guide) : GuideEvent → GuideAnswer
  | .start scenario steps =>
    if steps = 0 then .noSteps else .next (some { scenario, steps, done := 0 })
  | .observe holds =>
    match current with
    | none => .notRunning
    | some g => if holds && g.done < g.steps then .next (some { g with done := g.done + 1 }) else .next (some g)
  | .stop =>
    match current with
    | none => .notRunning
    | some _ => .next none

/-! ## Invariants -/

/-- A scenario starts at its first step, and only one with steps starts. -/
@[lungo_claim "lungo.law" subject guideStep]
theorem starts_at_first_step (current : Option Guide) (scenario : String) (steps : Nat) (g : Guide)
    (h : guideStep current (.start scenario steps) = .next (some g)) :
    g.scenario = scenario ∧ g.steps = steps ∧ g.done = 0 ∧ 0 < g.steps := by
  simp only [guideStep] at h
  split at h
  · cases h
  · rename_i hs
    simp only [GuideAnswer.next.injEq, Option.some.injEq] at h
    subst h
    exact ⟨rfl, rfl, rfl, Nat.pos_of_ne_zero hs⟩

/-- Observing never undoes a step, never changes which scenario is under way, and does at most one
step at a time. -/
@[lungo_claim "lungo.law" subject guideStep]
theorem observe_advances_by_at_most_one (g g' : Guide) (holds : Bool)
    (h : guideStep (some g) (.observe holds) = .next (some g')) :
    g'.scenario = g.scenario ∧ g'.steps = g.steps ∧ g.done ≤ g'.done ∧ g'.done ≤ g.done + 1 := by
  simp only [guideStep] at h
  split at h <;> simp only [GuideAnswer.next.injEq, Option.some.injEq] at h <;> subst h <;> simp

/-- A step is done only when its condition holds while it is the step due. -/
@[lungo_claim "lungo.law" subject guideStep]
theorem step_done_only_when_it_holds (g g' : Guide) (holds : Bool)
    (h : guideStep (some g) (.observe holds) = .next (some g')) (hd : g.done < g'.done) :
    holds = true ∧ g.done < g.steps := by
  simp only [guideStep] at h
  split at h
  · rename_i hc
    simp only [Bool.and_eq_true, decide_eq_true_eq] at hc
    exact hc
  · simp only [GuideAnswer.next.injEq, Option.some.injEq] at h
    subst h
    exact absurd hd (Nat.lt_irrefl _)

/-- A condition that holds does the step due, while one is due. -/
@[lungo_claim "lungo.law" subject guideStep]
theorem holding_does_the_step (g : Guide) (hd : g.done < g.steps) :
    guideStep (some g) (.observe true) = .next (some { g with done := g.done + 1 }) := by
  simp [guideStep, hd]

/-- No more steps are done than a scenario has: a scenario that starts within its steps stays
within them. -/
@[lungo_claim "lungo.law" subject guideStep]
theorem done_within_steps (g g' : Guide) (holds : Bool) (hw : g.done ≤ g.steps)
    (h : guideStep (some g) (.observe holds) = .next (some g')) : g'.done ≤ g'.steps := by
  simp only [guideStep] at h
  split at h
  · rename_i hc
    simp only [GuideAnswer.next.injEq, Option.some.injEq] at h
    subst h
    simp only [Bool.and_eq_true, decide_eq_true_eq] at hc
    exact hc.2
  · simp only [GuideAnswer.next.injEq, Option.some.injEq] at h
    subst h
    exact hw

/-- A finished scenario stays finished, as it is, whatever is observed. -/
@[lungo_claim "lungo.law" subject guideStep]
theorem finished_stays (g : Guide) (holds : Bool) (hf : g.finished = true) :
    guideStep (some g) (.observe holds) = .next (some g) := by
  simp only [Guide.finished, decide_eq_true_eq] at hf
  simp [guideStep, Nat.not_lt.mpr hf]

/-- Stopping ends the scenario under way; with none under way, observing or stopping is refused. -/
@[lungo_claim "lungo.law" subject guideStep]
theorem stop_ends_and_idle_refuses (g : Guide) (holds : Bool) :
    guideStep (some g) .stop = .next none ∧ guideStep none .stop = .notRunning ∧
      guideStep none (.observe holds) = .notRunning := by
  simp [guideStep]

end Swf.AppScenarios
