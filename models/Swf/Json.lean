/-!
JSON values, as the models receive what a host passed untyped (a settings patch, a projection's
configuration). Numbers are IEEE doubles, as in JavaScript; an object keeps its members in the
order the host gave them.
-/
namespace Swf

/-- A JSON value, as the host passed it. -/
inductive Json where
  /-- `null`. -/
  | null
  /-- A boolean. -/
  | bool (value : Bool)
  /-- A number, an IEEE double. -/
  | num (value : Float)
  /-- A string. -/
  | str (value : String)
  /-- An array, its items in order. -/
  | arr (items : Array Json)
  /-- An object, its members (name and value) in the order the host gave them. -/
  | obj (members : Array (String × Json))

end Swf
