# Spatial Workspace Framework

A browser-first TypeScript framework for spatial presentation and window management. Applications
attach opaque presentation surfaces to entities in a 3D scene, arrange and manipulate them, and
show the same scene through several views. The framework owns spatial presentation state and
interaction; the host owns whatever is presented.

## Packages

- `@swf/math`: vectors, unit quaternions, position/rotation/scale transforms, affine matrices,
  rays and axis-aligned boxes. The world is right-handed and +Y up; the default camera looks along
  -Z with +X to the right. Lengths are arbitrary world units.
- `@swf/core`: the scene kernel. Spatial nodes and their hierarchy, surface associations with
  their geometry, cameras and viewports, constraints, atomic revisioned transactions, previews, undo and redo,
  idempotency keys, typed events and the workspace lifecycle. It needs no DOM, renderer or UI
  framework.
- `@swf/surfaces`: binds the scene's surface associations to the host's presentation endpoints
  through registered adapters, negotiates each endpoint's capabilities, and drives every surface
  through its presentation lifecycle. It never inspects, decodes or runs what an endpoint shows,
  and releasing a surface never stops the endpoint's producer.
- `@swf/presentation`: the contracts between the scene and whatever draws it. What renderers,
  compositors and projections advertise; how each surface's presentation is negotiated from
  their capabilities; the fragments a view is made of; the stages from a committed scene to a
  presented frame; and the presenter, which runs those stages frame by frame within a budget,
  delivers advisory hints, and hands viewports between backends transactionally. It depends on no
  concrete renderer or compositor.
- `@swf/projections`: the projection contract (forward and inverse mapping, placing surfaces as
  fragments, visibility, interaction rays), registration that validates a projection before use,
  and the equirectangular reference projection with seam-continuous inverse mapping.
- `@swf/interaction`: device-neutral input. Pointer, wheel, keyboard and programmatic intents;
  picking through the projection's inverse and a spatial index; input regions that keep content
  input native; a gesture arena with pointer capture; drags that preview and commit once;
  explicit cancellation; and a named command for every spatial operation.
- `@swf/backend-dom`: a browser-native presentation backend. Live DOM content stays
  browser-owned and natively interactive: it is placed by its projected corners with its fidelity
  declared, clipped, stacked explicitly and never mounted twice; window chrome sits in layers of
  its own and labels are text.
- `@swf/backend-geometry`: a drawing presentation backend, written independently of the DOM one.
  It draws adapter-supplied drawables, proxies, placeholders, window chrome and indicators for
  windows out of view on canvases, pairs with a native renderer through `LayeredRenderer`, and
  its `LayerCompositor` stacks live and drawn layers in one explicit order.
- `@swf/conformance`: suites that check an adapter, a renderer or a compositor against the
  contracts, with reference mocks to run them against.
- `@swf/diagnostics`: what a running presentation can report locally: each viewport's backend
  and capabilities, the fallbacks chosen and why, frame and attachment measures, scene density,
  resource health and the last typed errors.
- `@swf/persistence`: versioned, canonical workspace snapshots with a published JSON Schema and
  a validator that matches it, policy parameters and opaque extension state with size limits,
  two-phase restore with format migrations, a replaceable storage interface with in-memory, Web
  Storage and IndexedDB stores, and the save state machine.

## Using the kernel

```ts
import { createWorkspace, worldMatrix } from '@swf/core';

const workspace = createWorkspace({ id: 'main' });

const result = workspace.transaction([
  {
    type: 'node.create',
    node: {
      id: 'notes',
      kind: 'window',
      bounds: [1.6, 0.9, 0.01],
      transform: { position: [0, 0, -3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      label: 'Notes',
    },
  },
  {
    type: 'surface.attach',
    surface: {
      id: 'notes-view',
      ownerNodeId: 'notes',
      bindingKey: 'editor-42',
      adapterTypeId: 'host.editor/1',
      bounds: [1.6, 0.9, 0.01],
    },
  },
]);

if (result.status === 'rejected') {
  console.error(result.error.code, result.error.path, result.error.message);
}

workspace.subscribe((event) => {
  if (event.type === 'transaction.committed') {
    console.log('now at revision', event.revision);
  }
});

const world = worldMatrix(workspace.getState().nodes, 'notes');
```

