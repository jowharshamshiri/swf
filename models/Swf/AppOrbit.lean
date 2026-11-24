import Lungo

/-!
The reference application's workspace orbit. A drag on the panorama's background either turns the
camera (view state, never undone) or turns the designated group, the orbit root, about the camera
(a change to the scene, undone like any other). Which one is the viewport's navigation setting,
chosen explicitly; it never switches by itself. This model decides every transition of that
setting and of the designation, and the scene commands that make it; the application commits
them.
-/
namespace Swf.AppOrbit

/-- What a background drag turns in a viewport. -/
inductive OrbitNavigation where
  | camera
  | orbit
deriving DecidableEq

/-- What the orbit policy weighs. -/
structure OrbitState where
  /-- The orbit policy is on. -/
  enabled : Bool
  navigation : OrbitNavigation
  /-- The designated group, if any. -/
  rootId : Option String
deriving DecidableEq

/-- A node of the scene, as designating it weighs it. -/
structure OrbitNode where
  /-- The node's kind, such as `group` or `window`. -/
  kind : String
  label : Option String
  /-- Not archived. -/
  active : Bool

/-- A node asked to be the orbit root: its ID, and the scene's node of that ID, if there is one. -/
structure OrbitCandidate where
  id : String
  node : Option OrbitNode

inductive OrbitEvent where
  /-- Background drags turn this from now on. -/
  | navigate (to : OrbitNavigation)
  /-- Designates the group orbit turns, or none. -/
  | designate (candidate : Option OrbitCandidate)
  /-- The policy is turned on or off. -/
  | enable (enabled : Bool)

/-- A scene command an orbit transition makes. -/
inductive OrbitCommand where
  /-- Designate the orbit root, or none. -/
  | setRoot (nodeId : Option String)
  /-- Set what the viewport's background drags turn. -/
  | setNavigation (to : OrbitNavigation)
deriving DecidableEq

inductive OrbitStep where
  /-- The state after the event, and the commands that make it: one transaction, or none when
  nothing of the scene changes. -/
  | next (state : OrbitState) (commands : List OrbitCommand)
  /-- The event cannot happen, naming the field at fault. -/
  | refused (field : String) (reason : String)

/-- Why a node cannot be the orbit root, or none when it can: only an active group can. -/
def orbitRootIssue (c : OrbitCandidate) : Option String :=
  match c.node with
  | none => some s!"no node \"{c.id}\""
  | some n =>
    let name := n.label.getD c.id
    if n.kind ≠ "group" then some s!"\"{name}\" is a {n.kind}, not a group"
    else if !n.active then some s!"\"{name}\" is archived"
    else none

/-- The command that sets the navigation, when it changes. -/
def navigateCommands (current to : OrbitNavigation) : List OrbitCommand :=
  if to = current then [] else [.setNavigation to]

/-- The next state for an event. Orbit navigation needs the policy on and a designated group;
turning the policy off, or taking the group away, returns background drags to the camera. -/
def orbitStep (s : OrbitState) (e : OrbitEvent) : OrbitStep :=
  match e with
  | .navigate to =>
    if to = .orbit ∧ !s.enabled then .refused "navigation" "workspace orbit is turned off"
    else if to = .orbit ∧ s.rootId = none then
      .refused "navigation" "no group is designated for workspace orbit"
    else .next { s with navigation := to } (navigateCommands s.navigation to)
  | .designate candidate =>
    match candidate.bind orbitRootIssue with
    | some issue => .refused "nodeId" issue
    | none =>
      let rootId := candidate.map (·.id)
      let navigation := if rootId = none then .camera else s.navigation
      .next { s with rootId, navigation }
        ((if rootId = s.rootId then [] else [.setRoot rootId]) ++ navigateCommands s.navigation navigation)
  | .enable enabled =>
    let navigation := if enabled then s.navigation else .camera
    .next { s with enabled, navigation } (navigateCommands s.navigation navigation)

/-- Whether a viewport must be brought back in line after the scene changed by another route: its
background drags turn the orbit root, but the policy is off or there is no root. -/
def orbitNeedsRepair (s : OrbitState) : Bool :=
  s.navigation = .orbit && (!s.enabled || s.rootId.isNone)

/-- Whether a key binding of `command` stays in the keymap: while the policy is off, none that
turns the orbit root does. -/
def orbitKeepsBinding (enabled : Bool) (command : String) : Bool :=
  enabled || command ≠ "orbit.turn"

/-! ## Invariants -/

/-- A state is coherent when background drags turn the orbit root only while the policy is on and
a group is designated. -/
def OrbitState.Coherent (s : OrbitState) : Prop :=
  s.navigation = .orbit → s.enabled = true ∧ s.rootId.isSome = true

/-- Only an active group can be the orbit root. -/
@[lungo_claim "lungo.law" subject orbitRootIssue]
theorem root_is_active_group (c : OrbitCandidate) :
    orbitRootIssue c = none ↔ ∃ n, c.node = some n ∧ n.kind = "group" ∧ n.active = true := by
  unfold orbitRootIssue
  cases h : c.node with
  | none => simp
  | some n =>
    by_cases hk : n.kind = "group" <;> cases ha : n.active <;> simp [hk, ha]

