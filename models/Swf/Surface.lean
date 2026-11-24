import Lungo

/-!
A surface's presentation lifecycle (spec §13.2): which state it moves to on each event of its
binding and attachments, whether the change is announced, and which requests it refuses in which
state. The runtime does the work (resolving through the adapter, attaching, releasing); this model
decides every state it passes through and every request it admits.
-/
namespace Swf.Surface

/-- Why a surface is unbound: it shows a placeholder that keeps its identity and geometry. -/
inductive UnboundReason where
  /-- The association names no endpoint yet. -/
  | noBindingKey
  /-- No adapter is registered for its adapter type. -/
  | adapterUnavailable
  /-- The adapter does not know the binding key. -/
  | unknownBindingKey
  /-- The host unbound it, or it is between two bindings: it can bind. -/
  | released
deriving DecidableEq

inductive Presentation where
  | unbound (reason : UnboundReason)
  | binding
  | ready
  | presented
  | hidden
  | error
  | detaching
  | detached
deriving DecidableEq

/-- Holding or acquiring a binding: releasing passes through `detaching`. -/
def Presentation.active : Presentation → Bool
  | .binding | .ready | .presented | .hidden => true
  | _ => false

/-- Bound to a handle: it can be presented. -/
def Presentation.bound : Presentation → Bool
  | .ready | .presented | .hidden => true
  | _ => false

/-- How resolving a binding through its adapter ended. -/
inductive Resolution where
  | bound
  | unknownKey
  | failed

/-- Where releasing a binding leaves the surface: unbound (association kept) or detached
(association removed). -/
inductive Release where
  | unbound (reason : UnboundReason)
  | detached

inductive SurfaceEvent where
  /-- Binding starts, the surface showing `reason` now; `released` means it can bind. -/
  | bindingStarts (reason : UnboundReason)
  /-- The adapter answered the binding in flight. -/
  | resolved (r : Resolution)
  /-- The host removes the binding: release starts. -/
  | releaseStarts
  /-- The presentation attachments are released. -/
  | releaseEnds (final : Release)
  /-- The handle failed (it reported itself unavailable, or exceeded its capabilities). -/
  | fails
  /-- The surface's attachments changed: whether any is visible, and whether any remains. -/
  | attachmentsChanged (visible attached : Bool)
  /-- The association's binding changed, the surface showing `reason` now. -/
  | rebound (reason : UnboundReason)

/-- The state after an event, and whether the change is announced (`presentation.stateChanged`). -/
structure SurfaceStep where
  next : Presentation
  announce : Bool

def surfaceStep (p : Presentation) (e : SurfaceEvent) : SurfaceStep :=
  match e with
  | .bindingStarts .released => ⟨.binding, true⟩
  | .bindingStarts r => ⟨.unbound r, p ≠ .unbound r⟩
  | .resolved r =>
    if p = .binding then
      match r with
      | .bound => ⟨.ready, true⟩
      | .unknownKey => ⟨.unbound .unknownBindingKey, true⟩
      | .failed => ⟨.error, true⟩
    else ⟨p, false⟩
  | .releaseStarts => if p.active then ⟨.detaching, true⟩ else ⟨p, false⟩
  | .releaseEnds (.unbound r) => ⟨.unbound r, true⟩
  | .releaseEnds .detached => ⟨.detached, true⟩
  | .fails => ⟨.error, true⟩
  | .attachmentsChanged visible attached =>
    if p.bound then
      let n := if visible then .presented else if attached then .hidden else .ready
      ⟨n, n ≠ p⟩
    else ⟨p, false⟩
  | .rebound r => ⟨.unbound r, p ≠ .unbound r⟩

/-- Why a request is refused. Every one is `INVALID_TRANSITION`, except `disposed`
(`WORKSPACE_DISPOSED`), `invalidViewport` (`INVALID_INPUT`) and the two single-owner refusals
(`UNSUPPORTED_CAPABILITY`). -/
inductive SurfaceRefusal where
  | disposed
  /-- Only an unbound or failed surface can bind. -/
  | notUnboundOrFailed
  | detaching
  | replacing
  /-- Only a bound surface can be presented, or hand its binding over. -/
  | notBound
  | invalidViewport
  | alreadyPresented
  /-- Its single-owner handle is already presented in another viewport. -/
  | singleOwnerElsewhere
  /-- Another surface already presents the same single-owner endpoint. -/
  | endpointPresented
  | notAttached

def bindGate (disposed : Bool) (p : Presentation) : Option SurfaceRefusal :=
  if disposed then some .disposed
  else match p with
    | .unbound _ | .error => none
    | _ => some .notUnboundOrFailed

/-- What unbinding does: refuse, nothing (already unbound), or release. -/
inductive UnbindGate where
  | release
  | done
  | refuse (why : SurfaceRefusal)

