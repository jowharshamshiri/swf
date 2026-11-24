/-!
JSON values, as the models receive what a host passed untyped (a settings patch, a projection's
configuration). Numbers are IEEE doubles, as in JavaScript; an object keeps its members in the
order the host gave them.
-/
namespace Swf

inductive Json where
  | null
  | bool (value : Bool)
  | num (value : Float)
  | str (value : String)
  | arr (items : Array Json)
  | obj (members : Array (String × Json))

end Swf
