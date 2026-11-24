import Lungo
import Std.Data.String.ToNat

/-!
The reference application's multi-surface composition: the surfaces a host supplied, rearranged
among windows. A surface can be detached into a window of its own, moved into another window, or
a window's surfaces merged into another's; a window can be moved into another group, or a new one.
This model decides each step from the committed scene: whether it can be done (or which field is
at fault and why), which windows hold which surfaces after it, what is created and what is
removed. The application turns the plan into the scene commands of one undoable transaction,
laying each window out round its surfaces (geometry). Only associations and placements change: a
surface is never split, and a window with one surface has nothing to detach.
-/
namespace Swf.AppComposition

/-- A node of the scene, as composition weighs it. -/
structure CompNode where
  id : String
  /-- Its kind, such as `window` or `group`. -/
  kind : String
  /-- Not archived. -/
  active : Bool
  label : Option String
  parentId : Option String
  childIds : Array String
  /-- Its surfaces, in their order. -/
  surfaceIds : Array String

/-- A surface of the scene: its window is `owner`. -/
structure CompSurface where
  id : String
  label : Option String
  owner : String

structure CompScene where
  nodes : Array CompNode
  surfaces : Array CompSurface
  /-- The group workspace orbit turns, if any. -/
  orbitRootId : Option String

/-- An ID as a host gave it, untyped: none when it is not a string at all; `shown` is how it
reads. -/
structure CompRef where
  id : Option String
  shown : String

/-- Where a window is moved: into a group that exists, or into a new group of its own. -/
inductive CompTarget where
  | group (id : String)
  | fresh (id : String) (label : String)

inductive CompStep where
  /-- Takes a surface out of its window into a new window of its own. -/
  | detach (surface : CompRef)
  /-- Moves a surface into another window, after its surfaces. -/
  | move (surface : CompRef) (window : CompRef)
  /-- Moves every surface of a window into another, after its own, and removes the emptied one. -/
  | merge (window : CompRef) (target : CompRef)
  /-- Moves a window into another group, keeping its place in the world. -/
  | regroup (window : CompRef) (target : CompTarget)

/-- Where a regrouped window goes. -/
inductive CompInto where
  | group (id : String)
  /-- A new group, made where the window is (under `parentId`). -/
  | fresh (id : String) (label : String) (parentId : Option String)

inductive CompPlan where
  | refused (field : String) (reason : String)
  /-- `surface` leaves `window` (laid out again round `kept`) for a new window `created`, named
  `label`, in the same group (`parentId`), beside the window it left. -/
  | detach (surface window created label : String) (parentId : Option String) (kept : Array String)
  /-- `surface` moves into `target`, laid out again round `laidOut`; `source`, the window it left,
  is laid out round `left`, or removed when `left` is empty. -/
  | move (surface target : String) (laidOut : Array String) (source : String) (left : Array String)
  /-- `moved`, the surfaces of `source`, move into `target`, laid out again round `laidOut`, and
  `source` is removed. -/
  | merge (source target : String) (moved laidOut : Array String)
  /-- `window` moves; `removed` is the group it left empty, when that group goes with it. -/
  | regroup (window : String) (into : CompInto) (removed : Option String)

def CompScene.node? (s : CompScene) (id : String) : Option CompNode := s.nodes.find? (·.id == id)

def CompScene.surface? (s : CompScene) (id : String) : Option CompSurface :=
  s.surfaces.find? (·.id == id)

/-- Every ID the scene's nodes and surfaces hold. -/
def CompScene.ids (s : CompScene) : List String :=
  s.nodes.toList.map (·.id) ++ s.surfaces.toList.map (·.id)

/-- The active window of an ID, if there is one. -/
def CompScene.window? (s : CompScene) (id : Option String) : Option CompNode :=
  match id.bind s.node? with
  | some n => if n.kind = "window" ∧ n.active then some n else none
  | none => none

