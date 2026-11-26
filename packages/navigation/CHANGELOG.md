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
