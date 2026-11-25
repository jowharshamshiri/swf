# 0002. A canonical 3D scene, separate from every presentation of it

- **Status:** Accepted
- **Date:** 2026-11-20
- **Requirements:** FR-001 to FR-032, FR-080, DATA-001 to DATA-007, ARCH-002

## Context

The same workspace must be shown in several independent modes (panorama, focus, map, overview),
through backends that may change at run time, and be saved and restored without any of them. The
framework must never need to know what a surface shows.

## Decision

`@swf/core` holds one canonical scene: right-handed, +Y up, arbitrary world units; windows and
groups with full position, rotation and scale; surface associations that carry only a binding
key, an adapter type, geometry and flags; cameras and viewports as view state. It depends on no
DOM, renderer or UI framework. Views are projections of the scene through a camera; renderers,
compositors and projections are registered modules behind contracts in `@swf/presentation`. The
architecture test fails any package below the presentation contracts that imports a concrete
backend.

## Alternatives

- **The DOM as the scene** (windows as positioned elements, as most web window managers do). It
  ties layout to one backend and one view, and makes saving a layout a serialization of markup.
- **A scene per view.** Several views would drift apart, and every change would have to be
  applied to each.
- **A 2D scene with a 3D projection added.** A panorama, depth and orbiting all need real 3D
  placement; a 2D model would have to be replaced to get them.

## Consequences

Layouts are tested, saved and restored without a browser. Any number of views show one scene.
Content stays the host's: the scene cannot reach it.

## Migration impact

Moving presentation into the scene would change every command, every snapshot and every backend
contract: a new major version of every package and a snapshot format migration.