/-- A node or surface as the operator reads it. -/
def nameOf (id : String) (label : Option String) : String := "“" ++ label.getD id ++ "”"

/-- The `n`th candidate for a new ID made from `stem`: the stem, then the stem numbered from 2. -/
def candidateId (stem : String) : Nat → String
  | 0 => stem
  | n + 1 => stem ++ "-" ++ toString (n + 2)

theorem candidateId_injective (stem : String) (a b : Nat) (h : candidateId stem a = candidateId stem b) :
    a = b := by
  have hl : ∀ n, (candidateId stem 0).length < (candidateId stem (n + 1)).length := by
    intro n
    simp only [candidateId, String.length_append]
    have : "-".length = 1 := rfl
    omega
  cases a with
  | zero =>
    cases b with
    | zero => rfl
    | succ b => have := hl b; rw [h] at this; omega
  | succ a =>
    cases b with
    | zero => have := hl a; rw [← h] at this; omega
    | succ b =>
      simp only [candidateId] at h
      have h' := (String.append_right_inj (stem ++ "-")).mp h
      have : a + 2 = b + 2 := Nat.repr_injective h'
      omega

/-- The candidates for a new ID while `taken` IDs are taken: one more than there are taken. -/
def freeCandidates (taken : List String) (stem : String) : List String :=
  (List.range (taken.length + 1)).map (candidateId stem)

theorem free_candidate_exists (taken : List String) (stem : String) :
    ((freeCandidates taken stem).find? (fun c => !taken.contains c)).isSome := by
  rw [List.find?_isSome]
  refine Classical.byContradiction fun hn => ?_
  have hsub : freeCandidates taken stem ⊆ taken := by
    intro c hc
    refine Classical.byContradiction fun hct => hn ⟨c, hc, by simpa using hct⟩
  have hnd : (freeCandidates taken stem).Nodup :=
    List.Pairwise.map (candidateId stem) (fun a b hab h => hab (candidateId_injective stem a b h))
      List.nodup_range
  have := hnd.length_le_of_subset hsub
  simp [freeCandidates] at this
  omega

/-- The first candidate ID made from `stem` that is not taken. -/
def freeId (taken : List String) (stem : String) : String :=
  ((freeCandidates taken stem).find? (fun c => !taken.contains c)).get
    (free_candidate_exists taken stem)

/-- An ID for a new node made from `stem`, among the IDs `taken`: the stem, or the stem numbered,
whichever is free first. -/
def compositionFreeId (taken : Array String) (stem : String) : String := freeId taken.toList stem

/-- The suffix a surface's ID carries when it is named after its window. -/
def surfaceSuffix : List Char := "-surface".toList

/-- The window a surface is named after (`note-1-surface` gives `note-1`), or the empty string. -/
def windowStem (surfaceId : String) : String :=
  let cs := surfaceId.toList
  if surfaceSuffix.length ≤ cs.length ∧ cs.drop (cs.length - surfaceSuffix.length) = surfaceSuffix then
    String.ofList (cs.take (cs.length - surfaceSuffix.length))
  else ""

/-- The ID of the window a detached surface gets: named after the surface. -/
def windowIdFor (s : CompScene) (surfaceId : String) : String :=
  let stem := windowStem surfaceId
  freeId s.ids (if stem = "" then surfaceId ++ "-window" else stem)

def compDetach (s : CompScene) (r : CompRef) : CompPlan :=
  match r.id.bind s.surface? with
  | none => .refused "surfaceId" s!"no surface \"{r.shown}\""
  | some sf =>
    match s.window? (some sf.owner) with
    | none => .refused "surfaceId" s!"surface {nameOf sf.id sf.label} is not in a window"
    | some w =>
      if w.surfaceIds.size < 2 then
        .refused "surfaceId"
          s!"{nameOf sf.id sf.label} is the only surface of {nameOf w.id w.label}: there is nothing to detach it from, and a surface’s own content is never split"
      else
        let id := windowIdFor s sf.id
        .detach sf.id w.id id (sf.label.getD id) w.parentId (w.surfaceIds.filter (· != sf.id))

