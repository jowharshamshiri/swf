import Lungo
import Swf.AppFeatures
import Swf.AppOrbit

/-!
The reference application's experiments: its eight capabilities tried one at a time, or all
together. An experiment is configuration alone: which of the feature modules are on, and how the
view is set up to show the one it isolates (the view mode, what a drag on the panorama's background
turns, whether the whole circle is in view). It never changes a window. This model decides each
experiment's switches and its setup from what the scene offers, and which experiment a combination
of switches is, if any: a combination that is no experiment's is a custom one. How turning a module
on or off acts is the feature modules' own business, decided where they are.
-/
namespace Swf.AppExperiments

open Swf.AppFeatures (FeatureFlags)
open Swf.AppOrbit (OrbitNavigation)

/-- The eight capabilities, in the order the experiments number them. -/
inductive Capability where
  /-- Focus and context: the Focus view mode. -/
  | focus
  /-- Workspace rotation: background drags turn a designated group round the camera. -/
  | orbit
  /-- Semantic depth: each window represented by its distance. -/
  | depth
  /-- Seamless 360° interaction: pointers wrapped at the seam. -/
  | cursor
  /-- The spatial map: the Map view mode. -/
  | map
  /-- Magnetic placement. -/
  | snap
  /-- Multi-surface composition. -/
  | composition
  /-- Persistent workspaces. -/
  | persistence
deriving DecidableEq

/-- Whether a capability's module is on. -/
def holds (f : FeatureFlags) : Capability → Bool
  | .focus => f.focus
  | .orbit => f.orbit
  | .depth => f.depth
  | .cursor => f.cursor
  | .map => f.map
  | .snap => f.snap
  | .composition => f.composition
  | .persistence => f.persistence

/-- An experiment: every capability together, or one alone. -/
inductive Experiment where
  /-- Every capability on, together. -/
  | everything
  /-- 01: focus and context alone. -/
  | focus
  /-- 02: workspace rotation alone. -/
  | orbit
  /-- 03: semantic depth alone. -/
  | depth
  /-- 04: seamless 360° interaction alone. -/
  | cursor
  /-- 05: the spatial map alone. -/
  | map
  /-- 06: magnetic placement alone. -/
  | snap
  /-- 07: multi-surface composition alone. -/
  | composition
  /-- 08: persistent workspaces alone. -/
  | persistence
deriving DecidableEq

/-- The experiments, in the order they are offered. -/
def experiments : List Experiment :=
  [.everything, .focus, .orbit, .depth, .cursor, .map, .snap, .composition, .persistence]

/-- The capability an experiment isolates: none for every capability together. -/
def isolates : Experiment → Option Capability
  | .everything => none
  | .focus => some .focus
  | .orbit => some .orbit
  | .depth => some .depth
  | .cursor => some .cursor
  | .map => some .map
  | .snap => some .snap
  | .composition => some .composition
  | .persistence => some .persistence

/-- Exactly one capability's module on. -/
def only (c : Capability) : FeatureFlags :=
  { focus := c = .focus, orbit := c = .orbit, map := c = .map, cursor := c = .cursor,
    snap := c = .snap, depth := c = .depth, composition := c = .composition,
    persistence := c = .persistence }

/-- Every module on. -/
def allOn : FeatureFlags :=
  { focus := true, orbit := true, map := true, cursor := true, snap := true, depth := true,
    composition := true, persistence := true }

/-- The modules an experiment turns on: the one it isolates alone, or every one. -/
def experimentFlags (e : Experiment) : FeatureFlags :=
  match isolates e with
  | none => allOn
  | some c => only c

/-- The experiment a combination of modules is: none for a custom combination. -/
def experimentOf (f : FeatureFlags) : Option Experiment :=
  experiments.find? (fun e => decide (experimentFlags e = f))

/-- The view an experiment is shown in. -/
inductive ExperimentView where
  /-- The 360° panorama. -/
  | panorama
  /-- A window in focus. -/
  | focus
  /-- The spatial map. -/
  | map
deriving DecidableEq

/-- What the scene offers an experiment's setup. -/
structure ExperimentContext where
  /-- A window is selected or focused: focus has one to show. -/
  target : Bool
  /-- A group is designated for workspace orbit: background drags can turn it. -/
  orbitRoot : Bool
deriving DecidableEq

/-- An experiment as it is applied: the modules on, and the view set up to show it. -/
structure ExperimentPlan where
  /-- The modules on. -/
  enabled : FeatureFlags
  /-- The view it is shown in. -/
  view : ExperimentView
  /-- What a drag on the panorama's background turns. -/
  navigation : OrbitNavigation
  /-- Whether the panorama is widened to the whole circle, which wrapping at the seam needs. -/
  wholeCircle : Bool

