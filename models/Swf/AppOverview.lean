import Lungo

/-!
The reference application's spatial overview.

The overview shows every window as a card on a board that is the whole sphere round the camera
unrolled: straight ahead in the middle, behind at both edges, overhead at the top and underfoot at
the bottom, as the panorama shows them. A card stands across the board where its window's heading
puts it, and never moves from there; down the board it stands as near its window's elevation as
the cards it would cover allow. Of two cards side by side that would come nearer than the gap, the
one whose window is higher stands above the other. The board tries each card size it is offered,
largest first, and takes the first at which every card stands on the board; when none does, it is
crowded. The application measures where each window is (the geometry); this model decides where
its card stands.

The names on the map are placed by `Swf.Names`.
-/
namespace Swf.AppOverview

/-- A window as the overview places it: where it is round the camera, in tenths of a degree. -/
structure OverviewWindow where
  /-- How far round from straight behind on the left (−180°) to the right: 0 to 3600. -/
  along : Nat
  /-- How far down from straight overhead (90° up) to straight underfoot: 0 to 1800. -/
  down : Nat
deriving Inhabited, DecidableEq

/-- The board the cards stand on, in pixels. -/
structure OverviewBoard where
  width : Nat
  height : Nat
deriving Inhabited, DecidableEq

/-- A card size the board may take, in pixels, with the least room between two cards. -/
structure OverviewSize where
  width : Nat
  height : Nat
  gap : Nat
deriving Inhabited, DecidableEq

/-- Where a window's card stands: its top-left corner on the board, in pixels. -/
structure OverviewCard where
  /-- The window's place in the windows asked about. -/
  index : Nat
  x : Int
  y : Int
deriving Inhabited, DecidableEq

/-- Where the cards stand, or why they cannot. -/
inductive OverviewAnswer where
  /-- At the size at this place in the sizes, every card stands on the board: the cards, highest
  window first. -/
  | laid (size : Nat) (cards : Array OverviewCard)
  /-- At no size offered does every card stand on the board. -/
  | crowded
  /-- The number at this field is out of range. -/
  | invalid (field : String)

/-- A whole turn, in tenths of a degree. -/
def turn : Nat := 3600

/-- From straight overhead to straight underfoot, in tenths of a degree. -/
def span : Nat := 1800

