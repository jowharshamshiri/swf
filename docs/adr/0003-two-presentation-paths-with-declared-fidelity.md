# 0003. Two presentation paths, live DOM and drawn geometry, with declared fidelity

- **Status:** Accepted
- **Date:** 2026-11-21
- **Requirements:** ARCH-010 to ARCH-014, FR-084, FR-086, FR-090, AC-013

## Context

A browser cannot warp arbitrary live, interactive DOM into a curved projection, and cannot render
it into a texture while keeping it interactive. Content that must stay natively interactive (a
form, an editor, a cross-origin frame) can only be a placed element. Content that only needs to be
seen can be drawn exactly where the projection says.

## Decision

Two independently written backends implement the same contracts. `@swf/backend-dom` places each
live element in a slot of its own, mapped onto its projected corners with a CSS perspective
transform, clipped to its visible part, never moved to another parent, and declares how it is
placed: exact at the corners, its shape approximate in a curved view. `@swf/backend-geometry`
draws adapter-supplied drawables, proxies, placeholders and chrome on canvases, warped point by
point and declared approximate. `LayeredRenderer` and `LayerCompositor` combine them, stacking
live and drawn layers in one explicit order with layer-level occlusion, which every frame
declares.

## Alternatives

- **One DOM backend that warps everything with CSS.** A perspective transform maps a rectangle
  onto a quadrilateral only; a curved projection would be claimed and not delivered.
- **One canvas or WebGL backend that rasterizes content.** Live DOM cannot be rasterized and stay
  interactive, and cross-origin content cannot be read at all.
- **Per-pixel depth between live and drawn content.** The browser has no depth test between an
  element and a canvas.

## Consequences

Both backends pass one conformance suite, which keeps the contracts backend-neutral. Fidelity is
declared on every placement (`data-swf-shape`, the composed frame's `occlusion`), so nothing
approximate is reported as exact.

## Migration impact

A third backend (WebGL, say) registers through the same contracts with no change to the scene or
to hosts. Dropping either path would remove the fallback that keeps a viewport presenting when
the other fails.