/-- How an experiment is applied in a scene: its modules, and the view that shows its capability
at work: focus on the window selected (the panorama while there is none to show), the map, drags
turning the workspace (the camera while no group is designated), the whole circle for wrapping at
the seam, and otherwise the panorama with drags turning the camera. -/
def experimentPlan (e : Experiment) (c : ExperimentContext) : ExperimentPlan :=
  { enabled := experimentFlags e
    view :=
      match e with
      | .focus => if c.target then .focus else .panorama
      | .map => .map
      | _ => .panorama
    navigation :=
      match e with
      | .orbit => if c.orbitRoot then .orbit else .camera
      | _ => .camera
    wholeCircle := decide (e = .cursor) }

/-! ## Invariants -/

theorem mem_experiments (e : Experiment) : e ∈ experiments := by
  cases e <;> simp [experiments]

/-- An experiment isolates its capability: every capability is on in "everything", and in any
other exactly the one it isolates is. -/
@[lungo_claim "lungo.law" subject experimentPlan]
theorem plan_isolates (e : Experiment) (c : ExperimentContext) (k : Capability) :
    holds (experimentPlan e c).enabled k =
      match isolates e with
      | none => true
      | some i => decide (i = k) := by
  cases e <;> cases k <;> rfl

/-- Every experiment is recognised from its own switches. -/
@[lungo_claim "lungo.law" subject experimentOf]
theorem recognised (e : Experiment) : experimentOf (experimentFlags e) = some e := by
  cases e <;> decide

/-- A combination is named an experiment only when its switches are exactly that experiment's. -/
@[lungo_claim "lungo.law" subject experimentOf]
theorem recognised_exactly (f : FeatureFlags) (e : Experiment) (h : experimentOf f = some e) :
    experimentFlags e = f := by
  have := List.find?_some h
  simpa using this

/-- A combination is custom exactly when no experiment's switches are these. -/
@[lungo_claim "lungo.law" subject experimentOf]
theorem custom_iff (f : FeatureFlags) :
    experimentOf f = none ↔ ∀ e, experimentFlags e ≠ f := by
  unfold experimentOf
  rw [List.find?_eq_none]
  constructor
  · intro h e he
    exact absurd (decide_eq_true he) (h e (mem_experiments e))
  · intro h e _ hd
    exact h e (of_decide_eq_true hd)

/-- Applying an experiment turns on its modules, and the combination is then that experiment. -/
@[lungo_claim "lungo.law" subject experimentPlan]
theorem plan_recognised (e : Experiment) (c : ExperimentContext) :
    (experimentPlan e c).enabled = experimentFlags e ∧
      experimentOf (experimentPlan e c).enabled = some e :=
  ⟨rfl, recognised e⟩

/-- An experiment's setup uses only what its modules turn on and the scene offers: focus with
focus on and a window to show, the map with the map on, drags turning the workspace with orbit on
and a group designated, and the whole circle with wrapping on. -/
@[lungo_claim "lungo.law" subject experimentPlan]
theorem plan_uses_what_is_on (e : Experiment) (c : ExperimentContext) :
    ((experimentPlan e c).view = .focus →
        (experimentPlan e c).enabled.focus = true ∧ c.target = true) ∧
      ((experimentPlan e c).view = .map → (experimentPlan e c).enabled.map = true) ∧
      ((experimentPlan e c).navigation = .orbit →
        (experimentPlan e c).enabled.orbit = true ∧ c.orbitRoot = true) ∧
      ((experimentPlan e c).wholeCircle = true → (experimentPlan e c).enabled.cursor = true) := by
  cases e <;> cases c with
  | mk target orbitRoot =>
    cases target <;> cases orbitRoot <;> simp [experimentPlan, experimentFlags, isolates, only, allOn]

/-- An experiment shows its capability whenever the scene lets it: focus on the window there is,
the map, drags turning the designated group, and the whole circle for wrapping at the seam. -/
@[lungo_claim "lungo.law" subject experimentPlan]
theorem plan_shows_capability (c : ExperimentContext) :
    (c.target = true → (experimentPlan .focus c).view = .focus) ∧
      (experimentPlan .map c).view = .map ∧
      (c.orbitRoot = true → (experimentPlan .orbit c).navigation = .orbit) ∧
      (experimentPlan .cursor c).wholeCircle = true := by
  refine ⟨fun h => ?_, rfl, fun h => ?_, rfl⟩ <;> simp [experimentPlan, h]

/-- Every other experiment is shown in the panorama with drags turning the camera, the view
widened only for wrapping. -/
@[lungo_claim "lungo.law" subject experimentPlan]
theorem plan_otherwise_panorama (e : Experiment) (c : ExperimentContext)
    (h : e ≠ .focus ∧ e ≠ .map ∧ e ≠ .orbit) :
    (experimentPlan e c).view = .panorama ∧ (experimentPlan e c).navigation = .camera := by
  obtain ⟨h1, h2, h3⟩ := h
  cases e <;> simp_all [experimentPlan]

end Swf.AppExperiments
