import Lungo

/-!
The reference application's wrapped cursor. In a panorama that shows the whole circle, the view's
left and right edges are the same place, the seam behind the camera. A pointer the framework took
(a window being moved, the view being turned) that is carried past one edge comes back in at the
other, and a virtual cursor shows where it is.

The platform's own pointer cannot be moved by a page and stops at the screen's edge, so a mouse
drag that reaches the view's edge asks the platform to lock the pointer to the view. While the
lock holds, the platform reports only the pointer's motion: the drag carries on from where the lock
took it, round the circle as far as the mouse goes, and the virtual cursor is the only cursor shown.
The lock lives exactly as long as the drag that asked for it: it is let go when the drag ends,
when the framework ends its gesture, and on Escape, which also ends the drag; a lock the platform
takes away ends the drag as a lost pointer does. Where the platform offers no lock or refuses it,
the drag wraps for as far as the platform's pointer goes, and stops where it stops.

Pointers the framework did not take, and every pointer while the view does not show the whole
circle, pass unchanged. A keyboard never asks for the lock: the keys that move a window or turn the
view cross the seam by themselves. This model decides which pointers are taken, which samples wrap
and where, when the lock is asked for and let go, what a lost lock ends, and when the virtual
cursor is drawn; the application carries the samples and talks to the platform.
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

/-- The view a sample lands in. -/
structure WrapFrame where
  /-- The view's width, in CSS pixels: finite and above zero. -/
  width : Float
  /-- The view's height, in CSS pixels: finite and above zero. -/
  height : Float
  /-- The view shows the whole circle with its seam at its edges, and the wrapped cursor is on. -/
  wraps : Bool
  /-- The platform offers to lock the pointer to the view. -/
  lockable : Bool

/-- A pointer sample, as the device reports it. -/
structure WrapSample where
  /-- The pointer, by its device and pointer ID. -/
  key : String
  /-- Where the pointer is in its stroke. -/
  phase : WrapPhase
  /-- The horizontal place, in CSS pixels from the view's left edge: finite. Frozen while locked. -/
  x : Float
  /-- The vertical place, in CSS pixels from the view's top edge: finite. Frozen while locked. -/
  y : Float
  /-- The horizontal motion since the previous sample, reported while the pointer is locked
  (zero otherwise): finite. -/
  dx : Float
  /-- The vertical motion since the previous sample, as `dx`: finite. -/
  dy : Float
  /-- The pointer is a mouse: the only pointer a platform locks. -/
  mouse : Bool

/-- The platform's pointer lock, as the wrapped cursor holds it. -/
inductive PointerLock where
  /-- No lock asked for or held. -/
  | free
  /-- The lock was asked for pointer `key`, which was last passed on at (`x`, `y`). -/
  | asked (key : String) (x y : Float)
  /-- The platform locked pointer `key`, whose virtual place is (`x`, `y`). -/
  | held (key : String) (x y : Float)
  /-- The platform refused the lock for pointer `key`: it is not asked for again until that
  pointer is let go. -/
  | refused (key : String)
  /-- The lock was let go; the platform has yet to say it ended. -/
  | letting

/-- The wrapped cursor's state. -/
structure CursorState where
  /-- The pointers the framework took: the ones that wrap. -/
  taken : List String
  /-- The pointer lock. -/
  lock : PointerLock
  /-- The virtual cursor is drawn. -/
  drawn : Bool
  /-- The lock took hold and no sample of its pointer has come since: the first one's motion is the
  platform's own, moving its pointer to where it holds it (Chromium to the page's corner, Firefox to
  a centre it warps to), not the person's. -/
  fresh : Bool

/-- The state before any pointer: none taken, no lock, no cursor drawn. -/
def cursorInitial : CursorState := { taken := [], lock := .free, drawn := false, fresh := false }

/-- What the application does after a step, in order. -/
inductive CursorAction where
  /-- Ask the platform to lock the pointer to the view. -/
  | request
  /-- Let the platform's lock go. -/
  | exit
  /-- Cancel pointer `key` at (`x`, `y`): its drag ends, as when the platform loses a pointer. -/
  | cancel (key : String) (x y : Float)
  /-- Draw the virtual cursor with its tip at (`x`, `y`). -/
  | show (x y : Float)
  /-- Take the virtual cursor away. -/
  | hide

