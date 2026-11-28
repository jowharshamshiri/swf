# Browser support

## Policy

SWF supports the current stable release of each of these engines on desktop:

| Engine   | Browsers                      | Checked in                                                    |
| -------- | ----------------------------- | ------------------------------------------------------------- |
| Chromium | Google Chrome, Microsoft Edge | Playwright's Chromium and stable Google Chrome                |
| Gecko    | Mozilla Firefox               | Playwright's Firefox and stable Firefox (over WebDriver BiDi) |
| WebKit   | Safari                        | Playwright's WebKit on Linux                                  |

Every release is checked by running every browser suite, including the ten end-to-end
acceptance scenarios, in each engine (`npm run conformance`); the release's `COMPATIBILITY.md`
names the versions it was checked in. A browser that fails a scenario is not released on. Support
for an engine's release ends when the engine's maker stops supporting it.

The packages need ES2022, ES modules, `WebAssembly`, `AbortController`, Pointer Events,
`requestAnimationFrame` and CSS 2D transforms. Persistence in the page uses `localStorage` or
IndexedDB, as the host chooses. The packages without a DOM (`@swf/math`, `@swf/models`,
`@swf/core`, `@swf/surfaces`, `@swf/presentation`, `@swf/projections`, `@swf/interaction`,
`@swf/persistence` with its memory store, `@swf/diagnostics`) also run in Node.js 24 or later.

## What the browser platform rules out

- **Live content cannot be bent, so no window is.** A browser cannot bend arbitrary live,
  interactive DOM. Every window is drawn as a flat, upright card at its projected centre: the DOM
  backend places a live element on its card by a translation and a scale, and the geometry backend
  draws drawn content into its rectangle on the card, both exactly. A window or surface carrying a
  rotation of its own is drawn upright, its placement declared approximate (`data-swf-anchor`,
  `data-swf-shape`). Nothing approximate is labelled exact.
- **Occlusion between live and drawn content is by layers.** Live elements and canvases are
  stacked by `z-index`, each layer wholly in front of or behind another; there is no per-pixel
  depth between them, and every composed frame says so (`occlusion: 'layer-order'`).
- **The pointer cannot be moved.** A page cannot move the platform's pointer, so the wrapped
  cursor is drawn by the page (`createVirtualCursor`). A drag that reaches the panorama's edge
  locks the pointer to the view (Pointer Lock) and goes on by the mouse's motion; where the browser
  offers no lock or refuses it, the drag stops at the screen's edge.
- **Cross-origin content keeps its own input.** Content in a cross-origin frame gets its input
  from the browser alone; the framework sees presses there only on title bars and resize handles,
  which the DOM renderer draws as elements of their own over it.
- **A hidden tab gets no animation frames.** Presentation waits there and resumes from the latest
  state.

## What each browser's automation can and cannot check

| Check                                     | Chromium                      | Firefox                                               | WebKit                     |
| ----------------------------------------- | ----------------------------- | ----------------------------------------------------- | -------------------------- |
| Mouse, keyboard and wheel                 | yes                           | yes                                                   | yes                        |
| Real touch and pen input                  | yes (DevTools protocol)       | skipped                                               | skipped                    |
| Emulated colour scheme and reduced motion | yes                           | Playwright's Firefox yes; stable Firefox over BiDi no | yes                        |
| Retained heap (NFR-006)                   | yes, after forced collections | not reported to automation                            | not reported to automation |
| Frame rate on a GPU                       | on the reference machine      | on a Linux desktop                                    | on a Linux desktop         |

The cases a browser's automation cannot drive are skipped there, never passed; the conformance
record counts them as skipped.

## Known gaps

- **Safari itself** is not yet checked: Playwright's WebKit on Linux stands in for it until the
  suites run on macOS.
- **Firefox on Windows** composites in software when driven headless, and a windowed Firefox
  cannot start its GPU process in the Windows test guests' service sessions; its performance
  verdict comes from a Linux desktop.
- **Firefox on a Windows guest without a desktop session** never has the system focus, so a
  `focus()` there may fire no focus event; the keyboard-only scenario's verdict for Firefox comes
  from a Linux desktop.
