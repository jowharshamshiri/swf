/-!
An order key for doubles, for the models whose claims are about order (the nearest snap, bands
that grow with distance). Lean states no ordering laws for `Float`, so a model compares the keys
of its numbers instead: for finite doubles, `floatKey a < floatKey b` exactly when `a < b`, and
`floatKey a = floatKey b` exactly when `a` and `b` are the same number (zero and minus zero have
the same key). A model checks its numbers are finite before it compares them by key.
-/
namespace Swf.Order

/-- The sign bit of a double's bits. -/
def signBit : UInt64 := 0x8000000000000000

/-- A double's order key: its bits as a whole number, negated (without the sign bit) for a
negative double, so keys order as the numbers do. -/
def floatKey (x : Float) : Int :=
  let bits := x.toBits
  if bits &&& signBit = 0 then (bits.toNat : Int)
  else -(((bits &&& ~~~signBit).toNat : Nat) : Int)

/-- The order key of a double's magnitude: the key of its absolute value. -/
def magnitudeKey (x : Float) : Nat := (x.toBits &&& ~~~signBit).toNat

end Swf.Order