A transaction applies all of its commands as one revision or none of them. A rejection carries an
error envelope with a stable `code` (such as `INVALID_INPUT`, `UNKNOWN_ENTITY`, `CONFLICT`,
`LOCKED` or `CONSTRAINT_REJECTED`), the `path` of the failing input and a readable message.
Committed state is immutable: every commit produces a new `SceneState`.

The node commands are `node.create`, `node.patch`, `node.reparent`, `node.reorder`,
`node.duplicate`, `node.archive`, `node.restoreArchived`, `node.delete`, `node.group`,
`node.ungroup`, `selection.set` and `focus.set`. The surface commands are `surface.attach`,
`surface.patch`, `surface.move`, `surface.reorder`, `surface.rebind` and `surface.detach`. Each
is documented on its type in `@swf/core`.

Cameras and viewports are scene records too: `camera.create`, `camera.patch`, `camera.delete`,
`viewport.create`, `viewport.patch`, `viewport.delete`, and `orbitRoot.set` for the node that
orbit navigation turns about. A viewport names its camera, its projection and that projection's
configuration, its size and its navigation target. They are view state: changing them commits a
revision and reports events, but never touches node or surface records and is not undone. Node,
surface, camera and viewport IDs share one ID space.

A surface's geometry is a descriptor: the built-in `rect` and `polygon`, or a kind the host
registers with `registerGeometry`. Descriptors are validated against configurable complexity
limits, and `workspace.surfaceGeometry(id)` places one in the world for rendering and picking.

## Binding surfaces

```ts
import { createSurfaceRuntime } from '@swf/surfaces';

const surfaces = createSurfaceRuntime(workspace, { bindingTimeoutMs: 15_000 });

surfaces.registerAdapter({
  id: 'host.editor/1',
  apiVersion: 1,
  declaredCapabilities: {
    attachStrategy: 'native-dom',
    nativeInteraction: 'full',
    uvAddressing: true,
    transformFidelity: 'approximate',
    transparency: true,
    clipping: true,
    cursorMapping: true,
    resize: 'spatial',
    viewportSharing: 'single-owner',
    safeDetach: true,
    rebinding: true,
    placeholder: false,
    snapshotHooks: false,
  },
  resolve: (bindingKey, signal) => editors.find(bindingKey, signal), // null for an unknown key
  capabilities: (editor) => editor.capabilities,
  attach: (editor, target) => editor.mountInto(target.container),
  update: (editor, hint) => editor.considerHint(hint), // advisory only
  detach: (editor, target) => editor.unmountFrom(target.container), // never stops the editor
});

await surfaces.present('notes-view', 'main-viewport', layerElement);
```

Each surface moves through `unbound`, `binding`, `ready`, `presented`, `hidden`, `error`,
`detaching` and `detached`. An unknown key or a missing adapter leaves an `unbound` placeholder
that keeps the surface's identity and geometry, and binds in place once it can. Bindings resolve
asynchronously with an abort signal and a timeout; a completion that arrives after the surface was
removed or rebound is discarded. `replaceBinding` swaps a surface's endpoint with a safe handoff:
the new endpoint is attached before the change commits, and the old one is released only after.

## Presenting

A viewport's projection produces fragments: the visible pieces of each surface, each with a
presentation fragment ID that maps back to exactly one surface. A surface split by a panorama seam
has several fragments, only one of which may hold its live element; the others show it as a
proxy. `planFrame` negotiates every fragment's presentation from the surface's, renderer's,
compositor's and projection's capabilities, walking the fallback policy (by default `exact`,
`native`, `approximated`, `proxy`, `placeholder`) and reporting why each better mode was not
possible. Where a live element is placed exactly but its shape only approximates the projection,
the result says so; nothing approximate is ever labelled exact.

Rendering order depends only on the scene revision and the view: layers come in the plan's order
whatever order fragments were produced in, and a compositor declares how overlapping layers
occlude each other (`occlusion`): `depth`, by a per-pixel depth test across layers, or
`layer-order`, each layer entirely in front of or behind another. Every composed frame says which
it used, so the layer-level fallback is never mistaken for depth-correct occlusion.

