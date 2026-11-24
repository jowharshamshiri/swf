import Lungo

/-!
The scene kernel's lifecycle and transaction ledger (spec §13.1 and the transaction protocol).

The workspace keeps the scene's records; this model decides everything about them that is not
data: whether the workspace admits an operation, the order of a transaction's checks (replaying
a known idempotency key, refusing one reused for other commands, refusing a stale expected
revision), what a commit does to the revision, the undo and redo stacks and the idempotency
cache, and how disposal proceeds. The ledger counts what the workspace holds; the workspace
applies each decision to its records exactly as the model states it.
-/
namespace Swf.Kernel

/-- Where a workspace is in its life. `disposing` says whether its disposal has been announced
(the `workspace.disposed` event emitted). -/
inductive Lifecycle where
  | ready
  | disposing (announced : Bool)
  | disposed
deriving DecidableEq

/-- What the workspace counts of its history and caches, and its revision. -/
structure Ledger where
  lifecycle : Lifecycle
  revision : Nat
  /-- Committed layout transactions that can be undone. -/
  undo : Nat
  /-- Undone transactions that can be redone. -/
  redo : Nat
  undoCapacity : Nat
  /-- Idempotency keys remembered. -/
  keys : Nat
  keyCapacity : Nat

/-- Whether the workspace admits an operation: only while ready. Anything else is refused with
`WORKSPACE_DISPOSED`. -/
def admits (l : Lifecycle) : Bool := l = .ready

/-- A ready workspace with nothing in its history, at revision 0. -/
def initial (undoCapacity keyCapacity : Nat) : Ledger :=
  { lifecycle := .ready, revision := 0, undo := 0, redo := 0, undoCapacity, keys := 0, keyCapacity }

/-- Disposal starts: a ready workspace stops admitting operations; disposing again changes
nothing. -/
def dispose (l : Ledger) : Ledger :=
  match l.lifecycle with
  | .ready => { l with lifecycle := .disposing false }
  | _ => l

/-- What the workspace does once it has nothing left to deliver or run. -/
inductive IdleStep where
  /-- Announce the disposal (cancel open previews, emit `workspace.disposed`), then go on. -/
  | announce (next : Ledger)
  /-- Release everything: listeners, history, caches. The workspace is disposed. -/
  | finish (next : Ledger)
  /-- Nothing to do. -/
  | rest

def idle (l : Ledger) : IdleStep :=
  match l.lifecycle with
  | .disposing false => .announce { l with lifecycle := .disposing true }
  | .disposing true => .finish { l with lifecycle := .disposed, undo := 0, redo := 0, keys := 0 }
  | _ => .rest

/-- What a transaction asks before its commands are applied: whether its idempotency key is
known (`some same`, `same` saying whether the commands are the ones recorded under it), and the
revision it expects the scene to be at. -/
structure TxRequest where
  known : Option Bool
  expected : Option Nat

/-- The outcome of a transaction's checks, in the order they are made. -/
inductive TxGate where
  | proceed
  /-- The key was used for these same commands: the recorded result, replayed. -/
  | replay
  | refuseDisposed
  /-- The key was used for different commands: `INVALID_INPUT`. -/
  | refuseKeyReused
  /-- The scene is not at the expected revision: `CONFLICT`. -/
  | refuseStale

def gate (l : Ledger) (r : TxRequest) : TxGate :=
  if l.lifecycle ≠ .ready then .refuseDisposed
  else match r.known with
    | some true => .replay
    | some false => .refuseKeyReused
    | none =>
      match r.expected with
      | some e => if e = l.revision then .proceed else .refuseStale
      | none => .proceed

/-- What is committed. -/
inductive Change where
  /-- A transaction's commands; `layout` says whether they changed any node, surface or the root
  order (only such a commit is recorded for undo), `keyed` whether it carries an idempotency key. -/
  | commands (layout : Bool) (keyed : Bool)
  /-- A snapshot restored, at the revision it was taken at. -/
  | restore (layout : Bool) (snapshotRevision : Nat)

/-- What a commit does to the workspace's records. -/
structure Commit where
  next : Ledger
  /-- Forget what could be redone: the commit changed the layout. -/
  clearRedo : Bool
  /-- Record the commit for undo: it changed the layout and the workspace keeps an undo history. -/
  push : Bool
  /-- Then drop the oldest undo record: the stack is past its capacity. -/
  dropOldest : Bool
  /-- Forget this many of the oldest idempotency keys. -/
  evictKeys : Nat