/-- What a pointer sample leads to. -/
inductive SampleStep where
  /-- Pass the sample on at (`x`, `y`), then do `actions`; `state` is the cursor's after it. -/
  | next (state : CursorState) (x y : Float) (actions : List CursorAction)
  /-- The sample cannot be placed, naming the field at fault: the view's `width` or `height` is
  not finite and above zero, or the sample's `x`, `y` or `movement` is not finite. -/
  | invalid (field : String) (reason : String)

/-- What anything else that happens leads to: the cursor's state after it, and what to do. -/
structure CursorNext where
  /-- The cursor's state after it. -/
  state : CursorState
  /-- What the application does, in order. -/
  actions : List CursorAction

/-- What happens to the wrapped cursor besides a pointer sample. -/
inductive CursorEvent where
  /-- The framework answered a sample of pointer `key` in phase `phase`, consuming it or not. -/
  | dispatched (key : String) (phase : WrapPhase) (consumed : Bool)
  /-- The framework let pointer `key` go: its gesture ended (committed, cancelled, or lost). -/
  | released (key : String)
  /-- Escape was pressed, once the framework had it. -/
  | escape
  /-- The platform locked the pointer to the view. -/
  | locked
  /-- The platform refused to lock the pointer. -/
  | refusedLock
  /-- The platform's lock ended. -/
  | unlocked
  /-- The wrapped cursor is taken off the device. -/
  | closed

/-- CSS pixels from the view's edge within which a held mouse asks for the lock. Where the view
meets the screen's edge, the platform's pointer stops on the view's last pixel, at least
`width - 1` whatever the pixel ratio, so the lock is asked for on the last two pixels, and for a
pointer beyond the edge; a drag that only comes near the edge keeps the platform's pointer. -/
def lockBand : Float := 2

/-- Where a horizontal place lands in a view `width` wide whose edges meet: in `[0, width)`. -/
def wrapAcross (x width : Float) : Float := x - width * (x / width).floor

/-- A place kept within `[0, limit]`. -/
def keepWithin (v limit : Float) : Float := if v < 0 then 0 else if v > limit then limit else v

/-- A horizontal place at or beyond the view's edge band, where a held mouse asks for the lock. -/
def nearEdge (x width : Float) : Bool := x < lockBand || x ≥ width - lockBand

/-- The phase ends the pointer's stroke. -/
def WrapPhase.ends : WrapPhase → Bool
  | .up | .cancel => true
  | _ => false

/-- The cursor taken away when it is drawn. -/
def hideIf (drawn : Bool) : List CursorAction := if drawn then [.hide] else []

/-- The sample's refusal, if any: the view's width and height first, then its place, then its
motion. -/
def sampleIssue (s : WrapSample) (f : WrapFrame) : Option (String × String) :=
  if !(f.width > 0) || !f.width.isFinite then
    some ("width", "a view's width is finite and above zero")
  else if !(f.height > 0) || !f.height.isFinite then
    some ("height", "a view's height is finite and above zero")
  else if !s.x.isFinite then some ("x", "a pointer's horizontal place is finite")
  else if !s.y.isFinite then some ("y", "a pointer's vertical place is finite")
  else if !s.dx.isFinite || !s.dy.isFinite then some ("movement", "a pointer's motion is finite")
  else none

/-- The motion a sample of the locked pointer carries: none for the first after the lock took
hold, whose motion is the platform's, and its own after that. -/
def lockedMotion (st : CursorState) (s : WrapSample) : Float × Float :=
  if st.fresh then (0, 0) else (s.dx, s.dy)