def compMove (s : CompScene) (r : CompRef) (t : CompRef) : CompPlan :=
  match r.id.bind s.surface? with
  | none => .refused "surfaceId" s!"no surface \"{r.shown}\""
  | some sf =>
    match s.window? t.id with
    | none => .refused "windowId" s!"no window \"{t.shown}\""
    | some target =>
      if target.id = sf.owner then
        .refused "windowId" s!"{nameOf sf.id sf.label} is already in {nameOf target.id target.label}"
      else
        match s.window? (some sf.owner) with
        | none => .refused "surfaceId" s!"surface {nameOf sf.id sf.label} is not in a window"
        | some source =>
          .move sf.id target.id (target.surfaceIds.push sf.id) source.id
            (source.surfaceIds.filter (· != sf.id))

def compMerge (s : CompScene) (r : CompRef) (t : CompRef) : CompPlan :=
  match s.window? r.id with
  | none => .refused "windowId" s!"no window \"{r.shown}\""
  | some source =>
    match s.window? t.id with
    | none => .refused "targetId" s!"no window \"{t.shown}\""
    | some target =>
      if target.id = source.id then .refused "targetId" "a window cannot be merged into itself"
      else if source.childIds.size > 0 then
        .refused "windowId" s!"{nameOf source.id source.label} holds other nodes and cannot be emptied"
      else .merge source.id target.id source.surfaceIds (target.surfaceIds ++ source.surfaceIds)

/-- The group a window leaves empty, which goes with it: not the group workspace orbit turns, and
never when the window goes into a new group (made inside the old one). -/
def emptiedGroup (s : CompScene) (window : CompNode) (target : CompTarget) : Option String :=
  match target with
  | .fresh .. => none
  | .group _ =>
    match window.parentId.bind s.node? with
    | some left =>
      if left.kind = "group" ∧ s.orbitRootId ≠ some left.id ∧ left.childIds.size = 1 ∧
          left.surfaceIds.size = 0 then some left.id
      else none
    | none => none

def compRegroup (s : CompScene) (r : CompRef) (target : CompTarget) : CompPlan :=
  match s.window? r.id with
  | none => .refused "windowId" s!"no window \"{r.shown}\""
  | some window =>
    let removed := emptiedGroup s window target
    match target with
    | .fresh id label =>
      if s.ids.contains id then .refused "groupId" s!"the ID \"{id}\" is taken"
      else .regroup window.id (.fresh id label window.parentId) removed
    | .group id =>
      match s.node? id with
      | some g =>
        if g.kind = "group" ∧ g.active then
          if window.parentId = some g.id then
            .refused "groupId" s!"{nameOf window.id window.label} is already in {nameOf g.id g.label}"
          else .regroup window.id (.group g.id) removed
        else .refused "groupId" s!"no group \"{id}\""
      | none => .refused "groupId" s!"no group \"{id}\""

/-- The plan of a composition step, from the committed scene alone. -/
def compositionPlan (s : CompScene) (step : CompStep) : CompPlan :=
  match step with
  | .detach r => compDetach s r
  | .move r t => compMove s r t
  | .merge r t => compMerge s r t
  | .regroup r t => compRegroup s r t

/-! ## Invariants -/

theorem freeId_spec (taken : List String) (stem : String) :
    (freeCandidates taken stem).find? (fun c => !taken.contains c) = some (freeId taken stem) := by
  simp [freeId]

/-- A new node's ID is never one the scene holds. -/
@[lungo_claim "lungo.law" subject compositionFreeId]
theorem free_id_unused (taken : Array String) (stem : String) :
    compositionFreeId taken stem ∉ taken := by
  have h := List.find?_some (freeId_spec taken.toList stem)
  simpa [compositionFreeId] using h

