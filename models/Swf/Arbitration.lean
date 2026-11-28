import Lungo
import Swf.Order

/-!
Picking arbitration: which hit under a pointer is the target, and which gesture wins a press. The
hits a ray makes are merged (a window's frame counts inside it only where none of its surfaces
covers it, and a surface only where its window's resize band and title bar do not lie over it),
marked occluded when a nearer occluding hit lies in front (a title bar never is: title bars are drawn
over every card), and ordered by presentation priority, then title bars before everything else,
then occlusion, depth, region and identity; the first is the target, ambiguous when the next is
another window that ties with it. Among the gestures the
policies bid for a press, the highest priority wins, then the lower policy ID. Priorities, distances
and the depth tolerance are compared by order keys (`Swf.Order`), so a number that is not finite is
refused before anything is ordered. The interaction layer intersects the geometry; this model
decides.
-/
namespace Swf.Arbitration

open Swf.Order

/-- A lexicographic sort key: lower sorts first, component by component. -/
structure SortKey where
  p : Int
  o : Nat
  d : Int
  r : Nat
  id : String

def keyLe (a b : SortKey) : Bool :=
  if a.p = b.p then
    if a.o = b.o then
      if a.d = b.d then
        if a.r = b.r then decide (a.id ≤ b.id) else decide (a.r < b.r)
      else decide (a.d < b.d)
    else decide (a.o < b.o)
  else decide (a.p < b.p)

theorem keyLe_refl (a : SortKey) : keyLe a a = true := by
  simp [keyLe]

theorem keyLe_trans (a b c : SortKey) (h1 : keyLe a b = true) (h2 : keyLe b c = true) :
    keyLe a c = true := by
  simp only [keyLe] at *
  by_cases p1 : a.p = b.p <;> by_cases p2 : b.p = c.p <;>
  by_cases o1 : a.o = b.o <;> by_cases o2 : b.o = c.o <;>
  by_cases d1 : a.d = b.d <;> by_cases d2 : b.d = c.d <;>
  by_cases r1 : a.r = b.r <;> by_cases r2 : b.r = c.r <;>
  simp_all <;> (try omega) <;> (try exact String.le_trans h1 h2) <;> split <;> omega

theorem keyLe_total (a b : SortKey) : (keyLe a b || keyLe b a) = true := by
  simp only [keyLe, Bool.or_eq_true]
  by_cases p : a.p = b.p
  · by_cases o : a.o = b.o
    · by_cases d : a.d = b.d
      · by_cases r : a.r = b.r
        · simp [p, o, d, r, String.le_total]
        · simp [p, o, d, r, Eq.comm]; omega
      · simp [p, o, d, Eq.comm]; omega
    · simp [p, o, Eq.comm]; omega
  · simp [p, Eq.comm]; omega

/-- `xs` sorted by the key of each index, smallest first, ties in their given order. -/
def sortBy (key : Nat → SortKey) (xs : List Nat) : List Nat :=
  xs.mergeSort (fun i j => keyLe (key i) (key j))

theorem sortBy_sorted (key : Nat → SortKey) (xs : List Nat) :
    (sortBy key xs).Pairwise (fun i j => keyLe (key i) (key j) = true) :=
  List.pairwise_mergeSort (fun a b c h1 h2 => keyLe_trans (key a) (key b) (key c) h1 h2)
    (fun a b => keyLe_total (key a) (key b)) xs

/-- The head of a sorted list sorts before (or with) every member of the list. -/
theorem sortBy_head_first (key : Nat → SortKey) (xs : List Nat) (h : Nat)
    (hh : (sortBy key xs).head? = some h) : ∀ j ∈ xs, keyLe (key h) (key j) = true := by
  intro j hj
  have hperm := List.mergeSort_perm xs (fun i j => keyLe (key i) (key j))
  have hs := sortBy_sorted key xs
  cases hl : sortBy key xs with
  | nil => simp [hl] at hh
  | cons x rest =>
    simp [hl] at hh
    subst hh
    have hmem : j ∈ sortBy key xs := (hperm.mem_iff).mpr hj
    rw [hl] at hmem hs
    cases List.mem_cons.mp hmem with
    | inl e => subst e; exact keyLe_refl _
    | inr hr => exact (List.pairwise_cons.mp hs).1 j hr

/-! ## The gesture arena -/

/-- The gesture a bid is for. -/
inductive BidKind where
  /-- A drag: it competes once a pressed pointer moves beyond the slop. -/
  | drag
  /-- A tap: it competes when the pointers lift before any drag. -/
  | tap
deriving DecidableEq, Inhabited

/-- A policy's bid for the pressed pointers. -/
structure Bid where
  /-- The gesture it bids for. -/
  kind : BidKind
  /-- How many pointers its gesture takes: it competes only when exactly that many are pressed. -/
  pointers : Nat
  /-- The bidding policy's priority: a finite number, higher winning. -/
  priority : Float
  /-- The bidding policy's ID, which breaks ties of priority: the lower wins. -/
  policy : String
deriving Inhabited

/-- Higher priority first, then the lower policy ID. -/
def bidKey (b : Bid) : SortKey := ⟨-floatKey b.priority, 0, 0, 0, b.policy⟩

def eligibleBid (bids : Array Bid) (kind : BidKind) (pointers : Nat) (i : Nat) : Bool :=
  (bids[i]!).kind = kind && (bids[i]!).pointers = pointers

/-- The first-ranked bid of a kind for a pointer count, by order key of priority, then policy ID,
or none when no bid is of that kind and count. The keys order priorities only when they are
finite: `bestBid` checks them first. -/
def rankedBid (bids : Array Bid) (kind : BidKind) (pointers : Nat) : Option Nat :=
  (sortBy (fun i => bidKey bids[i]!)
    ((List.range bids.size).filter (eligibleBid bids kind pointers))).head?

/-- The first-ranked bid is of the kind and pointer count asked for. -/
theorem ranked_eligible (bids : Array Bid) (kind : BidKind) (pointers : Nat) (i : Nat)
    (h : rankedBid bids kind pointers = some i) :
    i < bids.size ∧ (bids[i]!).kind = kind ∧ (bids[i]!).pointers = pointers := by
  have hmem : i ∈ (List.range bids.size).filter (eligibleBid bids kind pointers) := by
    have hperm := List.mergeSort_perm ((List.range bids.size).filter (eligibleBid bids kind pointers))
      (fun i j => keyLe (bidKey bids[i]!) (bidKey bids[j]!))
    have : i ∈ sortBy (fun i => bidKey bids[i]!) ((List.range bids.size).filter (eligibleBid bids kind pointers)) :=
      List.mem_of_head? h
    exact hperm.mem_iff.mp this
  simp [eligibleBid] at hmem
  exact ⟨hmem.1, hmem.2.1, hmem.2.2⟩

/-- No eligible bid ranks before the first-ranked one. -/
theorem ranked_first (bids : Array Bid) (kind : BidKind) (pointers : Nat) (i : Nat)
    (h : rankedBid bids kind pointers = some i) (j : Nat) (hj : j < bids.size)
    (he : eligibleBid bids kind pointers j = true) :
    keyLe (bidKey bids[i]!) (bidKey bids[j]!) = true :=
  sortBy_head_first _ _ i h j (by simp [hj, he])

/-- There is a first-ranked bid exactly when some bid is eligible. -/
theorem ranked_exists_iff (bids : Array Bid) (kind : BidKind) (pointers : Nat) :
    (rankedBid bids kind pointers).isSome = true ↔
      ∃ j, j < bids.size ∧ eligibleBid bids kind pointers j = true := by
  simp only [rankedBid, sortBy, Option.isSome_iff_exists]
  constructor
  · rintro ⟨i, hi⟩
    have hperm := List.mergeSort_perm ((List.range bids.size).filter (eligibleBid bids kind pointers))
      (fun i j => keyLe (bidKey bids[i]!) (bidKey bids[j]!))
    have := hperm.mem_iff.mp (List.mem_of_head? hi)
    simp at this
    exact ⟨i, this.1, this.2⟩
  · rintro ⟨j, hj, he⟩
    have hmem : j ∈ (List.range bids.size).filter (eligibleBid bids kind pointers) := by simp [hj, he]
    have hperm := List.mergeSort_perm ((List.range bids.size).filter (eligibleBid bids kind pointers))
      (fun i j => keyLe (bidKey bids[i]!) (bidKey bids[j]!))
    have hne : ((List.range bids.size).filter (eligibleBid bids kind pointers)).mergeSort
        (fun i j => keyLe (bidKey bids[i]!) (bidKey bids[j]!)) ≠ [] := by
      intro he'; have := hperm.mem_iff.mpr hmem; rw [he'] at this; simp at this
    cases hl : ((List.range bids.size).filter (eligibleBid bids kind pointers)).mergeSort
        (fun i j => keyLe (bidKey bids[i]!) (bidKey bids[j]!)) with
    | nil => exact absurd hl hne
    | cons x _ => exact ⟨x, rfl⟩

