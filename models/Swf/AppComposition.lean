import Lungo
import Std.Data.String.ToNat

/-!
The reference application's multi-surface composition: the surfaces a host supplied, rearranged
among windows. A surface can be detached into a window of its own, moved into another window, or
a window's surfaces merged into another's; a window can be moved into another group, or a new one;
and several windows can be gathered into a new group together.
This model decides each step from the committed scene: whether it can be done (or which field is
at fault and why), which windows hold which surfaces after it, what is created and what is
removed. The application turns the plan into the scene commands of one undoable transaction,
laying each window out round its surfaces (geometry). Only associations and placements change: a
surface is never split, and a window with one surface has nothing to detach.
-/
namespace Swf.AppComposition

/-- A node of the scene, as composition weighs it. -/
structure CompNode where
  /-- The node's ID. -/
  id : String
  /-- Its kind, such as `window` or `group`. -/
  kind : String
  /-- Not archived. -/
  active : Bool
  /-- Its label, if it has one; refusals name the node by it, else by its ID. -/
  label : Option String
  /-- Its parent's ID, or `none` at the root. -/
  parentId : Option String
  /-- Its child nodes' IDs. -/
  childIds : Array String
  /-- Its surfaces, in their order. -/
  surfaceIds : Array String

/-- A surface of the scene: its window is `owner`. -/
structure CompSurface where
  /-- The surface's ID. -/
  id : String
  /-- Its label, if it has one; a window made for it takes it, and refusals name it by it. -/
  label : Option String
  /-- The ID of the node that holds it. -/
  owner : String

/-- The committed scene, as composition weighs it. -/
structure CompScene where
  /-- Every node, archived ones included. -/
  nodes : Array CompNode
  /-- Every surface. -/
  surfaces : Array CompSurface
  /-- The group workspace orbit turns, if any. -/
  orbitRootId : Option String

/-- An ID as a host gave it, untyped: none when it is not a string at all; `shown` is how it
reads. -/
structure CompRef where
  /-- The ID, or `none` when the host gave something other than a string. -/
  id : Option String
  /-- How the value given reads, for a refusal to quote. -/
  shown : String

/-- Where a window is moved: into a group that exists, or into a new group of its own. -/
inductive CompTarget where
  /-- The existing group `id`; it must be an active group the window is not already in. -/
  | group (id : String)
  /-- A new group with ID `id`, which no node or surface may hold, labelled `label`. -/
  | fresh (id : String) (label : String)

/-- A composition step asked for. -/
inductive CompStep where
  /-- Takes a surface out of its window into a new window of its own. -/
  | detach (surface : CompRef)
  /-- Moves a surface into another window, after its surfaces. -/
  | move (surface : CompRef) (window : CompRef)
  /-- Moves every surface of a window into another, after its own, and removes the emptied one. -/
  | merge (window : CompRef) (target : CompRef)
  /-- Moves a window into another group, keeping its place in the world. -/
  | regroup (window : CompRef) (target : CompTarget)
  /-- Gathers several windows into a new group with ID `id`, labelled `label`, each keeping its
  place in the world. -/
  | group (windows : Array CompRef) (id : String) (label : String)

/-- Where a regrouped window goes. -/
inductive CompInto where
  /-- The existing group `id`. -/
  | group (id : String)
  /-- A new group, made where the window is (under `parentId`). -/
  | fresh (id : String) (label : String) (parentId : Option String)

/-- The plan of a composition step: what changes, or why it cannot be done. -/
inductive CompPlan where
  /-- The step cannot be done and nothing changes: `field` names the argument at fault
  (`surfaceId`, `windowId`, `targetId`, `groupId` or `windowIds`), `reason` says why, in English. -/
  | refused (field : String) (reason : String)
  /-- `surface` leaves `window` (laid out again round `kept`) for a new window `created`, named
  `label`, in the same group (`parentId`), beside the window it left. -/
  | detach (surface window created label : String) (parentId : Option String) (kept : Array String)
  /-- `surface` moves into `target`, laid out again round `laidOut`; `source`, the window it left,
  is laid out round `left`, or removed when `left` is empty, which it never is for a window that
  holds child nodes. -/
  | move (surface target : String) (laidOut : Array String) (source : String) (left : Array String)
  /-- `moved`, the surfaces of `source`, move into `target`, laid out again round `laidOut`, and
  `source` is removed. -/
  | merge (source target : String) (moved laidOut : Array String)
  /-- `window` moves; `removed` is the group it left empty, when that group goes with it. -/
  | regroup (window : String) (into : CompInto) (removed : Option String)
  /-- `windows` go together into a new group `id`, named `label`, made under `parentId` (the
  parent they all share, or the root when they share none); `removed` are the groups they leave
  empty, which go with them. -/
  | group (windows : Array String) (id label : String) (parentId : Option String)
      (removed : Array String)

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

