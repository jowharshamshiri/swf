# Architecture

SWF is a window manager for content it never looks into. A host hands it opaque things to show;
SWF keeps where each one is in a 3D scene, shows the scene through one or more views, and turns
input into changes of that scene. Everything about the content itself (what it is, how it runs,
where it comes from) stays with the host. That one division explains most of how the framework
is built.

## The scene and its views are separate

The scene is canonical and three-dimensional: windows and groups with full position, rotation
and scale, surfaces attached to windows, cameras and viewports. It knows nothing of pixels,
elements or canvases, and changes only by transactions that commit as one revision or not at
all. A view is a projection of that scene through a camera into a viewport: the equirectangular
panorama by default, but any projection that registers. Several views can show one scene at
once, each with its own camera, and none of them owns it.

Keeping the scene free of presentation means the same layout can be saved, restored, inspected
and tested without a browser, and shown by whatever backend a page can afford.

## Presentation is negotiated, never assumed

A browser cannot do everything a 3D window manager would like: it cannot bend live, interactive
DOM into an arbitrary shape, and it has no depth test between an element and a canvas. Rather
than pretend, SWF asks. Each surface's adapter says what its content can do (be a live element,
be drawn, be resized, be shown in two places); each renderer and compositor says what it can do;
each projection places each window's card, a flat, upright rectangle it never bends. For every fragment of every frame, the planner walks
a fallback order (exact, native, approximated, proxy, placeholder) and records why each better
mode was not possible. A window carrying a rotation its card cannot show is declared approximate;
a proxy says why it stands in. Nothing approximate is ever labelled exact.

Two backends implement the contracts independently: one places live DOM, one draws on canvases,
and a layered pair combines them. Both pass the same conformance suite, which is how the
contracts are known to be backend-neutral. A viewport hands over from one backend to another
transactionally, and when none works it says so and the scene keeps working.

## Decisions are proved, not just tested

Every state machine (the workspace's lifecycle, each surface's presentation, gestures, saves,
backend handoffs) and every decision that admits, refuses, orders or chooses is a Lean model with
its invariants proved, compiled to one WebAssembly program. The TypeScript does the work (binding,
drawing, storing, moving elements) and asks the model what to do at each step. A defect in a
decision is fixed in its model, where the proof says whether the fix keeps what must hold.

## The packages and what each may use

| Package                 | May import                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `@swf/math`             | nothing                                                                                             |
| `@swf/models`           | lungo-ts (its WebAssembly host)                                                                     |
| `@swf/core`             | math, models                                                                                        |
| `@swf/surfaces`         | math, core, models                                                                                  |
| `@swf/presentation`     | math, core, surfaces, models                                                                        |
| `@swf/projections`      | math, core, presentation                                                                            |
| `@swf/interaction`      | math, core, presentation, projections, models                                                       |
| `@swf/backend-dom`      | math, core, surfaces, presentation, projections, interaction                                        |
| `@swf/backend-geometry` | math, core, surfaces, presentation, projections                                                     |
| `@swf/persistence`      | math, core, models                                                                                  |
| `@swf/navigation`       | math, models, core, surfaces, presentation, projections, interaction, backend-dom, backend-geometry |
| `@swf/diagnostics`      | core, surfaces, presentation                                                                        |
| `@swf/conformance`      | math, core, surfaces, presentation                                                                  |
| `@swf/benchmark`        | math, core, surfaces, presentation, projections, interaction, backend-dom                           |

A package may import only what its row lists, and the architecture test
(`packages/presentation/test/architecture.test.ts`) fails any other import. In particular, nothing
below the presentation contracts reaches a concrete renderer or compositor: the scene,
persistence and interaction see only contracts. `@swf/models` is used only by the packages that
decide something through it. `@swf/navigation` sits above them all: it composes the framework into
the navigation experience a host shows its content with. The reference application depends on the
packages' public entry points alone, like any host. It and the navigation controls
(`@swf/navigation-ui`, `ui/navigation`), which it and any host on the same kit mount, are the only
parts built on a UI kit, their future host's; no framework package depends on either
([ADR 0014](../adr/0014-navigation-as-a-framework-package-and-kit-controls.md)).

## Why so many packages

Each optional capability is a package a host can leave out: a host with its own drawing never
installs the DOM backend; one without saved layouts never installs persistence. Every package is
tree-shakeable and held to a size budget, so what a host leaves out costs it nothing, and what it
uses is measured release by release.

## What is deliberately outside

- running, decoding or transporting content, and any knowledge of what content is;
- a trust model: the host and the browser decide what a page may show and run;
- a plugin runtime: modules are ordinary ES modules the host imports and registers;
- accounts, servers and services: the framework and its reference application run from static
  files.

The [architecture decisions](../adr/README.md) record each of these choices with the
alternatives that were weighed.
