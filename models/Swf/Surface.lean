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

/-- Where a surface is in its presentation lifecycle. -/
inductive Presentation where
  /-- Not bound to an endpoint: a placeholder keeps the surface's identity and geometry, for
  `reason`. -/
  | unbound (reason : UnboundReason)
  /-- Resolving its binding key through its adapter. -/
  | binding
  /-- Bound to a handle and attached in no viewport. -/
  | ready
  /-- Bound and visible in at least one viewport. -/
  | presented
  /-- Bound and attached, but visible in no viewport. -/
  | hidden
  /-- Its binding failed to resolve or its handle failed; it can bind again. -/
  | error
  /-- Releasing its binding and attachments. -/
  | detaching
  /-- Released, its association removed. -/
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
  /-- The adapter resolved the key to a handle. -/
  | bound
  /-- The adapter does not know the key. -/
  | unknownKey
  /-- Resolving failed: the adapter threw or timed out, or the handle's capabilities were
  unusable. -/
  | failed

/-- Where releasing a binding leaves the surface: unbound (association kept) or detached
(association removed). -/
inductive Release where
  /-- The association stays; the surface shows a placeholder for `reason`. -/
  | unbound (reason : UnboundReason)
  /-- The association is removed. -/
  | detached

/-- What happens to a surface's binding or attachments. -/
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
  /-- The state after the event. -/
  next : Presentation
  /-- Whether `presentation.stateChanged` is emitted: whenever the state changes, and also when a
  released surface starts binding, a release ends or the handle fails, even if the state is
  unchanged. -/
  announce : Bool

/-- The state a surface moves to on an event, and whether the change is announced. Binding a
released surface starts `binding`; binding for any other reason, and a rebinding, leave it
`unbound` for that reason. An answer from the adapter moves only a `binding` surface: to `ready`,
to `unbound` for an unknown key, or to `error`; any other surface ignores it. Release starts
(`detaching`) only from a state holding or acquiring a binding, and ends `unbound` or `detached`.
A handle failure moves any surface to `error`. A change of attachments moves only a bound surface:
to `presented` when one is visible, `hidden` when one remains, `ready` otherwise.

The model proves that a surface becomes `presented` only from a bound state, enters `error` only
on a failed resolution or handle, enters `detaching` only from a state holding or acquiring a
binding, and that every change of state is announced. -/
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
  /-- The surface runtime is disposed. -/
  | disposed
  /-- Only an unbound or failed surface can bind. -/
  | notUnboundOrFailed
  /-- The surface is already releasing its binding. -/
  | detaching
  /-- The surface is handing its binding over to another endpoint. -/
  | replacing
  /-- Only a bound surface can be presented, or hand its binding over. -/
  | notBound
  /-- The viewport ID is blank. -/
  | invalidViewport
  /-- The surface is already visible in this viewport, or attaching there. -/
  | alreadyPresented
  /-- Its single-owner handle is already presented in another viewport. -/
  | singleOwnerElsewhere
  /-- Another surface already presents the same single-owner endpoint. -/
  | endpointPresented
  /-- The surface is not attached in the viewport, or is still attaching there. -/
  | notAttached

/-- Whether a surface may start binding (or retry after an error): refused with `disposed` on a
disposed runtime, admitted (`none`) from `unbound` or `error`, and refused with
`notUnboundOrFailed` from any other state. -/
def bindGate (disposed : Bool) (p : Presentation) : Option SurfaceRefusal :=
  if disposed then some .disposed
  else match p with
    | .unbound _ | .error => none
    | _ => some .notUnboundOrFailed

/-- What unbinding does: refuse, nothing (already unbound), or release. -/
inductive UnbindGate where
  /-- Release the binding and every attachment. -/
  | release
  /-- The surface is already unbound: nothing to do. -/
  | done
  /-- Refused, for `why`. -/
  | refuse (why : SurfaceRefusal)

/-- What unbinding a surface does: refused with `replacing` while its binding is being handed
over and with `detaching` while it is already releasing; nothing to do (`done`) when it is
unbound; otherwise `release`. -/
def unbindGate (p : Presentation) (replacing : Bool) : UnbindGate :=
  if replacing then .refuse .replacing
  else match p with
    | .detaching => .refuse .detaching
    | .unbound _ => .done
    | _ => .release

/-- What presenting a surface in a viewport depends on. -/
structure PresentFacts where
  /-- The surface runtime is disposed. -/
  disposed : Bool
  /-- The viewport ID is a non-blank string. -/
  viewportValid : Bool
  /-- The surface is handing its binding over to another endpoint. -/
  replacing : Bool
  /-- The surface's presentation state. -/
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

/-- Whether a surface may be presented in a viewport, checked in this order: refused on a disposed
runtime (`disposed`), for a blank viewport ID (`invalidViewport`), while replacing its binding
(`replacing`), when not bound (`notBound`), and when already visible or attaching in this viewport
(`alreadyPresented`). An existing hidden attachment there, or a handle that may present several
viewports, is then admitted (`none`). A single-owner handle newly attached is refused when the
surface is attached in another viewport (`singleOwnerElsewhere`) or another surface presents the
same endpoint (`endpointPresented`). The model proves a single-owner handle is never mounted
twice. -/
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

/-- Every change of state is announced. (A step that keeps its state may announce too.) -/
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