/-- Why a window that holds child nodes cannot be emptied: emptying a window removes it, and its
child nodes would go with it. Moving its last surface out and merging it are refused alike. -/
def holdsNodes (w : CompNode) : String :=
  s!"{nameOf w.id w.label} holds other nodes and cannot be emptied"

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
          let left := source.surfaceIds.filter (· != sf.id)
          if left.size = 0 ∧ source.childIds.size > 0 then
            .refused "surfaceId" (holdsNodes source)
          else .move sf.id target.id (target.surfaceIds.push sf.id) source.id left

def compMerge (s : CompScene) (r : CompRef) (t : CompRef) : CompPlan :=
  match s.window? r.id with
  | none => .refused "windowId" s!"no window \"{r.shown}\""
  | some source =>
    match s.window? t.id with
    | none => .refused "targetId" s!"no window \"{t.shown}\""
    | some target =>
      if target.id = source.id then .refused "targetId" "a window cannot be merged into itself"
      else if source.childIds.size > 0 then .refused "windowId" (holdsNodes source)
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

/-- A window named to be grouped: an active window not inside another window, which it moves
with. -/
def groupable (s : CompScene) (r : CompRef) : Except (String × String) CompNode :=
  match s.window? r.id with
  | none => .error ("windowIds", s!"no window \"{r.shown}\"")
  | some n =>
    match n.parentId.bind s.node? with
    | some p =>
      if p.kind = "window" then
        .error ("windowIds", s!"{nameOf n.id n.label} moves with {nameOf p.id p.label}, the window it is in")
      else .ok n
    | none => .ok n

/-- The windows a group step names, after `acc`, in the order given and each named once; or the
refusal of the first that cannot be grouped. -/
def groupWindows (s : CompScene) : List CompRef → List CompNode → Except (String × String) (List CompNode)
  | [], acc => .ok acc
  | r :: rest, acc =>
    match groupable s r with
    | .error e => .error e
    | .ok n =>
      if acc.any (·.id == n.id) then .error ("windowIds", s!"{nameOf n.id n.label} is named twice")
      else groupWindows s rest (acc ++ [n])

/-- The parent the windows share, where their group is made: the root when they share none. -/
def sharedParent : List CompNode → Option String
  | [] => none
  | w :: rest => if rest.all (·.parentId == w.parentId) then w.parentId else none

/-- Whether the windows leave a group they came from empty, so it goes with them: a group that holds
no surface and no child but these windows, is not the group workspace orbit turns, and is not the
one their new group is made in. -/
def leftEmpty (s : CompScene) (ws : List CompNode) (parentId : Option String) (g : String) : Bool :=
  match s.node? g with
  | some left =>
    left.kind == "group" && s.orbitRootId != some g && left.surfaceIds.size == 0 &&
      left.childIds.all (fun c => ws.any (·.id == c)) && parentId != some g
  | none => false

/-- The groups the windows leave empty, each once. -/
def emptiedGroups (s : CompScene) (ws : List CompNode) (parentId : Option String) : List String :=
  (ws.filterMap (·.parentId)).eraseDups.filter (leftEmpty s ws parentId)

def compGroup (s : CompScene) (rs : Array CompRef) (id label : String) : CompPlan :=
  match groupWindows s rs.toList [] with
  | .error e => .refused e.1 e.2
  | .ok ws =>
    if ws.length < 2 then .refused "windowIds" "name at least two windows to group"
    else if s.ids.contains id then .refused "groupId" s!"the ID \"{id}\" is taken"
    else .group (ws.map (·.id)).toArray id label (sharedParent ws)
      (emptiedGroups s ws (sharedParent ws)).toArray