/-- What the arena decides for a press. -/
inductive BidOutcome where
  /-- The bid at `bid` wins. -/
  | winner (bid : Nat)
  /-- No bid is of the kind and pointer count asked for. -/
  | noBid
  /-- The bid at `bid`, the first whose priority is not finite, cannot be ranked: the press is
  refused, whatever the other bids. -/
  | invalidPriority (bid : Nat)

/-- The first bid whose priority is not finite, if any. -/
def firstNonFiniteBid (bids : Array Bid) : Option Nat :=
  (List.range bids.size).find? (fun i => !(bids[i]!).priority.isFinite)

/-- The winning bid of a kind for a pointer count. Priorities are compared by their order keys,
which order only finite numbers (`Swf.Order`): a bid whose priority is not finite, of any kind
and count, is refused (`invalidPriority`, naming the first). Otherwise the highest priority
wins, then the lower policy ID; `noBid` when no bid is of that kind and count. -/
def bestBid (bids : Array Bid) (kind : BidKind) (pointers : Nat) : BidOutcome :=
  match firstNonFiniteBid bids with
  | some i => .invalidPriority i
  | none =>
    match rankedBid bids kind pointers with
    | some i => .winner i
    | none => .noBid

theorem firstNonFiniteBid_none (bids : Array Bid) :
    firstNonFiniteBid bids = none ↔ ∀ j < bids.size, (bids[j]!).priority.isFinite = true := by
  simp [firstNonFiniteBid]

