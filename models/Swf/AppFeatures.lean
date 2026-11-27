import Lungo
import Swf.Json

/-!
The reference application's feature settings: its eight behaviour modules, each turned on or off on
its own, and the parameters of magnetic positioning and semantic depth. A change arrives as an
untyped patch (from a command, a form or a saved file); this model validates it as a whole against
the settings it changes and says which parts change, or which field it refuses and why. Only what
a patch names changes, and a refused patch changes nothing.
-/
namespace Swf.AppFeatures

open Swf (Json)

/-- Each module on or off. -/
structure FeatureFlags where
  /-- Focus and context, the Focus view mode. -/
  focus : Bool
  /-- Workspace orbit. -/
  orbit : Bool
  /-- The spatial map, the Map view mode. -/
  map : Bool
  /-- The wrapped cursor. -/
  cursor : Bool
  /-- Magnetic positioning. -/
  snap : Bool
  /-- Semantic depth. -/
  depth : Bool
  /-- Detaching, moving and merging surfaces, and regrouping windows. -/
  composition : Bool
  /-- Saving the workspace as it changes, named workspaces, import and export. -/
  persistence : Bool
deriving DecidableEq

/-- Magnetic positioning's thresholds: world units within which an edge snaps, degrees within
which a centre lines up, world units of gap kept between snapped edges, degrees between the spokes
a window's heading snaps to, and world units within which its distance snaps to a ring. -/
structure SnapSettings where
  /-- World units within which an edge snaps to a neighbour's; finite, zero or more. -/
  linear : Float
  /-- Degrees within which a window's centre lines up with a neighbour's or the horizon; finite,
  zero to 15. -/
  angular : Float
  /-- World units of gap kept between snapped edges; finite, zero or more. -/
  padding : Float
  /-- Degrees between the spokes round the camera a window's heading snaps to, within the angular
  threshold; finite, zero (no spokes) to 90. -/
  spoke : Float
  /-- World units within which a window's distance from the camera snaps to a ring; finite, zero
  (no rings) or more. -/
  ring : Float

/-- Semantic depth's bands, in world units from the camera along the floor: a window nearer than
`full` shows its content, one nearer than `compact` a compact preview, and one farther its label
alone. -/
structure DepthBands where
  /-- Where the full band ends, in world units; finite and above zero. -/
  full : Float
  /-- Where the compact band ends, in world units; finite, and farther than `full`. -/
  compact : Float

/-- The reference application's feature settings: which modules are on, and the parameters of
magnetic positioning and semantic depth. -/
structure FeatureSettings where
  /-- Each module on or off. -/
  enabled : FeatureFlags
  /-- Magnetic positioning's thresholds. -/
  snap : SnapSettings
  /-- Semantic depth's bands. -/
  depth : DepthBands

/-- What is wrong with a refused field. -/
inductive FeatureFault where
  /-- It must be an object. -/
  | notObject
  /-- It is not a setting; `settings` are the ones there are. -/
  | unknown (settings : List String)
  /-- It must be true or false. -/
  | notBoolean
  /-- It must be a finite number, zero or more. -/
  | notNonNegative
  /-- It must be a finite number above zero. -/
  | notPositive
  /-- It must be at most `max` degrees. -/
  | tooWide (max : Float)
  /-- The compact band must end farther than the full one. -/
  | bandsOutOfOrder (full compact : Float)

/-- The outcome of a patch: the field refused and why, or each part of the settings that changes
(none for a part that stays as it is). -/
inductive FeaturesUpdate where
  /-- The patch is refused and nothing changes: `field` is the path of the first field at fault
  (`features` for the patch itself, else such as `enabled.map` or `snap.angular`), `fault` what
  is wrong with it. -/
  | refused (field : String) (fault : FeatureFault)
  /-- The patch is admitted: each part's new value, or `none` for a part that stays as it is. -/
  | updated (enabled : Option FeatureFlags) (snap : Option SnapSettings) (depth : Option DepthBands)