/-- A sample of the locked pointer: carried on from its virtual place by its motion, round the
circle while the view wraps (kept within the view's width when it no longer does), and within the
view's height, where the virtual cursor can be seen. Its release or cancellation lets the lock go. -/
def lockedSample (st : CursorState) (s : WrapSample) (f : WrapFrame) (lx ly : Float) : SampleStep :=
  let (dx, dy) := lockedMotion st s
  let nx := if f.wraps then wrapAcross (lx + dx) f.width else keepWithin (lx + dx) f.width
  let ny := keepWithin (ly + dy) f.height
  if s.phase.ends then
    .next { st with lock := .letting, drawn := false, fresh := false } nx ny
      (.exit :: hideIf st.drawn)
  else
    .next { st with lock := .held s.key nx ny, drawn := true, fresh := false } nx ny [.show nx ny]

/-- The lock after a sample of a pointer it does not hold, and whether to ask for it: a held mouse
moving at the edge of a view that wraps asks, where the platform offers the lock and none is in
play; the stroke's end lets an asked lock of its pointer go. -/
def freeLock (st : CursorState) (s : WrapSample) (f : WrapFrame) (x : Float) :
    PointerLock × List CursorAction :=
  match st.lock with
  | .free =>
    if st.taken.contains s.key && f.wraps && f.lockable && s.mouse && s.phase == .move &&
        nearEdge s.x f.width then
      (.asked s.key x s.y, [.request])
    else (.free, [])
  | .asked k ax ay =>
    if k == s.key then (if s.phase.ends then (.letting, [.exit]) else (.asked k x s.y, []))
    else (.asked k ax ay, [])
  | other => (other, [])

/-- The virtual cursor after a sample of a pointer the lock does not hold: drawn where a moving
pointer wraps, taken away otherwise, and left alone while the lock holds another pointer, whose
cursor it is. -/
def freeCursor (st : CursorState) (s : WrapSample) (x : Float) : Bool × List CursorAction :=
  match st.lock with
  | .held _ _ _ => (st.drawn, [])
  | _ => if x != s.x && s.phase == .move then (true, [.show x s.y]) else (false, hideIf st.drawn)

/-- Where a pointer the lock does not hold is passed on: wrapped across the seam when the framework
took it and the view wraps; a press never is, being where the pointer is taken. -/
def freePlace (st : CursorState) (s : WrapSample) (f : WrapFrame) : Float :=
  if f.wraps && st.taken.contains s.key && s.phase != .down then wrapAcross s.x f.width else s.x

/-- A sample of a pointer the lock does not hold. -/
def freeSample (st : CursorState) (s : WrapSample) (f : WrapFrame) : SampleStep :=
  let x := freePlace st s f
  let lock := freeLock st s f x
  let cursor := freeCursor st s x
  .next { st with lock := lock.1, drawn := cursor.1 } x s.y (lock.2 ++ cursor.2)

/-- A pointer sample: where to pass it on, what the lock and the virtual cursor do, and the state
after it. A view's width or height that is not finite and above zero is refused first, then a
place or a motion that is not finite, whatever the pointer: none lies anywhere in the view. -/
def sampleStep (st : CursorState) (s : WrapSample) (f : WrapFrame) : SampleStep :=
  match sampleIssue s f with
  | some (field, reason) => .invalid field reason
  | none =>
    match st.lock with
    | .held k lx ly => if k == s.key then lockedSample st s f lx ly else freeSample st s f
    | _ => freeSample st s f

/-- The pointers taken once the framework answered a sample of pointer `key`: a press it consumed
takes the pointer, and its release or cancellation lets it go. -/
def takenAfter (taken : List String) (key : String) (phase : WrapPhase) (consumed : Bool) :
    List String :=
  match phase with
  | .down => if consumed && !taken.contains key then taken ++ [key] else taken
  | .up | .cancel => taken.filter (· != key)
  | .move => taken

/-- The lock when pointer `key` is let go: an asked or held lock of it is let go, and a refusal of
it is forgotten. -/
def lockLetGo (st : CursorState) (key : String) : CursorNext :=
  match st.lock with
  | .asked k _ _ | .held k _ _ =>
    if k == key then { state := { st with lock := .letting, drawn := false },
                       actions := .exit :: hideIf st.drawn }
    else { state := st, actions := [] }
  | .refused k => if k == key then { state := { st with lock := .free }, actions := [] }
                  else { state := st, actions := [] }
  | _ => { state := st, actions := [] }

/-- The lock let go by Escape: an asked or held lock is let go and its pointer's drag ended where
the pointer was. -/
def escapeStep (st : CursorState) : CursorNext :=
  match st.lock with
  | .asked k x y | .held k x y =>
    { state := { st with lock := .letting, drawn := false },
      actions := .exit :: .cancel k x y :: hideIf st.drawn }
  | _ => { state := st, actions := [] }

/-- What anything besides a pointer sample leads to. The framework's answer to a sample updates the
taken pointers, and a stroke's end forgets a refusal of its pointer. A pointer the framework lets
go lets its lock go. Escape, when the framework did not already end the drag, lets the lock go and
ends the drag. The platform's lock holds the pointer that asked for it from where it was last
passed on; a lock nobody asked for is let go. A refusal holds until its pointer is let go. A lock
the platform ends while it holds a pointer ends that pointer's drag where it is. -/
def cursorEvent (st : CursorState) : CursorEvent → CursorNext
  | .dispatched key phase consumed =>
    let st' := { st with taken := takenAfter st.taken key phase consumed }
    match st.lock with
    | .refused k =>
      if phase.ends && k == key then { state := { st' with lock := .free }, actions := [] }
      else { state := st', actions := [] }
    | _ => { state := st', actions := [] }
  | .released key => lockLetGo { st with taken := st.taken.filter (· != key) } key
  | .escape => escapeStep st
  | .locked =>
    match st.lock with
    | .asked k x y =>
      { state := { st with lock := .held k x y, drawn := true, fresh := true },
        actions := [.show x y] }
    | .held _ _ _ => { state := st, actions := [] }
    | _ => { state := { st with lock := .letting }, actions := [.exit] }
  | .refusedLock =>
    match st.lock with
    | .asked k _ _ => { state := { st with lock := .refused k }, actions := [] }
    | .letting => { state := { st with lock := .free }, actions := [] }
    | _ => { state := st, actions := [] }
  | .unlocked =>
    match st.lock with
    | .held k x y =>
      { state := { st with lock := .free, drawn := false },
        actions := .cancel k x y :: hideIf st.drawn }
    | .asked k _ _ => { state := { st with lock := .refused k }, actions := [] }
    | .letting => { state := { st with lock := .free }, actions := [] }
    | _ => { state := st, actions := [] }
  | .closed =>
    let exit := match st.lock with
      | .asked _ _ _ | .held _ _ _ | .letting => [CursorAction.exit]
      | _ => []
    { state := cursorInitial, actions := exit ++ hideIf st.drawn }

/-! ## Invariants -/

/-- The lock is asked for only by a pointer sample: nothing else that happens, a key among them,
asks for it. -/
@[lungo_claim "lungo.law" subject cursorEvent]
theorem only_samples_ask (st : CursorState) (e : CursorEvent) :
    CursorAction.request ∉ (cursorEvent st e).actions := by
  cases e <;> simp only [cursorEvent, lockLetGo, escapeStep, hideIf] <;>
    (repeat' split) <;> simp

theorem freeCursor_never_asks (st : CursorState) (s : WrapSample) (x : Float) :
    CursorAction.request ∉ (freeCursor st s x).2 := by
  unfold freeCursor hideIf; (repeat' split) <;> simp

theorem freeLock_asks (st : CursorState) (s : WrapSample) (f : WrapFrame) (x : Float)
    (hr : CursorAction.request ∈ (freeLock st s f x).2) :
    st.lock = .free ∧ s.key ∈ st.taken ∧ f.wraps = true ∧ f.lockable = true ∧ s.mouse = true ∧
      s.phase = .move ∧ nearEdge s.x f.width = true := by
  unfold freeLock at hr
  split at hr
  · rename_i hl
    split at hr
    · rename_i hc
      simp only [Bool.and_eq_true, List.contains_iff_mem, beq_iff_eq] at hc
      exact ⟨hl, hc.1.1.1.1.1, hc.1.1.1.1.2, hc.1.1.1.2, hc.1.1.2, hc.1.2, hc.2⟩
    · simp at hr
  · (repeat' split at hr) <;> simp at hr
  · simp at hr

theorem freeSample_asks (st st' : CursorState) (s : WrapSample) (f : WrapFrame) (x y : Float)
    (as : List CursorAction) (h : freeSample st s f = .next st' x y as)
    (hr : CursorAction.request ∈ as) :
    st.lock = .free ∧ s.key ∈ st.taken ∧ f.wraps = true ∧ f.lockable = true ∧ s.mouse = true ∧
      s.phase = .move ∧ nearEdge s.x f.width = true := by
  simp only [freeSample, SampleStep.next.injEq] at h
  obtain ⟨-, -, -, rfl⟩ := h
  rcases List.mem_append.mp hr with hr | hr
  · exact freeLock_asks st s f _ hr
  · exact absurd hr (freeCursor_never_asks st s _)

theorem lockedSample_actions (st st' : CursorState) (s : WrapSample) (f : WrapFrame)
    (lx ly x y : Float) (as : List CursorAction) (h : lockedSample st s f lx ly = .next st' x y as) :
    (s.phase.ends = true ∧ as = .exit :: hideIf st.drawn ∧ st'.lock = .letting ∧
        st'.drawn = false) ∨
      (s.phase.ends = false ∧ as = [.show x y] ∧ st'.lock = .held s.key x y ∧ st'.drawn = true) := by
  unfold lockedSample at h
  cases he : s.phase.ends <;> simp only [he, Bool.false_eq_true, ite_false, ite_true] at h <;>
    cases h <;> simp

theorem lockedSample_never_asks (st st' : CursorState) (s : WrapSample) (f : WrapFrame)
    (lx ly x y : Float) (as : List CursorAction) (h : lockedSample st s f lx ly = .next st' x y as) :
    CursorAction.request ∉ as := by
  rcases lockedSample_actions st st' s f lx ly x y as h with ⟨-, rfl, -⟩ | ⟨-, rfl, -⟩
  · simp [hideIf]
  · simp

/-- The lock is asked for only by a mouse the framework took, moving at the edge of a view that
wraps, where the platform offers the lock and no lock is in play. -/
@[lungo_claim "lungo.law" subject sampleStep]
theorem asks_only_at_the_edge_of_a_held_drag (st st' : CursorState) (s : WrapSample)
    (f : WrapFrame) (x y : Float) (as : List CursorAction)
    (h : sampleStep st s f = .next st' x y as) (hr : CursorAction.request ∈ as) :
    st.lock = .free ∧ s.key ∈ st.taken ∧ f.wraps = true ∧ f.lockable = true ∧ s.mouse = true ∧
      s.phase = .move ∧ nearEdge s.x f.width = true := by
  unfold sampleStep at h
  split at h
  · cases h
  · split at h
    · split at h
      · exact absurd hr (lockedSample_never_asks st st' s f _ _ x y as h)
      · exact freeSample_asks st st' s f x y as h hr
    · exact freeSample_asks st st' s f x y as h hr

/-- No lock is asked for where the platform offers none: the drag then wraps for as far as the
platform's pointer goes, and stops where it stops. -/
@[lungo_claim "lungo.law" subject sampleStep]
theorem no_lock_where_unavailable (st st' : CursorState) (s : WrapSample) (f : WrapFrame)
    (x y : Float) (as : List CursorAction) (hf : f.lockable = false)
    (h : sampleStep st s f = .next st' x y as) : CursorAction.request ∉ as := by
  intro hr
  have := (asks_only_at_the_edge_of_a_held_drag st st' s f x y as h hr).2.2.2.1
  simp_all

/-- A refused lock is not asked for again while its refusal holds, until its pointer is let go. -/
@[lungo_claim "lungo.law" subject sampleStep]
theorem refusal_holds_for_the_stroke (st st' : CursorState) (s : WrapSample) (f : WrapFrame)
    (x y : Float) (as : List CursorAction) (k : String) (hl : st.lock = .refused k)
    (h : sampleStep st s f = .next st' x y as) : CursorAction.request ∉ as := by
  intro hr
  have := (asks_only_at_the_edge_of_a_held_drag st st' s f x y as h hr).1
  simp_all

theorem sample_of_free (st st' : CursorState) (s : WrapSample) (f : WrapFrame) (x y : Float)
    (as : List CursorAction) (hl : ∀ lx ly, st.lock ≠ .held s.key lx ly)
    (h : sampleStep st s f = .next st' x y as) : freeSample st s f = .next st' x y as := by
  unfold sampleStep at h
  split at h
  · cases h
  · split at h
    · rename_i k lx ly hlk
      split at h
      · rename_i hk
        simp only [beq_iff_eq] at hk
        subst hk
        exact absurd hlk (hl lx ly)
      · exact h
    · exact h

/-- A pointer the framework did not take, that the lock does not hold, passes at its own place,
unless the sample is refused; so does every pointer while the view does not wrap. -/
@[lungo_claim "lungo.law" subject sampleStep]
theorem untaken_passes_unchanged (st st' : CursorState) (s : WrapSample) (f : WrapFrame)
    (x y : Float) (as : List CursorAction) (hk : s.key ∉ st.taken ∨ f.wraps = false)
    (hl : ∀ lx ly, st.lock ≠ .held s.key lx ly) (h : sampleStep st s f = .next st' x y as) :
    x = s.x ∧ y = s.y := by
  have h := sample_of_free st st' s f x y as hl h
  simp only [freeSample, SampleStep.next.injEq] at h
  obtain ⟨-, rfl, rfl, -⟩ := h
  refine ⟨?_, rfl⟩
  unfold freePlace
  rcases hk with hk | hk <;> simp [hk]

/-- A pointer the lock does not hold wraps only when the framework took it and the view wraps, and
never at its press. -/
@[lungo_claim "lungo.law" subject sampleStep]
theorem wraps_only_held_pointers_in_wrapping_views (st st' : CursorState) (s : WrapSample)
    (f : WrapFrame) (x y : Float) (as : List CursorAction)
    (hl : ∀ lx ly, st.lock ≠ .held s.key lx ly) (h : sampleStep st s f = .next st' x y as)
    (hx : x ≠ s.x) : f.wraps = true ∧ s.key ∈ st.taken ∧ s.phase ≠ .down := by
  have h := sample_of_free st st' s f x y as hl h
  simp only [freeSample, SampleStep.next.injEq] at h
  obtain ⟨-, rfl, -, -⟩ := h
  unfold freePlace at hx
  split at hx
  · rename_i hc
    simp only [Bool.and_eq_true, List.contains_iff_mem, bne_iff_ne, ne_eq] at hc
    exact ⟨hc.1.1, hc.1.2, hc.2⟩
  · exact absurd rfl hx

/-- While the lock holds a pointer, every sample of it that does not end its stroke draws the
virtual cursor where it is passed on, the platform's own pointer being hidden, and the lock goes on
holding it there. -/
@[lungo_claim "lungo.law" subject sampleStep]
theorem locked_pointer_draws_its_cursor (st st' : CursorState) (s : WrapSample) (f : WrapFrame)
    (x y lx ly : Float) (as : List CursorAction) (hl : st.lock = .held s.key lx ly)
    (he : s.phase.ends = false) (h : sampleStep st s f = .next st' x y as) :
    as = [.show x y] ∧ st'.lock = .held s.key x y ∧ st'.drawn = true := by
  unfold sampleStep at h
  split at h
  · cases h
  · rw [hl] at h
    simp only [beq_self_eq_true, ite_true] at h
    rcases lockedSample_actions st st' s f lx ly x y as h with ⟨he', -⟩ | ⟨-, h1, h2, h3⟩
    · simp_all
    · exact ⟨h1, h2, h3⟩

/-- Under a lock that has just taken hold, the next sample is placed whatever motion it reports:
that motion is the platform's, moving its pointer to where it holds it, so the virtual cursor stays
where the lock took hold. -/
@[lungo_claim "lungo.law" subject sampleStep]
theorem fresh_lock_takes_no_motion (st : CursorState) (s : WrapSample) (f : WrapFrame)
    (dx dy : Float) (hf : st.fresh = true) (hs : s.dx.isFinite = true ∧ s.dy.isFinite = true)
    (hd : dx.isFinite = true ∧ dy.isFinite = true) :
    sampleStep st s f = sampleStep st { s with dx := dx, dy := dy } f := by
  simp only [sampleStep, sampleIssue, hs.1, hs.2, hd.1, hd.2, Bool.not_true, Bool.false_or,
    Bool.false_eq_true, ite_false]
  split
  · rfl
  · split <;> simp [lockedSample, lockedMotion, hf, freeSample, freeLock, freeCursor, freePlace,
      nearEdge]

/-- The end of a stroke lets the lock of its pointer go, asked or held, and draws no cursor. -/
@[lungo_claim "lungo.law" subject sampleStep]
theorem stroke_end_lets_the_lock_go (st st' : CursorState) (s : WrapSample) (f : WrapFrame)
    (x y lx ly : Float) (as : List CursorAction)
    (hl : st.lock = .held s.key lx ly ∨ st.lock = .asked s.key lx ly)
    (he : s.phase.ends = true) (h : sampleStep st s f = .next st' x y as) :
    CursorAction.exit ∈ as ∧ st'.lock = .letting ∧ (∀ a b, CursorAction.show a b ∉ as) := by
  unfold sampleStep at h
  split at h
  · cases h
  · rcases hl with hl | hl
    · rw [hl] at h
      simp only [beq_self_eq_true, ite_true] at h
      rcases lockedSample_actions st st' s f lx ly x y as h with ⟨-, h1, h2, -⟩ | ⟨he', -⟩
      · subst h1
        refine ⟨by simp, h2, fun a b => ?_⟩
        simp [hideIf]
      · simp_all
    · rw [hl] at h
      simp only [freeSample, SampleStep.next.injEq] at h
      obtain ⟨rfl, -, -, rfl⟩ := h
      have hm : (s.phase == .move) = false := by
        cases hp : s.phase <;> simp_all [WrapPhase.ends]
      simp only [freeLock, freeCursor, hl, beq_self_eq_true, ite_true, he, hm, Bool.and_false,
        Bool.false_eq_true, ite_false, hideIf]
      refine ⟨by simp, by simp, fun a b => ?_⟩
      (try split) <;> simp

/-- A pointer the framework lets go keeps no lock: an asked or held lock of it is let go, and the
pointer is no longer taken. -/
@[lungo_claim "lungo.law" subject cursorEvent]
theorem released_pointer_keeps_no_lock (st : CursorState) (key : String) (x y : Float)
    (hl : st.lock = .held key x y ∨ st.lock = .asked key x y) :
    (cursorEvent st (.released key)).state.lock = .letting ∧
      CursorAction.exit ∈ (cursorEvent st (.released key)).actions ∧
      key ∉ (cursorEvent st (.released key)).state.taken := by
  rcases hl with hl | hl <;> simp [cursorEvent, lockLetGo, hl]

/-- Escape, with the lock in play, lets it go and ends the drag of the pointer it was for, where
that pointer was. -/
@[lungo_claim "lungo.law" subject cursorEvent]
theorem escape_ends_the_locked_drag (st : CursorState) (key : String) (x y : Float)
    (hl : st.lock = .held key x y ∨ st.lock = .asked key x y) :
    (cursorEvent st .escape).state.lock = .letting ∧
      (cursorEvent st .escape).actions.take 2 = [.exit, .cancel key x y] := by
  rcases hl with hl | hl <;> simp [cursorEvent, escapeStep, hl]

/-- A lock the platform ends while it holds a pointer ends that pointer's drag where it was, as a
lost pointer does, and takes the virtual cursor away. -/
@[lungo_claim "lungo.law" subject cursorEvent]
theorem lost_lock_cancels_the_drag (st : CursorState) (key : String) (x y : Float)
    (hl : st.lock = .held key x y) :
    (cursorEvent st .unlocked).state.lock = .free ∧
      (cursorEvent st .unlocked).state.drawn = false ∧
      (cursorEvent st .unlocked).actions.head? = some (.cancel key x y) := by
  simp [cursorEvent, hl]

/-- The platform's lock holds the pointer that asked for it from where it was last passed on, and
draws the virtual cursor there; a lock nobody asked for is let go. -/
@[lungo_claim "lungo.law" subject cursorEvent]
theorem lock_holds_only_what_asked (st : CursorState) :
    (∀ k x y, st.lock = .asked k x y →
      (cursorEvent st .locked).state.lock = .held k x y ∧
        (cursorEvent st .locked).actions = [.show x y]) ∧
    ((∀ k x y, st.lock ≠ .asked k x y) → (∀ k x y, st.lock ≠ .held k x y) →
      (cursorEvent st .locked).actions = [.exit]) := by
  refine ⟨fun k x y hl => by simp [cursorEvent, hl], fun ha hh => ?_⟩
  cases hl : st.lock <;> simp_all [cursorEvent]

/-- Taken off the device, the wrapped cursor lets any lock in play go, takes its cursor away, and
starts again with nothing taken. -/
@[lungo_claim "lungo.law" subject cursorEvent]
theorem closing_leaves_nothing (st : CursorState) :
    (cursorEvent st .closed).state = cursorInitial ∧
      (st.lock ≠ .free → (∀ k, st.lock ≠ .refused k) →
        CursorAction.exit ∈ (cursorEvent st .closed).actions) ∧
      (st.drawn = true → CursorAction.hide ∈ (cursorEvent st .closed).actions) := by
  refine ⟨rfl, fun hf hr => ?_, fun hd => ?_⟩
  · cases hl : st.lock <;> simp_all [cursorEvent]
  · simp [cursorEvent, hideIf, hd]

/-- A pointer is taken only by a press the framework consumed. -/
@[lungo_claim "lungo.law" subject cursorEvent]
theorem taken_only_on_consumed_down (st : CursorState) (key k : String) (phase : WrapPhase)
    (consumed : Bool) (hk : k ∈ (cursorEvent st (.dispatched key phase consumed)).state.taken)
    (hnew : k ∉ st.taken) : phase = .down ∧ consumed = true ∧ k = key := by
  have ht : (cursorEvent st (.dispatched key phase consumed)).state.taken =
      takenAfter st.taken key phase consumed := by
    simp only [cursorEvent]; (repeat' split) <;> rfl
  rw [ht] at hk
  cases phase <;> simp only [takenAfter] at hk
  · split at hk
    · rename_i hc
      have hc : consumed = true ∧ key ∉ st.taken := by simpa using hc
      rcases List.mem_append.mp hk with hk | hk
      · exact absurd hk hnew
      · simp at hk; exact ⟨rfl, hc.1, hk⟩
    · exact absurd hk hnew
  · exact absurd hk hnew
  · exact absurd (List.mem_filter.mp hk).1 hnew
  · exact absurd (List.mem_filter.mp hk).1 hnew

/-- A release or cancellation the framework answered lets its pointer go. -/
@[lungo_claim "lungo.law" subject cursorEvent]
theorem stroke_end_lets_the_pointer_go (st : CursorState) (key : String) (phase : WrapPhase)
    (consumed : Bool) (he : phase.ends = true) :
    key ∉ (cursorEvent st (.dispatched key phase consumed)).state.taken := by
  have ht : (cursorEvent st (.dispatched key phase consumed)).state.taken =
      takenAfter st.taken key phase consumed := by
    simp only [cursorEvent]; (repeat' split) <;> rfl
  rw [ht]
  cases phase <;> simp_all [takenAfter, WrapPhase.ends]

/-- The taken pointers stay a set: a pointer is never taken twice. -/
@[lungo_claim "lungo.law" subject takenAfter]
theorem taken_stays_distinct (taken : List String) (key : String) (phase : WrapPhase)
    (consumed : Bool) (hd : taken.Nodup) : (takenAfter taken key phase consumed).Nodup := by
  cases phase <;> simp only [takenAfter]
  · split
    · rename_i hc
      have hc : consumed = true ∧ key ∉ taken := by simpa using hc
      exact List.nodup_append.mpr ⟨hd, by simp, fun a ha b hb => by
        simp at hb; subst hb; exact fun he => hc.2 (he ▸ ha)⟩
    · exact hd
  · exact hd
  · exact hd.filter _
  · exact hd.filter _

/-- The wrapped cursor starts with nothing taken, no lock in play and no cursor drawn. -/
@[lungo_claim "lungo.law" subject cursorInitial]
theorem initial_holds_nothing :
    cursorInitial.taken = [] ∧ cursorInitial.lock = .free ∧ cursorInitial.drawn = false :=
  ⟨rfl, rfl, rfl⟩

end Swf.AppCursor