theorem bestBid_winner {bids : Array Bid} {kind : BidKind} {pointers i : Nat}
    (h : bestBid bids kind pointers = .winner i) :
    rankedBid bids kind pointers = some i ∧ firstNonFiniteBid bids = none := by
  unfold bestBid at h
  split at h
  · cases h
  · rename_i hn
    split at h
    · cases h; exact ⟨by assumption, hn⟩
    · cases h

/-- The winner is a bid of the kind and pointer count asked for, and every bid's priority is
finite. -/
@[lungo_claim "lungo.law" subject bestBid]
theorem winner_eligible (bids : Array Bid) (kind : BidKind) (pointers : Nat) (i : Nat)
    (h : bestBid bids kind pointers = .winner i) :
    i < bids.size ∧ (bids[i]!).kind = kind ∧ (bids[i]!).pointers = pointers ∧
      ∀ j < bids.size, (bids[j]!).priority.isFinite = true := by
  obtain ⟨hr, hn⟩ := bestBid_winner h
  exact ⟨(ranked_eligible _ _ _ _ hr).1, (ranked_eligible _ _ _ _ hr).2.1,
    (ranked_eligible _ _ _ _ hr).2.2, (firstNonFiniteBid_none bids).mp hn⟩

/-- No eligible bid outranks the winner: it has the highest priority among them, and the lowest
policy ID among those of that priority. -/
@[lungo_claim "lungo.law" subject bestBid]
theorem winner_ranks_first (bids : Array Bid) (kind : BidKind) (pointers : Nat) (i : Nat)
    (h : bestBid bids kind pointers = .winner i) (j : Nat) (hj : j < bids.size)
    (he : eligibleBid bids kind pointers j = true) :
    keyLe (bidKey bids[i]!) (bidKey bids[j]!) = true :=
  ranked_first bids kind pointers i (bestBid_winner h).1 j hj he

/-- There is a winner exactly when every bid's priority is finite and some bid is eligible. -/
@[lungo_claim "lungo.law" subject bestBid]
theorem winner_exists_iff (bids : Array Bid) (kind : BidKind) (pointers : Nat) :
    (∃ i, bestBid bids kind pointers = .winner i) ↔
      (∀ j < bids.size, (bids[j]!).priority.isFinite = true) ∧
        ∃ j, j < bids.size ∧ eligibleBid bids kind pointers j = true := by
  constructor
  · rintro ⟨i, h⟩
    obtain ⟨hr, hn⟩ := bestBid_winner h
    exact ⟨(firstNonFiniteBid_none bids).mp hn,
      (ranked_exists_iff bids kind pointers).mp (by simp [hr])⟩
  · rintro ⟨hf, he⟩
    have hn := (firstNonFiniteBid_none bids).mpr hf
    obtain ⟨i, hi⟩ := Option.isSome_iff_exists.mp ((ranked_exists_iff bids kind pointers).mpr he)
    exact ⟨i, by simp [bestBid, hn, hi]⟩

