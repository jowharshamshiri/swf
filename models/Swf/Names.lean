import Lungo

/-!
Where names are written over a drawing: a window's name in the panorama, beside an arrow at the
view's edge pointing to a window out of view, or beside a mark on a map or radar.

A name is written where its box overlaps nothing already written that belongs to something else,
in the order of their importance. A box may stand for a name or for something drawn that a name
must keep clear of (a window's frame, say): such a box is one that must be written, and is written
whatever it overlaps. A name may be offered at more than one place, best first: it is written at the
first of them that is free. Each box belongs to an owner (a window, say): a name may be written over
its own owner's boxes, as a window's name over its own frame, and over no other's. A name is dropped
only where it would overlap another owner's box written before it, or where it is already written at
a better place.
-/
namespace Swf.Names

/-- A box over the drawing, in pixels: a place for a name, or something a name keeps clear of. -/
structure LabelBox where
  /-- Which name it is a place for: the places for one name share it. -/
  name : Nat
  /-- What it belongs to: a name may lie over boxes of its own owner only. -/
  owner : Nat
  x : Int
  y : Int
  width : Nat
  height : Nat
  /-- It is written whatever it overlaps. -/
  kept : Bool
deriving Inhabited, DecidableEq

/-- The second box overlaps the first. -/
def overlaps (a b : LabelBox) : Bool :=
  decide (a.x < b.x + b.width) && decide (b.x < a.x + a.width) && decide (a.y < b.y + b.height) &&
    decide (b.y < a.y + a.height)

/-- A box written before keeps this one from being written: it overlaps it and belongs to another
owner, or its name is already written there. -/
def blocks (a b : LabelBox) : Bool := (overlaps a b && a.owner != b.owner) || a.name == b.name

/-- Each box, with whether it is written, given the boxes already written. -/
def placeLabels : List LabelBox → List LabelBox → List (LabelBox × Bool)
  | _, [] => []
  | shown, b :: rest =>
    let written := b.kept || !(shown.any fun a => blocks a b)
    (b, written) :: placeLabels (if written then b :: shown else shown) rest

/-- Which places are written, in the order asked: each in turn is written when it must be, or
when no box of another owner written before it overlaps it and its name is not written already. -/
def labelsShown (boxes : Array LabelBox) : Array Bool :=
  ((placeLabels [] boxes.toList).map (·.2)).toArray

/-! ## Invariants -/

theorem placeLabels_fst (shown l : List LabelBox) : (placeLabels shown l).map (·.1) = l := by
  induction l generalizing shown with
  | nil => simp [placeLabels]
  | cons b rest ih => simp [placeLabels, ih]

theorem placeLabels_clear (shown l : List LabelBox) :
    (placeLabels shown l).Pairwise
        (fun (a b : LabelBox × Bool) => a.2 = true → b.2 = true → b.1.kept = false →
          blocks a.1 b.1 = false) ∧
      ∀ b ∈ placeLabels shown l, b.2 = true → b.1.kept = false →
        ∀ a ∈ shown, blocks a b.1 = false := by
  induction l generalizing shown with
  | nil => simp [placeLabels]
  | cons b rest ih =>
    simp only [placeLabels]
    generalize hw : (b.kept || !shown.any fun a => blocks a b) = written
    refine ⟨List.pairwise_cons.2 ⟨fun c hc ha hcs hk => ?_, (ih _).1⟩, fun c hc hcs hk a ha => ?_⟩
    · simp only at ha
      subst ha
      have := (ih (b :: shown)).2 c (by simpa using hc) hcs hk b
      exact this (List.mem_cons_self ..)
    · simp only [List.mem_cons] at hc
      rcases hc with rfl | hc
      · simp only at hcs hk
        subst hcs
        simp only [hk, Bool.false_or, Bool.not_eq_true', List.any_eq_false] at hw
        simpa using hw a ha
      · have := (ih _).2 c hc hcs hk a
        split at this
        · exact this (List.mem_cons_of_mem _ ha)
        · exact this ha

theorem placeLabels_dropped (shown l : List LabelBox) :
    ∀ pre post b, placeLabels shown l = pre ++ b :: post → b.2 = false →
      (∃ a ∈ shown, blocks a b.1 = true) ∨ ∃ a ∈ pre, a.2 = true ∧ blocks a.1 b.1 = true := by
  induction l generalizing shown with
  | nil => intro pre post b h; simp [placeLabels] at h
  | cons c rest ih =>
    intro pre post b h hb
    simp only [placeLabels] at h
    cases pre with
    | nil =>
      simp only [List.nil_append, List.cons.injEq] at h
      obtain ⟨rfl, -⟩ := h
      simp only [Bool.or_eq_false_iff, Bool.not_eq_false', List.any_eq_true] at hb
      exact .inl hb.2
    | cons x pre' =>
      simp only [List.cons_append, List.cons.injEq] at h
      obtain ⟨rfl, h⟩ := h
      rcases ih _ pre' post b h hb with ⟨a, ha, ho⟩ | ⟨a, ha, hs, ho⟩
      · split at ha
        · rename_i hw
          simp only [List.mem_cons] at ha
          rcases ha with rfl | ha
          · exact .inr ⟨_, List.mem_cons_self .., hw, ho⟩
          · exact .inl ⟨a, ha, ho⟩
        · exact .inl ⟨a, ha, ho⟩
      · exact .inr ⟨a, List.mem_cons_of_mem _ ha, hs, ho⟩

theorem labels_decided (boxes : Array LabelBox) :
    boxes.toList.zip (labelsShown boxes).toList = placeLabels [] boxes.toList := by
  have h := List.zip_unzip (placeLabels [] boxes.toList)
  simp only [List.unzip_eq_map] at h
  simp only [labelsShown, List.toList_toArray]
  conv => lhs; arg 1; rw [← placeLabels_fst [] boxes.toList]
  exact h

/-- There is an answer for every box, in the order asked. -/
@[lungo_claim "lungo.law" subject labelsShown]
theorem labels_answered (boxes : Array LabelBox) : (labelsShown boxes).size = boxes.size := by
  have := congrArg List.length (placeLabels_fst [] boxes.toList)
  simp only [List.length_map] at this
  simp [labelsShown, this]

theorem placeLabels_kept : ∀ (shown l : List LabelBox),
    ∀ b ∈ placeLabels shown l, b.1.kept = true → b.2 = true := by
  intro shown l
  induction l generalizing shown with
  | nil => simp [placeLabels]
  | cons c rest ih =>
    intro b hb hk
    simp only [placeLabels, List.mem_cons] at hb
    rcases hb with rfl | hb
    · simp only at hk
      simp [hk]
    · exact ih _ b hb hk

/-- A box that must be written always is. -/
@[lungo_claim "lungo.law" subject labelsShown]
theorem kept_written (boxes : Array LabelBox) :
    ∀ b ∈ boxes.toList.zip (labelsShown boxes).toList, b.1.kept = true → b.2 = true := by
  rw [labels_decided]
  exact placeLabels_kept _ _

/-- A place written of its own accord overlaps no box of another owner written before it, and
writes no name written before it. -/
@[lungo_claim "lungo.law" subject labelsShown]
theorem written_names_clear (boxes : Array LabelBox) :
    (boxes.toList.zip (labelsShown boxes).toList).Pairwise
      (fun (a b : LabelBox × Bool) => a.2 = true → b.2 = true → b.1.kept = false →
        (overlaps a.1 b.1 = false ∨ a.1.owner = b.1.owner) ∧ a.1.name ≠ b.1.name) := by
  rw [labels_decided]
  refine ((placeLabels_clear [] boxes.toList).1).imp fun h ha hb hk => ?_
  have := h ha hb hk
  simp only [blocks, Bool.or_eq_false_iff, Bool.and_eq_false_iff, bne_eq_false_iff_eq,
    beq_eq_false_iff_ne] at this
  exact this

/-- A place is passed over only where it would overlap a box of another owner written before it,
or where its name is written already, at a better place. -/
@[lungo_claim "lungo.law" subject labelsShown]
theorem dropped_only_on_collision (boxes : Array LabelBox) :
    ∀ pre post b, boxes.toList.zip (labelsShown boxes).toList = pre ++ b :: post → b.2 = false →
      ∃ a ∈ pre, a.2 = true ∧
        ((overlaps a.1 b.1 = true ∧ a.1.owner ≠ b.1.owner) ∨ a.1.name = b.1.name) := by
  rw [labels_decided]
  intro pre post b h hb
  rcases placeLabels_dropped [] boxes.toList pre post b h hb with ⟨a, ha, -⟩ | ⟨a, ha, hs, hx⟩
  · simp at ha
  · refine ⟨a, ha, hs, ?_⟩
    simp only [blocks, Bool.or_eq_true, Bool.and_eq_true, bne_iff_ne, ne_eq, beq_iff_eq] at hx
    exact hx

/-! ## Leaving out what cannot change the answer

A caller may leave out, before asking, a place listed after an obstacle of another owner that it
overlaps (it is never written), and an obstacle that keeps nothing listed after it from being
written: the answers for every other box are the same. -/

/-- The answers, in the order asked. -/
def answers (shown l : List LabelBox) : List Bool := (placeLabels shown l).map (·.2)

theorem answers_eq (boxes : Array LabelBox) : (labelsShown boxes).toList = answers [] boxes.toList := by
  simp [labelsShown, answers]

/-- Boxes already written that keep the same boxes of `l` from being written give the same answers
for `l`. -/
theorem answers_congr : ∀ (l s1 s0 : List LabelBox),
    (∀ c ∈ l, (s1.any fun a => blocks a c) = (s0.any fun a => blocks a c)) →
    answers s1 l = answers s0 l := by
  intro l
  induction l with
  | nil => intro s1 s0 _; simp [answers, placeLabels]
  | cons c rest ih =>
    intro s1 s0 h
    have hc := h c (List.mem_cons_self ..)
    have hr : ∀ (d : LabelBox) (t1 t0 : List LabelBox),
        (∀ x ∈ rest, (t1.any fun a => blocks a x) = (t0.any fun a => blocks a x)) →
        ∀ x ∈ rest, ((d :: t1).any fun a => blocks a x) = ((d :: t0).any fun a => blocks a x) := by
      intro d t1 t0 ht x hx
      simp [List.any_cons, ht x hx]
    have hrest : ∀ x ∈ rest, (s1.any fun a => blocks a x) = (s0.any fun a => blocks a x) :=
      fun x hx => h x (List.mem_cons_of_mem _ hx)
    simp only [answers, placeLabels, List.map_cons, hc] at ih ⊢
    cases hw : (c.kept || !s0.any fun a => blocks a c)
    · simp only [Bool.false_eq_true, ↓reduceIte]
      rw [ih s1 s0 hrest]
    · simp only [↓reduceIte]
      rw [ih (c :: s1) (c :: s0) (hr c s1 s0 hrest)]

/-- A box not written can be left out: every other box is answered as before. -/
theorem answers_skip_unwritten : ∀ (pre post shown : List LabelBox) (b : LabelBox),
    (answers shown (pre ++ b :: post))[pre.length]? = some false →
    answers shown (pre ++ post) = (answers shown (pre ++ b :: post)).eraseIdx pre.length := by
  intro pre
  induction pre with
  | nil =>
    intro post shown b h
    simp only [answers, List.nil_append, placeLabels, List.map_cons, List.length_nil,
      List.getElem?_cons_zero, Option.some.injEq] at h ⊢
    simp [h]
  | cons c pre ih =>
    intro post shown b h
    simp only [answers, List.cons_append, placeLabels, List.map_cons, List.length_cons,
      List.getElem?_cons_succ, List.eraseIdx_cons_succ] at h ⊢
    have := ih post _ b h
    simp only [answers] at this
    rw [this]

/-- A box that must be written but keeps no box listed after it from being written can be left
out: every other box is answered as before. -/
theorem answers_skip_harmless : ∀ (pre post shown : List LabelBox) (b : LabelBox),
    b.kept = true → (∀ c ∈ post, blocks b c = false) →
    answers shown (pre ++ post) = (answers shown (pre ++ b :: post)).eraseIdx pre.length := by
  intro pre
  induction pre with
  | nil =>
    intro post shown b hk hb
    simp only [answers, List.nil_append, placeLabels, hk, Bool.true_or, ↓reduceIte,
      List.map_cons, List.length_nil, List.eraseIdx_cons_zero]
    have := answers_congr post (b :: shown) shown (fun c hc => by simp [List.any_cons, hb c hc])
    simp only [answers] at this
    rw [this]
  | cons c pre ih =>
    intro post shown b hk hb
    simp only [answers, List.cons_append, placeLabels, List.map_cons, List.length_cons,
      List.eraseIdx_cons_succ]
    have := ih post (if (c.kept || !shown.any fun a => blocks a c) = true then c :: shown else shown)
      b hk hb
    simp only [answers] at this
    rw [this]

/-- A place is never written where a box already written keeps it out. -/
theorem answers_blocked : ∀ (pre post shown : List LabelBox) (k b : LabelBox),
    k ∈ shown → b.kept = false → blocks k b = true →
    (answers shown (pre ++ b :: post))[pre.length]? = some false := by
  intro pre
  induction pre with
  | nil =>
    intro post shown k b hk hn hb
    simp only [answers, List.nil_append, placeLabels, List.map_cons, List.length_nil,
      List.getElem?_cons_zero, Option.some.injEq, hn, Bool.false_or, Bool.not_eq_false',
      List.any_eq_true]
    exact ⟨k, hk, hb⟩
  | cons c pre ih =>
    intro post shown k b hk hn hb
    simp only [answers, List.cons_append, placeLabels, List.map_cons, List.length_cons,
      List.getElem?_cons_succ]
    apply ih post _ k b _ hn hb
    split
    · exact List.mem_cons_of_mem _ hk
    · exact hk

/-- A place listed after a box of another owner that must be written, and overlapping it, is never
written. -/
theorem kept_keeps_out : ∀ (pre mid post shown : List LabelBox) (k b : LabelBox),
    k.kept = true → b.kept = false → overlaps k b = true → k.owner ≠ b.owner →
    (answers shown (pre ++ k :: (mid ++ b :: post)))[pre.length + 1 + mid.length]? = some false := by
  intro pre
  induction pre with
  | nil =>
    intro mid post shown k b hk hn ho hw
    simp only [answers, List.nil_append, placeLabels, hk, Bool.true_or, ↓reduceIte,
      List.map_cons, List.length_nil, Nat.zero_add]
    rw [Nat.add_comm, List.getElem?_cons_succ]
    apply answers_blocked mid post (k :: shown) k b (List.mem_cons_self ..) hn
    simp [blocks, ho, hw]
  | cons c pre ih =>
    intro mid post shown k b hk hn ho hw
    simp only [answers, List.cons_append, placeLabels, List.map_cons, List.length_cons]
    rw [show pre.length + 1 + 1 + mid.length = (pre.length + 1 + mid.length) + 1 by omega,
      List.getElem?_cons_succ]
    exact ih mid post _ k b hk hn ho hw

end Swf.Names