/-- The plan of a composition step, from the committed scene alone. -/
def compositionPlan (s : CompScene) (step : CompStep) : CompPlan :=
  match step with
  | .detach r => compDetach s r
  | .move r t => compMove s r t
  | .merge r t => compMerge s r t
  | .regroup r t => compRegroup s r t
  | .group rs id label => compGroup s rs id label

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
leaves the window it left with the rest; that window is removed exactly when nothing is left,
which happens only when it holds no child node. -/
@[lungo_claim "lungo.law" subject compositionPlan]
theorem move_keeps_every_surface (s : CompScene) (r t : CompRef) (sf target source : String)
    (laidOut left : Array String)
    (h : compositionPlan s (.move r t) = .move sf target laidOut source left) :
    ∃ nt ns : CompNode, s.window? t.id = some nt ∧ s.window? (some source) = some ns ∧
      nt.id = target ∧ ns.id = source ∧ target ≠ source ∧ laidOut = nt.surfaceIds.push sf ∧
      left = ns.surfaceIds.filter (· != sf) ∧ (left.size = 0 → ns.childIds.size = 0) := by
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
          split at h
          · cases h
          · rename_i hkeep
            cases h
            have hid := (window?_some hns).1
            simp only [Option.some.injEq] at hid
            refine ⟨nt, ns, hnt, ?_, rfl, rfl, ?_, rfl, rfl, fun h0 => by omega⟩
            · rw [← hid]; exact hns
            · intro e
              apply hne
              rw [e, hid]

/-- Composition decides a window that holds child nodes the same way whichever step would empty
it: emptying a window removes it, so neither moving its last surface out nor merging it into
another empties it. Both are refused for the same reason, `holdsNodes`. -/
@[lungo_claim "lungo.law" subject compositionPlan]
theorem window_with_nodes_never_emptied (s : CompScene) (w : CompNode)
    (hw : s.window? (some w.id) = some w) (hn : w.childIds.size > 0) :
    (∀ r t sf target laidOut left,
      compositionPlan s (.move r t) = .move sf target laidOut w.id left → left.size ≠ 0) ∧
    (∀ r t target moved laidOut,
      compositionPlan s (.merge r t) ≠ .merge w.id target moved laidOut) := by
  constructor
  · intro r t sf target laidOut left h h0
    obtain ⟨-, ns, -, hns, -, -, -, -, -, hc⟩ := move_keeps_every_surface s r t sf target w.id laidOut left h
    rw [hw] at hns
    cases hns
    have := hc h0
    omega
  · intro r t target moved laidOut h
    obtain ⟨ns, -, hns, -, hid, -, -, hc, -, -⟩ := merge_keeps_every_surface s r t w.id target moved laidOut h
    have hs := (window?_some hns).2
    rw [hid, hw] at hs
    cases hs
    omega