/-- A press is refused exactly when some bid's priority, of any kind and count, is not finite;
the refusal names the first such bid. -/
@[lungo_claim "lungo.law" subject bestBid]
theorem nonfinite_priority_refused (bids : Array Bid) (kind : BidKind) (pointers : Nat) (i : Nat) :
    bestBid bids kind pointers = .invalidPriority i ↔
      i < bids.size ∧ (bids[i]!).priority.isFinite = false ∧
        ∀ j < i, (bids[j]!).priority.isFinite = true := by
  have hf : firstNonFiniteBid bids = some i ↔ i < bids.size ∧
      (bids[i]!).priority.isFinite = false ∧ ∀ j < i, (bids[j]!).priority.isFinite = true := by
    simp only [firstNonFiniteBid, List.find?_range_eq_some, List.mem_range, Bool.not_eq_true',
      Bool.not_not]
    constructor
    · rintro ⟨a, b, c⟩; exact ⟨b, a, c⟩
    · rintro ⟨a, b, c⟩; exact ⟨b, a, c⟩
  rw [← hf]
  unfold bestBid
  split
  · rename_i k hk
    simp [hk]
  · rename_i hn
    simp only [hn, reduceCtorEq, iff_false]
    split <;> exact fun h => nomatch h

/-- Some bid is refused exactly when some bid's priority is not finite. -/
@[lungo_claim "lungo.law" subject bestBid]
theorem refused_iff_nonfinite (bids : Array Bid) (kind : BidKind) (pointers : Nat) :
    (∃ i, bestBid bids kind pointers = .invalidPriority i) ↔
      ∃ j < bids.size, (bids[j]!).priority.isFinite = false := by
  cases hf : firstNonFiniteBid bids with
  | none =>
    have := (firstNonFiniteBid_none bids).mp hf
    simp only [bestBid, hf]
    constructor
    · rintro ⟨i, h⟩; split at h <;> cases h
    · rintro ⟨j, hj, hnf⟩; simp_all
  | some k =>
    simp only [bestBid, hf]
    have hk := (nonfinite_priority_refused bids kind pointers k).mp (by simp [bestBid, hf])
    exact ⟨fun _ => ⟨k, hk.1, hk.2.1⟩, fun _ => ⟨k, rfl⟩⟩

/-! ## Picking -/

/-- What a hit lies on. -/
inductive HitRegion where
  /-- A surface whose interaction is content. -/
  | content
  /-- A node's frame, or a surface that only shows something. -/
  | chrome
  /-- The resize band along a resizable node's edges. -/
  | resizeHandle
  /-- A window's title bar: the bar across the top of its card, drawn over every card. -/
  | titleBar
deriving DecidableEq, Inhabited

/-- The band along a window's edges comes first, then content, then the frame (title bars are
ordered before every other region whatever its depth: `hitKey`). -/
def HitRegion.rank : HitRegion → Nat
  | .resizeHandle => 0
  | .content => 1
  | .chrome => 2
  | .titleBar => 3

/-- A hit of the ray: on a surface, or on a node's own frame (`surface` none). -/
structure Hit where
  /-- The node hit, or the owner of the surface hit. -/
  node : String
  /-- The surface hit, or `none` for the node's own frame. -/
  surface : Option String
  /-- What the hit lies on. -/
  region : HitRegion
  /-- Distance from the camera along the ray, in world units. -/
  distance : Float
  /-- The owner's plus the surface's presentation priority; higher picks first. -/
  priority : Float
  /-- The host says this hit hides what lies behind it. -/
  occluding : Bool
  /-- The view brings the hit's window in front of every other window, their title bars included
  (the one focus shows). -/
  front : Bool
deriving Inhabited

/-- Whether a hit counts: a node's frame inside the window only where no surface of its own covers
it, a surface only where neither its window's resize band nor its title bar lies over it. -/
def keeps (hits : Array Hit) (i : Nat) : Bool :=
  let h := hits[i]!
  let all := List.range hits.size
  match h.surface with
  | none => !(h.region = .chrome && all.any (fun j => (hits[j]!).surface.isSome && (hits[j]!).node = h.node))
  | some _ => !all.any (fun j => (hits[j]!).surface.isNone && (hits[j]!).node = h.node &&
      ((hits[j]!).region = .resizeHandle || (hits[j]!).region = .titleBar))

