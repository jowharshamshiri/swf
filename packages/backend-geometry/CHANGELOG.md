# Changelog of @swf/backend-geometry

Each release of @swf/backend-geometry and what it changed for those who use it. Versions follow semantic
versioning: before 1.0.0, a minor version may change the public API incompatibly and a patch
version never does; from 1.0.0, only a major version does.

## 0.1.0

The first release. A drawing presentation backend, written independently of the DOM one. It draws adapter-supplied drawables, proxies, placeholders, window chrome and indicators for windows out of view on canvases, pairs with a native renderer through `LayeredRenderer`, and its `LayerCompositor` stacks live and drawn layers in one explicit order.

Drawn content is drawn into its surface's rectangle on its window's card, exactly, with `affine-2d`
transforms; the `meshCells` option and the mesh helpers are gone. Window frames are drawn round
each card (`WindowFrame.card`), and `windowFrames(frame)` takes no projection modules: they are
needed only for the indicators of windows out of view.
