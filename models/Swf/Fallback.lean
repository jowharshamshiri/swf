import Lungo

/-!
Capability negotiation and fallback: how each surface is presented in a viewport. The first mode of
the fallback policy's order that the surface, renderer, compositor, projection, geometry and
ownership all allow is chosen, and every better mode is reported with what ruled it out. The
presentation layer gathers the capabilities; this model decides, for every fragment of a frame at
once.
-/
namespace Swf.Fallback

/-- How a surface is presented, best first. -/
inductive Mode where
  | exact
  | native
  | approximated
  | proxy
  | placeholder
deriving DecidableEq

inductive Requirement where
  | surface
  | renderer
  | compositor
  | projection
  | geometry
  | ownership
deriving DecidableEq

/-- How faithfully content follows its geometry. -/
inductive Fidelity where
  | native
  | exact
  | approximate
  | proxy
  | unsupported
deriving DecidableEq

/-- Worst first: `unsupported` 0 … `native` 4. -/
def Fidelity.rank : Fidelity → Nat
  | .unsupported => 0
  | .proxy => 1
  | .approximate => 2
  | .exact => 3
  | .native => 4

def Fidelity.name : Fidelity → String
  | .native => "native"
  | .exact => "exact"
  | .approximate => "approximate"
  | .proxy => "proxy"
  | .unsupported => "unsupported"

inductive Strategy where
  | nativeDom
  | drawable
  | proxyOnly
deriving DecidableEq

def Strategy.name : Strategy → String
  | .nativeDom => "native-dom"
  | .drawable => "drawable"
  | .proxyOnly => "proxy-only"

inductive Interaction where
  | full
  | partly
  | none
deriving DecidableEq

inductive Clip where
  | none
  | rect
  | path
deriving DecidableEq

def Clip.rank : Clip → Nat
  | .none => 0
  | .rect => 1
  | .path => 2

inductive TransformMode where
  | translate
  | affine2d
  | perspective3d
  | mesh
deriving DecidableEq

def TransformMode.rank : TransformMode → Nat
  | .translate => 0
  | .affine2d => 1
  | .perspective3d => 2
  | .mesh => 3

def TransformMode.name : TransformMode → String
  | .translate => "translate"
  | .affine2d => "affine-2d"
  | .perspective3d => "perspective-3d"
  | .mesh => "mesh"

inductive LayerCategory where
  | contentNative
  | contentRaster
  | proxy
  | placeholder
  | chrome
  | overlay
deriving DecidableEq

/-- What negotiation needs of a bound handle's capabilities. -/
structure HandleCapabilities where
  strategy : Strategy
  nativeInteraction : Interaction
  transformFidelity : Fidelity
  transparency : Bool
  /-- One handle may be shown in several viewports at once. -/
  shared : Bool

structure RendererCapabilities where
  /-- The handle kinds it presents, with the best transform fidelity for each. -/
  handleKinds : List (Strategy × Fidelity)
  transformMode : TransformMode
  clipping : Clip

structure CompositorCapabilities where
  layerCategories : List LayerCategory
  directNative : Bool
  clipping : Clip
  transparency : Bool

/-- What every fragment of a frame shares: the backends and whether the projection is nonlinear. -/
structure NegotiationContext where
  renderer : RendererCapabilities
  compositor : CompositorCapabilities
  nonlinear : Bool

/-- What negotiation weighs for one fragment. -/
structure FragmentFacts where
  /-- The bound handle's capabilities, or none when the surface has no bound handle. -/
  handle : Option HandleCapabilities
  geometryKind : String
  geometrySupported : Bool
  geometryExact : Bool
  anchorExact : Bool
  /-- The viewport may hold the live handle (a single-owner handle presented elsewhere is not its). -/
  viewportOwns : Bool
  /-- The fragment is the surface's native-owner fragment in the view (not a secondary seam piece). -/
  nativeOwner : Bool
  /-- The modes to try, in order: the fallback policy's. -/
  order : List Mode
  /-- The viewport represents the surface (a compact preview or its label) rather than showing it. -/
  represented : Bool

structure Gap where
  mode : Mode
  requirement : Requirement
  detail : String