/-- Switching background drags to the orbit root succeeds only with the policy on and a group
designated. -/
@[lungo_claim "lungo.law" subject orbitStep]
theorem orbit_needs_enabled_and_root (s s' : OrbitState) (cs : List OrbitCommand)
    (h : orbitStep s (.navigate .orbit) = .next s' cs) :
    s.enabled = true ∧ s.rootId.isSome = true := by
  unfold orbitStep at h
  cases he : s.enabled <;> cases hr : s.rootId <;> simp_all

/-- Every transition from a coherent state leads to a coherent one: drags never turn a root that
is missing or while the policy is off. -/
@[lungo_claim "lungo.law" subject orbitStep]
theorem step_keeps_coherent (s s' : OrbitState) (e : OrbitEvent) (cs : List OrbitCommand)
    (hs : s.Coherent) (h : orbitStep s e = .next s' cs) : s'.Coherent := by
  unfold OrbitState.Coherent at *
  cases e with
  | navigate to =>
    cases to <;> cases he : s.enabled <;> cases hr : s.rootId <;>
      simp [orbitStep, he, hr] at h <;> obtain ⟨rfl, -⟩ := h <;> simp_all
  | designate c =>
    cases c with
    | none => simp [orbitStep] at h; obtain ⟨rfl, -⟩ := h; simp
    | some c =>
      cases hi : orbitRootIssue c with
      | some _ => simp [orbitStep, hi] at h
      | none => simp [orbitStep, hi] at h; obtain ⟨rfl, -⟩ := h; simp_all
  | enable en =>
    cases en <;> simp [orbitStep] at h <;> obtain ⟨rfl, -⟩ := h <;> simp_all

/-- Turning the policy off returns background drags to the camera and keeps the designation,
which is the scene's. -/
@[lungo_claim "lungo.law" subject orbitStep]
theorem disable_returns_to_camera (s : OrbitState) :
    ∃ cs, orbitStep s (.enable false) = .next { s with enabled := false, navigation := .camera } cs := by
  simp [orbitStep]

/-- Taking the designation away returns background drags to the camera. -/
@[lungo_claim "lungo.law" subject orbitStep]
theorem undesignate_returns_to_camera (s : OrbitState) :
    ∃ cs, orbitStep s (.designate none) = .next { s with rootId := none, navigation := .camera } cs := by
  simp [orbitStep]

/-- A transition makes commands exactly for what it changes of the scene: the root, and the
viewport's navigation. One that changes neither commits nothing. -/
@[lungo_claim "lungo.law" subject orbitStep]
theorem unchanged_emits_nothing (s s' : OrbitState) (e : OrbitEvent) (cs : List OrbitCommand)
    (h : orbitStep s e = .next s' cs) :
    (cs = [] ↔ s'.rootId = s.rootId ∧ s'.navigation = s.navigation) ∧
      (∀ r, OrbitCommand.setRoot r ∈ cs → r = s'.rootId) ∧
      (∀ n, OrbitCommand.setNavigation n ∈ cs → n = s'.navigation) := by
  cases e with
  | navigate to =>
    cases to <;> cases hn : s.navigation <;> cases he : s.enabled <;> cases hr : s.rootId <;>
      simp [orbitStep, he, hr] at h <;> obtain ⟨rfl, rfl⟩ := h <;> simp [navigateCommands, hn]
  | designate c =>
    cases c with
    | none =>
      simp [orbitStep] at h; obtain ⟨rfl, rfl⟩ := h
      cases hr : s.rootId <;> cases hn : s.navigation <;> simp_all [navigateCommands]
    | some c =>
      cases hi : orbitRootIssue c with
      | some _ => simp [orbitStep, hi] at h
      | none =>
        simp [orbitStep, hi] at h; obtain ⟨rfl, rfl⟩ := h
        by_cases hr : some c.id = s.rootId <;> simp [navigateCommands, hr] <;> grind
  | enable en =>
    simp [orbitStep] at h; obtain ⟨rfl, rfl⟩ := h
    cases en <;> cases hn : s.navigation <;> simp_all [navigateCommands]

/-- A refused designation names a node that is not an active group, and says why. -/
@[lungo_claim "lungo.law" subject orbitStep]
theorem designate_refuses_non_group (s : OrbitState) (c : OrbitCandidate) (issue : String)
    (h : orbitRootIssue c = some issue) : orbitStep s (.designate (some c)) = .refused "nodeId" issue := by
  simp [orbitStep, h]

/-- A viewport is brought back in line exactly when its drags turn the orbit root while the
policy is off or there is no root: exactly when its state is not coherent. -/
@[lungo_claim "lungo.decides" subject orbitNeedsRepair]
theorem repair_iff_incoherent (s : OrbitState) : orbitNeedsRepair s = true ↔ ¬ s.Coherent := by
  unfold orbitNeedsRepair OrbitState.Coherent
  cases hn : s.navigation <;> cases he : s.enabled <;> cases hr : s.rootId <;> simp

/-- While the policy is off the keymap holds no binding that turns the orbit root, and every
other binding stays; while it is on every binding stays. -/
@[lungo_claim "lungo.decides" subject orbitKeepsBinding]
theorem keymap_drops_only_orbit_turn (enabled : Bool) (command : String) :
    orbitKeepsBinding enabled command = true ↔ enabled = true ∨ command ≠ "orbit.turn" := by
  simp [orbitKeepsBinding]

end Swf.AppOrbit
