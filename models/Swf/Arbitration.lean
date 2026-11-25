import Lungo
import Swf.Order

/-!
Picking arbitration: which hit under a pointer is the target, and which gesture wins a press. The
hits a ray makes are merged (a window's frame counts inside it only where none of its surfaces
covers it, except along its resize band), marked occluded when a nearer occluding hit lies in front,
and ordered by presentation priority, occlusion, depth, region and identity; the first is the
target, ambiguous when the next is another window that ties with it. Among the gestures the
policies bid for a press, the highest priority wins, then the lower policy ID. The interaction
layer intersects the geometry; this model decides.
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

/-- The winning bid of a kind for a pointer count, or none when no bid is of that kind and count. -/
def bestBid (bids : Array Bid) (kind : BidKind) (pointers : Nat) : Option Nat :=
  (sortBy (fun i => bidKey bids[i]!)
    ((List.range bids.size).filter (eligibleBid bids kind pointers))).head?

/-- The winner is a bid of the kind and pointer count asked for. -/
@[lungo_claim "lungo.law" subject bestBid]
theorem winner_eligible (bids : Array Bid) (kind : BidKind) (pointers : Nat) (i : Nat)
    (h : bestBid bids kind pointers = some i) :
    i < bids.size ∧ (bids[i]!).kind = kind ∧ (bids[i]!).pointers = pointers := by
  have hmem : i ∈ (List.range bids.size).filter (eligibleBid bids kind pointers) := by
    have hperm := List.mergeSort_perm ((List.range bids.size).filter (eligibleBid bids kind pointers))
      (fun i j => keyLe (bidKey bids[i]!) (bidKey bids[j]!))
    have : i ∈ sortBy (fun i => bidKey bids[i]!) ((List.range bids.size).filter (eligibleBid bids kind pointers)) :=
      List.mem_of_head? h
    exact hperm.mem_iff.mp this
  simp [eligibleBid] at hmem
  exact ⟨hmem.1, hmem.2.1, hmem.2.2⟩

/-- No eligible bid outranks the winner: it has the highest priority among them, and the lowest
policy ID among those of that priority. -/
@[lungo_claim "lungo.law" subject bestBid]
theorem winner_ranks_first (bids : Array Bid) (kind : BidKind) (pointers : Nat) (i : Nat)
    (h : bestBid bids kind pointers = some i) (j : Nat) (hj : j < bids.size)
    (he : eligibleBid bids kind pointers j = true) :
    keyLe (bidKey bids[i]!) (bidKey bids[j]!) = true :=
  sortBy_head_first _ _ i h j (by simp [hj, he])

/-- There is a winner exactly when some bid is eligible. -/
@[lungo_claim "lungo.law" subject bestBid]
theorem winner_exists_iff (bids : Array Bid) (kind : BidKind) (pointers : Nat) :
    (bestBid bids kind pointers).isSome = true ↔
      ∃ j, j < bids.size ∧ eligibleBid bids kind pointers j = true := by
  simp only [bestBid, sortBy, Option.isSome_iff_exists]
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

/-! ## Picking -/

/-- What a hit lies on. -/
inductive HitRegion where
  /-- A surface whose interaction is content. -/
  | content
  /-- A node's frame, or a surface that only shows something. -/
  | chrome
  /-- The resize band along a resizable node's edges. -/
  | resizeHandle
deriving DecidableEq, Inhabited

/-- The band along a window's edges comes first, then content, then the frame. -/
def HitRegion.rank : HitRegion → Nat
  | .resizeHandle => 0
  | .content => 1
  | .chrome => 2

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
deriving Inhabited

/-- Whether a hit counts: a node's frame inside the window only where no surface of its own covers
it, a surface only where its window's resize band does not lie over it. -/
def keeps (hits : Array Hit) (i : Nat) : Bool :=
  let h := hits[i]!
  let all := List.range hits.size
  match h.surface with
  | none => !(h.region = .chrome && all.any (fun j => (hits[j]!).surface.isSome && (hits[j]!).node = h.node))
  | some _ => !all.any (fun j => (hits[j]!).surface.isNone && (hits[j]!).node = h.node &&
      (hits[j]!).region = .resizeHandle)

/-- A kept hit is occluded when another kept hit that occludes lies nearer than it by more than the
depth tolerance. -/
def occludedAt (hits : Array Hit) (kept : List Nat) (tolerance : Float) (i : Nat) : Bool :=
  kept.any fun j => j != i && (hits[j]!).occluding &&
    decide (floatKey ((hits[j]!).distance + tolerance) < floatKey (hits[i]!).distance)

/-- Presentation priority first (higher), then not occluded, nearer, region, and identity. -/
def hitKey (hits : Array Hit) (kept : List Nat) (tolerance : Float) (i : Nat) : SortKey :=
  let h := hits[i]!
  ⟨-floatKey h.priority, if occludedAt hits kept tolerance i then 1 else 0, floatKey h.distance,
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

/-- Orders the hits a ray makes, with `tolerance` the depth difference (world units) that counts as
a tie. A node's frame counts only where none of the node's surfaces is hit, except along its
resize band, and a surface only where the node's resize band is not hit; every hit that counts is
ordered once, and nothing else. A hit is occluded when another occluding hit that counts lies nearer by more than the
tolerance. The order is by higher priority, then not occluded, nearer, region (resize band, then
content, then frame) and node and surface ID; the target ranks first. -/
def pickOrder (hits : Array Hit) (tolerance : Float) : PickOrder :=
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
@[lungo_claim "lungo.law" subject pickOrder]
theorem order_is_kept (hits : Array Hit) (tolerance : Float) :
    (pickOrder hits tolerance).order.Perm ((List.range hits.size).filter (keeps hits)) := by
  simp only [pickOrder, sortBy]
  exact List.mergeSort_perm _ _

/-- The target sorts first: no hit that counts outranks it. -/
@[lungo_claim "lungo.law" subject pickOrder]
theorem target_ranks_first (hits : Array Hit) (tolerance : Float) (t : Nat)
    (h : (pickOrder hits tolerance).order.head? = some t) (j : Nat) (hj : j < hits.size)
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

/-- A hit is occluded exactly when another kept, occluding hit lies nearer than it by more than the
tolerance. -/
@[lungo_claim "lungo.law" subject pickOrder]
theorem occluded_by_nearer (hits : Array Hit) (tolerance : Float) (k : Nat)
    (hk : k < (pickOrder hits tolerance).order.length) :
    (pickOrder hits tolerance).occluded[k]! = true ↔
      ∃ j ∈ (List.range hits.size).filter (keeps hits),
        j ≠ (pickOrder hits tolerance).order[k]! ∧ (hits[j]!).occluding = true ∧
        floatKey ((hits[j]!).distance + tolerance) <
          floatKey (hits[(pickOrder hits tolerance).order[k]!]!).distance := by
  simp only [pickOrder] at hk ⊢
  rw [List.getElem!_eq_getElem?_getD, List.getElem?_map, List.getElem?_eq_getElem hk]
  simp only [Option.map_some, Option.getD_some, occludedAt, List.any_eq_true, Bool.and_eq_true,
    bne_iff_ne, ne_eq, decide_eq_true_eq, List.getElem!_eq_getElem?_getD, List.getElem?_eq_getElem hk]
  constructor
  · rintro ⟨j, hj, ⟨hne, ho⟩, hlt⟩; exact ⟨j, hj, hne, ho, hlt⟩
  · rintro ⟨j, hj, hne, ho, hlt⟩; exact ⟨j, hj, ⟨hne, ho⟩, hlt⟩

end Swf.Arbitration