/-- Where a card's left edge stands: the share of the board's width (less a card's) that the
window's heading is of a whole turn. -/
def acrossAt (board : OverviewBoard) (s : OverviewSize) (w : OverviewWindow) : Int :=
  ((w.along * (board.width - s.width) / turn : Nat) : Int)

/-- Where a card's top edge would stand were it alone: the share of the board's height (less a
card's) that the window's elevation is of the span. -/
def idealAt (board : OverviewBoard) (s : OverviewSize) (w : OverviewWindow) : Int :=
  ((w.down * (board.height - s.height) / span : Nat) : Int)

/-- Two cards whose left edges are at `a` and `b` stand side by side, nearer than the gap. -/
def crowds (s : OverviewSize) (a b : Int) : Bool :=
  decide (a < b + s.width + s.gap) && decide (b < a + s.width + s.gap)

theorem crowds_comm (s : OverviewSize) (a b : Int) : crowds s a b = crowds s b a := by
  simp [crowds, Bool.and_comm]

/-- Lower than every card placed above it that it stands beside: as high as `y`, or just below the
lowest of those. -/
def below (s : OverviewSize) (placed : List OverviewCard) (x y : Int) : Int :=
  placed.foldl (fun acc p => if crowds s p.x x then max acc (p.y + s.height + s.gap) else acc) y

/-- The cards placed from the highest window down, each pushed below those it stands beside. -/
def downward (s : OverviewSize) (cards : List OverviewCard) : List OverviewCard :=
  cards.foldl (fun placed c => placed ++ [{ c with y := below s placed c.x c.y }]) []

/-- Higher than every card below it that it stands beside: as low as `y`, or just above the highest
of those. -/
def above (s : OverviewSize) (later : List OverviewCard) (x y : Int) : Int :=
  later.foldl (fun acc p => if crowds s p.x x then min acc (p.y - s.height - s.gap) else acc) y

/-- The cards settled from the lowest window up, each kept on the board (`limit` high) and lifted
above those below it that it stands beside. -/
def upward (s : OverviewSize) (limit : Int) : List OverviewCard → List OverviewCard
  | [] => []
  | c :: rest =>
    let later := upward s limit rest
    { c with y := above s later c.x (min c.y (limit - s.height)) } :: later

/-- The order the cards are placed in: the higher window first (the stable sort keeps the order of
the windows asked about between windows as high as each other). -/
def higher (windows : Array OverviewWindow) (i j : Nat) : Bool :=
  decide (windows[i]!.down ≤ windows[j]!.down)

/-- Every card at one size, highest window first. -/
def layAt (board : OverviewBoard) (windows : Array OverviewWindow) (s : OverviewSize) :
    List OverviewCard :=
  let order := (List.range windows.size).mergeSort (higher windows)
  let start := order.map fun i =>
    { index := i, x := acrossAt board s windows[i]!, y := idealAt board s windows[i]! }
  upward s board.height (downward s start)

/-- A size a card may take on the board: some, and no larger than the board. -/
def sizeOk (board : OverviewBoard) (s : OverviewSize) : Bool :=
  decide (0 < s.width) && decide (0 < s.height) && decide (s.width ≤ board.width) &&
    decide (s.height ≤ board.height)

/-- Every card stands on the board: none above its top. -/
def standsOn (cards : List OverviewCard) : Bool := cards.all fun c => decide (0 ≤ c.y)

/-- The board is laid at this size. -/
def laysAt (board : OverviewBoard) (windows : Array OverviewWindow) (s : OverviewSize) : Bool :=
  sizeOk board s && standsOn (layAt board windows s)

/-- The first size, from the `k`th on, at which the board is laid. -/
def firstSize (board : OverviewBoard) (windows : Array OverviewWindow) :
    List OverviewSize → Nat → Option (Nat × OverviewSize)
  | [], _ => none
  | s :: rest, k => if laysAt board windows s then some (k, s) else firstSize board windows rest (k + 1)

/-- The first field whose number is out of range, if any. -/
def overviewInvalid (windows : Array OverviewWindow) (sizes : Array OverviewSize) : Option String :=
  match (List.range windows.size).find? (fun i => !(decide (windows[i]!.along ≤ turn))) with
  | some i => some s!"windows[{i}].along"
  | none =>
    match (List.range windows.size).find? (fun i => !(decide (windows[i]!.down ≤ span))) with
    | some i => some s!"windows[{i}].down"
    | none => if sizes.isEmpty then some "sizes" else none

/-- Where every window's card stands on the board, at the largest size offered that holds them. -/
def overviewLayout (board : OverviewBoard) (windows : Array OverviewWindow)
    (sizes : Array OverviewSize) : OverviewAnswer :=
  match overviewInvalid windows sizes with
  | some field => .invalid field
  | none =>
    match firstSize board windows sizes.toList 0 with
    | some (k, s) => .laid k (layAt board windows s).toArray
    | none => .crowded

/-! ## Invariants of the overview -/

theorem below_ge (s : OverviewSize) (placed : List OverviewCard) (x y : Int) :
    y ≤ below s placed x y := by
  unfold below
  induction placed generalizing y with
  | nil => simp
  | cons p ps ih =>
    simp only [List.foldl_cons]
    split
    · exact Int.le_trans (Int.le_max_left _ _) (ih _)
    · exact ih _

theorem above_le (s : OverviewSize) (later : List OverviewCard) (x y : Int) :
    above s later x y ≤ y := by
  unfold above
  induction later generalizing y with
  | nil => simp
  | cons p ps ih =>
    simp only [List.foldl_cons]
    split
    · exact Int.le_trans (ih _) (Int.min_le_left _ _)
    · exact ih _

/-- A card lifted above those below it stands clear above each it stands beside. -/
theorem above_clear (s : OverviewSize) (later : List OverviewCard) (x y : Int) :
    ∀ q ∈ later, crowds s q.x x = true → above s later x y + s.height + s.gap ≤ q.y := by
  unfold above
  induction later generalizing y with
  | nil => simp
  | cons p ps ih =>
    intro q hq hc
    simp only [List.foldl_cons]
    simp only [List.mem_cons] at hq
    rcases hq with rfl | hq
    · simp only [hc, ite_true]
      have h := above_le s ps x (min y (q.y - s.height - s.gap))
      unfold above at h
      have := Int.min_le_right y (q.y - s.height - s.gap)
      omega
    · split
      · exact ih _ q hq hc
      · exact ih _ q hq hc

theorem upward_keeps (s : OverviewSize) (limit : Int) (l : List OverviewCard) :
    (upward s limit l).map (fun c => (c.index, c.x)) = l.map (fun c => (c.index, c.x)) := by
  induction l with
  | nil => simp [upward]
  | cons c rest ih => simp [upward, ih]

theorem downward_keeps (s : OverviewSize) (l : List OverviewCard) :
    (downward s l).map (fun c => (c.index, c.x)) = l.map (fun c => (c.index, c.x)) := by
  unfold downward
  suffices h : ∀ acc : List OverviewCard,
      (l.foldl (fun placed c => placed ++ [{ c with y := below s placed c.x c.y }]) acc).map
          (fun c => (c.index, c.x)) =
        acc.map (fun c => (c.index, c.x)) ++ l.map (fun c => (c.index, c.x)) by
    simpa using h []
  induction l with
  | nil => simp
  | cons c rest ih =>
    intro acc
    simp only [List.foldl_cons, ih, List.map_append, List.map_cons, List.map_nil,
      List.append_assoc, List.cons_append, List.nil_append]

/-- Settled from the lowest up, no two cards side by side come nearer than the gap, and of two
such the earlier stands above. -/
theorem upward_clear (s : OverviewSize) (limit : Int) (l : List OverviewCard) :
    (upward s limit l).Pairwise
      (fun (p q : OverviewCard) => crowds s p.x q.x = true → p.y + s.height + s.gap ≤ q.y) := by
  induction l with
  | nil => simp [upward]
  | cons c rest ih =>
    simp only [upward, List.pairwise_cons]
    refine ⟨fun q hq hc => ?_, ih⟩
    exact above_clear s _ c.x _ q hq (by rw [crowds_comm]; exact hc)

/-- Every card settled stands no lower than the board's foot. -/
theorem upward_within (s : OverviewSize) (limit : Int) (l : List OverviewCard) :
    ∀ p ∈ upward s limit l, p.y + s.height ≤ limit := by
  induction l with
  | nil => simp [upward]
  | cons c rest ih =>
    intro p hp
    simp only [upward, List.mem_cons] at hp
    rcases hp with rfl | hp
    · have h1 := above_le s (upward s limit rest) c.x (min c.y (limit - s.height))
      have h2 := Int.min_le_right c.y (limit - s.height)
      simp only
      omega
    · exact ih p hp

theorem higher_trans (windows : Array OverviewWindow) (a b c : Nat) :
    higher windows a b = true → higher windows b c = true → higher windows a c = true := by
  simp only [higher, decide_eq_true_eq]
  exact Nat.le_trans

theorem higher_total (windows : Array OverviewWindow) (a b : Nat) :
    (higher windows a b || higher windows b a) = true := by
  simp only [higher, Bool.or_eq_true, decide_eq_true_eq]
  exact Nat.le_total _ _

/-- The cards at a size, as windows and where across they stand: one for each window asked about,
highest first. -/
theorem layAt_keeps (board : OverviewBoard) (windows : Array OverviewWindow) (s : OverviewSize) :
    (layAt board windows s).map (fun c => (c.index, c.x)) =
      ((List.range windows.size).mergeSort (higher windows)).map
        (fun i => (i, acrossAt board s windows[i]!)) := by
  simp only [layAt, upward_keeps, downward_keeps, List.map_map]
  rfl

theorem layAt_index (board : OverviewBoard) (windows : Array OverviewWindow) (s : OverviewSize) :
    (layAt board windows s).map (·.index) =
      (List.range windows.size).mergeSort (higher windows) := by
  have h := congrArg (List.map Prod.fst) (layAt_keeps board windows s)
  simpa [List.map_map, Function.comp_def] using h

theorem layAt_across (board : OverviewBoard) (windows : Array OverviewWindow) (s : OverviewSize) :
    ∀ p ∈ layAt board windows s, p.x = acrossAt board s windows[p.index]! := by
  intro p hp
  have hm : (p.index, p.x) ∈ (layAt board windows s).map (fun c => (c.index, c.x)) :=
    List.mem_map.2 ⟨p, hp, rfl⟩
  rw [layAt_keeps] at hm
  obtain ⟨i, -, he⟩ := List.mem_map.1 hm
  simp only [Prod.mk.injEq] at he
  obtain ⟨h1, h2⟩ := he
  subst h1
  exact h2.symm

theorem firstSize_spec (board : OverviewBoard) (windows : Array OverviewWindow) :
    ∀ (l : List OverviewSize) (k₀ k : Nat) (s : OverviewSize),
      firstSize board windows l k₀ = some (k, s) →
        k₀ ≤ k ∧ l[k - k₀]? = some s ∧ laysAt board windows s = true ∧
          ∀ j < k - k₀, ∀ t, l[j]? = some t → laysAt board windows t = false := by
  intro l
  induction l with
  | nil => intro k₀ k s h; simp [firstSize] at h
  | cons t rest ih =>
    intro k₀ k s h
    simp only [firstSize] at h
    split at h
    · rename_i hl
      simp only [Option.some.injEq, Prod.mk.injEq] at h
      obtain ⟨rfl, rfl⟩ := h
      exact ⟨Nat.le_refl _, by simp, hl, fun j hj => absurd hj (by omega)⟩
    · rename_i hl
      obtain ⟨hk, hs, hlays, hfirst⟩ := ih (k₀ + 1) k s h
      refine ⟨by omega, ?_, hlays, ?_⟩
      · have : k - k₀ = (k - (k₀ + 1)) + 1 := by omega
        rw [this]
        simpa using hs
      · intro j hj u hu
        cases j with
        | zero => simp at hu; subst hu; simpa using hl
        | succ j => exact hfirst j (by omega) u (by simpa using hu)

theorem firstSize_none (board : OverviewBoard) (windows : Array OverviewWindow) :
    ∀ (l : List OverviewSize) (k₀ : Nat), firstSize board windows l k₀ = none →
      ∀ t ∈ l, laysAt board windows t = false := by
  intro l
  induction l with
  | nil => simp
  | cons t rest ih =>
    intro k₀ h u hu
    simp only [firstSize] at h
    split at h
    · cases h
    · rename_i hl
      simp only [List.mem_cons] at hu
      rcases hu with rfl | hu
      · simpa using hl
      · exact ih (k₀ + 1) h u hu

theorem overviewLayout_laid {board : OverviewBoard} {windows : Array OverviewWindow}
    {sizes : Array OverviewSize} {k : Nat} {cards : Array OverviewCard}
    (h : overviewLayout board windows sizes = .laid k cards) :
    overviewInvalid windows sizes = none ∧ ∃ s, sizes[k]? = some s ∧
      cards.toList = layAt board windows s ∧ laysAt board windows s = true ∧
      ∀ j < k, ∀ t, sizes[j]? = some t → laysAt board windows t = false := by
  unfold overviewLayout at h
  cases hv : overviewInvalid windows sizes with
  | some f => simp [hv] at h
  | none =>
    simp only [hv] at h
    cases hf : firstSize board windows sizes.toList 0 with
    | none => simp [hf] at h
    | some ks =>
      obtain ⟨k', s⟩ := ks
      simp only [hf, OverviewAnswer.laid.injEq] at h
      obtain ⟨rfl, rfl⟩ := h
      obtain ⟨-, hs, hl, hfirst⟩ := firstSize_spec board windows sizes.toList 0 k' s hf
      refine ⟨rfl, s, by simpa using hs, by simp, hl, fun j hj t ht => hfirst j (by omega) t ?_⟩
      simpa using ht

theorem invalid_none_along {windows : Array OverviewWindow} {sizes : Array OverviewSize}
    (h : overviewInvalid windows sizes = none) : ∀ i < windows.size, windows[i]!.along ≤ turn := by
  intro i hi
  unfold overviewInvalid at h
  split at h
  · cases h
  · rename_i hn
    have := List.find?_eq_none.1 hn i (List.mem_range.2 hi)
    simpa using this

theorem invalid_none_down {windows : Array OverviewWindow} {sizes : Array OverviewSize}
    (h : overviewInvalid windows sizes = none) : ∀ i < windows.size, windows[i]!.down ≤ span := by
  intro i hi
  unfold overviewInvalid at h
  split at h
  · cases h
  · split at h
    · cases h
    · rename_i hn
      have := List.find?_eq_none.1 hn i (List.mem_range.2 hi)
      simpa using this

/-- Every window has one card, and only the windows asked about have one. -/
@[lungo_claim "lungo.law" subject overviewLayout]
theorem every_window_once (board : OverviewBoard) (windows : Array OverviewWindow)
    (sizes : Array OverviewSize) (k : Nat) (cards : Array OverviewCard)
    (h : overviewLayout board windows sizes = .laid k cards) :
    (cards.toList.map (·.index)).Perm (List.range windows.size) := by
  obtain ⟨-, s, -, hc, -⟩ := overviewLayout_laid h
  rw [hc, layAt_index]
  exact List.mergeSort_perm _ _

/-- A card stands across the board exactly where its window's heading puts it. -/
@[lungo_claim "lungo.law" subject overviewLayout]
theorem card_at_heading (board : OverviewBoard) (windows : Array OverviewWindow)
    (sizes : Array OverviewSize) (k : Nat) (cards : Array OverviewCard)
    (h : overviewLayout board windows sizes = .laid k cards) :
    ∃ s, sizes[k]? = some s ∧ ∀ p ∈ cards.toList, p.x = acrossAt board s windows[p.index]! := by
  obtain ⟨-, s, hs, hc, -⟩ := overviewLayout_laid h
  exact ⟨s, hs, by rw [hc]; exact layAt_across board windows s⟩

/-- No two cards side by side come nearer than the gap: of two such, the card listed first stands
wholly above the other, the gap between them. -/
@[lungo_claim "lungo.law" subject overviewLayout]
theorem cards_never_overlap (board : OverviewBoard) (windows : Array OverviewWindow)
    (sizes : Array OverviewSize) (k : Nat) (cards : Array OverviewCard)
    (h : overviewLayout board windows sizes = .laid k cards) :
    ∃ s, sizes[k]? = some s ∧ cards.toList.Pairwise
      (fun (p q : OverviewCard) => crowds s p.x q.x = true → p.y + s.height + s.gap ≤ q.y) := by
  obtain ⟨-, s, hs, hc, -⟩ := overviewLayout_laid h
  exact ⟨s, hs, by rw [hc]; exact upward_clear _ _ _⟩

/-- The cards are listed highest window first: of two cards side by side, the higher window's
stands above. -/
@[lungo_claim "lungo.law" subject overviewLayout]
theorem higher_window_above (board : OverviewBoard) (windows : Array OverviewWindow)
    (sizes : Array OverviewSize) (k : Nat) (cards : Array OverviewCard)
    (h : overviewLayout board windows sizes = .laid k cards) :
    cards.toList.Pairwise (fun p q => windows[p.index]!.down ≤ windows[q.index]!.down) := by
  obtain ⟨-, s, -, hc, -⟩ := overviewLayout_laid h
  rw [hc]
  have hp := List.pairwise_mergeSort (higher_trans windows) (higher_total windows)
    (List.range windows.size)
  rw [← layAt_index board windows s] at hp
  have := List.pairwise_map.1 hp
  exact this.imp fun hpq => by simpa [higher] using hpq

theorem acrossAt_within (board : OverviewBoard) (s : OverviewSize) (w : OverviewWindow)
    (hw : w.along ≤ turn) (hs : s.width ≤ board.width) :
    0 ≤ acrossAt board s w ∧ acrossAt board s w + s.width ≤ board.width := by
  unfold acrossAt
  refine ⟨Int.natCast_nonneg _, ?_⟩
  have h : w.along * (board.width - s.width) / turn ≤ board.width - s.width := by
    apply Nat.div_le_of_le_mul
    exact Nat.mul_le_mul_right _ hw
  have h' : ((w.along * (board.width - s.width) / turn : Nat) : Int) + s.width ≤ board.width := by
    omega
  exact h'

/-- Every card stands wholly on the board. -/
@[lungo_claim "lungo.law" subject overviewLayout]
theorem cards_on_board (board : OverviewBoard) (windows : Array OverviewWindow)
    (sizes : Array OverviewSize) (k : Nat) (cards : Array OverviewCard)
    (h : overviewLayout board windows sizes = .laid k cards) :
    ∃ s, sizes[k]? = some s ∧ ∀ p ∈ cards.toList,
      0 ≤ p.x ∧ p.x + s.width ≤ board.width ∧ 0 ≤ p.y ∧ p.y + s.height ≤ board.height := by
  obtain ⟨hv, s, hs, hc, hl, -⟩ := overviewLayout_laid h
  refine ⟨s, hs, fun p hp => ?_⟩
  rw [hc] at hp
  simp only [laysAt, sizeOk, standsOn, Bool.and_eq_true, decide_eq_true_eq, List.all_eq_true]
    at hl
  obtain ⟨⟨⟨⟨-, -⟩, hwid⟩, -⟩, hon⟩ := hl
  have hidx : p.index < windows.size := by
    have hm : p.index ∈ (layAt board windows s).map (·.index) := List.mem_map.2 ⟨p, hp, rfl⟩
    rw [layAt_index] at hm
    exact List.mem_range.1 (List.mem_mergeSort.1 hm)
  have hx := layAt_across board windows s p hp
  obtain ⟨h0, h1⟩ := acrossAt_within board s windows[p.index]! (invalid_none_along hv _ hidx) hwid
  refine ⟨by omega, by omega, hon p hp, ?_⟩
  exact upward_within s board.height _ p hp

/-- The board is laid at the first size offered at which every card stands on it: at no larger
size offered before it does every card. -/
@[lungo_claim "lungo.law" subject overviewLayout]
theorem largest_size_that_holds (board : OverviewBoard) (windows : Array OverviewWindow)
    (sizes : Array OverviewSize) (k : Nat) (cards : Array OverviewCard)
    (h : overviewLayout board windows sizes = .laid k cards) :
    ∀ j < k, ∀ t, sizes[j]? = some t → laysAt board windows t = false := by
  obtain ⟨-, -, -, -, -, hfirst⟩ := overviewLayout_laid h
  exact hfirst

/-- The board is crowded only when no size offered holds every card. -/
@[lungo_claim "lungo.law" subject overviewLayout]
theorem crowded_only_when_none_holds (board : OverviewBoard) (windows : Array OverviewWindow)
    (sizes : Array OverviewSize) (h : overviewLayout board windows sizes = .crowded) :
    ∀ t ∈ sizes.toList, laysAt board windows t = false := by
  unfold overviewLayout at h
  split at h
  · cases h
  · split at h
    · cases h
    · rename_i hf
      exact firstSize_none board windows sizes.toList 0 hf

/-- A heading or elevation out of range, or no size to try, is refused, naming it. -/
@[lungo_claim "lungo.law" subject overviewLayout]
theorem out_of_range_refused (board : OverviewBoard) (windows : Array OverviewWindow)
    (sizes : Array OverviewSize) (field : String) (h : overviewInvalid windows sizes = some field) :
    overviewLayout board windows sizes = .invalid field := by
  simp [overviewLayout, h]

end Swf.AppOverview
