# Changelog of @swf/interaction

Each release of @swf/interaction and what it changed for those who use it. Versions follow semantic
versioning: before 1.0.0, a minor version may change the public API incompatibly and a patch
version never does; from 1.0.0, only a major version does.

## 0.1.0

The first release. Device-neutral input. Pointer, wheel, keyboard and programmatic intents; picking on the cards each view draws; input regions that keep content input native; a gesture arena with pointer capture; drags that preview and commit once; explicit cancellation; and a named command for every spatial operation.

Keyboard step sizes are no longer a router setting, where changing them alone changed no binding:
`defaultKeymap(steps)` takes the steps to build the default bindings from, any left out being
`DEFAULT_KEYBOARD_STEPS`', and a router takes them as the keymap it builds. A keymap given at
creation must bind only commands the router has, as `configure` requires. An input adapter's
dispatch refuses intents once the device is disconnected, or when its registration failed, and
`subscribe` refuses a listener once the router is disposed.

Picking refuses a number it cannot order: `pick` throws a `RangeError` when the depth tolerance is
not finite and at least zero, or when a hit's distance or presentation priority is not finite,
naming the hit and the field, where before such a hit was ordered by a meaningless key.

The wheel with the depth modifier held reads its turn one way on every platform: a dragged
window's depth and the wheel's move of a window take it from `deltaY`, or from `deltaX` when
`deltaY` is zero, as browsers on Windows and Linux deliver a wheel turned with Shift held. Before,
both read `deltaY` alone, so there the wheel did nothing. `wheelTurn(intent)` reads a wheel intent
so, for a host's own gestures.

While a press is held in a viewport, every wheel there is its gesture's: a gesture that uses it
has it, and any other wheel is consumed (`route: 'gesture'`) and does nothing, while the press is
pending and while a gesture with no `wheel`, or one that returns false, runs. Before, such a wheel
was routed as if no gesture ran, so Shift and the wheel during a resize, a turn or a pinch moved a
window in depth as a change of its own in the middle of the gesture. `captures()` names the
viewport each held pointer was pressed in (`viewportId`).

A pointer intent may carry `movement`, the motion since the pointer's previous sample while the
platform locks the pointer to the view, whose place then stays where the lock took it; each of its
numbers must be finite, as the intent's validation checks.

Every window stands in one room round the viewport's camera (`RoomPlace`, `ROOM_LIMITS`,
`ROOM_PACE`, `roomPlaceOf`, `standingInRoom`, decided by the Lean model `Swf.Room`). A window drag
turns its heading by the pointer's motion across and raises it a 68th of a unit a pixel at any
distance; Shift and the wheel move it along the floor; pressing Shift or turning the wheel mid-drag
goes on from where it stands (`RoomMotion`). `node.move` takes `heading`, `height` and `floor`;
`node.rotate` and the keys that turned a window are gone, and `camera.turn` turns the heading only.
The settings drop `dragMode`, `worldPlaneNormal`, `wheelDepthPerPixel` and `minDistance`;
`KeyboardSteps` are `heading`, `height`, `floor`, `resize` and `turn`. Picking hits the cards each
view draws, with the viewport's representation policy (the router's `representation` option), and
a candidate says its card's `pixelsPerUnit`. The plane drags (`dragFrame`, `dragAnchor`,
`withDepth`, `movedTransform`, `translatedBy`, `headingOf`, `DRAG_MODES`) and the scene index are
gone; `placementOf`, `worldOrigin` and `turnedAbout` stay.

Picking finds a window's title bar (the `title-bar` region), which takes a press, a drag and a
double press as the window's own and is ordered before every other hit of the same presentation
priority, and its resize band round the window's outline, both sized for the pointer: `pick` and
the router's `pick` take a `PointerPrecision` (a press by a finger or a pen is `coarse`).
`PickOptions.handlePx` and the `handlePx` setting are gone. A copy of a live window's card across a
seam picks as the window's card (`chrome`), not as content.

A press the router leaves to a window's live content is announced as a `content.pressed` event
(its viewport, window and surface); the router takes nothing of the press and changes nothing.
