# Spatial Workspace Framework

A browser-first TypeScript framework for spatial presentation and window management. Applications
attach opaque presentation surfaces to entities in a 3D scene, arrange and manipulate them, and
show the same scene through several views. The framework owns spatial presentation state and
interaction; the host owns whatever is presented.

## Documentation

This README describes each package's behaviour. [`docs/`](docs/README.md) holds the tutorial, the
integration guide and the other how-to guides, the generated API reference, the lifecycle and
ownership rules, browser support, versions and compatibility, the security boundary, the
architecture and its decision records, and the handover pack. [`examples/`](examples/README.md)
holds small hosts, each run by the tests.

## Packages

- `@swf/math`: vectors, unit quaternions, position/rotation/scale transforms, affine matrices,
  rays, axis-aligned boxes, and a seeded random sequence that is the same on every engine. The world is right-handed and +Y up; the default camera looks along
  -Z with +X to the right. Lengths are arbitrary world units.
- `@swf/models`: the framework's and the reference application's state machines and decision
  logic, written in Lean with their invariants proved, and compiled by lungo into one WebAssembly
  program that this package loads once when it is first imported (see
  [State machines and decision logic](#state-machines-and-decision-logic)). Only the packages that
  decide something through it depend on it.
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

## Installing

The packages are installed by git URL, never from a package registry: each release makes a git
ref of this repository for each package, `<folder>/v<version>`, holding exactly the built package,
and a package brings its sibling packages by their refs. For example, with release 0.1.0 of each:

```sh
npm install git+https://github.com/jowharshamshiri/swf.git#core/v0.1.0
```

installs `@swf/core` with `@swf/math` and `@swf/models`. Each release's `COMPATIBILITY.md` lists
every package with its URL; [Integrate SWF into a host](docs/how-to/integrate-a-host.md#install-the-packages)
says which a browser host needs.

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
`LOCKED` or `CONSTRAINT_REJECTED`), the `path` of the failing input and a readable message. A
host callback the transaction calls (a constraint's `appliesTo` or `resolve`, `createId`, a
geometry or projection check, the workspace's clocks) that throws is a rejection too, naming the
callback and what it threw. Committed state is immutable: every commit produces a new
`SceneState`.

Every commit ends with one `transaction.committed` event, and every refusal is announced as
`transaction.rejected`, except one for a failing clock, since no event can be stamped without it.
Each of the two says how long the transaction took by the workspace's `timer` (its `now` clock
unless a finer one, such as `performance.now`, is given), and a commit carries the commands it
committed (none for an undo, a redo or a restore, which name what they reverse or replace), so a
listener can trace operations without the caller's help. Every event of one operation carries the
same `timestamp`: the workspace's `now` clock as the operation began.

A host ties events to its own actions with `causeId`, which an event carries as its
`causationId`. Given to a transaction, an undo, a redo or a restore, it is on every event of the
commit, its entity events and `transaction.committed` alike, or on the refusal's
`transaction.rejected`; given to a preview, it is on the preview's `transform.preview` events
and on the `preview.cancelled` that ends it, even when a commit re-applies or ends the preview.
Without one, those events carry the transaction's or the preview's own ID.

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
whole edge row. Within `EQUIRECTANGULAR_POLE_BAND` (2⁻²⁶ radians) of a pole, where rounding
through the camera loses a direction's longitude, a direction is the pole, imaged at the centre of
its row, and a point unprojects to the pole whatever its column. A surface crossing the seam yields
one fragment on each side, both referring to the same surface, and surfaces behind the camera are
kept, not dropped. Its inverse is exact. A surface whose bounding sphere lies wholly above, below
or (short of the full circle) beside the view is ruled out from its bounds alone, without sampling
its outline (NFR-017).
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
with the layout. A keymap must bind only commands the router has, given at creation or configured
later. Other step sizes for the keyboard come as a keymap: `defaultKeymap({ move: 0.2 })` builds
the default bindings with those steps, to configure as `keymap`.

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

A viewport is listed (`presenter.viewport(id)`, `presenter.viewports()`) once it started, on a
backend or degraded; its ID cannot be opened again while it is open or still opening. When it
cannot start, because the host's `showDegraded` throws, say, it is disposed and the `open` rejects
with that failure: nothing of it stays registered, and the same ID can be opened again. A viewport
whose record the scene no longer has (a `viewport.delete` committed before the host disposed it)
keeps its last frame and presents nothing more, while the other viewports go on; dispose it with
the record.

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
the old pair is released. Any failure on the way, a surface the runtime will not move, release or
hide included, and a new pair whose loss cannot be watched, releases everything the new pair made,
puts back what was moved, released or hidden and keeps the old pair; a switch that would strand
content whose endpoint cannot be detached safely is refused. Putting back goes on past a surface
the runtime will not put back, and `kept` names each such surface, with why, in `unrestored`. When the
backend in use is unregistered, or loses its resources (a canvas's 2D context, say), the viewport
falls back through its `backends` in order. When none works it is `presentation-degraded`:
`showDegraded` puts a status line in its container saying why, the scene keeps taking commands and
input, and when a preferred backend is registered again (or `view.restore()` is called after a
loss) the viewport returns to it with whatever was committed meanwhile. `view.restore()` answers
`kept`, with the failure, only when a preferred backend was tried and failed; a viewport already on
its first backend has nothing to try and answers `switched` with it. A handoff the viewport begins
on its own (a loss, an unregistration, a preferred backend registered again) has no caller, so
when it fails to finish, because `showDegraded` throws, say, the viewport is degraded all the
same, its old pair released, and the failure is kept in `presenter.getDiagnostics()` as
`BACKGROUND_FAILED`; a function `showDegraded` returned that throws is kept there as
`HOST_THREW`.

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
the host's data and error messages are added only when chosen, each in its own section keyed by
ID, and the trace's timestamps and durations only when timings are chosen (the report's own
performance measures are always in it); the host's own measures go in as given. Nothing walks a surface's content.

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
of namespaces whose owner is not registered goes into later snapshots exactly as it was. A
policy's or extension's `watch` is started when it registers; one that throws, or does not return
the function that stops it, fails the registration with `EXTENSION_FAILED` and leaves nothing
registered, so the owner can register again.

`persistence.restore(input)`, given JSON text or a document, restores in two phases. First, changing
nothing, it reads the snapshot within the size limits, brings it to the current format on a copy
and validates it, and has each registered extension migrate its state on a copy when the snapshot
holds an older version of it. Then the workspace's scene is replaced in one revision. Its surfaces
come back as placeholders that keep their binding keys and bind in place as soon as their adapters
resolve them, in the same window, with the same Surface ID. The policies then take back their
parameters, and the extensions their state, each alone within the hook timeout and the caller's
signal; a policy or extension that throws, rejects or runs out of time is reported. A
failure in the first phase, or the workspace refusing the scene, returns `rejected` with nothing
changed and an error naming the failing path where there is one. Text over the size limit or not
JSON is refused before its format is read; every later refusal also names the format the snapshot
was in, as `details.sourceVersion`. An extension that cannot take its
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
never replaces the last good snapshot, and a save whose marker landed is reported as saved. `createIndexedDbStore` keeps large layouts in IndexedDB,
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
search) are on the left; the radar and what is selected are on the right; the panorama is the whole
centre, with the view mode, the backend, the command list and the panel across its top and the
view's own controls (field of view, camera heading, workspace turned) above it; how the panorama
is presented is in the panel below it. In a narrow window one side at a time floats
over the panorama, and a panorama narrower than 600 CSS pixels (a phone's) has the view mode as a
list across its top, leaving what drags turn and the backend to the command list and the
experiment panel, so
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
npm run build:everyday -w @swf/reference   # the same, without the experiment panel
```

The built page holds its script, styles and the kit's faces inline, so it runs from any static
host or opened straight from the file, offline, with no server, account or network access.
Staging builds and the development server add a Developer panel to the right side (see below).
Production builds leave it out, with the diagnostics package and the failure simulation. Every build
but an everyday one carries the experiment panel (see Behaviour modules); an everyday build leaves
it out, nothing of it in the page, with every capability on and the everyday controls (the view
switcher, what drags turn, the view's sliders, the radar, the inspector, the command list) in
place. Building in any other mode is refused, naming the mode.

The address picks the scene: `?preset=seam&seed=7&backend=geometry`. An address that names no
preset and no seed restores the workspace this browser saved last (see Workspaces), or loads the
default scene when there is none or it cannot be restored, which is said over the panorama.

- `preset`: `studio` (the default: thirteen named windows all the way round and at every depth),
  `sparse` (six windows all the way round), `dense` (250 windows in five rings, the benchmark's
  count), `seam` (windows across the seam behind the camera, behind it on both sides and near the
  pole above it), `composed` (a board of three supplied surfaces side by side in one window, and a
  window of its own to either side) or `empty`.
- `seed`: an integer from 0 to 4294967295; each preset has its own default.
- `backend`: `geometry` (the default) or `dom`; each is the other's fallback. The default is the
  geometry backend (`LayeredRenderer`): notes are placed live in the page and tiles are drawn, so
  every window, a focused one included, shows what it holds. The DOM backend places live elements
  and never draws (ADR 0003), so it shows tiles by their labelled stand-ins.

The studio is the workspace a first visit opens on. A board of three surfaces (Plan, Timeline and
Sources) stands straight ahead; round it stand twelve more windows (Writing Desk, Build Status,
Messages, Metrics, Calendar, Code Review, Reading List, Tasks, Sketches, Signal Monitor, Media
Notes and Archive), eight of them behind the camera, some high and some low, at distances in each
of semantic depth's bands: the near ones show their content, the middle ones a compact preview and
the far ones their labels. Each window shows a category, a headline figure and a line about what
it holds, in a colour of its own, and its category is exposed to search beside its colour
(`host.reference.category`). The near windows are native notes, which both backends present live;
the far ones are drawn tiles. A seed moves each window a few degrees, never across a band.

An unknown or invalid setting is said in the page, naming it, and nothing starts. A preset plans the same windows from the
same seed on every run, browser and release; the plans of the default seeds are a committed
fixture (`apps/reference/test/fixtures/preset-plans.json`), so a change to them is deliberate.
Loading a preset, resetting it and reseeding it each replace every window in one undoable step and
turn the camera straight ahead. Notes are native page elements, live and editable; what the
operator writes in one is the host's, kept in this browser by the note's binding key (never in the
layout), so the note shows it whenever that key is bound again, in a later visit too. Tiles are
drawn on canvases, warped into the panorama by the geometry backend and shown as labelled proxies
by the DOM one.

Every string the application shows is a message with a stable ID, in English unless a translation
pack is given, and each action is a command with a stable ID (`reference.preset.load`,
`reference.scene.reset`, `reference.scene.reseed`, `reference.mode.switch`,
`reference.mode.back`, `reference.view.fov`, `reference.view.heading`,
`reference.backend.switch`, `reference.window.reveal`, `reference.window.bringFront`,
`reference.window.sendBehind`, `reference.window.arrange`, `reference.focus.enter`,
`reference.focus.exit`, `reference.focus.step`, `reference.window.map`,
`reference.window.inspect`, `reference.window.place`, `reference.window.nudge`,
`reference.window.turn`, `reference.window.resize`, `reference.window.size`,
`reference.window.face`, `reference.window.lock`, `reference.gesture.grab`,
`reference.gesture.drop`, `reference.feature.set`,
`reference.feature.reset`, `reference.snap.configure`, `reference.depth.configure`,
`reference.navigation.set`, `reference.orbit.designate`, `reference.orbit.turn`,
`reference.orbit.turnTo`,
`reference.history.undo`, `reference.history.redo`, `reference.gesture.cancel`,
`reference.experiment.run`, `reference.window.remove`, `reference.surface.detach`,
`reference.surface.move`, `reference.window.merge`, `reference.window.regroup`,
`reference.window.add`,
`reference.workspace.save`, `reference.workspace.open`, `reference.workspace.delete`,
`reference.workspace.deleteAll`, `reference.workspace.export`, `reference.workspace.import`,
`reference.workspace.saveNow`, `reference.scenario.start`, `reference.scenario.stop`,
`reference.challenge.start`, `reference.challenge.cancel`, `reference.challenge.clear`). Undo and
redo are also across the top of the centre.

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
  P, Enter, Space to pick it up), A and D turn the camera as Alt with Left and Right do, 1 to 4
  show the views in the switcher's order, F shows the selected window in focus, M shows the map
  and Escape leaves the map or the overview for the view it was opened from; the panel's hint lists
  the keys. These single keys act only while the panorama has the keyboard. While it has the keyboard
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
  control, a background drag has each window's Reveal and the experiment panel's turns, and a tap has the
  Windows list.
- **The Windows view** stands in for the panorama for whoever cannot see it: every window, by
  name, with where it is (degrees right or left, up or down, and units away), selected, focused,
  centred on, brought in front of the camera, sent behind it or inspected from its row.
- **The view's controls** above the panorama are the kit's sliders, each with a number to type:
  the arrows step them a degree, Page Up and Page Down a tenth of their range, Home and End to
  their ends.
- **What happens is said.** What a key or a control did (a window selected, moved, turned,
  resized, picked up, put down, cancelled, locked, the workspace saved) is spoken politely
  through the kit's one announcer, which takes no room; what was refused, and why, is shown as an
  alert where it was asked for, once: over the panorama for its keys, under the entry it names for
  the inspector's exact entries (read with the entry, which is marked not valid), and over the
  inspector for its other controls.
- The kit draws every control at 24 CSS pixels at least, with its focus ring, its contrast in
  both appearances, and no motion when the reader asks for reduced motion; the application moves
  the view into and out of a focus only when motion is allowed (the camera jumps otherwise).
  Windows' content is the host's and outside the framework's accessibility guarantee.

### View modes

The modes switcher across the top of the centre shows the one scene four ways. A mode is the
viewport's view setting, never a placement: switching mode changes no window's world transform,
ID or surface association, and the panorama stays presented in the same element throughout, so no
content is attached or detached by a switch.

- **Panorama**: the whole 360° around the camera, or as much of it as the field of view shows.
  The field of view (85° to 360°, set above the panorama) zooms it, its vertical angle keeping the
  panorama's proportion; the map and the overview show the panorama at the same field of view, and
  focus, which frames its window with a projection of its own, puts it back when it closes. Under
  the windows the panorama shades what lies behind the camera and names it, and while it shows the
  whole circle it marks both edges as the seam, where they meet: a window carried past one edge
  comes in at the other, its heading moving on without a jump.
- **Focus**: the selected (or focused) window shown readably, centred and filling three-quarters
  of the view at most two and a half times its content's own size, by turning the camera to face
  it and narrowing the projection to frame it (the same angle per pixel across and down, so
  nothing is stretched). Its content stays live: a note is the same element, edited in place. A
  bar above names it, steps to the next window to the right (round the circle, past the last) and
  closes the focus. Under it, with a movable edge between them, the focus strip holds a card for
  every window: the focused one in the middle, the others left and right of it in the order they
  lie round the camera, behind it at the ends, each as far from the middle as it lies round where
  room allows and never over another. A card is the window's name, in the kit's stage units, over
  the host's own picture of what it holds: a tile's drawing (the very drawable the panorama draws)
  or a note drawn small in its colours with what is written in it, drawn again as it changes. The
  cards lie in one row while they fit at a width their names can be read at, in two staggered rows
  when not; when even two rows cannot hold them, the nearest each way are kept and the rest named
  above the strip. Pressing a card focuses its window; from the strip's keyboard stop, the arrows
  step to the next window either way; above it the nearest two each way are named with how far
  round each lies, each a press away.
  A double press on a window's frame or stand-in in the panorama focuses it (a double press on live
  content stays the content's). Focus follows the workspace's focus, so focusing a window from any
  list, tile or the map frames that one; a resize fits the frame again. Escape or the bar's close
  button leaves focus for the mode, projection and camera it was entered from, exactly, and
  leaving it for any other mode puts the camera back too. Entering a focus, moving it to another
  window and leaving it are committed at once and shown moving there over about a quarter of a
  second, from the first frame that shows the new view, as a preview of the view's own records;
  the operator turning the camera or taking a window in hand ends the move at once, and with
  reduced motion asked for the view goes there at once. On the DOM backend, which cannot draw, a
  focused tile is shown by its stand-in.
- **Map**: the scene from above, with straight ahead of the default camera up the page: the
  camera and its heading, the ground in front of it and behind it shaded apart, the wedge the
  panorama shows while its field of view is less than the circle, rings a world unit apart (five
  zoomed out), their distances written down the line behind the camera every ring or every second,
  fifth or tenth as room allows, and each window as the line it stands on, filled in front and
  hollow and dashed behind, faded while the panorama does not show it, ringed while it is focused,
  with its name. In front and behind are named where the line through the camera meets the map's
  edges. A name is the size the kit writes it, to the right of its window's mark, or to its left,
  above or below it where that runs off the map or onto another name; it is dropped only where
  every one of those places overlaps a name already written, and the selected and the focused
  windows' names are always written (the Lean model `Swf.AppOverview`).
  Pressing a window selects it; dragging it (past the same slop as the panorama's) moves it on the
  ground as far as the pointer moves, the point it was grabbed by staying under the pointer,
  previewed in every view as it goes (the panorama below the map shows it move) and committed once
  when let go; Escape puts it back. A press that does not drag moves nothing. A window moved round
  the camera turns with it, so it keeps facing the camera, and with magnetic positioning on it
  snaps to the windows beside it as a move in the panorama does. Dragging the ground pans, the wheel and
  the zoom buttons zoom, and the fields beside the map place the selected window exactly, its
  height (which a map from above cannot show) included.
- **Overview**: every window at once, as a card on a board that is the whole sphere round the
  camera unrolled as the panorama unrolls it: straight ahead in the middle, left and right a
  quarter of the way to each edge, behind at both edges (shaded), overhead at the top, the horizon
  dashed across, the regions named along the top. A card stands across the board exactly at its
  window's heading, and down it as near its elevation as the cards beside it allow, never
  overlapping one, the higher window's above; the board takes the largest card size that holds
  every window, and says so where none does, drawing each window as a dot where it stands (the
  Lean model `Swf.AppOverview`). A card names its window and, large enough, says where it is
  (heading and distance), its group, what it shows and how many parts it is composed of; its strip
  is its group's colour, named beside the board. It is selected in the selection's colour, ringed
  while focused, and faded while the panorama does not show it or the search leaves it out.
  Pressing a card selects its window, a double press focuses it. Beside the board, the search and
  the windows it finds, as a list, a page at a time with the rest a press away: pressing a row
  selects it, opening it (a double press or Enter) focuses it, and the selected window's actions
  stand at the head. The board and the list are read from the scene each time it changes and keep
  nothing of their own: a card and a row are the window's own ID.

The map and the overview take the top of the centre over the live panorama, with a movable edge
between them.

### The radar and the view's controls

The radar is at the top of the right side, above what is selected, in every view: the map's
drawing, always centred on the camera and scaled to hold every window inside its rim, with the
distance of each ring and the bearings round the rim written on it, and a line saying what its
marks mean. Pressing a window on it selects it; dragging one moves it round the camera, behind it
too, previewed in the panorama as it goes and committed once when let go. Under it, Centre on the
selected turns the camera to face the selected window, and Arrange round spreads every window that
stands on its own and is not locked evenly round the whole circle from straight ahead, by what it
shows and its colour, on three rings (one in each band semantic depth draws by), as one undoable
change. Its head folds it, leaving the side to the selection, and opens it again.

Above the panorama, three sliders set the view: the field of view, the camera's heading and the
workspace's turn. The heading and the field of view are view state, never undone; turning the
workspace previews as the slider moves and is one undoable change when let go, and is offered while
workspace orbit is on and a group is designated, saying why when it is not. Switching what a drag
on the panorama's background turns, the camera or the workspace, changes no scene coordinate.

Each window's actions, in the inspector, the Windows view's rows and the overview, focus it,
centre the view on it, bring it straight in front of the camera or send it straight behind (at the
distance and height it stands, facing the camera; one undoable change each), and show it in the
map.

### Behaviour modules

Eight behaviour modules are modules of their own, each installed only through the framework's
public contracts: focus and context, workspace orbit (the workspace's rotation), semantic depth,
the wrapped cursor (seamless 360° interaction), the spatial map, magnetic positioning,
composition, and saving and opening workspaces (persistent workspaces). All are on by default.
Turning one off removes its hooks and its controls (a mode leaves the switcher, after the view
showing it goes back to where it came from; a view leaves the side; its commands are refused, saying
it is off) and never changes the scene's data, its layout or what is saved, and none needs another.
Each application holds its own modules: nothing is shared between two of them. The radar beside the
panorama is an everyday control and stays whatever is on.

The **experiment panel** (Experiments, on the left; an everyday build leaves it out) tries the eight
capabilities one at a time or together. Its head says which experiment the switches are now and how
to try it, comparing the behaviour with the capability off; any other combination is said to be a
custom one, naming what is on. Under it are the experiments: **Everything combined** and **01 Focus
and context** to **08 Persistent workspaces**, each turning its capability on and every other off
and setting the view up to show it (`reference.experiment.run`): focus on the selected window (the
panorama while none is selected), drags turning the workspace (while a group is designated), the
whole circle in view for the seamless 360° experiment, the map, and otherwise the panorama with
drags turning the camera. An experiment changes no window and nothing undo puts back. Then the
eight switches, which combine the capabilities in any way, and the settings of those that have
any; Reset turns all eight on and puts the settings back. The panel holds only configuration: it
runs the commands that turn the modules on and off and set the view, and none of a capability's
behaviour is in it. Which modules an experiment turns on, how it sets the view up, and which
experiment a combination is are the Lean model `Swf.AppExperiments`. The command list offers the
experiments and the switches while the panel is there.

- **Focus and context** and **the spatial map** are the Focus and Map view modes, offered while
  they are on.

- **Workspace orbit** turns a designated group round the camera, as an ordinary scene change that
  undo puts back; turning the camera instead changes only the view and is never undone. What a drag
  on the panorama's background turns is the viewport's navigation setting, chosen explicitly with
  the Camera | Workspace switch across the top of the centre (or the command list) and never
  switched by where the pointer is: the panel says which one is in force, and while drags turn the
  workspace a line above the panorama says so. The experiment panel picks the group, turns it by 15°
  either way (as do Alt+Shift+Left and Right), and shows the camera's heading beside the
  workspace's turn to compare the two; the slider above the panorama turns it to any heading. Off, drags turn the camera and the keys that turn the group
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
  stops at the edge of the screen, as the experiment panel says. Pointers left to content, and every
  pointer while the view shows less than the whole circle (in focus), are not wrapped.

- **Composition** and **saving and opening workspaces** are described below.

### Composition

A window can hold several surfaces a host supplied, side by side within its frame. The inspector
lists the selected window's surfaces and rearranges them, each change one undoable step:
**detach** a surface into a window of its own, standing beside the one it left and turned as it is,
while that window closes up round the rest; **move** a surface into another window, after its own
surfaces; **merge** a window's surfaces into another window; or move the window into another group,
or a new one, keeping its place in the world. A window left with no surface is removed with the
step that emptied it, and so is a group left empty; a window that holds other nodes is never emptied,
so neither its last surface moves out nor is it merged. Only associations and placements change: a
surface is always moved whole, its binding and content untouched, and a window's only surface
offers nothing to detach, since a surface's own content is never split.

### Adding a window

**Add a window**, at the top of the Windows view (and in the command list, and offered by an empty
workspace), adds a blank native note to the workspace straight ahead of the camera, three units
away and facing it, wherever the camera or the workspace is turned, and selects it: one undoable
step. Each added window has a number and a colour of its own, and its content is known by its key
alone (`added/note/<number>`), so a saved layout holding it binds it again in another visit.

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
fault, and nothing changes. Reset to demo loads the studio, leaving saved workspaces as they
are. Delete all saved removes every layout the application saved in this browser, and says that it
touches neither what windows show nor anything the host keeps elsewhere. Only layout is stored: the
scene, the policies' parameters and the scene's source (the host's own state, under
`host.reference.scene`), never content.

### Scenarios

The Scenarios view on the left walks through the framework's principal behaviours, one scenario
at a time, in the studio. Starting a scenario loads the studio as it is planned, with the features
the scenario shows turned on and the panorama shown: one undoable step, so undo brings back the
workspace it replaced. The view lists the scenario's steps; the step due says the ways the
application offers to do it, and is ticked off as soon as it is done, by any of them: the panorama,
the keyboard, the inspector, the map, the Windows view or the command list. **Show me** does the
step due as the application's own controls would. Start again begins the scenario afresh; Stop
leaves it.

- **Put a window behind you**: select the Writing Desk, move it behind the camera, and see it on the
  map.
- **Reach a window you cannot see**: select Tasks, high up behind the camera, without turning round;
  turn to face it; read it in focus.
- **Change a window's depth**: select Media Notes, far enough away that only its label shows; bring
  it nearer than semantic depth's full band, where its content shows; push it back beyond the
  compact band.
- **Switch focus between windows**: focus a window, focus one of its neighbours, leave focus.
- **Compose surfaces**: detach Sources from the Project Board, move it into the Writing Desk, and put
  it back on the board.
- **Save and restore a layout**: save the studio as “Studio layout”, change it, and open the saved
  layout again, every window going back where it was saved.

A step that waits for a change (a neighbour focused, the layout changed, the saved layout opened)
counts only a change made after it became due. A step whose window has been removed cannot be done
or shown, and says so: undo, or start the scenario again.

### Finding a window, timed

Under the scenarios, **Find a window** is an optional timed task for comparing ways of navigating:
turning the camera, turning the workspace, the map, the overview, or searching by name. Pick one
and press Start: the view the way navigates in is shown, and the task names a window to find,
behind the camera whenever one is and never the window already selected. It counts every press and
key made anywhere in the page, and the run ends the moment that window is selected, by any route,
recording the window, the way, the time in milliseconds and the presses and keys. The runs of the
visit are listed, latest first, and summed up by way (runs, best and average time, average presses
and keys); Clear the runs forgets them. A run whose window is removed ends unfinished, saying so;
Give up ends one without a record. A way whose feature is off (the workspace orbit, the map) cannot
be picked.

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
metadata the host exposes (the demo host exposes each window's colour, `host.reference.colour`,
and the studio's windows' categories, `host.reference.category`)
and the labels of the groups they are in. It never looks at what a window shows. Matching is the
kernel's `findNodes` (Unicode-normalized NFKC, case-insensitive substrings), run once typing has
paused for 100 ms. Filters, which compose, narrow by group (at any depth), effective visibility,
lock, how the window's content is attached (attached, attaching, not bound or failed) and whether
the viewport shows it. Results sort by most recently focused (the default), name (numbers by their
value), distance from the camera, group or ID, either way round; ties go by name, then ID. The
list draws only the rows in view and reads the results in pages of 50, so hundreds are all
reachable and none is cut off; when nothing matches it says so and offers to clear the filters or
reset the search. Each result can be focused, centred on in the panorama, brought in front of the
camera, sent behind it, shown in the map or inspected; only bringing and sending move it.

## State machines and decision logic

Every state machine of the framework and the reference application, and every decision that
admits, refuses, orders or chooses, is a Lean model in `models/` (the Lake project `swf_models`),
with its invariants stated and proved in Lean. lungo compiles the models into one program,
`swf-models`, and generates the TypeScript package `packages/models/program/` from it: the
program as WebAssembly, its typed API, and `assurance.json`, which records every claim proved of
every export. `@swf/models` loads the program once, with top-level await, on lungo's minimal WASI
in every environment; the packages call it synchronously and keep their own public APIs, converting
their values at the boundary. The TypeScript does the work (binding, rendering, storing, moving
attachments); the model decides each state it passes through and each request it admits.

| Model                | Decides                                                                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Swf.Kernel`         | The workspace lifecycle (§13.1); a transaction's admission, idempotent replay and refusals in order; what a commit, undo, redo or restore does to the revision, the history and the idempotency cache |
| `Swf.Hierarchy`      | That a node never becomes its own ancestor (reparenting, grouping), and which commands a lock refuses                                                                                                 |
| `Swf.Surface`        | Every surface presentation state and its announcement (§13.2), and the bind, unbind, present, replace, move and hide requests each state admits, single-owner mounts and handovers included           |
| `Swf.Gesture`        | Where each pointer sample, press and key goes; each gesture phase from press to commit or cancel (§13.3); the keyboard hold's admission                                                               |
| `Swf.Arbitration`    | Which gesture wins a press, and which hit under a pointer is the target, in what order and whether ambiguously                                                                                        |
| `Swf.Save`           | The snapshot save states (§13.4), which acknowledgements count, and that the saved revision never goes back                                                                                           |
| `Swf.Migration`      | The steps that bring a snapshot of an older format to the current one, without cycles                                                                                                                 |
| `Swf.Fallback`       | Each fragment's presentation mode, its fallback report, fidelities and layer, which fragment holds the live handle, and which fallback orders are policies; a whole frame in one call                 |
| `Swf.Handoff`        | Each backend handoff stage (§13.5), what becomes of every attached surface, what a failed handoff puts back for each, and whether it switched, kept the previous backend or degraded the viewport     |
| `Swf.Presenter`      | Which viewport IDs the presenter admits and lists: one viewport per ID, listed once it started, its ID freed when it is disposed or fails to start                                                    |
| `Swf.ViewMode`       | The reference application's view-mode switch and the view a mode returns to                                                                                                                           |
| `Swf.Order`          | An order key for doubles, so the models' claims about order (priorities, distances) are proved over integers                                                                                          |
| `Swf.AppOrbit`       | The reference application's workspace orbit: which group it turns, what a background drag navigates, and the commands of each change                                                                  |
| `Swf.AppCursor`      | Which pointers the wrapped cursor carries across the panorama's seam, where it wraps them, and when its virtual cursor is drawn                                                                       |
| `Swf.AppFeatures`    | Which feature toggles and settings a patch may set, refused field by field, and what changes                                                                                                          |
| `Swf.AppExperiments` | The experiments: the modules each turns on (one alone, or all), the view it sets up from what the scene offers, and which experiment a combination of switches is, any other being custom             |
| `Swf.AppSnap`        | The magnetic snap: which neighbour edge or line-up, spoke round the camera or ring a moved window snaps to, nearest first, within its thresholds                                                      |
| `Swf.AppDepth`       | The semantic-depth band of every window of a frame at once, farther never showing more                                                                                                                |
| `Swf.AppComposition` | Composition plans (detaching, moving and merging surfaces, breaking a window into parts and recombining them, regrouping and grouping windows) and the IDs of new windows                             |
| `Swf.AppWheel`       | A burst of the wheel over a window as one gesture: what it shows, when it is committed once, and when cancelled                                                                                       |
| `Swf.AppWorkspaces`  | Named workspaces: valid names, autosave, saving now, restoring the newest visit, the stale visits, save times and which files import                                                                  |
| `Swf.AppScenarios`   | How a guided scenario advances: from its first step, one step at a time and in order, each only once its condition holds while it is due, never undone                                                |
| `Swf.AppChallenge`   | The timed window-finding task: which window a run names (never the selected one, behind the camera when any is), what it counts, when it ends and the records it keeps                                |
| `Swf.AppOverview`    | Where each window's card stands on the overview's board (across at its heading, never overlapping, the higher above, at the largest size that holds them all), and which names the map writes         |
| `Swf.AppFocus`       | When the view moves into a focus, between focused windows and out of it: when a move starts, goes on through a fit, finishes or ends at once                                                          |

`lungo.toml` names the exports and requires a proved claim of every one (`require-claims`); a claim
proved with `sorry` fails the build. Read what was proved of an export with
`lungo assurance Swf.Kernel.gate`, or in `packages/models/program/assurance.json`;
`packages/models/test/assurance.test.ts` checks that every export the packages call carries proved
claims resting on nothing but Lean's standard axioms.

### Building and changing the models

The models need the `lungo` command at version 1.131.83 (machinefabric's apt package; without
installing anything on the machine, `apt-get download lungo=1.131.83` and `dpkg -x` it into a
folder of your own, then put its `opt/lungo` on `PATH`) and Lean 4.35.0, which
`lungo setup`, run at the repository root, installs through elan in the per-user elan home. The Lake project
requires lungo's Lean library at the same version (`models/lakefile.toml`, locked by
`models/lake-manifest.json`). npm builds and tests need neither: the generated program is
committed.

```sh
cd models && lake build && cd ..   # elaborate the models and check every proof
npm run models                     # regenerate packages/models/program from them
npm run models:verify              # check that the committed program is what the models generate
```

To change a decision, change its model, never the TypeScript around it: edit the Lean, state and
prove what the change must keep, add any new export to `lungo.toml`, run `npm run models`, adapt
the boundary in the package that calls it, and commit the Lean and the regenerated program together.
`npm run check` starts with `models:verify`, so a program out of step with its models fails it.
`packages/models/program/` is generated: never edit it by hand (`.gitattributes` marks it so).

The reference application's single-file page carries the program inlined, as a data URL its loader
fetches, so the page still runs offline from the file.

## Development

The workspace needs Node.js 24 or later and npm. The reference application is built from the wsb
UI kit, which comes from the git submodule `wsb`; its repository is not public. A clone without
it checks, tests and builds every package and the examples, and leaves the reference application
out, saying so; with access to it, `git submodule update --init wsb` and `npm install` bring it.

```sh
npm install     # install the locked development tools
npm run check   # formatting, type checks (svelte-check for the application), lint, tests and
                # build, in that order
npm test        # the test suites only
npm run build   # compile every package to dist/ (ES modules, declarations, source maps),
                # then build the reference application
npm run size    # each package's bundle size against its budget, and that it tree-shakes
npm run api-reference   # the API reference in api-reference/, failing on an undocumented
                        # public declaration
```

`npm run check` runs `npm run size` and `npm run smoke:packages` after building the packages, and
`npm run api-reference -- --check` after the lint. The first fails a package over its budget in
`size-budgets.json`, or one that leaves code behind when imported for nothing, and reports each
package's change from its recorded size; the second packs every package as npm packs it for a host,
installs the tarballs in a fresh project, and compiles and runs a program using them all, with every
library's declarations checked; the third fails on an undocumented public declaration. `npm run
release` builds a versioned release from a commit ([Release the packages](docs/how-to/release.md)).

A budget is raised only deliberately, by hand, to the package's measured gzip size rounded up to the
next 256 bytes, so it leaves no room for growth nobody looked at; the measured sizes are recorded
with `npm run size -- --record` in the same commit, whose message gives the old and the new budget.
`@swf/models` is at 55296 bytes: it is the compiled program of every proved decision model the
framework and the reference application run, so it grows with each model, the experiments the
latest (55111 bytes measured).

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
(`mg-test/windows.ps1` says what it does). The benchmark's reference machine (§26.1) is the
`windows-gpu` plan's guest, which has an NVIDIA card: its `probe` task runs one short trial in each
browser and says what each renders with, and its `browsers` task makes the record. A guest with
no GPU renders in software, where a browser may not reach 60 Hz even for the control; its numbers
are an observation of that machine, not a verdict.

What each browser's automation can and cannot do shapes what runs where (NFR-022). Real touch and
pen input reach a page only in Chromium (over its DevTools protocol), so those cases are skipped
elsewhere. Firefox driven over WebDriver BiDi (`moz-firefox`) cannot emulate an appearance or
reduced motion through Playwright, so the accessibility cases that need them are skipped there. On
a Windows guest, tasks run without a desktop session: a browser's window never has the system
focus, so stable Firefox may fire no focus event for a `focus()` (scenario 10's keys panel then
never shows), and headless Firefox composites in software. The heap is measured only in Chromium.
Firefox's results that count are therefore from a Linux desktop, where it has the focus and
composites at 60 Hz.

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

## Licence

SWF is licensed under the [Apache License, Version 2.0](LICENSE); [`NOTICE`](NOTICE) holds its
copyright notice. Every package carries both.