/-- Moving the last surface out of a window that holds child nodes is refused on the surface, and
merging that window is refused on the window, both for the same reason. -/
@[lungo_claim "lungo.law" subject compositionPlan]
theorem emptying_refused_alike (s : CompScene) (r t : CompRef) (sf : CompSurface) (source : CompNode)
    (hsf : r.id.bind s.surface? = some sf) (hs : s.window? (some sf.owner) = some source)
    (ht : ∃ target, s.window? t.id = some target ∧ target.id ≠ sf.owner)
    (hlast : (source.surfaceIds.filter (· != sf.id)).size = 0) (hn : source.childIds.size > 0) :
    compositionPlan s (.move r t) = .refused "surfaceId" (holdsNodes source) ∧
      ∀ t' target', s.window? t'.id = some target' → target'.id ≠ source.id →
        compositionPlan s (.merge ⟨some source.id, source.id⟩ t') = .refused "windowId" (holdsNodes source) := by
  obtain ⟨target, htw, hne⟩ := ht
  have hsrc := window?_some hs
  constructor
  · simp only [compositionPlan, compMove, hsf, htw, hs]
    simp [hne, hlast, hn]
  · intro t' target' ht' hne'
    simp only [compositionPlan, compMerge, hsrc.2, ht']
    simp [hne', hn]

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

theorem groupable_window {s : CompScene} {r : CompRef} {n : CompNode}
    (h : groupable s r = .ok n) : s.window? (some n.id) = some n := by
  unfold groupable at h
  split at h
  · cases h
  · rename_i m hm
    split at h
    · split at h
      · cases h
      · cases h
        exact (window?_some hm).2
    · cases h
      exact (window?_some hm).2

theorem groupWindows_spec (s : CompScene) :
    ∀ (rs : List CompRef) (acc ws : List CompNode),
      (∀ n ∈ acc, s.window? (some n.id) = some n) → (acc.map (·.id)).Nodup →
      groupWindows s rs acc = .ok ws →
      (∀ n ∈ ws, s.window? (some n.id) = some n) ∧ (ws.map (·.id)).Nodup
  | [], acc, ws, ha, hd, h => by
    simp only [groupWindows, Except.ok.injEq] at h
    subst h
    exact ⟨ha, hd⟩
  | r :: rest, acc, ws, ha, hd, h => by
    simp only [groupWindows] at h
    split at h
    · cases h
    · rename_i n hn
      split at h
      · cases h
      · rename_i hnot
        refine groupWindows_spec s rest (acc ++ [n]) ws ?_ ?_ h
        · intro m hm
          simp only [List.mem_append, List.mem_singleton] at hm
          rcases hm with hm | hm
          · exact ha m hm
          · subst hm
            exact groupable_window hn
        · rw [List.map_append, List.nodup_append]
          refine ⟨hd, by simp, ?_⟩
          intro a ha' b hb heq
          simp only [List.map_cons, List.map_nil, List.mem_singleton] at hb
          subst hb heq
          apply hnot
          simp only [List.mem_map] at ha'
          obtain ⟨m, hm, hmid⟩ := ha'
          simp only [List.any_eq_true, beq_iff_eq]
          exact ⟨m, hm, hmid⟩

/-- Windows are gathered into a group only when at least two are named, each an active window
named once, and the new group's ID is the one asked for, which no node or surface holds. -/
@[lungo_claim "lungo.law" subject compositionPlan]
theorem group_gathers_named_windows (s : CompScene) (rs : Array CompRef) (id label gid glabel : String)
    (ws : Array String) (parentId : Option String) (removed : Array String)
    (h : compositionPlan s (.group rs id label) = .group ws gid glabel parentId removed) :
    2 ≤ ws.size ∧ ws.toList.Nodup ∧ (∀ w ∈ ws, ∃ n, s.window? (some w) = some n) ∧ gid = id ∧
      glabel = label ∧ gid ∉ s.ids := by
  simp only [compositionPlan, compGroup] at h
  split at h
  · cases h
  · rename_i nodes hn
    have spec := groupWindows_spec s rs.toList [] nodes (by simp) (by simp) hn
    split at h
    · cases h
    · rename_i hlen
      split at h
      · cases h
      · rename_i hid
        simp only [CompPlan.group.injEq] at h
        obtain ⟨hws, hgid, hlabel, -, -⟩ := h
        subst hws hgid hlabel
        refine ⟨by simp; omega, by simpa using spec.2, ?_, rfl, rfl, by simpa using hid⟩
        intro w hw
        simp only [List.mem_toArray, List.mem_map] at hw
        obtain ⟨n, hn', rfl⟩ := hw
        exact ⟨n, spec.1 n hn'⟩

/-- A group is removed with the windows gathered only when it is a group they came from that holds
no surface and no child but them, is not the group workspace orbit turns, and is not the one their
new group is made in. -/
@[lungo_claim "lungo.law" subject compositionPlan]
theorem group_removes_only_emptied (s : CompScene) (rs : Array CompRef) (id label gid glabel : String)
    (ws : Array String) (parentId : Option String) (removed : Array String)
    (h : compositionPlan s (.group rs id label) = .group ws gid glabel parentId removed) :
    ∀ g ∈ removed, ∃ left, s.node? g = some left ∧ left.kind = "group" ∧ s.orbitRootId ≠ some g ∧
      left.surfaceIds.size = 0 ∧ (∀ c ∈ left.childIds, c ∈ ws) ∧ parentId ≠ some g := by
  simp only [compositionPlan, compGroup] at h
  split at h
  · cases h
  · rename_i nodes _
    split at h
    · cases h
    · split at h
      · cases h
      · simp only [CompPlan.group.injEq] at h
        obtain ⟨hws, -, -, hp, hr⟩ := h
        subst hws hp hr
        intro g hg
        simp only [emptiedGroups, List.mem_toArray, List.mem_filter] at hg
        obtain ⟨-, hsel⟩ := hg
        unfold leftEmpty at hsel
        split at hsel
        · rename_i left hl
          simp only [Bool.and_eq_true, beq_iff_eq, bne_iff_ne, ne_eq] at hsel
          obtain ⟨⟨⟨⟨hk, horbit⟩, hsurf⟩, hkids⟩, hparent⟩ := hsel
          refine ⟨left, hl, hk, horbit, hsurf, ?_, hparent⟩
          intro c hc
          have hc' := Array.all_eq_true_iff_forall_mem.mp hkids c hc
          simp only [List.any_eq_true, beq_iff_eq] at hc'
          obtain ⟨n, hn, hid⟩ := hc'
          simp only [List.mem_toArray, List.mem_map]
          exact ⟨n, hn, hid⟩
        · cases hsel

end Swf.AppComposition
