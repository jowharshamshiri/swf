# Spatial Workspace Framework

A browser-first TypeScript framework for spatial presentation and window management. Applications
attach opaque presentation surfaces to entities in a 3D scene, arrange and manipulate them, and
show the same scene through several views. The framework owns spatial presentation state and
interaction; the host owns whatever is presented.

## Packages

- `@swf/math`: vectors, unit quaternions, position/rotation/scale transforms, affine matrices,
  rays, axis-aligned boxes, and a seeded random sequence that is the same on every engine. The world is right-handed and +Y up; the default camera looks along
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
  their capabilities; how a viewport's representation policy shows a surface in full, as a compact
  preview or by its label alone; the fragments a view is made of; the stages from a committed scene
  to a presented frame; and the presenter, which runs those stages frame by frame within a budget,
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
  its own and labels are text. It also draws a virtual cursor for input policies that move where
  input acts without moving the platform's pointer.
- `@swf/backend-geometry`: a drawing presentation backend, written independently of the DOM one.
  It draws adapter-supplied drawables, proxies, placeholders, window chrome and indicators for
  windows out of view on canvases, pairs with a native renderer through `LayeredRenderer`, and
  its `LayerCompositor` stacks live and drawn layers in one explicit order.
- `@swf/conformance`: suites that check an adapter, a renderer or a compositor against the
  contracts, with reference mocks to run them against.
- `@swf/diagnostics`: what a running presentation can report locally: each viewport's backend
  and capabilities, the fallbacks chosen and why, frame, attachment and scene-operation measures,
  scene density, resource health and the last typed errors; a trace of the workspace's operations
  to reproduce interaction bugs; and an export of both that discloses labels, binding keys and the
  host's data only when asked.
- `@swf/persistence`: versioned, canonical workspace snapshots with a published JSON Schema and
  a validator that matches it, policy parameters and opaque extension state with size limits,
  two-phase restore with format migrations, a replaceable storage interface with in-memory, Web
  Storage and IndexedDB stores, and the save state machine.
- `@swf/benchmark`: the performance benchmark. Seeded standard and stress fixtures, a host that
  presents a fixture through the framework as an application would, the measures a run takes in
  the page (frame intervals, input-to-preview latency, hit queries), the statistics results are
  reported in, and a probe of the listeners, observers, frames and timers a page holds, for
  disposal soaks.

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

Every commit ends with one `transaction.committed` event, and every refusal is announced as
`transaction.rejected`. Each says how long the transaction took by the workspace's `timer` (its
`now` clock unless a finer one, such as `performance.now`, is given), and a commit carries the
commands it committed (none for an undo, a redo or a restore, which name what they reverse or
replace), so a listener can trace operations without the caller's help.

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

`findNodes` (also `workspace.findNodes`) finds nodes by what the workspace says about them, never
by what a surface shows. Its text matches, as a Unicode-normalized (NFKC), case-insensitive
substring, a node's ID, label and tags; the values at the metadata keys the query exposes
(`metadataKeys`, string and number values only; any other metadata is never searched); and, with
`groupPath`, the labels and IDs of the groups the node is in. It filters by kind, tags, `within`
(inside a group's subtree), effective visibility and lock, and returns IDs in scene order. `fold`
is the same normalization, for callers that compare names.

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

Each planned fragment also carries its surface's `condition`: `bound` (with the capabilities its
endpoint declares, and whether a single-owner handle is presented in another viewport),
`pending`, `unbound` (no key, an unknown key, or released), `unsupported` (no adapter for its
type) or `failed` (with the typed error). `standInReason` turns it into what a proxy or
placeholder says: `pending`, `unbound`, `unsupported`, `unavailable` (a failure that can be
retried), `failed` or `elsewhere` (shown in another view). Both renderers write the reason on
the stand-in, in English by default (`STAND_IN_TEXT`) or in the host's words (their `standIn`
option), and the DOM renderer marks it `data-swf-stand-in`; a stand-in chosen by a representation,
or a seam's secondary proxy, says nothing, since the view shows why. A viewport with no working
backend says `Backend unavailable` and why.

