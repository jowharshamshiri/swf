# Changelog of @swf/backend-dom

Each release of @swf/backend-dom and what it changed for those who use it. Versions follow semantic
versioning: before 1.0.0, a minor version may change the public API incompatibly and a patch
version never does; from 1.0.0, only a major version does.

## 0.1.0

The first release. A browser-native presentation backend. Live DOM content stays browser-owned and natively interactive: it is placed by its projected corners with its fidelity declared, clipped, stacked explicitly and never mounted twice; window chrome sits in layers of its own and labels are text. It also draws a virtual cursor for input policies that move where input acts without moving the platform's pointer.