/-- A kept hit is occluded when another kept hit that occludes lies nearer than it by more than the
depth tolerance, unless it is a title bar or its window is in front: those are drawn over every
other card, so nothing occludes them. -/
def occludedAt (hits : Array Hit) (kept : List Nat) (tolerance : Float) (i : Nat) : Bool :=
  (hits[i]!).region != .titleBar && !(hits[i]!).front &&
    kept.any fun j => j != i && (hits[j]!).occluding &&
      decide (floatKey ((hits[j]!).distance + tolerance) < floatKey (hits[i]!).distance)

/-- Where a hit lies among the layers a view draws: a window in front over everything (0), then
title bars (1), then whatever is not occluded (2), then the occluded (3). -/
def layerOf (hits : Array Hit) (kept : List Nat) (tolerance : Float) (i : Nat) : Nat :=
  if (hits[i]!).front then 0
  else if (hits[i]!).region = .titleBar then 1
  else if occludedAt hits kept tolerance i then 3 else 2

/-- Presentation priority first (higher), then the layer (a window in front, title bars, the rest
not occluded, the occluded), nearer, region, and identity. -/
def hitKey (hits : Array Hit) (kept : List Nat) (tolerance : Float) (i : Nat) : SortKey :=
  let h := hits[i]!
  ⟨-floatKey h.priority, layerOf hits kept tolerance i, floatKey h.distance,
    h.region.rank, h.node ++ "\u0000" ++ h.surface.getD ""⟩

/-- The hits that count, best first, whether each is occluded, and whether the target is
ambiguous: the next is another window tied with it on priority, occlusion and, within the
tolerance, depth. -/
structure PickOrder where
  /-- The positions of the hits that count, best first; the first is the target. -/
  order : List Nat
  /-- Whether each hit of `order`, in the same order, is occluded. -/
  occluded : List Bool
  /-- The first two hits of `order` are different nodes tied on priority, occlusion and, within
  the tolerance, depth: the target was chosen by identity. -/
  ambiguous : Bool

/-- Orders hits whose distances and priorities, and the tolerance, are finite (`pickOrder` checks
them): the order keys compare only finite numbers. With `tolerance` the depth difference (world units) that counts as
a tie. A node's frame counts only where none of the node's surfaces is hit, except along its
resize band, and a surface only where the node's resize band is not hit; every hit that counts is
ordered once, and nothing else. A hit is occluded when another occluding hit that counts lies nearer by more than the
tolerance. The order is by higher priority, then not occluded, nearer, region (resize band, then
content, then frame) and node and surface ID; the target ranks first. -/
def orderHits (hits : Array Hit) (tolerance : Float) : PickOrder :=
  let kept := (List.range hits.size).filter (keeps hits)
  let order := sortBy (hitKey hits kept tolerance) kept
  let occ := fun i => occludedAt hits kept tolerance i
  let ambiguous := match order with
    | t :: s :: _ =>
      (hits[s]!).node != (hits[t]!).node &&
        decide (floatKey (hits[s]!).priority = floatKey (hits[t]!).priority) &&
        occ s == occ t && decide (((hits[s]!).distance - (hits[t]!).distance).abs ≤ tolerance)
    | _ => false
  { order, occluded := order.map occ, ambiguous }

/-- Every hit that counts is ordered, once, and nothing else. -/
theorem orderHits_kept (hits : Array Hit) (tolerance : Float) :
    (orderHits hits tolerance).order.Perm ((List.range hits.size).filter (keeps hits)) := by
  simp only [orderHits, sortBy]
  exact List.mergeSort_perm _ _

/-- The target sorts first: no hit that counts outranks it. -/
theorem orderHits_target_first (hits : Array Hit) (tolerance : Float) (t : Nat)
    (h : (orderHits hits tolerance).order.head? = some t) (j : Nat) (hj : j < hits.size)
    (hk : keeps hits j = true) :
    keyLe (hitKey hits ((List.range hits.size).filter (keeps hits)) tolerance t)
      (hitKey hits ((List.range hits.size).filter (keeps hits)) tolerance j) = true :=
  sortBy_head_first _ _ t h j (by simp [hj, hk])

