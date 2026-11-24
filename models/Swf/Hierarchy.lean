import Lungo

/-!
The scene hierarchy's structural rules, as a transaction's commands are validated: a node may
never become its own ancestor (reparenting, grouping), and a locked entity refuses what a user
would do to it.
-/
namespace Swf.Hierarchy

/-- Whether `ancestor` is the node itself or one of its ancestors, given the node's chain: the node
first, then its ancestors, nearest first. -/
def selfOrAncestor (ancestor : String) (chain : List String) : Bool := chain.contains ancestor

/-- Whether `node` may be placed under the parent whose chain (the parent, then its ancestors) is
`parentChain`: only when that does not make it its own ancestor. -/
def mayParent (node : String) (parentChain : List String) : Bool := !selfOrAncestor node parentChain

/-- Whether a command is refused because what it changes is locked: only a user's command is, and
only on a locked entity. A host or system command may still change it. -/
def lockRefuses (byUser locked : Bool) : Bool := byUser && locked

@[lungo_claim "lungo.decides" subject selfOrAncestor]
theorem selfOrAncestor_iff (ancestor : String) (chain : List String) :
    selfOrAncestor ancestor chain = true ↔ ancestor ∈ chain := by
  simp [selfOrAncestor]

/-- The hierarchy stays acyclic: a node placed under a parent it may be placed under has a chain
with no node twice, when the parent's had none. -/
@[lungo_claim "lungo.law" subject mayParent]
theorem mayParent_keeps_acyclic (node : String) (parentChain : List String)
    (h : mayParent node parentChain = true) (acyclic : parentChain.Nodup) :
    (node :: parentChain).Nodup := by
  simp [mayParent, selfOrAncestor] at h
  exact List.nodup_cons.mpr ⟨h, acyclic⟩

/-- A node may never be placed under itself or under one of its own descendants (whose chains
contain it). -/
@[lungo_claim "lungo.law" subject mayParent]
theorem mayParent_refuses_own_line (node : String) (parentChain : List String)
    (h : node ∈ parentChain) : mayParent node parentChain = false := by
  simp [mayParent, selfOrAncestor, h]

@[lungo_claim "lungo.decides" subject lockRefuses]
theorem lockRefuses_iff (byUser locked : Bool) :
    lockRefuses byUser locked = true ↔ byUser = true ∧ locked = true := by
  simp [lockRefuses]

/-- The first member (by position) that is inside another member, with that member: members are
given with their chains (the member, then its ancestors). Grouping such members would put a node
under its own descendant's group. -/
def nestedMember (members : Array (String × List String)) : Option (Nat × Nat) :=
  (List.range members.size).findSome? fun i =>
    ((List.range members.size).find? fun j =>
        j != i && (members[i]!).2.contains (members[j]!).1).map fun j => (i, j)

/-- The first member (by position) in `chain`: a group placed under the parent whose chain this
is would be inside its own member. -/
def memberInChain (members : Array String) (chain : List String) : Option Nat :=
  (List.range members.size).find? fun i => chain.contains members[i]!

/-- No member found nested means none is inside another. -/
@[lungo_claim "lungo.law" subject nestedMember]
theorem nestedMember_none (members : Array (String × List String))
    (h : nestedMember members = none) (i j : Nat) (hi : i < members.size) (hj : j < members.size)
    (hij : i ≠ j) : (members[j]!).1 ∉ (members[i]!).2 := by
  simp only [nestedMember, List.findSome?_eq_none_iff, Option.map_eq_none_iff,
    List.find?_eq_none, List.mem_range] at h
  simp_all
  exact h i hi j hj (by omega)

/-- A member found nested is inside the other member it names. -/
@[lungo_claim "lungo.law" subject nestedMember]
theorem nestedMember_some (members : Array (String × List String)) (i j : Nat)
    (h : nestedMember members = some (i, j)) :
    i ≠ j ∧ (members[j]!).1 ∈ (members[i]!).2 := by
  simp only [nestedMember, List.findSome?_eq_some_iff] at h
  obtain ⟨_, _, _, _, hm, _⟩ := h
  simp only [Option.map_eq_some_iff, List.find?_eq_some_iff_append] at hm
  obtain ⟨j', ⟨hp, _⟩, hj⟩ := hm
  cases hj
  simp_all [bne_iff_ne]
  omega

/-- With no member in the chain of the group's parent, every member may be placed under it: the
hierarchy stays acyclic. -/
@[lungo_claim "lungo.law" subject memberInChain]
theorem memberInChain_none (members : Array String) (chain : List String)
    (h : memberInChain members chain = none) (i : Nat) (hi : i < members.size) :
    mayParent members[i]! chain = true := by
  simp only [memberInChain, List.find?_eq_none, List.mem_range] at h
  simpa [mayParent, selfOrAncestor] using h i hi

/-- A member found in the chain is in it. -/
@[lungo_claim "lungo.law" subject memberInChain]
theorem memberInChain_some (members : Array String) (chain : List String) (i : Nat)
    (h : memberInChain members chain = some i) : members[i]! ∈ chain := by
  simp only [memberInChain, List.find?_eq_some_iff_append] at h
  obtain ⟨hp, _⟩ := h
  simpa using hp

end Swf.Hierarchy
