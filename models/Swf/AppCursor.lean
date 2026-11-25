import Lungo

/-!
The reference application's wrapped cursor. In a panorama that shows the whole circle, the view's
left and right edges are the same place, the seam behind the camera. A pointer the framework took
(a window being moved, the view being turned) that is carried past one edge comes back in at the
other, and a virtual cursor shows where it is. Pointers the framework did not take, and every
pointer while the view does not show the whole circle, pass unchanged. This model decides which
pointers are taken, which samples wrap and where, and when the virtual cursor is drawn; the
application carries the samples.
-/
namespace Swf.AppCursor

/-- A pointer sample's phase. -/
inductive WrapPhase where
  /-- The pointer went down: a press, never wrapped. -/
  | down
  /-- The pointer moved. -/
  | move
  /-- The pointer was released. -/
  | up
  /-- The platform cancelled the pointer. -/
  | cancel
deriving DecidableEq

/-- What to do with a pointer sample. -/
inductive WrapOutcome where
  /-- Pass it on unchanged, with no virtual cursor. -/
  | pass
  /-- Pass it on at the wrapped horizontal place `x`, and draw the virtual cursor there when
  `cursor` (while the pointer is held; a release or cancellation ends it). -/
  | wrapped (x : Float) (cursor : Bool)
  /-- The view's width is not one a pointer can wrap across: it is not finite and above zero. -/
  | invalidWidth

/-- Where a horizontal place lands in a view `width` wide whose edges meet: in `[0, width)`. -/
def wrapAcross (x width : Float) : Float := x - width * (x / width).floor

/-- A pointer sample, wrapped across the seam when the framework took the pointer (its key is in
`taken`) and the view wraps. A press is never wrapped: it is where the pointer is taken. -/
def wrapPointerStep (taken : List String) (key : String) (phase : WrapPhase) (x width : Float)
    (wraps : Bool) : WrapOutcome :=
  if !(width > 0) || !width.isFinite then
    .invalidWidth
  else if !wraps || phase = .down || !taken.contains key then .pass
  else
    let wrapped := wrapAcross x width
    if wrapped == x then .pass else .wrapped wrapped (phase = .move)

/-- The pointers taken once the framework answered a sample of pointer `key`: a press it consumed
takes the pointer, and its release or cancellation lets it go. None when they stay as they were. -/
def wrapAfterDispatch (taken : List String) (key : String) (phase : WrapPhase) (consumed : Bool) :
    Option (List String) :=
  match phase with
  | .down => if consumed && !taken.contains key then some (taken ++ [key]) else none
  | .up | .cancel => if taken.contains key then some (taken.filter (· != key)) else none
  | .move => none

/-! ## Invariants -/

/-- A pointer the framework did not take passes unchanged, whatever the view. -/
@[lungo_claim "lungo.law" subject wrapPointerStep]
theorem untaken_passes_unchanged (taken : List String) (key : String) (phase : WrapPhase)
    (x width : Float) (wraps : Bool) (h : key ∉ taken) :
    wrapPointerStep taken key phase x width wraps = .pass ∨
      wrapPointerStep taken key phase x width wraps = .invalidWidth := by
  unfold wrapPointerStep
  split
  · exact .inr rfl
  · simp [h]

/-- No pointer wraps while the view does not show the whole circle, and no press ever wraps. -/
@[lungo_claim "lungo.law" subject wrapPointerStep]
theorem wraps_only_held_pointers_in_wrapping_views (taken : List String) (key : String)
    (phase : WrapPhase) (x width y : Float) (wraps cursor : Bool)
    (h : wrapPointerStep taken key phase x width wraps = .wrapped y cursor) :
    wraps = true ∧ phase ≠ .down ∧ key ∈ taken := by
  unfold wrapPointerStep at h
  split at h
  · cases h
  · split at h
    · cases h
    · simp_all

/-- The virtual cursor is drawn only for a held pointer that moves: a release or cancellation
lands wrapped with no cursor left drawn. -/
@[lungo_claim "lungo.law" subject wrapPointerStep]
theorem cursor_only_while_moving (taken : List String) (key : String) (phase : WrapPhase)
    (x width y : Float) (wraps : Bool)
    (h : wrapPointerStep taken key phase x width wraps = .wrapped y true) : phase = .move := by
  unfold wrapPointerStep at h
  split at h
  · cases h
  · split at h
    · cases h
    · simp only at h
      split at h
      · cases h
      · simp only [WrapOutcome.wrapped.injEq] at h
        exact of_decide_eq_true h.2

/-- A width that is not finite and above zero is refused. -/
@[lungo_claim "lungo.law" subject wrapPointerStep]
theorem invalid_width_refused (taken : List String) (key : String) (phase : WrapPhase)
    (x width : Float) (wraps : Bool) (h : !(width > 0) || !width.isFinite) :
    wrapPointerStep taken key phase x width wraps = .invalidWidth := by
  simp [wrapPointerStep, h]

/-- A pointer is taken only by a press the framework consumed. -/
@[lungo_claim "lungo.law" subject wrapAfterDispatch]
theorem taken_only_on_consumed_down (taken taken' : List String) (key k : String)
    (phase : WrapPhase) (consumed : Bool) (h : wrapAfterDispatch taken key phase consumed = some taken')
    (hk : k ∈ taken') (hnew : k ∉ taken) : phase = .down ∧ consumed = true ∧ k = key := by
  cases phase <;> simp [wrapAfterDispatch] at h
  · obtain ⟨⟨hc, -⟩, rfl⟩ := h
    simp_all
  · obtain ⟨-, rfl⟩ := h
    simp_all
  · obtain ⟨-, rfl⟩ := h
    simp_all

/-- A taken pointer is let go on its release or cancellation, and the others stay taken. -/
@[lungo_claim "lungo.law" subject wrapAfterDispatch]
theorem released_on_up_or_cancel (taken : List String) (key : String) (phase : WrapPhase)
    (consumed : Bool) (hp : phase = .up ∨ phase = .cancel) (hk : key ∈ taken) :
    ∃ taken', wrapAfterDispatch taken key phase consumed = some taken' ∧ key ∉ taken' ∧
      ∀ k ∈ taken, k ≠ key → k ∈ taken' := by
  rcases hp with rfl | rfl <;> simp_all [wrapAfterDispatch]

/-- The taken pointers stay a set: a pointer is never taken twice. -/
@[lungo_claim "lungo.law" subject wrapAfterDispatch]
theorem taken_stays_distinct (taken taken' : List String) (key : String) (phase : WrapPhase)
    (consumed : Bool) (hd : taken.Nodup) (h : wrapAfterDispatch taken key phase consumed = some taken') :
    taken'.Nodup := by
  cases phase <;> simp [wrapAfterDispatch] at h
  · obtain ⟨⟨-, hn⟩, rfl⟩ := h
    exact List.nodup_append.mpr ⟨hd, by simp, fun a ha b hb => by simp at hb; subst hb; exact fun he => hn (he ▸ ha)⟩
  · obtain ⟨-, rfl⟩ := h
    exact hd.filter _
  · obtain ⟨-, rfl⟩ := h
    exact hd.filter _

end Swf.AppCursor