/-- A window's frame under one of its own surfaces does not count, and neither does a surface
under its window's resize band. -/
@[lungo_claim "lungo.law" subject keeps]
theorem covered_frames_dropped (hits : Array Hit) (i j : Nat) (hi : i < hits.size) (hj : j < hits.size)
    (same : (hits[i]!).node = (hits[j]!).node) :
    ((hits[i]!).surface = none → (hits[i]!).region = .chrome → (hits[j]!).surface.isSome →
      keeps hits i = false) ∧
    ((hits[i]!).surface.isSome → (hits[j]!).surface = none → (hits[j]!).region = .resizeHandle →
      keeps hits i = false) := by
  constructor
  · intro hn hc hs
    simp only [keeps, hn, hc]
    simp
    exact ⟨j, hj, by simp_all⟩
  · intro hs hn hr
    cases hsi : (hits[i]!).surface with
    | none => simp [hsi] at hs
    | some s =>
      simp only [keeps, hsi]
      simp
      exact ⟨j, hj, by simp_all⟩

/-- A hit is occluded exactly when it is not a title bar and another kept, occluding hit lies nearer
than it by more than the tolerance. -/
theorem orderHits_occluded (hits : Array Hit) (tolerance : Float) (k : Nat)
    (hk : k < (orderHits hits tolerance).order.length) :
    (orderHits hits tolerance).occluded[k]! = true ↔
      (hits[(orderHits hits tolerance).order[k]!]!).region ≠ .titleBar ∧
      (hits[(orderHits hits tolerance).order[k]!]!).front = false ∧
      ∃ j ∈ (List.range hits.size).filter (keeps hits),
        j ≠ (orderHits hits tolerance).order[k]! ∧ (hits[j]!).occluding = true ∧
        floatKey ((hits[j]!).distance + tolerance) <
          floatKey (hits[(orderHits hits tolerance).order[k]!]!).distance := by
  simp only [orderHits] at hk ⊢
  rw [List.getElem!_eq_getElem?_getD, List.getElem?_map, List.getElem?_eq_getElem hk]
  simp only [Option.map_some, Option.getD_some, occludedAt, List.any_eq_true, Bool.and_eq_true,
    bne_iff_ne, ne_eq, decide_eq_true_eq, List.getElem!_eq_getElem?_getD, List.getElem?_eq_getElem hk]
  constructor
  · rintro ⟨⟨hr, hf⟩, j, hj, ⟨hne, ho⟩, hlt⟩
    exact ⟨hr, by simpa using hf, j, hj, hne, ho, hlt⟩
  · rintro ⟨hr, hf, j, hj, hne, ho, hlt⟩
    exact ⟨⟨hr, by simpa using hf⟩, j, hj, ⟨hne, ho⟩, hlt⟩


/-- A title bar ranks before every hit that is neither one nor of a window in front, of the same
presentation priority, however near that hit is: title bars are drawn over every other card, so the
one under the pointer is pressed. -/
@[lungo_claim "lungo.law" subject hitKey]
theorem titleBar_before (hits : Array Hit) (kept : List Nat) (tolerance : Float) (i j : Nat)
    (hi : (hits[i]!).region = .titleBar) (hf : (hits[i]!).front = false)
    (hj : (hits[j]!).region ≠ .titleBar) (hjf : (hits[j]!).front = false)
    (hp : floatKey (hits[i]!).priority = floatKey (hits[j]!).priority) :
    keyLe (hitKey hits kept tolerance i) (hitKey hits kept tolerance j) = true := by
  have li : layerOf hits kept tolerance i = 1 := by simp [layerOf, hi, hf]
  have lj : 1 < layerOf hits kept tolerance j := by
    unfold layerOf
    by_cases hr : (hits[j]!).region = .titleBar
    · exact absurd hr hj
    · cases ho : occludedAt hits kept tolerance j <;> simp [hjf, hr, ho]
  simp only [keyLe, hitKey, hp, li]
  simp only [ite_true]
  have : (1 : Nat) ≠ layerOf hits kept tolerance j := by omega
  simp [this, lj]

/-- A hit of a window in front ranks before every hit of a window that is not, of the same
presentation priority, a title bar included: the window the view brings forward is drawn over
everything, so a press on it is its own. -/
@[lungo_claim "lungo.law" subject hitKey]
theorem front_before (hits : Array Hit) (kept : List Nat) (tolerance : Float) (i j : Nat)
    (hi : (hits[i]!).front = true) (hj : (hits[j]!).front = false)
    (hp : floatKey (hits[i]!).priority = floatKey (hits[j]!).priority) :
    keyLe (hitKey hits kept tolerance i) (hitKey hits kept tolerance j) = true := by
  have li : layerOf hits kept tolerance i = 0 := by simp [layerOf, hi]
  have lj : 0 < layerOf hits kept tolerance j := by
    unfold layerOf
    by_cases hr : (hits[j]!).region = .titleBar
    · simp [hj, hr]
    · cases ho : occludedAt hits kept tolerance j <;> simp [hj, hr, ho]
  simp only [keyLe, hitKey, hp, li]
  simp only [ite_true]
  have : (0 : Nat) ≠ layerOf hits kept tolerance j := by omega
  simp [this, lj]