def unbindGate (p : Presentation) (replacing : Bool) : UnbindGate :=
  if replacing then .refuse .replacing
  else match p with
    | .detaching => .refuse .detaching
    | .unbound _ => .done
    | _ => .release

/-- What presenting a surface in a viewport depends on. -/
structure PresentFacts where
  disposed : Bool
  /-- The viewport ID is a non-blank string. -/
  viewportValid : Bool
  replacing : Bool
  phase : Presentation
  /-- The surface's attachment in this viewport, if any: whether it is visible. -/
  existing : Option Bool
  /-- An attachment in this viewport is in flight. -/
  pending : Bool
  /-- The handle presents only one viewport at a time. -/
  singleOwner : Bool
  /-- The surface is attached, or attaching, in some viewport. -/
  attachedAnywhere : Bool
  /-- Another surface presents (or is attaching) the same endpoint. -/
  endpointElsewhere : Bool

def presentGate (f : PresentFacts) : Option SurfaceRefusal :=
  if f.disposed then some .disposed
  else if !f.viewportValid then some .invalidViewport
  else if f.replacing then some .replacing
  else if !f.phase.bound then some .notBound
  else if f.existing = some true || f.pending then some .alreadyPresented
  else if f.existing.isSome || !f.singleOwner then none
  else if f.attachedAnywhere then some .singleOwnerElsewhere
  else if f.endpointElsewhere then some .endpointPresented
  else none

/-- Handing a bound surface over to another binding: only from a bound state with its adapter,
no replacement or attachment in flight. -/
def replaceGate (disposed : Bool) (p : Presentation) (replacing hasAdapter pending : Bool) :
    Option SurfaceRefusal :=
  if disposed then some .disposed
  else if replacing then some .replacing
  else if !p.bound || !hasAdapter || pending then some .notBound
  else none

/-- Moving an attachment to another container: the surface must be attached in the viewport (and
not attaching there), and not replacing its binding. -/
def moveGate (disposed attached replacing : Bool) : Option SurfaceRefusal :=
  if disposed then some .disposed
  else if !attached then some .notAttached
  else if replacing then some .replacing
  else none

/-- Hiding a surface in a viewport: the same, on a runtime that may be disposing. -/
def hideGate (attached replacing : Bool) : Option SurfaceRefusal :=
  if !attached then some .notAttached
  else if replacing then some .replacing
  else none

/-- Whether hiding also releases the attachment: only when asked and when the handle declares that
it can be detached and attached again safely; otherwise it stays attached, hidden. -/
def hideReleases (requested safeDetach : Bool) : Bool := requested && safeDetach

/-- Whether the surface holds or is acquiring a binding: releasing it passes through `detaching`,
and losing its adapter releases it. -/
def holdsBinding (p : Presentation) : Bool := p.active

/-- Whether a newly registered adapter starts the surface binding: only one waiting for an adapter. -/
def bindsOnAdapter (p : Presentation) : Bool := p = .unbound .adapterUnavailable

/-! ## Invariants -/

/-- A surface is presented only from a bound state: never without a compatible ready binding. -/
@[lungo_claim "lungo.law" subject surfaceStep]
theorem presented_needs_binding (p : Presentation) (e : SurfaceEvent)
    (h : (surfaceStep p e).next = .presented) (changed : p ≠ .presented) : p.bound = true := by
  cases p <;> cases e <;> (try (rename_i a b; cases a <;> cases b)) <;> (try (rename_i a; cases a)) <;>
    simp_all [surfaceStep, Presentation.bound, Presentation.active]

/-- A surface enters `error` only when its binding fails to resolve or its handle fails. -/
@[lungo_claim "lungo.law" subject surfaceStep]
theorem error_only_on_failure (p : Presentation) (e : SurfaceEvent)
    (h : (surfaceStep p e).next = .error) (changed : p ≠ .error) :
    (p = .binding ∧ e = .resolved .failed) ∨ e = .fails := by
  cases p <;> cases e <;> (try (rename_i a b; cases a <;> cases b)) <;> (try (rename_i a; cases a)) <;>
    simp_all [surfaceStep, Presentation.bound, Presentation.active]

/-- `detaching` is entered only from a state holding or acquiring a binding. -/
@[lungo_claim "lungo.law" subject surfaceStep]
theorem detaching_only_from_active (p : Presentation) (e : SurfaceEvent)
    (h : (surfaceStep p e).next = .detaching) (changed : p ≠ .detaching) : p.active = true := by
  cases p <;> cases e <;> (try (rename_i a b; cases a <;> cases b)) <;> (try (rename_i a; cases a)) <;>
    simp_all [surfaceStep, Presentation.bound, Presentation.active]