/-- The largest angular snap threshold, in degrees: beyond it everything would snap to
everything. -/
def maxAngularSnap : Float := 15

/-- The widest spacing of spokes, in degrees: a quarter turn. -/
def maxSpoke : Float := 90

/-- The modules, by stable ID, in the order the specification lists them. -/
def featureIds : List String :=
  ["focus", "orbit", "map", "cursor", "snap", "depth", "composition", "persistence"]

/-- A module's flag set, by ID. -/
def FeatureFlags.set (f : FeatureFlags) (id : String) (on : Bool) : FeatureFlags :=
  match id with
  | "focus" => { f with focus := on }
  | "orbit" => { f with orbit := on }
  | "map" => { f with map := on }
  | "cursor" => { f with cursor := on }
  | "snap" => { f with snap := on }
  | "depth" => { f with depth := on }
  | "composition" => { f with composition := on }
  | "persistence" => { f with persistence := on }
  | _ => f

/-- A check of part of a patch: its value, or the field refused and why. -/
abbrev Checked := Except (String × FeatureFault)

/-- The value of an object's member, if it has one. -/
def member (ms : Array (String × Json)) (key : String) : Option Json :=
  (ms.find? (·.1 == key)).map (·.2)

def record (v : Json) (field : String) : Checked (Array (String × Json)) :=
  match v with
  | .obj ms => .ok ms
  | _ => .error (field, .notObject)

/-- Refuses the first member that is not one of `keys`. -/
def known (ms : Array (String × Json)) (keys : List String) (field : String) : Checked Unit :=
  match ms.find? (fun m => !keys.contains m.1) with
  | some m => .error (field ++ "." ++ m.1, .unknown keys)
  | none => .ok ()

/-- A finite number, zero or more. -/
def nonNegativeOk (x : Float) : Bool := x.isFinite && !(x < 0)

/-- A finite number above zero. -/
def positiveOk (x : Float) : Bool := x.isFinite && !(x ≤ 0)

/-- A member's number, checked by `ok`, or the current value when the member is absent. -/
def number (ms : Array (String × Json)) (key field : String) (ok : Float → Bool)
    (fault : FeatureFault) (current : Float) : Checked Float :=
  match member ms key with
  | none => .ok current
  | some (.num x) => if ok x then .ok x else .error (field, fault)
  | some _ => .error (field, fault)

/-- The flags a patch's `enabled` object sets: every member must be a module, and each module it
names must be true or false. -/
def flagsCheck (current : FeatureFlags) (v : Json) : Checked FeatureFlags := do
  let ms ← record v "enabled"
  known ms featureIds "enabled"
  featureIds.foldlM (init := current) fun f id =>
    match member ms id with
    | none => .ok f
    | some (.bool on) => .ok (f.set id on)
    | some _ => .error ("enabled." ++ id, .notBoolean)

/-- The snap settings a patch's `snap` object sets. -/
def snapCheck (current : SnapSettings) (v : Json) : Checked SnapSettings := do
  let ms ← record v "snap"
  known ms ["linear", "angular", "padding", "spoke", "ring"] "snap"
  let linear ← number ms "linear" "snap.linear" nonNegativeOk .notNonNegative current.linear
  let angular ← number ms "angular" "snap.angular" nonNegativeOk .notNonNegative current.angular
  let padding ← number ms "padding" "snap.padding" nonNegativeOk .notNonNegative current.padding
  let spoke ← number ms "spoke" "snap.spoke" nonNegativeOk .notNonNegative current.spoke
  let ring ← number ms "ring" "snap.ring" nonNegativeOk .notNonNegative current.ring
  if angular > maxAngularSnap then .error ("snap.angular", .tooWide maxAngularSnap)
  else if spoke > maxSpoke then .error ("snap.spoke", .tooWide maxSpoke)
  else .ok { linear, angular, padding, spoke, ring }