def commit (l : Ledger) (c : Change) : Commit :=
  let layout := match c with | .commands layout _ => layout | .restore layout _ => layout
  let revision := match c with
    | .commands _ _ => l.revision + 1
    | .restore _ snapshot => max (l.revision + 1) snapshot
  let keyed := match c with | .commands _ keyed => keyed | .restore _ _ => false
  let push := layout && decide (l.undoCapacity > 0)
  let pushed := if push then l.undo + 1 else l.undo
  let dropOldest := push && decide (pushed > l.undoCapacity)
  let keys := if keyed then l.keys + 1 else l.keys
  let evict := if keyed then keys - l.keyCapacity else 0
  { next := { l with
      revision
      undo := if dropOldest then pushed - 1 else pushed
      redo := if layout then 0 else l.redo
      keys := keys - evict }
    clearRedo := layout
    push
    dropOldest
    evictKeys := evict }

inductive Direction where
  | undo
  | redo

/-- The outcome of an undo or redo. `stale` says whether anything the step would restore has
changed since it was recorded; it is read only when there is a step to take. -/
inductive Travel where
  /-- Restore the step as a new commit, moving its record to the other stack. -/
  | commit (next : Ledger)
  | refuseDisposed
  /-- There is nothing to undo or redo: `INVALID_INPUT`. -/
  | refuseEmpty
  /-- What the step would restore has changed since: `CONFLICT`, history left as it was. -/
  | refuseStale

def travel (l : Ledger) (d : Direction) (stale : Bool) : Travel :=
  if l.lifecycle ≠ .ready then .refuseDisposed
  else match d with
    | .undo =>
      if l.undo = 0 then .refuseEmpty
      else if stale then .refuseStale
      else .commit { l with revision := l.revision + 1, undo := l.undo - 1, redo := l.redo + 1 }
    | .redo =>
      if l.redo = 0 then .refuseEmpty
      else if stale then .refuseStale
      else .commit { l with revision := l.revision + 1, undo := l.undo + 1, redo := l.redo - 1 }

/-- Whether an undo or redo is possible now. -/
def canTravel (l : Ledger) (d : Direction) : Bool :=
  admits l.lifecycle && match d with | .undo => l.undo > 0 | .redo => l.redo > 0

/-! ## Invariants -/

/-- The ledger's bounds: history never holds more than its capacity (undo and redo together), and
the idempotency cache never more keys than its own. -/
def Bounded (l : Ledger) : Prop := l.undo + l.redo ≤ l.undoCapacity ∧ l.keys ≤ l.keyCapacity

/-- A new workspace is ready, at revision 0, with nothing in its history or caches. -/
@[lungo_claim "lungo.law" subject initial]
theorem initial_bounded (u k : Nat) :
    (initial u k).lifecycle = .ready ∧ (initial u k).revision = 0 ∧ Bounded (initial u k) := by
  simp [initial, Bounded]

/-- Only a ready workspace admits an operation. -/
@[lungo_claim "lungo.decides" subject admits]
theorem admits_iff_ready (l : Lifecycle) : admits l = true ↔ l = .ready := by
  simp [admits]

/-- A disposed workspace stays disposed: disposing it again and running out of work change
nothing, and it refuses every transaction, undo and redo. -/
@[lungo_claim "lungo.law" subject dispose idle gate travel]
theorem disposed_absorbing (l : Ledger) (h : l.lifecycle = .disposed) (r : TxRequest)
    (d : Direction) (stale : Bool) :
    dispose l = l ∧ idle l = .rest ∧ gate l r = .refuseDisposed ∧
      travel l d stale = .refuseDisposed := by
  simp [dispose, idle, gate, travel, h]

/-- Disposal goes `ready → disposing → (announced) → disposed`, and nowhere else: from a ready
workspace, disposing and then running out of work twice announces, then finishes with nothing
left in its history or caches. -/
@[lungo_claim "lungo.law" subject dispose idle]
theorem dispose_order (l : Ledger) (h : l.lifecycle = .ready) :
    idle l = .rest ∧
      idle (dispose l) = .announce { l with lifecycle := .disposing true } ∧
      idle { l with lifecycle := .disposing true } =
        .finish { l with lifecycle := .disposed, undo := 0, redo := 0, keys := 0 } := by
  simp [dispose, idle, h]

/-- Whether the workspace still delivers what it holds (events held for the next frame): until it
is disposed. -/
def delivers (l : Lifecycle) : Bool := l ≠ .disposed

@[lungo_claim "lungo.decides" subject delivers]
theorem delivers_iff (l : Lifecycle) : delivers l = true ↔ l ≠ .disposed := by
  simp [delivers]

/-- A disposing or disposed workspace refuses every transaction before looking at it. -/
@[lungo_claim "lungo.law" subject gate]
theorem not_ready_refuses (l : Ledger) (r : TxRequest) (h : l.lifecycle ≠ .ready) :
    gate l r = .refuseDisposed := by
  simp [gate, h]

/-- A ready workspace replays a known key used for the same commands, whatever revision it
expected; refuses one used for other commands; and otherwise proceeds exactly when the scene is
at the expected revision (or none is expected). -/
@[lungo_claim "lungo.law" subject gate]
theorem gate_order (l : Ledger) (h : l.lifecycle = .ready) (e : Option Nat) :
    gate l ⟨some true, e⟩ = .replay ∧ gate l ⟨some false, e⟩ = .refuseKeyReused ∧
      (gate l ⟨none, e⟩ = .proceed ↔ e = none ∨ e = some l.revision) := by
  refine ⟨by simp [gate, h], by simp [gate, h], ?_⟩
  cases e with
  | none => simp [gate, h]
  | some v => by_cases hv : v = l.revision <;> simp [gate, h, hv]