/-- Whether the fragment may hold the live handle: in a viewport that may, the native-owner fragment;
and every fragment of drawable content the handle shares. -/
def FragmentFacts.owner (f : FragmentFacts) : Bool :=
  f.viewportOwns && (f.nativeOwner || f.handle.any (fun h => h.strategy = .drawable && h.shared))

def kindFor (r : RendererCapabilities) (s : Strategy) : Option Fidelity :=
  (r.handleKinds.find? (·.1 = s)).map (·.2)

/-- Everything that rules `m` out for a fragment; empty when the mode is possible. -/
def gapsFor (c : NegotiationContext) (f : FragmentFacts) (m : Mode) : List Gap :=
  let gap := fun (r : Requirement) (d : String) => [Gap.mk m r d]
  match m, f.handle with
  | .placeholder, _ => []
  | _, none => gap .surface "no bound handle"
  | .proxy, some _ =>
    if c.compositor.layerCategories.contains .proxy then [] else gap .compositor "no proxy layer"
  | m, some h =>
    let owner := if f.owner then [] else gap .ownership "another fragment or viewport holds the live handle"
    if h.strategy = .proxyOnly then owner ++ gap .surface "the endpoint can only be shown as a proxy"
    else
      let kind := kindFor c.renderer h.strategy
      let live :=
        owner ++
        (if kind.all (·.rank < Fidelity.approximate.rank) then
          gap .renderer s!"cannot present {h.strategy.name} handles" else []) ++
        (if h.strategy = .nativeDom && !c.compositor.directNative then
          gap .compositor "cannot present native layers" else []) ++
        (if h.strategy = .drawable && !c.compositor.layerCategories.contains .contentRaster then
          gap .compositor "no content-raster layer" else [])
      if m = .approximated then live
      else
        live ++
        (if m = .exact then
          if h.strategy ≠ .drawable then
            gap .surface "only drawable content can be warped exactly; live elements are never claimed exact"
          else
            (if h.transformFidelity.rank < Fidelity.exact.rank then
              gap .surface s!"the endpoint's transform fidelity is {h.transformFidelity.name}" else []) ++
            (match kind with
              | some k => if k.rank < Fidelity.exact.rank then
                  gap .renderer s!"draws {h.strategy.name} content at {k.name} fidelity" else []
              | none => [])
        else []) ++
        (if m = .native && h.strategy ≠ .nativeDom then
          gap .surface "native presentation needs a native-dom endpoint" else []) ++
        (if c.nonlinear then
          if m = .native then
            gap .projection "a nonlinear projection bends a planar element, which can only approximate it"
          else if c.renderer.transformMode ≠ .mesh then
            gap .renderer "a nonlinear projection needs mesh warping"
          else []
        else if c.renderer.transformMode.rank < TransformMode.perspective3d.rank then
          gap .renderer s!"its {c.renderer.transformMode.name} transforms cannot follow a perspective projection"
        else []) ++
        (if f.anchorExact then [] else gap .projection "the projected placement is approximate") ++
        (if !f.geometrySupported then gap .geometry s!"geometry kind \"{f.geometryKind}\" has no provider"
         else if !f.geometryExact then gap .geometry s!"geometry kind \"{f.geometryKind}\" is approximate"
         else []) ++
        (if f.geometryKind = "polygon" &&
            min c.renderer.clipping.rank c.compositor.clipping.rank < Clip.path.rank then
          gap (if c.renderer.clipping.rank < Clip.path.rank then .renderer else .compositor)
            "a polygon needs path clipping"
         else []) ++
        (if h.transparency && !c.compositor.transparency then
          gap .compositor "the endpoint is transparent but the compositor is not" else [])

/-- How a chosen mode presents the fragment. -/
inductive ShapeFidelity where
  | exact
  | approximate
  | none

structure Negotiated where
  mode : Mode
  /-- Every better mode of the order and what ruled it out, in order. -/
  gaps : List Gap
  shape : ShapeFidelity
  content : Fidelity
  interaction : Interaction
  layer : LayerCategory