/-- A free stem is the ID itself, unnumbered. -/
@[lungo_claim "lungo.law" subject compositionFreeId]
theorem free_id_prefers_stem (taken : Array String) (stem : String) (h : stem ∉ taken) :
    compositionFreeId taken stem = stem := by
  have hs := freeId_spec taken.toList stem
  simp only [freeCandidates, List.range_succ_eq_map, List.map_cons, List.find?_cons, candidateId] at hs
  have : (!taken.toList.contains stem) = true := by simpa using h
  rw [this] at hs
  simp only [Option.some.injEq] at hs
  exact hs.symm

theorem node?_id {s : CompScene} {id : String} {n : CompNode} (h : s.node? id = some n) :
    n.id = id := by
  have := Array.find?_some h
  simpa using this

theorem window?_some {s : CompScene} {id : Option String} {n : CompNode} (h : s.window? id = some n) :
    id = some n.id ∧ s.window? (some n.id) = some n := by
  unfold CompScene.window? at h
  split at h
  · rename_i m hm
    split at h
    · cases h
      cases id with
      | none => simp at hm
      | some i =>
        simp only [Option.bind_some] at hm
        have hi := node?_id hm
        subst hi
        refine ⟨rfl, ?_⟩
        unfold CompScene.window?
        simp_all
    · cases h
  · cases h

/-- A surface is detached only from a window holding another surface; the window it leaves keeps
the rest, and the window made for it has an ID no node or surface holds. -/
@[lungo_claim "lungo.law" subject compositionPlan]
theorem detach_needs_two_surfaces (s : CompScene) (r : CompRef) (sf w created label : String)
    (parentId : Option String) (kept : Array String)
    (h : compositionPlan s (.detach r) = .detach sf w created label parentId kept) :
    ∃ n, s.window? (some w) = some n ∧ 2 ≤ n.surfaceIds.size ∧
      kept = n.surfaceIds.filter (· != sf) ∧ parentId = n.parentId ∧ created ∉ s.ids := by
  simp only [compositionPlan, compDetach] at h
  split at h
  · cases h
  · rename_i sfr _
    split at h
    · cases h
    · rename_i n hn
      split at h
      · cases h
      · cases h
        refine ⟨n, (window?_some hn).2, by omega, rfl, rfl, ?_⟩
        have := List.find?_some (freeId_spec s.ids
          (if windowStem sfr.id = "" then sfr.id ++ "-window" else windowStem sfr.id))
        simpa [windowIdFor] using this

/-- Merging keeps every surface of both windows: the target holds its own, then all of the
merged window's, which is removed only when it holds nothing else and is another window. -/
@[lungo_claim "lungo.law" subject compositionPlan]
theorem merge_keeps_every_surface (s : CompScene) (r t : CompRef) (source target : String)
    (moved laidOut : Array String)
    (h : compositionPlan s (.merge r t) = .merge source target moved laidOut) :
    ∃ ns nt, s.window? r.id = some ns ∧ s.window? t.id = some nt ∧ ns.id = source ∧
      nt.id = target ∧ source ≠ target ∧ ns.childIds.size = 0 ∧ moved = ns.surfaceIds ∧
      laidOut = nt.surfaceIds ++ ns.surfaceIds := by
  simp only [compositionPlan, compMerge] at h
  split at h
  · cases h
  · rename_i ns hns
    split at h
    · cases h
    · rename_i nt hnt
      split at h
      · cases h
      · rename_i hne
        split at h
        · cases h
        · cases h
          exact ⟨ns, nt, hns, hnt, rfl, rfl, fun e => hne e.symm, by omega, rfl, rfl⟩

