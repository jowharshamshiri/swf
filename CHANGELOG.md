# Changelog of @swf/projections

Each release of @swf/projections and what it changed for those who use it. Versions follow semantic
versioning: before 1.0.0, a minor version may change the public API incompatibly and a patch
version never does; from 1.0.0, only a major version does.

## 0.1.0

The first release. The projection contract (forward and inverse mapping, placing surfaces as fragments, visibility, interaction rays), registration that validates a projection before use, and the equirectangular reference projection with seam-continuous inverse mapping.

The equirectangular projection has a pole band, `EQUIRECTANGULAR_POLE_BAND` (2⁻²⁶ radians), shared
by both directions of its mapping: a direction within it of straight up or down is `singular`,
imaged at the centre of its pole's row, and a point whose row lies within it of a pole unprojects
to the pole itself, with latitude ±π/2 and its column's longitude. Before, a direction counted as a
pole only within about 10⁻¹² radians, and a point a hair from the top or bottom edge could come back
from its own ray at another column. A view shows the poles when its vertical angle reaches the bands
(at least π − 2 × the band). A direction lies on a side edge or the seam to within 10⁻¹² radians of
arc rather than of longitude, so one near a pole keeps both its seam images.