def presented (f : FragmentFacts) (m : Mode) (gaps : List Gap) : Negotiated :=
  let native := f.handle.any (·.strategy = .nativeDom)
  let handleInteraction := (f.handle.map (·.nativeInteraction)).getD .none
  match m with
  | .exact => ⟨m, gaps, .exact, .exact, .none, .contentRaster⟩
  | .native => ⟨m, gaps, .exact, .native, handleInteraction, .contentNative⟩
  | .approximated =>
    if native then ⟨m, gaps, .approximate, .native, handleInteraction, .contentNative⟩
    else ⟨m, gaps, .approximate, .approximate, .none, .contentRaster⟩
  | .proxy => ⟨m, gaps, .approximate, .proxy, .none, .proxy⟩
  | .placeholder => ⟨m, gaps, .none, .unsupported, .none, .placeholder⟩

def chooseFrom (c : NegotiationContext) (f : FragmentFacts) : List Mode → List Gap → Option Negotiated
  | [], _ => none
  | m :: rest, acc =>
    match gapsFor c f m with
    | [] => some (presented f m acc)
    | gs => chooseFrom c f rest (acc ++ gs)

/-- The modes tried for a fragment: a represented surface stands without its live content, so only
by a proxy or a placeholder, in the policy's order. -/
def representedModes (represented : Bool) (order : List Mode) : List Mode :=
  if represented then order.filter (fun m => m = .proxy || m = .placeholder) else order

/-- The presentation of one fragment: none only when no mode of its order is possible, which a
valid policy (ending with `placeholder`) never allows. -/
def negotiateOne (c : NegotiationContext) (f : FragmentFacts) : Option Negotiated :=
  chooseFrom c f (representedModes f.represented f.order) []

/-- Every fragment of a frame, negotiated at once. -/
def negotiateFrame (c : NegotiationContext) (fs : Array FragmentFacts) : Array (Option Negotiated) :=
  fs.map (negotiateOne c)

/-- Why a fallback order is not a policy. -/
inductive PolicyIssue where
  | empty
  | unknown (name : String)
  | repeats (m : Mode)
  | notEndingWithPlaceholder

def modeOf : String → Option Mode
  | "exact" => some .exact
  | "native" => some .native
  | "approximated" => some .approximated
  | "proxy" => some .proxy
  | "placeholder" => some .placeholder
  | _ => none

/-- The first entry, in order, that is not a mode or repeats one before it. -/
def badEntry : List String → List Mode → Option PolicyIssue
  | [], _ => none
  | s :: rest, seen =>
    match modeOf s with
    | none => some (.unknown s)
    | some m => if m ∈ seen then some (.repeats m) else badEntry rest (m :: seen)

/-- A fallback order is a policy when it names modes, each once, and ends with `placeholder`, the
mode that is always possible. -/
def policyIssue (order : List String) : Option PolicyIssue :=
  if order = [] then some .empty
  else match badEntry order [] with
    | some issue => some issue
    | none => if order.getLast? = some "placeholder" then none else some .notEndingWithPlaceholder

/-! ## Invariants -/

theorem presented_mode (f : FragmentFacts) (m : Mode) (g : List Gap) : (presented f m g).mode = m := by
  cases m <;> simp only [presented] <;> split <;> rfl

theorem presented_gaps (f : FragmentFacts) (m : Mode) (g : List Gap) : (presented f m g).gaps = g := by
  cases m <;> simp only [presented] <;> split <;> rfl

theorem chooseFrom_spec (c : NegotiationContext) (f : FragmentFacts) :
    ∀ (order : List Mode) (acc : List Gap) (r : Negotiated), chooseFrom c f order acc = some r →
      ∃ before after, order = before ++ r.mode :: after ∧ gapsFor c f r.mode = [] ∧
        (∀ m ∈ before, gapsFor c f m ≠ []) ∧
        r.gaps = acc ++ (before.map (gapsFor c f)).flatten ∧ r = presented f r.mode r.gaps := by
  intro order
  induction order with
  | nil => intro acc r h; simp [chooseFrom] at h
  | cons m rest ih =>
    intro acc r h
    simp only [chooseFrom] at h
    split at h
    · rename_i hg
      cases h
      refine ⟨[], rest, by simp [presented_mode], by rw [presented_mode]; exact hg, by simp,
        by simp [presented_gaps], by rw [presented_mode, presented_gaps]⟩
    · rename_i gs hg
      obtain ⟨before, after, ho, hz, hb, hgaps, hp⟩ := ih _ r h
      refine ⟨m :: before, after, by simp [ho], hz, ?_, ?_, hp⟩
      · intro m' hm'
        cases List.mem_cons.mp hm' with
        | inl e => subst e; intro he; exact hg he
        | inr hm' => exact hb m' hm'
      · rw [hgaps]; simp [List.append_assoc]

