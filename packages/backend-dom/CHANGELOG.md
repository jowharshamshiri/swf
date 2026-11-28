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

Each window drawn with a card has a title bar element (`data-swf-title-bar`, with its
`data-swf-node`) across the top of its card, in a layer over every card, named for the window, in
the host's colours (`chrome.titleBars`) or the inks, taking input; its resize handles lie round its
outline as `bandZones` lays them out. Floating names are written only for windows shown by their
label alone. `chrome.handlePx` is gone.

The view's cursor says what a press would do (`pointer.hovered`): a grab on a title bar, a card or
the background, the edge's resize cursor on a band, a move on taken-over content, the content's
own cursor on content, and a grabbing hand while a window or the view is carried; resize handles
carry no cursor of their own. `createDomInput` offers `leave` when the pointer leaves the view, and
a sample of the pointer where it is when a modifier goes down or up anywhere on the page.
`chrome.hover` edges the window a press would take in the `selected` ink, or draws the edge of its
band hovered.

A window in front (the one focus shows) is drawn over every other window's title bar, its own bar in
a layer of its own over everything (`overlay:front-bars`).

The resize handles lie where the band lies on the window's card, and nowhere outside it, so a press
just past a window's edge reaches whatever is drawn there. They are a finger's on a page whose every
pointer is coarse, else a mouse's.

A sample that reaches the view under a newly taken pointer lock before the browser says the lock
took hold is reported after `locked`, as the first sample under the lock. Before, a drag carried to
the panorama's seam could take the browser's own motion to where it holds the pointer as the
mouse's, and jump half the view.