/-- The bands a patch's `depth` object sets; when they end out of order, the field refused is the
one the patch named last of the two (compact, unless it named full alone). -/
def depthCheck (current : DepthBands) (v : Json) : Checked DepthBands := do
  let ms ← record v "depth"
  known ms ["full", "compact"] "depth"
  let full ← number ms "full" "depth.full" positiveOk .notPositive current.full
  let compact ← number ms "compact" "depth.compact" positiveOk .notPositive current.compact
  if !(compact > full) then
    .error ((if (member ms "compact").isNone then "depth.full" else "depth.compact"),
      .bandsOutOfOrder full compact)
  else .ok { full, compact }

/-- A section of the patch, checked when the patch names it. -/
def section? {α : Type} (ms : Array (String × Json)) (key : String) (check : Json → Checked α) :
    Checked (Option α) :=
  match member ms key with
  | none => .ok none
  | some v => (check v).map some

/-- Whether two numbers are the same number: the same bits. -/
def sameNumber (a b : Float) : Bool := a.toBits == b.toBits

def SnapSettings.same (a b : SnapSettings) : Bool :=
  sameNumber a.linear b.linear && sameNumber a.angular b.angular && sameNumber a.padding b.padding &&
    sameNumber a.spoke b.spoke && sameNumber a.ring b.ring

def DepthBands.same (a b : DepthBands) : Bool :=
  sameNumber a.full b.full && sameNumber a.compact b.compact

/-- The keys of a patch. -/
def patchKeys : List String := ["enabled", "snap", "depth"]

/-- The settings a patch sets, each section checked in turn. -/
def featuresCheck (current : FeatureSettings) (patch : Json) :
    Checked (Option FeatureFlags × Option SnapSettings × Option DepthBands) := do
  let ms ← record patch "features"
  known ms patchKeys "features"
  let enabled ← section? ms "enabled" (flagsCheck current.enabled)
  let snap ← section? ms "snap" (snapCheck current.snap)
  let depth ← section? ms "depth" (depthCheck current.depth)
  pure (enabled, snap, depth)

/-- The settings with a patch applied, validated as a whole: the first field at fault, or the
parts that change. A part the patch names but sets to the values it has stays as it is. -/
def featuresUpdate (current : FeatureSettings) (patch : Json) : FeaturesUpdate :=
  match featuresCheck current patch with
  | .error (field, fault) => .refused field fault
  | .ok (enabled, snap, depth) =>
    .updated (enabled.filter (· ≠ current.enabled)) (snap.filter (!·.same current.snap))
      (depth.filter (!·.same current.depth))

/-! ## Invariants -/

def SnapSettings.valid (s : SnapSettings) : Bool :=
  nonNegativeOk s.linear && nonNegativeOk s.angular && !(s.angular > maxAngularSnap) &&
    nonNegativeOk s.padding && nonNegativeOk s.spoke && !(s.spoke > maxSpoke) && nonNegativeOk s.ring

def DepthBands.valid (d : DepthBands) : Bool :=
  positiveOk d.full && positiveOk d.compact && d.compact > d.full

theorem number_ok {ms : Array (String × Json)} {key field : String} {ok : Float → Bool}
    {fault : FeatureFault} {current x : Float} (hc : ok current = true)
    (h : number ms key field ok fault current = .ok x) : ok x = true := by
  unfold number at h
  split at h
  · cases h; exact hc
  · split at h
    · cases h; assumption
    · cases h
  · cases h

theorem snapCheck_valid {current s : SnapSettings} {v : Json} (hc : current.valid = true)
    (h : snapCheck current v = .ok s) : s.valid = true := by
  simp only [SnapSettings.valid, Bool.and_eq_true] at hc
  obtain ⟨⟨⟨⟨⟨⟨hl, ha⟩, -⟩, hp⟩, hs⟩, -⟩, hr⟩ := hc
  unfold snapCheck at h
  simp only [bind, Except.bind] at h
  split at h; · cases h
  split at h; · cases h
  split at h; · cases h
  rename_i l hl'
  split at h; · cases h
  rename_i a ha'
  split at h; · cases h
  rename_i p hp'
  split at h; · cases h
  rename_i sp hs'
  split at h; · cases h
  rename_i r hr'
  split at h
  · cases h
  · split at h
    · cases h
    · cases h
      simp_all [SnapSettings.valid, number_ok hl hl', number_ok ha ha', number_ok hp hp',
        number_ok hs hs', number_ok hr hr']