/-- A surface under its own window's title bar does not count: the bar is drawn over it. -/
@[lungo_claim "lungo.law" subject keeps]
theorem titleBar_covers_own_surface (hits : Array Hit) (i j : Nat) (hj : j < hits.size)
    (same : (hits[i]!).node = (hits[j]!).node) (hs : (hits[i]!).surface.isSome)
    (hn : (hits[j]!).surface = none) (hr : (hits[j]!).region = .titleBar) :
    keeps hits i = false := by
  cases hsi : (hits[i]!).surface with
  | none => simp [hsi] at hs
  | some s =>
    simp only [keeps, hsi]
    simp
    exact ⟨j, hj, by simp_all⟩

/-- What picking decides for the hits a ray makes. -/
inductive PickOutcome where
  /-- The hits that count, ordered. -/
  | ordered (pick : PickOrder)
  /-- The depth tolerance is not a finite number at least zero: nothing is ordered. -/
  | invalidTolerance
  /-- The hit at `hit`, the first with a number that is not finite, cannot be ordered: `field`
  (`distance`, or else `priority`) is not finite. Nothing is ordered. -/
  | invalidHit (hit : Nat) (field : String)

/-- The field of a hit that is not finite, if any: its distance first, then its priority. -/
def hitIssue (h : Hit) : Option String :=
  if !h.distance.isFinite then some "distance"
  else if !h.priority.isFinite then some "priority"
  else none

/-- The first hit with a field that is not finite, and that field, if any. -/
def firstInvalidHit (hits : Array Hit) : Option (Nat × String) :=
  (List.range hits.size).findSome? fun i => (hitIssue hits[i]!).map (i, ·)

/-- Orders the hits a ray makes, with `tolerance` the depth difference (world units) that counts as
a tie, as `orderHits` does. Distances and priorities are compared by their order keys, which order
only finite numbers (`Swf.Order`): a tolerance that is not finite and at least zero is refused
first (`invalidTolerance`), then the first hit whose distance or priority is not finite
(`invalidHit`, naming it and the field). -/
def pickOrder (hits : Array Hit) (tolerance : Float) : PickOutcome :=
  if !tolerance.isFinite || !decide (0 ≤ tolerance) then .invalidTolerance
  else
    match firstInvalidHit hits with
    | some (i, field) => .invalidHit i field
    | none => .ordered (orderHits hits tolerance)

theorem hitIssue_none (h : Hit) :
    hitIssue h = none ↔ h.distance.isFinite = true ∧ h.priority.isFinite = true := by
  unfold hitIssue
  cases h.distance.isFinite <;> cases h.priority.isFinite <;> simp

theorem firstInvalidHit_none (hits : Array Hit) :
    firstInvalidHit hits = none ↔
      ∀ i < hits.size, (hits[i]!).distance.isFinite = true ∧ (hits[i]!).priority.isFinite = true := by
  simp only [firstInvalidHit, List.findSome?_eq_none_iff, List.mem_range, Option.map_eq_none_iff]
  exact forall_congr' fun i => imp_congr_right fun _ => hitIssue_none _

theorem pickOrder_ordered {hits : Array Hit} {tolerance : Float} {po : PickOrder}
    (h : pickOrder hits tolerance = .ordered po) : po = orderHits hits tolerance := by
  unfold pickOrder at h
  split at h
  · cases h
  · split at h
    · cases h
    · cases h; rfl

/-- Every hit that counts is ordered, once, and nothing else. -/
@[lungo_claim "lungo.law" subject pickOrder]
theorem order_is_kept (hits : Array Hit) (tolerance : Float) (po : PickOrder)
    (h : pickOrder hits tolerance = .ordered po) :
    po.order.Perm ((List.range hits.size).filter (keeps hits)) := by
  rw [pickOrder_ordered h]
  exact orderHits_kept hits tolerance