/-- A commit of commands moves the revision on by exactly one; a restore moves it on by at least
one and never below the snapshot's. -/
@[lungo_claim "lungo.law" subject commit]
theorem commit_advances_revision (l : Ledger) (layout keyed : Bool) (s : Nat) :
    (commit l (.commands layout keyed)).next.revision = l.revision + 1 ∧
      l.revision + 1 ≤ (commit l (.restore layout s)).next.revision ∧
      s ≤ (commit l (.restore layout s)).next.revision := by
  simp [commit]; omega

/-- A commit that changes the layout is recorded and leaves nothing to redo; one that does not
leaves the history as it was. -/
@[lungo_claim "lungo.law" subject commit]
theorem commit_history (l : Ledger) (c : Change) :
    let r := commit l c
    (r.clearRedo = true → r.next.redo = 0) ∧
      (r.clearRedo = false → r.next.undo = l.undo ∧ r.next.redo = l.redo ∧ r.push = false ∧
        r.dropOldest = false) := by
  cases c <;> rename_i layout _ <;> cases layout <;> simp [commit]

/-- The counts move exactly as the workspace's records do when it applies a commit's effects: one
undo record pushed when `push`, the oldest dropped when `dropOldest`, the redo stack emptied when
`clearRedo`, one key remembered for a keyed commit and `evictKeys` of the oldest forgotten. -/
@[lungo_claim "lungo.law" subject commit]
theorem commit_mirrors_records (l : Ledger) (layout keyed : Bool) (s : Nat) :
    (let r := commit l (.commands layout keyed)
     r.next.undo + (if r.dropOldest then 1 else 0) = l.undo + (if r.push then 1 else 0) ∧
       r.next.redo = (if r.clearRedo then 0 else l.redo) ∧
       r.next.keys + r.evictKeys = l.keys + (if keyed then 1 else 0)) ∧
    (let r := commit l (.restore layout s)
     r.next.undo + (if r.dropOldest then 1 else 0) = l.undo + (if r.push then 1 else 0) ∧
       r.next.redo = (if r.clearRedo then 0 else l.redo) ∧
       r.next.keys = l.keys ∧ r.evictKeys = 0) := by
  simp only [commit]
  refine ⟨⟨?_, ?_, ?_⟩, ⟨?_, ?_, ?_, ?_⟩⟩ <;> (try split) <;> (try split) <;> simp_all <;> omega

/-- Every commit keeps the ledger within its bounds, given capacities as the workspace accepts
them (an idempotency cache of at least one key). -/
@[lungo_claim "lungo.law" subject commit]
theorem commit_bounded (l : Ledger) (c : Change) (hb : Bounded l) :
    Bounded (commit l c).next := by
  cases c with
  | commands layout keyed =>
    cases layout <;> cases keyed <;>
      by_cases h1 : l.undoCapacity > 0 <;> by_cases h2 : l.undo + 1 > l.undoCapacity <;>
      simp_all [commit, Bounded] <;> (try split) <;> omega
  | restore layout s =>
    cases layout <;>
      by_cases h1 : l.undoCapacity > 0 <;> by_cases h2 : l.undo + 1 > l.undoCapacity <;>
      simp_all [commit, Bounded] <;> (try split) <;> omega

/-- Undo and redo move one record between the stacks, keep the ledger within its bounds, and
refuse to move anything from an empty stack or when what they would restore has changed. -/
@[lungo_claim "lungo.law" subject travel]
theorem travel_moves_one (l : Ledger) (d : Direction) (stale : Bool) (next : Ledger)
    (hb : Bounded l) (h : travel l d stale = .commit next) :
    stale = false ∧ next.revision = l.revision + 1 ∧ next.undo + next.redo = l.undo + l.redo ∧
      Bounded next := by
  obtain ⟨hu, hk⟩ := hb
  unfold travel at h
  split at h
  · cases h
  · cases d <;> simp only at h <;> split at h <;> (try cases h) <;> split at h <;> cases h <;>
      simp_all [Bounded] <;> omega

/-- An undo or redo is offered exactly when one would not be refused as disposed or empty. -/
@[lungo_claim "lungo.law" subject canTravel travel]
theorem can_travel_iff (l : Ledger) (d : Direction) :
    canTravel l d = true ↔ (travel l d false ≠ .refuseDisposed ∧ travel l d false ≠ .refuseEmpty) := by
  cases hl : l.lifecycle <;> cases d <;> simp [canTravel, travel, admits, hl] <;> split <;> simp_all <;> omega

end Swf.Kernel
