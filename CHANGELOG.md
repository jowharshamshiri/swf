# Changelog of @swf/backend-geometry

Each release of @swf/backend-geometry and what it changed for those who use it. Versions follow semantic
versioning: before 1.0.0, a minor version may change the public API incompatibly and a patch
version never does; from 1.0.0, only a major version does.

## 0.1.0

The first release. A drawing presentation backend, written independently of the DOM one. It draws adapter-supplied drawables, proxies, placeholders, window chrome and indicators for windows out of view on canvases, pairs with a native renderer through `LayeredRenderer`, and its `LayerCompositor` stacks live and drawn layers in one explicit order.