### Projections

```ts
import { createPresentationRegistry } from '@swf/presentation';
import {
  cameraRotation,
  createProjectionRegistry,
  equirectangular,
  pickAt,
  projectionFor,
  viewGeometryOf,
} from '@swf/projections';

const presentation = createPresentationRegistry();
const projections = createProjectionRegistry({
  kinds: workspace.mutator(),
  projectors: presentation.registrar(),
});
projections.register(equirectangular);

workspace.transaction([
  { type: 'camera.create', camera: { id: 'eye', rotation: cameraRotation(0, 0) } },
  {
    type: 'viewport.create',
    viewport: {
      id: 'main-viewport',
      cameraId: 'eye',
      projection: { id: 'equirectangular/1', config: { horizontal: 360, vertical: 120 } },
      size: { width: 1600, height: 800, devicePixelRatio: 2 },
    },
  },
]);

const state = workspace.getState();
const view = viewGeometryOf(state, 'main-viewport');
const pick = pickAt(projectionFor(equirectangular, view), state, view, 800, 400, (id) =>
  workspace.surfaceGeometry(id),
);
```

Registering a projection validates it first: its contract version, its profile, the domain it
describes, and a round trip through a probe view. The scene then accepts viewports that use it,
checking each configuration with the projection's own rules, and the host can project them.

The equirectangular projection maps longitude across and latitude down. It covers 360° across,
wrapping at a seam behind the camera, and 120° up and down by default (up to 180°, which reaches
the poles); narrower angles are configurable. A direction on the seam has two images; a pole is a
whole edge row. A surface crossing the seam yields one fragment on each side, both referring to
the same surface, and surfaces behind the camera are kept, not dropped. Its inverse is exact.
`pickAt` returns every selectable surface under a point, nearest first; given the previous
longitude of a drag, the longitude is unwrapped so it stays continuous across the seam.

Renderers, compositors and projectors register by versioned ID with
`createPresentationRegistry()`. Each module can be handed only the scope it needs:
`workspace.reader()`, `workspace.mutator()`, `workspace.persistence()`, `surfaces.binder()` and
`registry.registrar()`.

## Interaction

```ts
import { createInteractionRouter, createSyntheticInput } from '@swf/interaction';

const router = createInteractionRouter({ workspace, projections });

// A device adapter turns platform events into intents; this one is driven by a program.
const input = createSyntheticInput();
router.registerInputAdapter(input);

const press = input.pointer('down', 'main-viewport', 812, 240);
if (!press.consumed) {
  // Over live content: let the platform deliver the event natively.
}
input.pointer('move', 'main-viewport', 900, 260);
input.pointer('up', 'main-viewport', 900, 260);

input.command('node.move', { viewportId: 'main-viewport', right: 0.2 });
```

Every device reaches the router as the same intents: pointer samples carry the viewport, device,
pointer ID, position, buttons, modifiers, phase, timestamp and, when the device has them,
pressure, tilt and twist. `dispatch` answers whether the framework consumed the intent; anything
it does not consume is the host's to deliver natively.

Picking follows the viewport's projection inverse to a world ray, finds candidates in a
bounding-volume tree kept in step with the scene, and intersects their exact geometry. Candidates
are ordered by presentation priority, occlusion and depth, and each reports its window, surface,
local point, UV and region: `content`, `chrome`, `resize-handle`, `background` or
`modal-overlay`. A surface split by a seam is one surface in the world, so it always picks as one
Surface ID. A surface shown only as a proxy is marked so, with focus and activation offered in
place of direct input.

Presses on content stay with the content unless a takeover is active (the takeover modifier,
Alt by default, or `setTakeover(true)`), and the wheel over content stays with it unless the
depth modifier (Shift by default) is held. Pressed pointers enter a gesture arena per target;
registered policies bid for them, and the arena resolves to the highest-priority drag once a
pointer moves past the slop, or to a tap when they lift before that. Two pointers pressed on one
window go to two-pointer gestures; a pointer pressed on a window already in a gesture is refused
rather than starting a second one.