/-- Moving a surface puts it after the target's surfaces, in another window than its own, and
leaves the window it left with the rest; that window is removed exactly when nothing is left. -/
@[lungo_claim "lungo.law" subject compositionPlan]
theorem move_keeps_every_surface (s : CompScene) (r t : CompRef) (sf target source : String)
    (laidOut left : Array String)
    (h : compositionPlan s (.move r t) = .move sf target laidOut source left) :
    ∃ nt ns : CompNode, s.window? t.id = some nt ∧ nt.id = target ∧ ns.id = source ∧
      target ≠ source ∧ laidOut = nt.surfaceIds.push sf ∧ left = ns.surfaceIds.filter (· != sf) := by
  simp only [compositionPlan, compMove] at h
  split at h
  · cases h
  · rename_i sfr _
    split at h
    · cases h
    · rename_i nt hnt
      split at h
      · cases h
      · rename_i hne
        split at h
        · cases h
        · rename_i ns hns
          cases h
          refine ⟨nt, ns, hnt, rfl, rfl, ?_, rfl, rfl⟩
          intro e
          apply hne
          have := (window?_some hns).1
          simp only [Option.some.injEq] at this
          rw [e, this]

/-- A window goes only into another active group, or a new group under an ID nothing holds. -/
@[lungo_claim "lungo.law" subject compositionPlan]
theorem regroup_into_other_group (s : CompScene) (r : CompRef) (t : CompTarget) (w : String)
    (into : CompInto) (removed : Option String)
    (h : compositionPlan s (.regroup r t) = .regroup w into removed) :
    ∃ n, s.window? r.id = some n ∧ n.id = w ∧
      ((∃ g, into = .group g.id ∧ s.node? g.id = some g ∧ g.kind = "group" ∧ g.active = true ∧
          n.parentId ≠ some g.id) ∨
        (∃ id label, into = .fresh id label n.parentId ∧ id ∉ s.ids)) := by
  simp only [compositionPlan, compRegroup] at h
  split at h
  · cases h
  · rename_i n hn
    refine ⟨n, hn, ?_⟩
    cases t with
    | fresh id label =>
      simp only at h
      split at h
      · cases h
      · rename_i hc
        cases h
        exact ⟨rfl, .inr ⟨id, label, rfl, by simpa using hc⟩⟩
    | group id =>
      simp only at h
      split at h
      · rename_i g hg
        split at h
        · rename_i hk
          split at h
          · cases h
          · rename_i hp
            cases h
            have := node?_id hg
            subst this
            exact ⟨rfl, .inl ⟨g, rfl, hg, hk.1, by simpa using hk.2, hp⟩⟩
        · cases h
      · cases h

/-- A group is removed with a window only when the window was its one child and it holds no
surface, the window goes into another group that exists, and it is not the group workspace orbit
turns. -/
@[lungo_claim "lungo.law" subject compositionPlan]
theorem emptied_group_removed_only (s : CompScene) (r : CompRef) (t : CompTarget) (w : String)
    (into : CompInto) (g : String)
    (h : compositionPlan s (.regroup r t) = .regroup w into (some g)) :
    ∃ n left, s.window? r.id = some n ∧ n.parentId.bind s.node? = some left ∧ left.id = g ∧
      left.kind = "group" ∧ s.orbitRootId ≠ some g ∧ left.childIds.size = 1 ∧
      left.surfaceIds.size = 0 ∧ ∃ id, t = .group id := by
  simp only [compositionPlan, compRegroup] at h
  split at h
  · cases h
  · rename_i n hn
    have hr : emptiedGroup s n t = some g := by
      cases t with
      | fresh id label =>
        simp only at h
        split at h
        · cases h
        · simp only [CompPlan.regroup.injEq] at h; exact h.2.2
      | group id =>
        simp only at h
        split at h
        · split at h
          · split at h
            · cases h
            · simp only [CompPlan.regroup.injEq] at h; exact h.2.2
          · cases h
        · cases h
    cases t with
    | fresh id label => simp [emptiedGroup] at hr
    | group id =>
      simp only [emptiedGroup] at hr
      split at hr
      · rename_i left hl
        split at hr
        · rename_i hc
          cases hr
          exact ⟨n, left, hn, hl, rfl, hc.1, hc.2.1, hc.2.2.1, hc.2.2.2, id, rfl⟩
        · cases hr
      · cases hr

end Swf.AppComposition