/-- The chosen mode is one the fragment's order lists and that nothing rules out; every mode before
it was ruled out, and each of those modes' gaps is reported, in order. -/
@[lungo_claim "lungo.law" subject negotiateOne]
theorem first_allowed_in_order (c : NegotiationContext) (f : FragmentFacts) (r : Negotiated)
    (h : negotiateOne c f = some r) :
    ∃ before after, representedModes f.represented f.order = before ++ r.mode :: after ∧
      gapsFor c f r.mode = [] ∧ (∀ m ∈ before, gapsFor c f m ≠ []) ∧
      r.gaps = (before.map (gapsFor c f)).flatten := by
  obtain ⟨before, after, ho, hz, hb, hg, -⟩ :=
    chooseFrom_spec c f (representedModes f.represented f.order) [] r h
  exact ⟨before, after, ho, hz, hb, by simpa using hg⟩

/-- `placeholder` is never ruled out, so an order containing it always finds a mode. -/
@[lungo_claim "lungo.law" subject negotiateOne]
theorem placeholder_last_resort (c : NegotiationContext) (f : FragmentFacts)
    (h : Mode.placeholder ∈ f.order) : (negotiateOne c f).isSome := by
  have hr : Mode.placeholder ∈ representedModes f.represented f.order := by
    unfold representedModes; split <;> simp_all
  have key : ∀ (order : List Mode) (acc : List Gap), Mode.placeholder ∈ order →
      (chooseFrom c f order acc).isSome := by
    intro order
    induction order with
    | nil => intro acc h; simp at h
    | cons m rest ih =>
      intro acc h
      simp only [chooseFrom]
      split
      · simp
      · rename_i gs hg
        cases List.mem_cons.mp h with
        | inl e => subst e; simp [gapsFor] at hg
        | inr hr => exact ih _ hr
  exact key _ [] hr

/-- A live mode (exact, native, approximated) is chosen only for a fragment that may hold the live
handle, of a bound handle that is not proxy-only. -/
@[lungo_claim "lungo.law" subject negotiateOne]
theorem live_needs_owner (c : NegotiationContext) (f : FragmentFacts) (r : Negotiated)
    (h : negotiateOne c f = some r) (live : r.mode ≠ .proxy ∧ r.mode ≠ .placeholder) :
    f.owner = true ∧ ∃ hc, f.handle = some hc ∧ hc.strategy ≠ .proxyOnly := by
  obtain ⟨_, _, _, hz, _, _⟩ := first_allowed_in_order c f r h
  obtain ⟨np, npl⟩ := live
  cases hh : f.handle with
  | none => cases hm : r.mode <;> simp_all [gapsFor]
  | some hc =>
    refine ⟨?_, hc, rfl, ?_⟩
    · cases ho : f.owner
      · exfalso
        cases hm : r.mode <;> simp_all [gapsFor] <;> split at hz <;> simp_all
      · rfl
    · intro hs
      cases hm : r.mode <;> simp_all [gapsFor]

/-- Only drawable content is presented exactly; without a bound handle, only a placeholder. -/
@[lungo_claim "lungo.law" subject negotiateOne]
theorem exact_only_drawable (c : NegotiationContext) (f : FragmentFacts) (r : Negotiated)
    (h : negotiateOne c f = some r) :
    (r.mode = .exact → ∃ hc, f.handle = some hc ∧ hc.strategy = .drawable) ∧
      (f.handle = none → r.mode = .placeholder) := by
  obtain ⟨_, _, _, hz, _, _⟩ := first_allowed_in_order c f r h
  constructor
  · intro he
    rw [he] at hz
    cases hh : f.handle with
    | none => simp [gapsFor, hh] at hz
    | some hc =>
      refine ⟨hc, rfl, ?_⟩
      by_cases hs : hc.strategy = .drawable
      · exact hs
      · exfalso; revert hz; simp only [gapsFor, hh]
        by_cases hp : hc.strategy = .proxyOnly <;> simp_all
  · intro hn
    revert hz
    cases hm : r.mode <;> simp [gapsFor, hn]