A window drag keeps the grabbed point under the pointer on a plane facing the camera (or on a
world plane, or around the camera at a constant distance), with depth changed only by the wheel
during the drag. It previews on every move, keeps its capture across the seam, outside the
viewport and through viewport resizes, and commits once on release. Escape, a lost capture, a
deleted viewport or target, a rejected commit, a host `cancel()`, an invalidated preview and
workspace disposal each end it without a change, release its pointers (`capture.released`) and
report the reason (`gesture.ended`). Background drags turn the camera or the orbit root, as the
viewport's `navigation` setting says.

Every operation a gesture performs is also a command (`node.move`, `node.resize`,
`node.rotate`, `camera.turn`, `orbit.turn`, `selection.set`, `focus.set` and more), and a policy
is registered only if its operations are. The default keymap moves, turns, resizes and selects
with the keyboard; `configure` changes it and the other settings, validating every field, and
announces each change as a `settings.changed` event so a host can save the settings with the
layout.

## Presenting in the browser

```ts
import { createWorkspace } from '@swf/core';
import {
  animationFrames,
  createDomInput,
  DOM_COMPOSITOR_ID,
  DOM_RENDERER_ID,
  DomCompositor,
  DomRenderer,
  showDegraded,
} from '@swf/backend-dom';
import { createPresenter } from '@swf/presentation';

// Drag previews are announced once per animation frame, not once per pointer move.
const workspace = createWorkspace({
  id: 'main',
  frameBoundary: (flush) => requestAnimationFrame(flush),
});
// … projections, the surface runtime and the presentation registry as above …

presentation.registerRenderer(new DomRenderer({ document, chrome: { projections } }));
presentation.registerCompositor(new DomCompositor());

const presenter = createPresenter({
  workspace,
  runtime: surfaces,
  registry: presentation,
  frames: animationFrames(window),
  showDegraded,
});
const container = document.querySelector('#main');
const view = await presenter.open({
  viewportId: 'main-viewport',
  container,
  backends: [{ renderer: DOM_RENDERER_ID, compositor: DOM_COMPOSITOR_ID }],
});

router.registerInputAdapter(
  createDomInput({
    root: container,
    viewportId: 'main-viewport',
    events: (listener) => router.subscribe(listener),
  }),
);
```

