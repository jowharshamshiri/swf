# Changelog of @swf/backend-dom

Each release of @swf/backend-dom and what it changed for those who use it. Versions follow semantic
versioning: before 1.0.0, a minor version may change the public API incompatibly and a patch
version never does; from 1.0.0, only a major version does.

## 0.1.0

The first release. A browser-native presentation backend. Live DOM content stays browser-owned and natively interactive: it is placed by its projected corners with its fidelity declared, clipped, stacked explicitly and never mounted twice; window chrome sits in layers of its own and labels are text. It also draws a virtual cursor for input policies that move where input acts without moving the platform's pointer.

`createDomInput` returns a `DomInput`, whose `pointerLock` locks the pointer to the view's root
for a drag that must go on past the screen's edge: `available` says whether the platform offers it,
`request` asks for it and `exit` lets it go, and `subscribe` hears each answer and change
(`locked`, `refused`, `unlocked`), a request's answer never arriving during the request. While the lock holds, each
pointer intent carries the platform's `movement`; disconnecting the input lets a held lock go.
