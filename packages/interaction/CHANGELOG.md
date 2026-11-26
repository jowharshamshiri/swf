# Changelog of @swf/interaction

Each release of @swf/interaction and what it changed for those who use it. Versions follow semantic
versioning: before 1.0.0, a minor version may change the public API incompatibly and a patch
version never does; from 1.0.0, only a major version does.

## 0.1.0

The first release. Device-neutral input. Pointer, wheel, keyboard and programmatic intents; picking through the projection's inverse and a spatial index; input regions that keep content input native; a gesture arena with pointer capture; drags that preview and commit once; explicit cancellation; and a named command for every spatial operation.

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
