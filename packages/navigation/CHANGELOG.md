# Changelog of @swf/navigation

Each release of @swf/navigation and what it changed for those who use it. Versions follow semantic
versioning: before 1.0.0, a minor version may change the public API incompatibly and a patch
version never does; from 1.0.0, only a major version does.

## 0.1.0

The first release. A host's own content in one viewport with the whole navigation experience:
the panorama, focus with its strip, the map and radar, the overview with search, workspace orbit,
the wrapped cursor, magnetic snapping, semantic depth and composition, each a capability switched
on and off on its own and isolated by an experiment, and every action of the navigation controls a
named `swf.*` command. `createNavigation` starts it in the host's element with the host's surface
adapters; navigation never looks into the content.

The wrapped cursor locks the pointer to the view for a mouse drag that reaches the panorama's edge
and carries the drag on by the mouse's motion; its decisions are the Lean model `Swf.AppCursor`.
`wrappedInput` takes the view's `lock` (the DOM input's `pointerLock`, or null where the device
offers none), the `viewportId` its samples land in and the router's `events`, and its `frame` gives
the view's `height` as well as its width; the policies' `input(device, lock)` passes the lock on.
The step functions it was built from (`wrapPointer`, `afterDispatch`, `NO_POINTERS`, `WrapState`,
`Wrapped`) are no longer exported.

Navigation works in the room. A `Pose` gives a window's heading, its `reach` along the floor and how
far it stands `above` the camera's level, with its elevation derived from them; `turned` and
`rotatable` are gone, and `swf.window.pose` keeps a window inside the room. Semantic depth reads the
distance along the floor, with bands at 6.7 and 9.3 by default. Focus faces its window with a level
camera and scales its card to read (`FocusOptions` is `fill` and `maxMagnification`; `FocusFrame`
is a heading and a scale). Magnetic positioning snaps room places measured on the cards the view
draws (`SnapBox`, `CardMeasure`, `cardMeasureOf`) to `SNAP_RINGS` and the spokes, and keeps a
window let go on a spoke clear of its neighbours (`spacedPlace`, `SNAP_SPACING`, decided by
`Swf.AppSpacing`). Arrange lays windows on `ARRANGE_RINGS`. The map and the radar reach
`MAP_REACH` (`radarReach` is gone); a map starts holding the whole room (`roomMapView`;
`MAP_SCALE.initial` is gone). The panorama spans 130° down with its horizon at 0.49
(`PANORAMA_VERTICAL`). The depth-drag and turn-drag policies are gone. The viewport stays the size
of its element when a restored scene or an undo gives it another size.

A host says how each window's title bar is coloured (`WindowTraits.titleBar`, or null for the
chrome's own colours); both backends draw the bars.

A press in a window's live content makes it the selection unless it is already among the selected,
as a drag that takes a window does, decided by `selectionOnPress`; the content keeps the press.