A viewport projects again only what changed (NFR-005, NFR-020): while its view is the same, the
presenter hands the projector the scene and fragments of its last frame, and the projector keeps
the fragments of every surface whose record, owner and ancestors are the same objects, projecting
only the rest; the result equals a projection made afresh. A camera turn or a resize changes the
view, and everything is projected again.

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
the same surface, and surfaces behind the camera are kept, not dropped. Its inverse is exact. A
surface whose bounding sphere lies wholly above, below or (short of the full circle) beside the
view is ruled out from its bounds alone, without sampling its outline (NFR-017).
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
it does not consume is the host's to deliver natively. A pointer or wheel intent that picked also
reports its hit query (`pick`): whether its best two candidates tied, and how long it took by the
router's `timer` (`Date.now` unless the host gives a finer clock, such as `performance.now`).

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
is registered only if its operations are. A command honours the flags its gesture does: a window
that is not draggable, rotatable or resizable is left as it is, saying why, and a locked one is
refused by the scene. `configure` changes the keymap and the other settings, validating every
field, and announces each change as a `settings.changed` event so a host can save the settings
with the layout.

The default keymap acts on the selected window while the view has the keyboard: the arrows move
it along the camera's right and up (with Shift, five times as far), Page Up and Page Down change
its depth, `[` and `]` turn it, `+` and `-` resize it; Alt with the arrows turns the camera, and
Alt+Shift with Left and Right the orbit root; N and P select the next and previous window, Enter
focuses the selected one, and Ctrl or Cmd with Z, Shift+Z or Y undo and redo. Tab is never bound,
so the keyboard can always leave the view. A sign is matched however it is typed: `+` is Shift
and `=` on many layouts, so Shift does not count against a binding of a sign that does not list
it; a letter's case is Shift's to say.

Space picks the selected window up (`gesture.grab`, or the command with a `nodeId`): a keyboard
gesture reported like a pointer's (`gesture.started` with `KEYBOARD_HOLD_ID` and no pointers).
While it is held, every `node.move`, `node.rotate` and `node.resize` of it, from a key or a
program, previews instead of committing; Enter or Space (`gesture.drop`) puts it down as one
commit that one undo takes back, and Escape, `gesture.cancel`, the window's removal or the view's
disposal cancel it with nothing changed. A locked window is refused when it is picked up, and a
pointer pressed on the held window is refused, as on any window in a gesture.

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

// One frame source paces both the workspace and the presenter: drag previews are announced once
// per animation frame, not once per pointer move, and presented in the frame that announces them.
const frames = animationFrames(window);
const workspace = createWorkspace({
  id: 'main',
  frameBoundary: (flush) => {
    frames.request(flush);
  },
});
// … projections, the surface runtime and the presentation registry as above …

presentation.registerRenderer(new DomRenderer({ document, chrome: { projections } }));
presentation.registerCompositor(new DomCompositor());

