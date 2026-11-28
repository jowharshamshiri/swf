# 0016. Every window moved by its title bar, live content keeping its input, every target sized for the pointer

- **Status:** Accepted; supersedes the panorama's fixed span in focus in
  [0015](0015-one-room-with-windows-drawn-as-flat-cards.md)
- **Date:** 2026-11-28
- **Requirements:** FR-103, FR-104, FR-105, FR-106, FR-108, FR-110, FR-113, NFR-003

## Context

A window of live content (a note, a terminal, an editor) filled its card, so the only way to move
it was to hold the takeover modifier over its content, the inspector or the keyboard. Its name
was an inert label, its frame a band that ate the content's edges, and its targets were sized
for nobody in particular: a few pixels of frame for a mouse, the same for a finger. A press on
content was the content's, but the framework did not know which window that made the one worked
on; a double press was the browser's `dblclick`, which counts two quick drags as one; and the
wheel over a window changed its distance only with a modifier, while over live content it was
sometimes the framework's. Content that uses Alt and a press itself (a terminal's block selection,
an editor's second caret) lost them to the takeover.

## Decision

- **Live content keeps its input.** A press, a drag, a double press, the wheel (whatever modifier
  is held) and keys over a window's live content are the content's. The framework only observes a
  press there (`content.pressed`) and makes that window the selection unless it is already among
  the selected (`Swf.Gesture.selectionOnPress`), as an operating system activates the window
  pressed.
- **A title bar on every window.** Every window drawn with a card has a bar across the top of the
  card, 24 CSS pixels high whatever the card's scale, in the window's colour and named for it,
  drawn over every card: a press selects the window, a drag moves it round the room, a double
  press focuses it (and in focus returns), and the wheel over it changes its distance. A window
  behind a nearer card is reached by its bar (`Swf.Arbitration`: title bars before every other hit
  of the same priority, never occluded). A window shown by its label alone has its label as its
  bar. A copy of a live window across the seam is a picture, handled as the window's card.
- **Resize bands round the outline.** 8 pixels outside the window's outline (its card with its
  bar) and 4 inside at the sides and bottom, square corners 20 pixels on a side.
- **A target is sized for the pointer that presses it.** A mouse's bar is 24 pixels high and its
  band 8 out and 4 in; a finger's or a pen's bar counts 44 pixels high and its band 16 out and 6 in
  (`WINDOW_HANDLES` by `PointerPrecision`); a radar or map mark is taken within 12 pixels by a
  mouse and 22 by a finger, the nearest mark winning. A press becomes a drag past 4 pixels for a
  mouse and 10 for a finger or a pen. A part of a handle past what its window draws (the band
  outside the outline, a finger's bar above the bar as drawn) is its reach: taken only where
  nothing drawn is, never from another window's content or card, and hiding nothing
  (`Swf.Arbitration`'s `reach_after`, `reach_hides_nothing`).
- **The router decides a double press.** Two presses that each lift before the slop, on one
  window, within 8 pixels for a mouse or 22 for a finger and within 500 milliseconds
  (`Swf.Gesture.pressedTwice`), announced as `pointer.doublePressed`; a drag, a press on content or
  on the background, or another pointer between them keeps them apart.
- **The cursor says what a press would do** (`Swf.Gesture.hoverShows`, derived from the press
  route), and the window a press would take is edged before anything is pressed.
- **The wheel.** Over live content it is the content's; over a title bar, a frame or a picture it
  moves the window along the floor; over the background a scroll sideways turns the view (in
  workspace navigation, the workspace), and Ctrl or a pinch widens or narrows its field of view
  (`Swf.Gesture.wheelRoute`). While a press is held the wheel is its gesture's.
- **The takeover is the content's to allow.** The takeover modifier (Alt by default) takes a press
  on content over only where the content has no use for it: a surface adapter's handle reports
  the `takeover` capability false for a terminal or an editor, and the press stays the content's
  (`Swf.Gesture.takesOver`). The host's takeover control takes every content's presses.
- **Leaving live content by the keyboard.** F6 (a host may rebind it) takes the keyboard out of a
  window's live content to the view, the window selected (`swf.content.leave`); Escape stays the
  content's.
- **The window in focus stands in front.** In focus, the focused window is drawn and picked before
  every other window's hits, their title bars included (`Swf.Arbitration`'s `front_before`), and
  focus narrows the panorama's vertical span only as far as a window standing high or low needs
  to stand, with its bar, in the middle of the view.

## Alternatives

- **Move a window by its content with a modifier.** The content loses that modifier and a press,
  and nothing on screen says which modifier moves which window.
- **A label chip above the card made pressable.** It does not read as part of the window, and
  sits over whatever lies above.
- **Bands inside the card.** They take the content's edges, where scroll bars and text selection
  live.
- **The browser's `dblclick`.** It pairs two quick drags, and its distance is the platform's, not
  the target's.
- **One size for every pointer.** A finger misses a mouse's 8 pixel band; a mouse loses content to
  a finger's 16.
- **A takeover setting saved with each surface.** Whether content uses Alt and a press is a fact
  about the content, which its adapter knows; saving it with the layout would let the two disagree.

## Consequences

Every window has a target that moves it, sized at least to WCAG 2.5.8's 24 CSS pixels for a
mouse and to the 44 pixels of touch norms for a finger, measured in the running reference
application. Live content never loses a press, a wheel or a key it did not offer. The decisions
are proved in Lean (`Swf.Arbitration`, `Swf.Gesture`, `Swf.AppFocus`, `Swf.AppWheel`). Tests: the
router's picking and gestures (`packages/interaction/test/pick.test.ts`, `gestures.test.ts`), the
surface capabilities (`packages/surfaces/test/registration.test.ts`), and the Chromium suites that
press, drag and double press every kind of target at its edges with the real mouse and a finger
(`apps/reference/test/browser/targets.browser.test.ts`) and keep Alt and a press in a terminal-like
log (`examples/navigation-host/test/host.browser.test.ts`).

## Migration impact

A host's adapters report `takeover` for each handle. A host that relied on Alt moving every
window by its content keeps that only for content whose handle allows it; every window is moved
by its title bar. Settings carry the slop and the double press's reach per pointer precision.
Reversing this record would remove the title bars and the reach rule from picking, return the
double press to the browser, and give the takeover back to every surface.
