# 0015. One room round the camera, with every window drawn as a flat card at its projected centre

- **Status:** Accepted; supersedes the placement in
  [0003](0003-two-presentation-paths-with-declared-fidelity.md)
- **Date:** 2026-11-27
- **Requirements:** ARCH-010 to ARCH-014, FR-084, FR-086, FR-090, FR-105, FR-122, FR-125, AC-013

## Context

Placing each window where a projection sends its corners (a perspective transform for a live
element, a warped mesh for drawn content) bends a planar window in a panorama: text is skewed,
a window near the poles is a sliver, and the shape can only ever be declared approximate. Windows
of a workspace are read, so what matters is that each one is legible and stands where it is
expected to, not that its outline follows the projection. A window's place was also its full 3D
position, so a drag had to pick a plane or a shell to move on, and the same pointer motion moved a
near window further than a far one.

## Decision

- **One room.** A window's place is its heading round the viewport's camera, its distance from
  the camera along the floor and its height above the camera's level: the room every window
  shares, decided by the Lean model `Swf.Room` (`packages/interaction`'s `RoomPlace`,
  `ROOM_LIMITS`, `ROOM_PACE`). A place is kept between 2 and 13.5 world units out and between 3
  below and 4 above the camera. How high a window looks, its elevation, is derived from its height
  and its distance along the floor. A drag turns its heading by the pointer's motion across (the
  view's angle a pixel), raises it by 1/68 of a unit a pixel at any distance, and with Shift moves
  it along the floor by 1/27 of a unit a pixel; the wheel moves it along the floor by a factor
  e^(0.0012) a pixel (down is farther). The camera stays level: navigation turns it in heading
  only.
- **Flat cards.** Every surface is drawn on its window's card: a flat, upright rectangle centred
  where the projection places the window's centre (`placeDirection`), the window's own size at
  `CARD_PIXELS_PER_UNIT` (80 CSS pixels a world unit) times a scale. Where the viewport represents
  windows by distance (a representation policy), a card keeps nearly one size and distance
  changes what it shows: in full `0.91 + (6 − r) × 0.012` (r its distance along the floor) within
  0.75 to 1.08, a compact preview 0.9 at 138/176 by 61/126 of the card, a label alone 112 by 31
  pixels; otherwise every window is in full at `7.1 / r × 200 / (fov + 50)` within 0.36 to 1.5. A
  policy may give a card's scale outright (focus scales its window's card to read).
- **A card's size does not follow the view's size.** Cards keep this fixed pixel size whatever the
  view's pixels per degree, so a window stays readable in a small or embedded view. In a narrow view
  showing the whole circle, cards stand closer together and may overlap; that is the view's layout
  and the scene's spread to address, not the card's size.
- **Both backends draw cards.** The DOM backend lays a live element out at its size on the card
  before the card's scale and places it by a translation and that scale alone; the geometry
  backend draws a drawable into the surface's rectangle on the card. Picking hits the cards as they
  are drawn, with the viewport's representation policy.
- **Fidelity follows the card.** A card is never bent, so a projection's shape rules nothing out:
  the negotiation model (`Swf.Fallback`) asks only for transforms that scale a card (`affine-2d`
  or more) to present content exactly or natively, and a projection profile no longer declares a
  mapping. A window or surface that carries a rotation of its own, or a surface of another shape
  than `rect`, is drawn upright as its rectangle: its placement is declared `approximate`, so it is
  presented `approximated` and the DOM backend says so (`data-swf-anchor`, `data-swf-shape`).
  Nothing a host sets on a window is ignored without saying so.
- **Windows carry no rotation of their own.** The framework's drags, moves, keys and commands never
  turn a window; turning a window is not an operation. The scene keeps rotation as generic as
  [0002](0002-canonical-scene-separate-from-presentation.md) states, for groups (whose rotation
  moves their windows round the camera) and for hosts, which are told as above when a window's own
  rotation is not shown. Saved workspaces of format `swf.workspace/1` are moved by one migration
  step to `swf.workspace/2`, which stands every window and surface upright and names each one in
  a warning.
- **The panorama.** The equirectangular panorama spans 130° down whatever its field of view across,
  with the horizon 0.49 of its height from the top (`PANORAMA_VERTICAL`): cards are not squeezed by
  a span, so a fixed span keeps every height of the room in view.

## Alternatives

- **Keep mapping windows onto their projected corners.** Faithful outlines, but bent text and
  slivers near the poles, a shape never better than approximate in a panorama, and a drag whose
  pace depends on distance.
- **Scale cards with the view's pixels per degree.** Cards would keep their angular size, but turn
  unreadable in a small or embedded view, which is where a fixed size matters most.
- **Let the vertical span follow the field of view.** A narrow view would lose the room's high and
  low windows off its top and bottom.
- **Draw a window's own rotation.** A flat card facing the camera has no way to show it; drawing it
  would bring back the bent shapes this record removes.

## Consequences

Live content is presented natively in a panorama, its text legible; drawn content is exact on its
card. A drag moves a window the same height a pixel at any distance and comes back where it began
after a full turn. The geometry renderer needs only 2D affine transforms. The room's moves, limits
and derived elevation, the band and spacing decisions and the negotiation's rule for cards are
proved in Lean (`Swf.Room`, `Swf.AppSpacing`, `Swf.Fallback`'s `cards_need_scaling`). Tests: the
card projector (`packages/projections/test/projector.test.ts`), the cards
(`packages/presentation/test/cards.test.ts`), the room (`packages/interaction/test/room.test.ts`),
the negotiation (`packages/presentation/test/negotiation.test.ts`), the migration
(`packages/persistence/test/restore.test.ts`), and the browser suites of both backends.

## Migration impact

Hosts with saved layouts read them through the `swf.workspace/2` migration. A host that sets a
window's or surface's own rotation sees it placed `approximate`. A projection module implements
`placeDirection` and no longer `projectGeometry` or `clipVisibility`, and its profile drops
`mapping`. Renderers declare the transforms they use; a backend that only translates cannot
present anything exactly. Reversing this record would restore the corner mapping in both backends,
the old negotiation rule and the turning operations, and need a migration back.
