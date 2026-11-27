# Changelog of @swf/backend-dom

Each release of @swf/backend-dom and what it changed for those who use it. Versions follow semantic
versioning: before 1.0.0, a minor version may change the public API incompatibly and a patch
version never does; from 1.0.0, only a major version does.

## 0.1.0

The first release. A browser-native presentation backend. Live DOM content stays browser-owned and natively interactive: it is placed flat on its window's card by a translation and a scale, its fidelity declared, clipped, stacked explicitly and never mounted twice; window chrome sits in layers of its own and labels are text. It also draws a virtual cursor for input policies that move where input acts without moving the platform's pointer.

`createDomInput` returns a `DomInput`, whose `pointerLock` locks the pointer to the view's root
for a drag that must go on past the screen's edge: `available` says whether the platform offers it,
`request` asks for it and `exit` lets it go, and `subscribe` hears each answer and change
(`locked`, `refused`, `unlocked`), a request's answer never arriving during the request. While the lock holds, each
pointer intent carries the platform's `movement`; disconnecting the input lets a held lock go.

A live element is laid out at its size on its window's card before the card's scale and placed by
a translation and that scale: exact in a panorama too, and `approximated` (said in
`data-swf-anchor` and `data-swf-shape`) for a window carrying a rotation of its own. The renderer
declares `affine-2d` transforms. The `pixelsPerUnit` option, `ChromeOptions.projections` and
`data-swf-placement` are gone; chrome is drawn round each card, at both edges for a card across the
seam. The package no longer depends on `@swf/projections`.