/-- Every change of state is announced, and nothing else is. -/
@[lungo_claim "lungo.law" subject surfaceStep]
theorem announces_changes (p : Presentation) (e : SurfaceEvent)
    (h : (surfaceStep p e).next ≠ p) : (surfaceStep p e).announce = true := by
  cases p <;> cases e <;> (try (rename_i a b; cases a <;> cases b)) <;> (try (rename_i a; cases a)) <;>
    simp_all [surfaceStep, Presentation.bound, Presentation.active]

/-- Binding (and retrying after an error) is admitted exactly from `unbound` and `error`, on a
runtime that is not disposed. -/
@[lungo_claim "lungo.law" subject bindGate]
theorem bind_only_from_unbound_or_error (p : Presentation) :
    bindGate true p = some .disposed ∧
      (bindGate false p = none ↔ (∃ r, p = .unbound r) ∨ p = .error) := by
  cases p <;> simp [bindGate]

/-- A surface presented in a viewport is bound, not replacing its binding, not already presented
there; and a single-owner handle is never mounted twice: newly attached only when the surface is
attached nowhere else and no other surface presents its endpoint. -/
@[lungo_claim "lungo.law" subject presentGate]
theorem present_admits_single_mount (f : PresentFacts) (h : presentGate f = none) :
    f.disposed = false ∧ f.replacing = false ∧ f.phase.bound = true ∧ f.existing ≠ some true ∧
      f.pending = false ∧
      (f.singleOwner = true → f.existing = none →
        f.attachedAnywhere = false ∧ f.endpointElsewhere = false) := by
  obtain ⟨d, v, r, ph, ex, pe, so, aa, ee⟩ := f
  cases d <;> cases v <;> cases r <;> simp only [presentGate] at h ⊢ <;> (try simp at h) <;>
    cases hb : ph.bound <;> simp_all <;>
    cases ex <;> (try rename_i b; cases b) <;> simp_all <;>
    cases pe <;> cases so <;> cases aa <;> cases ee <;> simp_all

/-- Hiding releases an attachment only when asked and the handle declares it safe. -/
@[lungo_claim "lungo.decides" subject hideReleases]
theorem hide_releases_only_if_safe (requested safeDetach : Bool) :
    hideReleases requested safeDetach = true ↔ requested = true ∧ safeDetach = true := by
  simp [hideReleases]

/-- A binding is handed over only from a bound state with its adapter and nothing in flight. -/
@[lungo_claim "lungo.law" subject replaceGate]
theorem replace_only_when_bound (disposed : Bool) (p : Presentation) (replacing hasAdapter pending : Bool)
    (h : replaceGate disposed p replacing hasAdapter pending = none) :
    disposed = false ∧ replacing = false ∧ p.bound = true ∧ hasAdapter = true ∧ pending = false := by
  simp only [replaceGate] at h
  split at h <;> (try cases h)
  split at h <;> (try cases h)
  split at h <;> (try cases h)
  simp_all

/-- Unbinding refuses while replacing or detaching, does nothing on an unbound surface, and
otherwise releases. -/
@[lungo_claim "lungo.law" subject unbindGate]
theorem unbind_cases (p : Presentation) (replacing : Bool) :
    (replacing = true → unbindGate p replacing = .refuse .replacing) ∧
      (replacing = false → p = .detaching → unbindGate p replacing = .refuse .detaching) ∧
      (replacing = false → (∃ r, p = .unbound r) → unbindGate p replacing = .done) ∧
      (replacing = false → p.active = true → unbindGate p replacing = .release) := by
  refine ⟨fun h => by simp [unbindGate, h], fun h hp => by simp [unbindGate, h, hp],
    fun h ⟨r, hp⟩ => by simp [unbindGate, h, hp], fun h ha => ?_⟩
  cases p <;> simp_all [unbindGate, Presentation.active]

/-- Moving and hiding act only on an attached surface that is not replacing its binding. -/
@[lungo_claim "lungo.law" subject moveGate hideGate]
theorem move_and_hide_need_attachment (disposed attached replacing : Bool) :
    (moveGate disposed attached replacing = none ↔
      disposed = false ∧ attached = true ∧ replacing = false) ∧
    (hideGate attached replacing = none ↔ attached = true ∧ replacing = false) := by
  cases disposed <;> cases attached <;> cases replacing <;> simp [moveGate, hideGate]

@[lungo_claim "lungo.decides" subject holdsBinding]
theorem holdsBinding_iff (p : Presentation) :
    holdsBinding p = true ↔ p = .binding ∨ p = .ready ∨ p = .presented ∨ p = .hidden := by
  cases p <;> simp [holdsBinding, Presentation.active]

@[lungo_claim "lungo.decides" subject bindsOnAdapter]
theorem bindsOnAdapter_iff (p : Presentation) :
    bindsOnAdapter p = true ↔ p = .unbound .adapterUnavailable := by
  simp [bindsOnAdapter]

end Swf.Surface