const presenter = createPresenter({
  workspace,
  runtime: surfaces,
  registry: presentation,
  frames,
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
has (`active` when its window has focus). The frame keeps every attached surface's hint as it
computed it (`view.lastFrame().hints`), sent again or not, for inspection. Hints never stop, pause or reconfigure a producer, and
nothing the framework does to presentation calls the adapter for anything but attaching, hints and
releasing an attachment.

`maxLive` caps how many surfaces show their own content in a viewport (the focused window first,
then the selection, then the largest on screen); the rest are shown as proxies. With `release`,
a surface that stops being live releases its attachment, but only when its endpoint declares safe
detachment; otherwise it stays attached, hidden.

`view.setRepresentation(policy)` gives a viewport a representation policy: for each surface in
each frame, `representationOf({ scene, view, surfaceId, nodeId })` answers `full`, `compact` or
`label` (semantic depth answers by distance from the camera, say). A `full` surface is negotiated
as usual; a `compact` or `label` one only among the modes that stand for it without its content (a
proxy, or a placeholder where no proxy is possible), so its content is not mounted there. That is
a choice of presentation only: the endpoint stays bound and attached (hidden), nothing is released,
paused or reconfigured, and a fallback is reported only when capabilities rule a mode out, never for
the representation chosen. Each planned fragment carries its `representation`; renderers draw a
`label` proxy as the label alone, with no window chrome, and a `compact` one as a framed proxy, and
hints say `compact` (or `proxy`, for a label) as the tier. `view.setRepresentation(null)` shows
every surface in full again. The policy must answer from what it is given alone, and anything that
is not a representation is an error naming the policy and the surface.

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
never intercepts content. Its frame is drawn in `chrome.inks` (CSS colours, custom properties
included): every frame in `frame`, the selected window's thicker in `selected` and the focused
one's in `focused`, so the window keys act on is seen. The defaults stand out on a light page; a
host gives the colours its own design system checks against its grounds; only the resize handles along a window's edges take input, so a press
there reaches the framework even over a cross-origin frame. `createDomInput` offers every pointer,
wheel and key event over the view to the interaction router. What the router consumes stops there
(and a pressed pointer is captured until its gesture ends); what it does not consume reaches the
content as the browser's own event. Nothing is synthesized, and content in a cross-origin frame
gets its input from the browser alone. Labels and host metadata are always inserted as text.

`createVirtualCursor({ container })` draws a cursor in a view's container for an input policy
that changes where input acts (a cursor wrapped across a panorama's seam, say): a page cannot move
the platform's pointer, so the policy shows where its pointer is with `show(x, y)` and `hide()`. It
takes no input, is hidden from assistive technology and shifts nothing the container lays out;
whoever shows it says in words what it means.

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
with their labels, each on a ground of its own; window frames and titles along each window's
projected frame; and markers at the edge of a narrow view pointing to windows outside it. Frames,
the selection, the focus, titles and markers are drawn in `inks`, a function the renderer reads
every frame so a host's change of appearance is drawn at the next one; a canvas takes no custom
property, so the host gives resolved colours. Drawn content is warped piecewise, so it
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
typed errors. Scene operations are measured by command type (AN-002): how many committed and were
refused, the nodes they changed, the last revision, and the last, longest and total duration by
the workspace's `timer` (its `now` clock unless the host gives a finer one). It holds
identifiers, counts and timings only, never content, and sends nothing anywhere.

```ts
import { createOperationTrace, exportDiagnostics } from '@swf/diagnostics';

const trace = createOperationTrace({ workspace });
// ... reproduce the bug ...
const text = trace.serialize(); // canonical JSON: the same operations give the same text
const shared = exportDiagnostics({
  report: diagnostics.read(),
  scene: workspace.getState(),
  trace,
  exportedAt: Date.now(),
  disclosure: { labels: false, bindingKeys: false, hostData: false }, // the default
});
```

The operation trace keeps every transaction, committed or refused, in order (1000 by default):
its ID, source, cause, revisions, command types, the commands committed (each transaction event
carries them), what an undo or redo reversed, the IDs it changed, and a refusal's error code and
path. Serialized, it leaves out what is the host's unless disclosed: a label becomes `"[label]"`,
a binding key a token (`binding-1`, one per key), tags and metadata `"[host data]"`, and error
messages and timings are dropped, so two runs of the same operations give the same text. The
export holds identifiers, performance numbers and error codes by default; labels, binding keys,
the host's data, error messages and timings are added only when chosen, each in its own section
keyed by ID, and the host's own measures go in as given. Nothing walks a surface's content.

## Measuring performance

```ts
import {
  analyseFrames,
  createBenchmarkHost,
  layoutViewports,
  planFixture,
  recordFrames,
  STANDARD,
} from '@swf/benchmark';

const fixture = planFixture(STANDARD, 1);
const host = await createBenchmarkHost({
  fixture,
  containers: layoutViewports(document.body, fixture),
});
await host.settled();
const frames = recordFrames(window);
// ... turn the camera, drag a window ...
const analysis = analyseFrames(frames.stop());
await host.dispose();
```

`planFixture` plans a seeded fixture, the same on every run and engine (AN-010). The standard
fixture (`STANDARD`, §26.1) holds 250 windows with 300 surfaces among them (every fifth window
holds two, the second drawn), in five groups nested one inside the next with windows at every
depth, in five rings round the camera; two viewports side by side on the 1920×1080 page, one
looking ahead and one behind, each 64° by 72° (the same degrees per pixel each way), each show 30
to 50 surfaces wherever its camera turns. The stress fixture (`STRESS`) doubles it. Content is
plain elements and proxies, so frames measure the framework. `createBenchmarkHost` presents a
fixture with the DOM backend on the page's animation frames, with input over the first viewport
routed by the built-in policies; the elements are the caller's, and disposing the host leaves
them holding nothing of the framework's.

A run measures with `recordFrames` (animation-frame timestamps), `recordPreviewLatency` (from
each pointer event's timestamp to the start of the frame after the one that shows its preview,
with the most moves waiting at once), `recordPicks` (the router's own hit-query times) and
`timePicks` (hit queries at fixed points, many per point so that a coarse clock still resolves
them), and `recordControl`, the control a run is read against: the page itself moving one plain
element every frame, with no framework, which shows what the browser on the machine gives a page
at all. `summarize` gives median, 95th percentile (by nearest rank) and maximum; `analyseFrames`
gives intervals, a histogram in 1 ms bins, skipped frames and the share of intervals that were
one display frame, and `meetsFrameBudget` holds NFR-001: at least 95% of intervals one 60 Hz
frame, at the 60 Hz rate itself. `growthExponent` fits how a cost grows with the scene (about 1
for linear, 2 for quadratic). `createResourceProbe` wraps a window's listener, observer,
animation-frame and timer registration and counts what is held: compared before a workspace is
made and after it is disposed, it shows what disposal left behind (NFR-010).

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
reach an object's prototype, naming the failing path. Text that is not JSON is refused with the
line and column where it breaks and what was expected there (`details.line`, `details.column`),
found the same way in every engine (`jsonSyntaxError`). Nothing in a snapshot is ever run.

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
DOM, layered and geometry backends, the projection, input and the view modes). It shows one
scene four ways: as a 360° panorama around the camera, in focus, on a map from above and as tiles.

Its window is built from wsb's UI kit (`@wsb/uikit`) with Svelte 5, and nothing else: every
control, look and automation handle is the kit's. The scene's controls and the windows (with their
search) are on the left; what is selected is on the right; the panorama is the whole centre, with the
view mode, the backend, the command list and the panel across its top; how the panorama is
presented is in the panel below it. In a narrow window one side at a time floats
over the panorama, and a panorama narrower than 600 CSS pixels (a phone's) has the view mode as a
list across its top, leaving what drags turn and the backend to the command list and Features, so
the actions stay within it: at 320 pixels the scene, the overview, selection and the inspector are
all there. Ctrl+Shift+P or F1 opens the command list, which runs every command and goes
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
Staging builds and the development server add a Developer panel to the right side (see below).
Production builds leave it out, with the diagnostics package and the failure simulation.

The address picks the scene: `?preset=seam&seed=7&backend=geometry`. An address that names no
preset and no seed restores the workspace this browser saved last (see Workspaces), or loads the
default scene when there is none or it cannot be restored, which is said over the panorama.

- `preset`: `sparse` (six windows all the way round, the default), `dense` (250 windows in five
  rings, the benchmark's count), `seam` (windows across the seam behind the camera, behind it on
  both sides and near the pole above it), `composed` (a board of three supplied surfaces side by
  side in one window, and a window of its own to either side) or `empty`.
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
`reference.backend.switch`, `reference.window.reveal`, `reference.focus.enter`,
`reference.focus.exit`, `reference.focus.step`, `reference.window.map`,
`reference.window.inspect`, `reference.window.place`, `reference.window.nudge`,
`reference.window.turn`, `reference.window.resize`, `reference.window.size`,
`reference.window.face`, `reference.window.lock`, `reference.gesture.grab`,
`reference.gesture.drop`, `reference.feature.set`,
`reference.feature.reset`, `reference.snap.configure`, `reference.depth.configure`,
`reference.navigation.set`, `reference.orbit.designate`, `reference.orbit.turn`,
`reference.history.undo`, `reference.history.redo`, `reference.gesture.cancel`,
`reference.feature.combine`, `reference.window.remove`, `reference.surface.detach`,
`reference.surface.move`, `reference.window.merge`, `reference.window.regroup`,
`reference.workspace.save`, `reference.workspace.open`, `reference.workspace.delete`,
`reference.workspace.deleteAll`, `reference.workspace.export`, `reference.workspace.import`,
`reference.workspace.saveNow`). Undo and redo are also across the top of the centre.

Every preset's windows are in one group, Workspace, which stands unturned at the camera's place and
is designated as the group workspace orbit turns.

### Keyboard and assistive technology

Everything is done with the keyboard alone, and nothing needs a pointer's precision: finding a
window (the command list, or the Windows view's search), selecting, focusing, moving it on each
axis and in depth, turning, resizing, grouping and locking it, undoing and redoing, cancelling a
gesture, saving and restoring.

- **The panorama** is one stop of the page's keyboard order, an application a screen reader
  names "Panorama" and describes by its keys (`aria-description`). With the keyboard there, the
  framework's keymap acts on the selected window (arrows, Page Up/Down, `[` `]`, `+` `-`, N and
  P, Enter, Space to pick it up), and the panel's hint lists the keys. While it has the keyboard
  the kit's view draws its focus ring inside its own edge. Tab leaves it, through the windows' own
  content, which keeps its own keys. The selected window is outlined in the kit's focus colour and
  the focused one in its warning colour, in both backends and appearances.
- **Anywhere but a field or a window's content**: Ctrl+Z undoes, Ctrl+Shift+Z or Ctrl+Y redoes,
  Ctrl+S saves the workspace now (Cmd on a Mac), Escape cancels the gesture running (a drag, or a
  window held from the keyboard) or else closes focus, and Ctrl+Shift+P or F1 opens the command
  list, which also goes to the panorama, picks the selected window up, and locks or unlocks it.
- **The inspector's Place** moves the selected window a step at a time (left, right, up, down,
  nearer, farther), turns it (15°), resizes it (0.1 units), picks it up and puts it down, takes its
  exact place, turn (0 faces the camera) and size, and locks it. Each is one undoable change; a
  locked window's controls are disabled, saying why. These are also what touch and pen use for
  every gesture: a drag, a resize handle, the wheel with Shift and a pinch each have their
  control, a background drag has each window's Reveal and Features' turns, and a tap has the
  Windows list.
- **The Windows view** stands in for the panorama for whoever cannot see it: every window, by
  name, with where it is (degrees right or left, up or down, and units away), selected, focused,
  revealed or inspected from its row.
- **What happens is said.** What a key or a control did (a window selected, moved, turned,
  resized, picked up, put down, cancelled, locked, the workspace saved) is spoken politely
  through the kit's one announcer, which takes no room; what was refused, and why, is shown as an
  alert where it was asked for, once: over the panorama for its keys, under the entry it names for
  the inspector's exact entries (read with the entry, which is marked not valid), and over the
  inspector for its other controls.
- The kit draws every control at 24 CSS pixels at least, with its focus ring, its contrast in
  both appearances, and no motion when the reader asks for reduced motion; the application moves
  nothing of its own (the camera jumps). Windows' content is the host's and outside the
  framework's accessibility guarantee.

### View modes

The modes switcher across the top of the centre shows the one scene four ways. A mode is the
viewport's view setting, never a placement: switching mode changes no window's world transform,
ID or surface association, and the panorama stays presented in the same element throughout, so no
content is attached or detached by a switch.

- **Panorama**: the whole 360° around the camera.
- **Focus**: the selected (or focused) window shown readably, centred and filling three-quarters
  of the view at most two and a half times its content's own size, by turning the camera to face
  it and narrowing the projection to frame it (the same angle per pixel across and down, so
  nothing is stretched). A bar above names it; a row below holds the nearest windows to its left
  and right, with how far round each lies, and pressing one focuses it. Focus follows the
  workspace's focus, so focusing a window from any list, tile or the map frames that one; a resize
  fits the frame again. Escape or the bar's close button leaves focus for the mode, projection and
  camera it was entered from, and leaving it for any other mode puts the camera back too.
- **Map**: the scene from above, with straight ahead of the default camera up the page: the
  camera and its heading, the ground in front of it and behind it shaded apart, rings a world unit
  apart, and each window as the line it stands on, filled in front and hollow behind, with its name.
  Pressing a window selects it; dragging it (past the same slop as the panorama's) moves it on the
  ground as far as the pointer moves, the point it was grabbed by staying under the pointer,
  previewed in every view as it goes (the panorama below the map shows it move) and committed once
  when let go; Escape puts it back. A press that does not drag moves nothing. A window moved round
  the camera turns with it, so it keeps facing the camera. Dragging the ground pans, the wheel and
  the zoom buttons zoom, and the fields beside the map place the selected window exactly, its
  height (which a map from above cannot show) included.
- **Overview**: every window the search finds, as tiles, a page at a time with the rest a press
  away. A tile is the window itself: pressing it selects that window's ID, opening it (a double
  press or Enter) focuses it.

The map and the overview take the top of the centre over the live panorama, with a movable edge
between them.

### Behaviour modules

Eight behaviour modules are modules of their own, each installed only through the framework's
public contracts and each turned on or off on its own from the Features view on the left: focus and
context, workspace orbit, the spatial map, the wrapped cursor, magnetic positioning, semantic depth,
composition, and saving and opening workspaces. All are on by default, the combined preset; Turn
every feature on brings them all back keeping their settings, and Reset also puts the settings back.
Turning one off removes its hooks and its controls (a mode leaves the switcher, after the view
showing it goes back to where it came from; a view leaves the side; its commands are refused, saying
it is off) and never changes the scene's data, its layout or what is saved, and none needs another.
Each application holds its own modules: nothing is shared between two of them.

- **Focus and context** and **the spatial map** are the Focus and Map view modes, offered while
  they are on.

- **Workspace orbit** turns a designated group round the camera, as an ordinary scene change that
  undo puts back; turning the camera instead changes only the view and is never undone. What a drag
  on the panorama's background turns is the viewport's navigation setting, chosen explicitly with
  the Camera | Workspace switch across the top of the centre (or the command list) and never
  switched by where the pointer is: the panel says which one is in force, and while drags turn the
  workspace a line above the panorama says so. The Features view picks the group, turns it by 15°
  either way (as do Alt+Shift+Left and Right), and shows the camera's heading beside the
  workspace's turn to compare the two. Off, drags turn the camera and the keys that turn the group
  are taken out of the keymap; the group stays designated.
- **Semantic depth** represents each window by its distance from the camera: nearer than the first
  band it shows its content, then a compact preview stands for it, and beyond the second band its
  label alone (4 and 5.5 world units by default). The window focus presents is always shown in full.
  It is the viewport's representation policy, so content is never detached, paused or
  reconfigured: a window brought nearer shows the same live content again. The inspector says how
  the selected window is shown.
- **Magnetic positioning** snaps a window being moved: an edge within the snap distance (0.08 world
  units) of a neighbour's facing edge, short of it or over it, goes to that edge with the padding
  (0.04) between them, and the window's centre lines up with a neighbour's heading or elevation, or
  the horizon, within the line-up angle (2°). Only windows side by side snap, those whose distance
  from the camera is within a quarter of the moving one's. A snap turns the window about the
  camera, so it keeps its distance and facing. Each place is previewed snapped, a line above the
  panorama says what it snapped to and offers Cancel (as Escape does), and releasing commits the
  snapped place once, after which the line says how it ended and offers Undo.
- **The wrapped cursor** carries a pointer the framework took (a window being moved, the view being
  turned) past one edge of the 360° panorama back in at the other, where the seam behind the camera
  is, so a drag across the seam keeps its window and the point of it that was grabbed. A drawn
  cursor shows where the drag acts, because a page cannot move the platform's pointer: that pointer
  stops at the edge of the screen, as the Features view says. Pointers left to content, and every
  pointer while the view shows less than the whole circle (in focus), are not wrapped.

- **Composition** and **saving and opening workspaces** are described below.

### Composition

A window can hold several surfaces a host supplied, side by side within its frame. The inspector
lists the selected window's surfaces and rearranges them, each change one undoable step:
**detach** a surface into a window of its own, standing beside the one it left and turned as it is,
while that window closes up round the rest; **move** a surface into another window, after its own
surfaces; **merge** a window's surfaces into another window; or move the window into another group,
or a new one, keeping its place in the world. A window left with no surface is removed with the
step that emptied it, and so is a group left empty. Only associations and placements change: a
surface is always moved whole, its binding and content untouched, and a window's only surface
offers nothing to detach, since a surface's own content is never split.

### Removing a window

**Remove from workspace** takes the selected window out of the workspace as one undoable step. A
line above the panorama says it was removed and that its content is not deleted or stopped, and
offers Undo while the removal is still the last change; undo brings the window back with the very
same content.

### Workspaces

While saving is on, the workspace is saved in this browser as it changes, and the next visit that
names no scene restores it; the panel says whether everything is saved. Each visit saves under a
key of its own, so a visit that loads a scene of its own never saves over another, and older visits
are removed only once the new one is stored. The Workspaces view on the left saves what is on
screen under a name (a name saved again is replaced only once the new one is stored), opens a named
workspace, exports the workspace to a `.json` file and imports one. Opening or importing first
says what the snapshot holds (its windows, groups, surfaces and viewports, when it was made, its
format and the host state it carries) and replaces the workspace only when that is confirmed, as
one undoable step; a file that is not a workspace snapshot is refused, saying the line or path at
fault, and nothing changes. Reset to demo loads the demo scene, leaving saved workspaces as they
are. Delete all saved removes every layout the application saved in this browser, and says that it
touches neither what windows show nor anything the host keeps elsewhere. Only layout is stored: the
scene, the policies' parameters and the scene's source (the host's own state, under
`host.reference.scene`), never content.

### Developer panel

Staging builds and the development server have a Developer panel on the right, in five sections.
It reads through the framework's public APIs only, changes the scene only as a host does, and never
looks into a surface's content.

- **Inspect**: the selected window's world and local transforms and parent; for each surface its
  adapter, binding key and binding state, its tier, attention, visibility and occlusion with its
  confidence (from the last frame's hints), its last error, its fragments in the last frame (bounds,
  whether it owns input or is a seam duplicate, mode, layer, fidelity, and why it stands in), and
  the capabilities its endpoint declares; the last input target (where it landed, what it hit, the
  region and route, and whether the hit was ambiguous); and the last frame's scheduling. The debug
  overlay draws each fragment's bounds and projected outline over the panorama, a seam's second
  fragment marked as a duplicate of the same surface, and where the last pick landed; it takes no
  input.
- **Events**: a timeline of scene, surface, input and presentation events by the IDs they concern.
- **Capabilities**: what each kind of endpoint in the scene declares, side by side, and the
  panorama's renderer and compositor.
- **Simulate**: windows whose adapter is missing, slow or throws, each saying why it stands in
  (unsupported, binding, temporarily unavailable) while every other window goes on working, with
  the host's recovery for each (registering the adapter, letting the binding finish, fixing the
  adapter and retrying); a second view of the scene, in which a note, which can be shown in one view
  at a time, says it is shown in another; and taking each backend's renderer away, after which the
  panorama falls back to the other and, with none left, says the backend is unavailable.
- **Measures**: scene density, scene operations by command type, input and hit-query measures,
  mode changes, the time from a mode change to the next focus, pointer travel, and persistence
  sizes, times and outcomes; and the diagnostics and operation-trace exports, which hold IDs,
  numbers and error codes only unless labels, binding keys, the host's data, error messages or
  timings are chosen.

### Search

The Windows view finds windows by their workspace metadata only: ID, label, tags, the descriptive
metadata the host exposes (the demo host exposes each window's colour, `host.reference.colour`)
and the labels of the groups they are in. It never looks at what a window shows. Matching is the
kernel's `findNodes` (Unicode-normalized NFKC, case-insensitive substrings), run once typing has
paused for 100 ms. Filters, which compose, narrow by group (at any depth), effective visibility,
lock, how the window's content is attached (attached, attaching, not bound or failed) and whether
the viewport shows it. Results sort by most recently focused (the default), name (numbers by their
value), distance from the camera, group or ID, either way round; ties go by name, then ID. The
list draws only the rows in view and reads the results in pages of 50, so hundreds are all
reachable and none is cut off; when nothing matches it says so and offers to clear the filters or
reset the search. Each result can be focused, revealed in the panorama, shown in the map or
inspected, and none of these moves it.

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

`SWF_BROWSERS` picks the browsers (comma-separated; all three by default).
`SWF_CHROMIUM_CHANNEL` runs Chromium as an installed browser instead of Playwright's own build
(`chrome` for Google Chrome), and `SWF_FIREFOX_CHANNEL` does the same for Firefox (`moz-firefox`
for Mozilla Firefox, driven over WebDriver BiDi): for example
`SWF_BROWSERS=chromium,firefox SWF_CHROMIUM_CHANNEL=chrome SWF_FIREFOX_CHANNEL=moz-firefox npm run test:browser`.

Conformance is recorded per browser: `npm run conformance -- --out <folder>` runs the browser
suites in each browser in turn and writes each browser's report, `conformance.json` and
`conformance.md`, which name the browser, its version and the machine, and gather the tests of
each end-to-end acceptance scenario of §33.2 (a test names its scenario as `§33.2 scenario <n>`).
It exits non-zero when a test failed or a scenario has no test.

The performance benchmark runs one browser at a time on a 1920×1080 page:
`npm run bench -- --out <folder>` writes what each browser measured on the standard and stress
fixtures as JSON, and `benchmark.md` with every measure's median, 95th percentile and maximum
over five trials, the environment and the method, and a verdict for each budget on the standard
fixture (the stress fixture records how far it degrades, held only to sub-quadratic growth). A
trial first records the control, then times cold creation (NFR-007), the retained heap (NFR-006),
hit queries (NFR-003), and 60
seconds after a warm-up each of turning the camera by its background and dragging a window by
its frame with the real mouse (NFR-001, NFR-004), and one window's move at 125 to 1000 windows
(NFR-008). The heap is measured where the engine reports it to automation, which only Chromium
does (over the DevTools protocol, after forced collections): in Firefox and Safari it is
recorded as not measurable. `SWF_BENCH_TRIALS`, `SWF_BENCH_WARMUP_MS` and `SWF_BENCH_TRIAL_MS`
shorten a run for trying it out, and the report says what they were.

On Windows both run on an mg-test guest, in Google Chrome and Mozilla Firefox as their publishers
ship them (each installer's signature checked, Node.js checked against its release's checksums):
`mg-test run mg-test.yaml --plan windows` brings back `out/conformance` and `out/bench`
(`mg-test/windows.ps1` says what it does).

Golden scenes and scripted interaction traces of the reference application's four view modes
and eight behaviour modules are committed under `apps/reference/test/fixtures/golden` (QA-012):
a change in behaviour shows as a changed fixture, reviewed and updated with `npx vitest -u`.

The reference application's browser tests check its accessibility with axe-core (WCAG 2.2 A and
AA) and by hand: keyboard order, focus rings, target sizes, reduced motion, contrast, what is
said and alerted, a control for every gesture and the 320-pixel layout
(`apps/reference/test/browser/accessibility.browser.test.ts`). The keyboard-only scenario is one
self-contained test, `apps/reference/test/browser/keyboard.browser.test.ts`.

The reference application's build and development server are tested in Chromium, and that the
development server's page shows the application filling the window in Chromium, Firefox and
WebKit:

```sh
npx playwright install --with-deps chromium firefox webkit && npm run test:build
```