theorem depthCheck_valid {current d : DepthBands} {v : Json} (hc : current.valid = true)
    (h : depthCheck current v = .ok d) : d.valid = true := by
  simp only [DepthBands.valid, Bool.and_eq_true] at hc
  obtain ⟨⟨hf, hk⟩, -⟩ := hc
  unfold depthCheck at h
  simp only [bind, Except.bind] at h
  split at h; · cases h
  split at h; · cases h
  split at h; · cases h
  rename_i f hf'
  split at h; · cases h
  rename_i k hk'
  split at h
  · cases h
  · cases h
    simp_all [DepthBands.valid, number_ok hf hf', number_ok hk hk']

theorem section_ok {α : Type} {ms : Array (String × Json)} {key : String} {check : Json → Checked α}
    {a : α} (h : section? ms key check = .ok (some a)) : ∃ v, member ms key = some v ∧ check v = .ok a := by
  unfold section? at h
  split at h
  · cases h
  · rename_i v hv
    cases hcv : check v <;> simp_all [Except.map]

theorem featuresCheck_ok {current : FeatureSettings} {patch : Json}
    {e : Option FeatureFlags} {s : Option SnapSettings} {d : Option DepthBands}
    (h : featuresCheck current patch = .ok (e, s, d)) :
    ∃ ms, patch = .obj ms ∧ known ms patchKeys "features" = .ok () ∧
      section? ms "enabled" (flagsCheck current.enabled) = .ok e ∧
      section? ms "snap" (snapCheck current.snap) = .ok s ∧
      section? ms "depth" (depthCheck current.depth) = .ok d := by
  unfold featuresCheck at h
  simp only [bind, Except.bind, pure, Except.pure] at h
  split at h; · cases h
  rename_i ms hms
  split at h; · cases h
  rename_i u hk
  split at h; · cases h
  rename_i e' he
  split at h; · cases h
  rename_i s' hs
  split at h; · cases h
  rename_i d' hd
  cases h
  refine ⟨ms, ?_, hk, he, hs, hd⟩
  unfold record at hms
  split at hms <;> simp_all

/-- Settings that were valid stay valid: every snap threshold a finite number, zero or more, the
angular one at most `maxAngularSnap` degrees and the spokes at most `maxSpoke` apart, and both depth bands above zero with the compact
one ending farther. -/
@[lungo_claim "lungo.law" subject featuresUpdate]
theorem accepted_settings_valid (current : FeatureSettings) (patch : Json)
    (e : Option FeatureFlags) (s : Option SnapSettings) (d : Option DepthBands)
    (hs : current.snap.valid = true) (hd : current.depth.valid = true)
    (h : featuresUpdate current patch = .updated e s d) :
    (s.getD current.snap).valid = true ∧ (d.getD current.depth).valid = true := by
  unfold featuresUpdate at h
  split at h
  · cases h
  · rename_i e' s' d' hc
    cases h
    obtain ⟨ms, -, -, -, hs', hd'⟩ := featuresCheck_ok hc
    constructor
    · cases s' with
      | none => simpa using hs
      | some x =>
        obtain ⟨_, -, hx⟩ := section_ok hs'
        by_cases hx' : (!x.same current.snap) = true <;> simp [Option.filter, hx', hs, snapCheck_valid hs hx]
    · cases d' with
      | none => simpa using hd
      | some x =>
        obtain ⟨_, -, hx⟩ := section_ok hd'
        by_cases hx' : (!x.same current.depth) = true <;> simp [Option.filter, hx', hd, depthCheck_valid hd hx]