The presenter brings each open viewport up to date at frame boundaries: it projects the presented
scene (the committed scene with every open preview applied, so a drag shows before it commits),
plans, renders and composes it, attaches what is live and hides what no longer is, then delivers
the hints and publishes the frame's measures. A viewport is presented only when something it reads
changed (its view, the windows and surfaces, selection, focus, or the surfaces' bindings), and
however many changes arrive between two boundaries, it gets one frame with the latest state.
Another viewport's camera moving leaves it alone. `interactive` viewports are presented every
frame they are due; `background` ones (an overview, say) wait while the frame budget (`budgetMs`,
8 by default) is spent, and are counted as skipped. A hidden tab gets no animation frames, so work
waits there and resumes from the latest state. `view.update()` presents a frame at once, for
code that cannot wait.

Unchanged objects cause no writes: the DOM renderer and compositor write an element's properties
only when they change, the geometry renderer redraws a layer only when what it shows changed
(give a drawable a `revision` that changes with its pixels; one without is redrawn every frame),
and every frame reports how many writes it made.

Each surface attached in a viewport gets one advisory hint per frame, and a hint equal to the
last is not sent again. A hint keeps apart whether the frame shows the surface at all
(`visible`), whether its own content is attached and shown (`mounted`), the scene's own flag
(`sceneVisible`), how much of it is in the view (`intersectionRatio`), how much is covered by
what is in front (`occlusion`, `exact`, `estimated` or `unknown`), and how much attention it
has (`active` when its window has focus). Hints never stop, pause or reconfigure a producer, and
nothing the framework does to presentation calls the adapter for anything but attaching, hints and
releasing an attachment.

`maxLive` caps how many surfaces show their own content in a viewport (the focused window first,
then the selection, then the largest on screen); the rest are shown as proxies. With `release`,
a surface that stops being live releases its attachment, but only when its endpoint declares safe
detachment; otherwise it stays attached, hidden.

`view.switchBackend` hands a viewport to another renderer and compositor: the new pair is
prepared (`preparing`), the scene is planned with its capabilities (`validating`), the view is
rebuilt in it and live content is moved over (`swapping`), and only then does it become active and
the old pair is released. Any failure on the way puts back what was moved and keeps the old pair;
a switch that would strand content whose endpoint cannot be detached safely is refused. When the
backend in use is unregistered, or loses its resources (a canvas's 2D context, say), the viewport
falls back through its `backends` in order. When none works it is `presentation-degraded`:
`showDegraded` puts a status line in its container saying why, the scene keeps taking commands and
input, and when a preferred backend is registered again (or `view.restore()` is called after a
loss) the viewport returns to it with whatever was committed meanwhile.

Each live surface gets a slot of its own in each view, laid out at the surface's size
(`pixelsPerUnit` CSS pixels per world unit, 400 by default) and mapped onto its projected corners
with a CSS perspective transform, inside a clip box at the part of it that is visible. The slot
never moves to another parent, so content such as a frame or a video is never reloaded; layers
are stacked by `z-index` in the planned order. Every live slot declares how it is placed
(`data-swf-mode`, `data-swf-anchor`, `data-swf-shape`, `data-swf-placement`): a panorama bends a
planar element, so there it is placed exactly by its corners and its shape is declared
approximate, and a slot that cannot follow its corners is never declared exact.

A surface whose endpoint has a single owner is live in one view only, and in one fragment of it:
another view, or the other side of a seam, shows a proxy with the surface's label instead. If two
views race for the same endpoint, the runtime refuses the second, and that view shows the proxy.

Window chrome (frame outline and title) is a layer of its own that takes no pointer input, so it
never intercepts content; only the resize handles along a window's edges take input, so a press
there reaches the framework even over a cross-origin frame. `createDomInput` offers every pointer,
wheel and key event over the view to the interaction router. What the router consumes stops there
(and a pressed pointer is captured until its gesture ends); what it does not consume reaches the
content as the browser's own event. Nothing is synthesized, and content in a cross-origin frame
gets its input from the browser alone. Labels and host metadata are always inserted as text.

## Drawing and layering

```ts
import { GeometryRenderer, LayeredRenderer, LayerCompositor } from '@swf/backend-geometry';

const renderer = new LayeredRenderer({
  native: new DomRenderer({ document }), // live content only: no chrome of its own
  geometry: new GeometryRenderer({
    projections,
    drawables: (surfaceId) => surfaces.handleOf(surfaceId), // a `drawable` adapter's handles
  }),
});
const compositor = new LayerCompositor();
```

The geometry renderer draws: content a `drawable` adapter supplies (an image source with its
size), warped by a mesh that follows the view's projection point by point and clipped to each
fragment, so a surface split by the panorama seam is drawn on both sides; proxies and placeholders
with their labels; window frames and titles along each window's projected frame; and markers at
the edge of a narrow view pointing to windows outside it. Drawn content is warped piecewise, so it
is declared approximate, never exact. On its own it shows live surfaces as proxies; paired with a
native renderer by `LayeredRenderer`, live content comes from that renderer and everything else
from the geometry renderer, merged in plan order.

`LayerCompositor` stacks live elements and drawn layers in that order by `z-index`: consecutive
drawn layers share one canvas, and a live element between them splits them into separate
canvases. Live elements are appended once and never moved. Occlusion between a live element and
drawn content is by whole layers (`layer-order`): there is no per-pixel depth between them, and
the composed frame says so. Nothing in the framework reads rendered pixels back.

## Checking an implementation

```ts
import { adapterConformance, runConformance } from '@swf/conformance';

const results = await runConformance(
  adapterConformance({
    create: () => new EditorAdapter(),
    keys: { valid: ['editor-1', 'editor-2'], unknown: 'no-such-editor' },
  }),
);
```

Each case also runs on its own (`case.run()` throws on failure), so the suites fit any test
framework. `backendConformance` checks a renderer and a compositor the same way; the DOM backend,
the geometry backend and the two layered together all pass the same suite. `handoffConformance`
runs a backend in a presenter beside the reference mocks: a handoff to it and away from it, a
failed handoff that rolls back, the loss of its graphics context (given `loseContext`, which says
how the backend loses it), and the fallback it chose shown in a running viewport, or the viewport
visibly degraded when nothing works.

## Diagnostics

```ts
import { createDiagnostics } from '@swf/diagnostics';

const diagnostics = createDiagnostics({
  workspace,
  runtime: surfaces,
  presenter,
  registry: presentation,
});
const report = diagnostics.read();
```

A report gives each viewport's backend with its capabilities and state, the fallbacks its last
frame chose grouped by their reasons, frame measures per viewport (frames, skipped frames, last
and longest duration, why the last frame was due, fragments drawn and writes made), attachment
measures per adapter type (bound, presented, failed, binding time and fallback modes), scene
density (nodes, surfaces, and per viewport the candidates, mounted surfaces and culled ones),
resource health (sessions, listeners and subscriptions held, handoffs under way) and the last
typed errors. It holds identifiers, counts and timings only, never content, and sends nothing
anywhere.

## Saving layouts

```ts
import { createIndexedDbStore, createPersistence, createSaver } from '@swf/persistence';

const persistence = createPersistence({ workspace: workspace.persistence() });

// Layout-relevant settings are saved with the layout.
persistence.registerPolicy({
  id: 'swf.interaction/1',
  capture: () => router.settings(),
  restore: (settings) => router.configure(settings),
  watch: (changed) =>
    router.subscribe((event) => {
      if (event.type === 'settings.changed') changed();
    }),
});

// An extension keeps its own state, opaque to the framework, under its namespace.
persistence.registerExtension({
  namespace: 'ext.notes',
  version: 1,
  capture: () => notes.state(),
  restore: (data) => notes.load(data),
});

const store = createIndexedDbStore(indexedDB, { database: 'my-app' });

// On start: restore the last good layout, if there is one.
const stored = await store.load('main');
if (stored !== null) {
  const outcome = await persistence.restore(stored.document);
  if (outcome.status === 'rejected') console.error(outcome.error.path, outcome.error.message);
}

const saver = createSaver({
  persistence,
  store,
  key: 'main',
  ...(stored === null
    ? {}
    : { saved: { revision: stored.revision, changes: persistence.changes() } }),
});
saver.subscribe((state) => console.log('layout is', state));
await saver.save();

const text = persistence.export((await persistence.capture()).document); // portable JSON
const document = persistence.import(text); // validated, or a SNAPSHOT_INVALID error with a path
```

`workspace.serialize()` gives the committed scene as a canonical snapshot: every node with its
hierarchy, transform, bounds, flags, label, tags and metadata (archived ones included), every
surface with its binding key, adapter type, geometry and flags, every camera and viewport, the orbit
root, the selection and focus. Entities are ordered by ID, fields in a fixed order and object keys
sorted, so the same scene always gives the same text. It holds no runtime handle, element,
callback or content: those are never part of the scene. `workspace.persistence()` is the scope for
modules that manage persistence; it offers the revision, `serialize`, `restore` and change
notifications, and nothing else that changes the scene.

`workspace.restore(snapshot)` replaces the whole scene with a snapshot's, as one revision. Nothing is
replaced unless the snapshot is valid and everything it names is usable in this workspace: its
geometry and projection kinds registered and their parameters accepted. A failure leaves the
workspace exactly as it was, with `SNAPSHOT_INVALID` naming the failing path. Records equal to the
current ones are kept as they are, so restoring the same snapshot again changes nothing: a restore
replaces, never adds. The revision never goes back (it becomes the snapshot's when that is later),
and the restore is one undoable step, with the history before it still coherent: undo puts the
previous nodes and surfaces back, while cameras and viewports, being view state, stay.

A snapshot document adds the format (`swf.workspace/1`), the engine that wrote it, when it was
taken, the policies' parameters and the extensions' state. Its JSON Schema is published with the
package (`@swf/persistence/schema/swf.workspace-1.schema.json`, also `SNAPSHOT_SCHEMA`), and the
validator enforces everything the schema says, plus what a schema cannot: unit rotations, a
camera's far beyond its near, unique IDs, references that hold, a hierarchy without cycles, data
nested at most 64 levels deep, and the size limits. Reading a snapshot checks its size before
parsing it, and rejects non-finite numbers, unknown or missing fields, cycles and keys that could
reach an object's prototype, naming the failing path. Nothing in a snapshot is ever run.

Each extension's state is captured on its own, within a timeout (`hookTimeoutMs`, 5 s by
default) and the size limits (1 MiB per namespace and 10 MiB in all by default, set with
`limits`). One that throws, runs out of time or goes over its limit is reported in the capture's
`failures`, and the snapshot carries its last known state; the layout is always captured.
`persistence.retain(document)` keeps a loaded snapshot's policy and extension state, so the state
of namespaces whose owner is not registered goes into later snapshots exactly as it was.

`persistence.restore(input)`, given JSON text or a document, restores in two phases. First, changing
nothing, it reads the snapshot within the size limits, brings it to the current format on a copy
and validates it, and has each registered extension migrate its state on a copy when the snapshot
holds an older version of it. Then the workspace's scene is replaced in one revision. Its surfaces
come back as placeholders that keep their binding keys and bind in place as soon as their adapters
resolve them, in the same window, with the same Surface ID. The policies and extensions then take
back their state, each alone within the hook timeout. A failure in the first phase, or the
workspace refusing the scene, returns `rejected` with nothing changed and an error naming the path
and `details.sourceVersion`, the format the snapshot was in. An extension that cannot take its
state back (a newer version than it reads, no migration, or a failing hook) is reported, and its
state from the snapshot is held: later snapshots carry it unchanged, never overwritten by what the
extension holds instead, until a restore it takes back. The outcome lists the format the snapshot
was in, every migration step with its warnings, and anything kept for an absent owner.

Snapshot formats move forward by migration steps (`SchemaMigration`), each reading one format and
writing the next on a copy of its own; `migrateDocument` follows them to the current format and
validates the result. `swf.workspace/1` is the first published format, so the built-in list
(`SNAPSHOT_MIGRATIONS`) is empty: every later format adds its step, and the fixtures in
`packages/persistence/fixtures` of each format still read must restore and write back byte for
byte. A host can add steps of its own with `migrations`, such as a converter of its earlier layout
format.

A store is the host's: `load`, `save`, `list` and `delete`, declaring whether its saves are atomic
and compare-and-swap. A save names the revision it expects the store to hold; a store refuses a
stale expectation or an older revision than it holds, and keeps what it held when a save fails.
`createMemoryStore` is atomic and compare-and-swap, with an optional size limit.

For browsers there are two stores, both atomic and compare-and-swap. `createWebStorageStore` keeps
layouts of a few megabytes in `localStorage`: each key has two slots and a commit marker naming the
slot with its last good snapshot. A save writes the candidate into the other slot, reads it back,
and only then rewrites the marker in one write, so a save cut short or refused for lack of room
never replaces the last good snapshot. `createIndexedDbStore` keeps large layouts in IndexedDB,
checking the stored revision and writing the new snapshot in one transaction, which either
commits whole or leaves the store as it was. Either one reports a full storage as
`QUOTA_EXCEEDED` and anything else as `STORAGE_FAILED`, and never acknowledges a save that did not
land. They store only the snapshot text: layout metadata and the extensions' own state, never
anything presented.

A saver is `clean`, `dirty`, `saving` or `failed`. A commit, a policy's parameters changing or
an extension reporting a change makes it `dirty`. Only the store's acknowledgement of exactly the
saved key and revision makes it `clean`, and only when nothing changed meanwhile; otherwise it is
`dirty` again. A save the store does not acknowledge makes it `failed`, still unsaved, with the
store holding what it held before. A retry captures afresh, so it never stores an older revision,
and a store that holds a newer one, saved elsewhere, refuses it with `CONFLICT`.

## The reference application

`apps/reference` is a host of the framework like any other: it imports only the packages' public
entry points and registers everything it shows through them (the demo content's adapters, the
DOM, layered and geometry backends, the projection, input and the view modes). It shows the
scene as a 360° panorama around the camera.

Its window is built from wsb's UI kit (`@wsb/uikit`) with Svelte 5, and nothing else: every
control, look and automation handle is the kit's. The scene's controls and the list of windows
are on the left; what is selected is on the right; the panorama is the whole centre, with the
view mode, the backend, the command list and the panel across its top; how the panorama is
presented is in the panel below it. In a narrow window one side at a time floats
over the panorama. Ctrl+Shift+P or F1 opens the command list, which runs every command and goes
to any window by its name. The page installs the kit's automation driver as
`window.wsbAutomation`, which presses controls by their handles as a person does. The page
mounts the window in the body's first element (`#app`), which the kit lays out as the whole
window; a page without it there is refused, saying so.

The kit is taken from a checkout of wsb pinned as the git submodule `wsb`, at the commit the
application builds with; the application depends on the kit's folder there
(`file:../../wsb/wsb/daemon/uikit`), and no framework package depends on the kit, wsb or Svelte.
Clone with `git clone --recurse-submodules`, or run `git submodule update --init` in a clone made
without it, before `npm ci`. npm installs the kit's own development tools inside its folder
there; nothing of the application's build reads them. A new version of the kit is taken by moving
the pin and installing again:

```sh
git -C wsb fetch && git -C wsb checkout <commit>
npm install
git add wsb package-lock.json && git commit
```

```sh
npm run dev                                # the development server, reloading in place on every edit
npm run build -w @swf/reference            # apps/reference/dist/index.html: one self-contained page
npm run build:staging -w @swf/reference    # the same, with the debug overlay
```

The built page holds its script, styles and the kit's faces inline, so it runs from any static
host or opened straight from the file, offline, with no server, account or network access.
Staging builds and the development server add a Diagnostics view to the right side: what the
running presentation reports, read with every frame. Production builds leave it out, with the
diagnostics package.

The address picks the scene: `?preset=seam&seed=7&backend=geometry`.

- `preset`: `sparse` (six windows all the way round, the default), `dense` (250 windows in five
  rings, the benchmark's count), `seam` (windows across the seam behind the camera, behind it on
  both sides and near the pole above it) or `empty`.
- `seed`: an integer from 0 to 4294967295; each preset has its own default.
- `backend`: `dom` (the default) or `geometry`; each is the other's fallback.

An unknown or invalid setting is said in the page, naming it, and nothing starts. A preset plans the same windows from the
same seed on every run, browser and release; the plans of the default seeds are a committed
fixture (`apps/reference/test/fixtures/preset-plans.json`), so a change to them is deliberate.
Loading a preset, resetting it and reseeding it each replace every window in one undoable step and
turn the camera straight ahead. Notes are native page elements, live and editable; tiles are drawn
on canvases, warped into the panorama by the geometry backend and shown as labelled proxies by the
DOM one.

Every string the application shows is a message with a stable ID, in English unless a translation
pack is given, and each action is a command with a stable ID (`reference.preset.load`,
`reference.scene.reset`, `reference.scene.reseed`, `reference.mode.switch`,
`reference.backend.switch`, `reference.window.reveal`).

## Development

The workspace needs Node.js 24 or later and npm.

```sh
npm install     # install the locked development tools
npm run check   # formatting, type checks (svelte-check for the application), lint, tests and
                # build, in that order
npm test        # the test suites only
npm run build   # compile every package to dist/ (ES modules, declarations, source maps),
                # then build the reference application
```

Tests run against each package's TypeScript source, so they need no build first.

The backends', the stores' and the reference application's browser tests run in real browsers,
through Playwright:

```sh
npx playwright install --with-deps chromium firefox webkit && npm run test:browser
```

`SWF_BROWSERS` picks the browsers (comma-separated; all three by default), and
`SWF_CHROMIUM_CHANNEL` runs Chromium as an installed browser instead of Playwright's own, for
example `SWF_BROWSERS=chromium SWF_CHROMIUM_CHANNEL=chrome npm run test:browser` with Google
Chrome installed.

The reference application's build and development server are tested in Chromium, and that the
development server's page shows the application filling the window in Chromium, Firefox and
WebKit:

```sh
npx playwright install --with-deps chromium firefox webkit && npm run test:build
```