/-- The target sorts first: no hit that counts outranks it. -/
@[lungo_claim "lungo.law" subject pickOrder]
theorem target_ranks_first (hits : Array Hit) (tolerance : Float) (po : PickOrder)
    (h : pickOrder hits tolerance = .ordered po) (t : Nat) (ht : po.order.head? = some t) (j : Nat)
    (hj : j < hits.size) (hk : keeps hits j = true) :
    keyLe (hitKey hits ((List.range hits.size).filter (keeps hits)) tolerance t)
      (hitKey hits ((List.range hits.size).filter (keeps hits)) tolerance j) = true := by
  rw [pickOrder_ordered h] at ht
  exact orderHits_target_first hits tolerance t ht j hj hk

/-- A hit is occluded exactly when it is neither a title bar nor of a window in front and another
kept, occluding hit lies nearer than it by more than the tolerance. -/
@[lungo_claim "lungo.law" subject pickOrder]
theorem occluded_by_nearer (hits : Array Hit) (tolerance : Float) (po : PickOrder)
    (h : pickOrder hits tolerance = .ordered po) (k : Nat) (hk : k < po.order.length) :
    po.occluded[k]! = true ↔
      (hits[po.order[k]!]!).region ≠ .titleBar ∧ (hits[po.order[k]!]!).front = false ∧
      ∃ j ∈ (List.range hits.size).filter (keeps hits),
        j ≠ po.order[k]! ∧ (hits[j]!).occluding = true ∧
        floatKey ((hits[j]!).distance + tolerance) < floatKey (hits[po.order[k]!]!).distance := by
  rw [pickOrder_ordered h] at hk ⊢
  exact orderHits_occluded hits tolerance k hk

/-- The hits are ordered exactly when the tolerance is finite and at least zero and every hit's
distance and priority are finite: the order keys are compared only for finite numbers. -/
@[lungo_claim "lungo.law" subject pickOrder]
theorem ordered_iff_finite (hits : Array Hit) (tolerance : Float) :
    (∃ po, pickOrder hits tolerance = .ordered po) ↔
      (tolerance.isFinite = true ∧ 0 ≤ tolerance) ∧
        ∀ i < hits.size, (hits[i]!).distance.isFinite = true ∧ (hits[i]!).priority.isFinite = true := by
  unfold pickOrder
  by_cases ht : tolerance.isFinite = true ∧ 0 ≤ tolerance
  · have hc : (!tolerance.isFinite || !decide (0 ≤ tolerance)) = false := by simp [ht.1, ht.2]
    rw [hc]
    simp only [Bool.false_eq_true, ite_false, ht, true_and]
    rw [← firstInvalidHit_none]
    cases firstInvalidHit hits with
    | none => simp
    | some p => simp
  · have hc : (!tolerance.isFinite || !decide (0 ≤ tolerance)) = true := by
      by_cases h1 : tolerance.isFinite = true
      · have : ¬ 0 ≤ tolerance := fun h2 => ht ⟨h1, h2⟩
        simp [this]
      · simp_all
    simp only [hc, ite_true, reduceCtorEq, exists_false, false_iff]
    exact fun h => ht h.1

/-- A refused hit is one that is given, and the field named is not finite: its distance, or its
priority when its distance is finite. -/
@[lungo_claim "lungo.law" subject pickOrder]
theorem invalid_hit_named (hits : Array Hit) (tolerance : Float) (i : Nat) (field : String)
    (h : pickOrder hits tolerance = .invalidHit i field) :
    i < hits.size ∧
      ((field = "distance" ∧ (hits[i]!).distance.isFinite = false) ∨
        (field = "priority" ∧ (hits[i]!).distance.isFinite = true ∧
          (hits[i]!).priority.isFinite = false)) := by
  unfold pickOrder at h
  split at h
  · cases h
  · split at h
    · rename_i i' f' hf
      simp only [PickOutcome.invalidHit.injEq] at h
      obtain ⟨rfl, rfl⟩ := h
      obtain ⟨j, hj, hm⟩ := List.exists_of_findSome?_eq_some hf
      simp only [Option.map_eq_some_iff, Prod.mk.injEq] at hm
      obtain ⟨f, hf', rfl, rfl⟩ := hm
      refine ⟨by simpa using hj, ?_⟩
      unfold hitIssue at hf'
      cases hd : (hits[j]!).distance.isFinite <;> cases hp : (hits[j]!).priority.isFinite <;>
        simp_all
    · cases h

end Swf.Arbitration