/-- A patch that is not an object is refused as a whole. -/
@[lungo_claim "lungo.law" subject featuresUpdate]
theorem not_object_refused (current : FeatureSettings) (patch : Json)
    (h : ∀ ms, patch ≠ .obj ms) : featuresUpdate current patch = .refused "features" .notObject := by
  cases patch <;> simp_all [featuresUpdate, featuresCheck, record, bind, Except.bind]

/-- A patch naming anything but the three sections is refused, naming the first such member. -/
@[lungo_claim "lungo.law" subject featuresUpdate]
theorem unknown_field_refused (current : FeatureSettings) (ms : Array (String × Json))
    (m : String × Json) (h : ms.find? (fun m => !patchKeys.contains m.1) = some m) :
    featuresUpdate current (.obj ms) = .refused ("features" ++ "." ++ m.1) (.unknown patchKeys) := by
  simp only [featuresUpdate, featuresCheck, record, known, h, bind, Except.bind]

/-- A patch is applied whole or not at all: one whose snap or depth section is refused is
refused, whatever else it holds. -/
@[lungo_claim "lungo.law" subject featuresUpdate]
theorem refused_patch_atomic (current : FeatureSettings) (ms : Array (String × Json))
    (e : Option FeatureFlags) (s : Option SnapSettings) (d : Option DepthBands)
    (h : featuresUpdate current (.obj ms) = .updated e s d) :
    (∀ v, member ms "enabled" = some v → ∃ f, flagsCheck current.enabled v = .ok f) ∧
      (∀ v, member ms "snap" = some v → ∃ x, snapCheck current.snap v = .ok x) ∧
      (∀ v, member ms "depth" = some v → ∃ x, depthCheck current.depth v = .ok x) := by
  unfold featuresUpdate at h
  split at h
  · cases h
  · rename_i e' s' d' hc
    obtain ⟨ms', hm, -, he, hs, hd⟩ := featuresCheck_ok hc
    cases hm
    refine ⟨fun v hv => ?_, fun v hv => ?_, fun v hv => ?_⟩
    · unfold section? at he; rw [hv] at he
      cases hf : flagsCheck current.enabled v <;> simp_all [Except.map]
    · unfold section? at hs; rw [hv] at hs
      cases hf : snapCheck current.snap v <;> simp_all [Except.map]
    · unfold section? at hd; rw [hv] at hd
      cases hf : depthCheck current.depth v <;> simp_all [Except.map]

/-- A patch that names nothing changes nothing. -/
@[lungo_claim "lungo.law" subject featuresUpdate]
theorem empty_patch_unchanged (current : FeatureSettings) :
    featuresUpdate current (.obj #[]) = .updated none none none := by
  simp [featuresUpdate, featuresCheck, record, known, section?, member, bind, Except.bind, pure,
    Except.pure]

/-- A part said to change differs from the part it replaces, so a part set to the values it has
stays the very same part. -/
@[lungo_claim "lungo.law" subject featuresUpdate]
theorem changed_parts_differ (current : FeatureSettings) (patch : Json)
    (e : Option FeatureFlags) (s : Option SnapSettings) (d : Option DepthBands)
    (h : featuresUpdate current patch = .updated e s d) :
    (∀ f, e = some f → f ≠ current.enabled) ∧ (∀ x, s = some x → x.same current.snap = false) ∧
      (∀ x, d = some x → x.same current.depth = false) := by
  unfold featuresUpdate at h
  split at h
  · cases h
  · cases h
    refine ⟨fun f hf => ?_, fun x hx => ?_, fun x hx => ?_⟩
    · simp only [Option.filter_eq_some_iff] at hf; simp_all
    · simp only [Option.filter_eq_some_iff] at hx; simp_all
    · simp only [Option.filter_eq_some_iff] at hx; simp_all

end Swf.AppFeatures