/-- Every fragment of a frame is negotiated as it would be alone. -/
@[lungo_claim "lungo.law" subject negotiateFrame]
theorem frame_is_each (c : NegotiationContext) (fs : Array FragmentFacts) (i : Nat)
    (hi : i < fs.size) : (negotiateFrame c fs)[i]'(by simpa [negotiateFrame] using hi) =
      negotiateOne c fs[i] := by
  simp [negotiateFrame]

theorem badEntry_none (order : List String) :
    ∀ seen : List Mode, badEntry order seen = none → seen.Nodup →
      ∃ ms : List Mode, order.map modeOf = ms.map some ∧ (ms ++ seen).Nodup ∧
        ∀ m ∈ ms, m ∉ seen := by
  induction order with
  | nil => intro seen _ hs; exact ⟨[], rfl, by simpa using hs, by simp⟩
  | cons s rest ih =>
    intro seen h hs
    simp only [badEntry] at h
    split at h
    · cases h
    · rename_i m hm
      split at h
      · cases h
      · rename_i hnot
        obtain ⟨ms, hmap, hnd, hfresh⟩ := ih (m :: seen) h (List.nodup_cons.mpr ⟨hnot, hs⟩)
        refine ⟨m :: ms, by simp [hm, hmap], ?_, ?_⟩
        · have : ms ++ m :: seen = (ms ++ [m]) ++ seen := by simp
          rw [List.nodup_append] at hnd ⊢
          obtain ⟨h1, h2, h3⟩ := hnd
          refine ⟨List.nodup_cons.mpr ⟨fun hin => hfresh m hin (List.mem_cons_self), h1⟩,
            (List.nodup_cons.mp h2).2, ?_⟩
          intro a ha b hb
          cases List.mem_cons.mp ha with
          | inl e => subst e; exact fun he => hnot (he ▸ hb)
          | inr ha => exact h3 a ha b (List.mem_cons_of_mem _ hb)
        · intro x hx
          cases List.mem_cons.mp hx with
          | inl e => subst e; exact hnot
          | inr hx => exact fun hs' => hfresh x hx (List.mem_cons_of_mem _ hs')

/-- A valid policy names modes only, each once, and ends with `placeholder`. -/
@[lungo_claim "lungo.law" subject policyIssue]
theorem policy_valid (order : List String) (h : policyIssue order = none) :
    ∃ ms : List Mode, order.map modeOf = ms.map some ∧ ms.Nodup ∧
      order.getLast? = some "placeholder" := by
  simp only [policyIssue] at h
  split at h
  · cases h
  · split at h
    · cases h
    · rename_i hb
      split at h
      · rename_i hl
        obtain ⟨ms, hmap, hnd, -⟩ := badEntry_none order [] hb List.nodup_nil
        exact ⟨ms, hmap, by simpa using hnd, hl⟩
      · cases h

/-- A represented surface is only ever shown by a proxy or a placeholder, tried in the policy's
order; a surface shown in full tries the whole policy. -/
@[lungo_claim "lungo.law" subject representedModes]
theorem represented_only_stand_ins (order : List Mode) :
    (∀ m ∈ representedModes true order, m = .proxy ∨ m = .placeholder) ∧
      (representedModes true order).Sublist order ∧ representedModes false order = order := by
  refine ⟨fun m hm => ?_, by simp [representedModes, List.filter_sublist], by simp [representedModes]⟩
  simp only [representedModes, ite_true, List.mem_filter] at hm
  cases m <;> simp_all

/-- Only the native-owner fragment of a viewport that may hold the handle holds it live, except
drawable content the handle shares, which every fragment of such a viewport may draw. -/
@[lungo_claim "lungo.decides" subject FragmentFacts.owner]
theorem owner_rule (f : FragmentFacts) :
    f.owner = true ↔ f.viewportOwns = true ∧
      (f.nativeOwner = true ∨ ∃ h, f.handle = some h ∧ h.strategy = .drawable ∧ h.shared = true) := by
  cases hh : f.handle <;> simp [FragmentFacts.owner, hh]

end Swf.Fallback

