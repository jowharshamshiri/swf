# Integrate SWF into a host

This guide takes a web application (the host) from no SWF to windows of its own content
presented, manipulated, saved and restored, and taken down cleanly. Each step names the package
and links to the README's description of its behaviour. The finished code of a minimal host is
[`examples/browser-host/host.js`](../../examples/browser-host/host.js).

The host keeps everything it shows: SWF places, arranges and presents it, and never creates,
runs, pauses or stops it. Whatever the host gives SWF to present is an opaque endpoint behind a
binding key.

## Install the packages

Install the packages of one release together: each requires its siblings at exactly the
versions released with it ([Versions and compatibility](../reference/versions-and-compatibility.md)).
A browser host needs at least:

```sh
npm install @swf/core @swf/surfaces @swf/presentation @swf/projections @swf/interaction @swf/backend-dom
```

They are ES2022 modules with `sideEffects: false` (except `@swf/models`, which loads its
WebAssembly program when first imported), so a bundler keeps only what the host uses. Without a
bundler, an import map naming each package's `dist/index.js` is enough, as the
[browser host example](../../examples/browser-host/index.html) shows.

## 1. Make the workspace

```ts
import { createWorkspace } from '@swf/core';
import { animationFrames } from '@swf/backend-dom';

const frames = animationFrames(window);
const workspace = createWorkspace({
  id: 'main',
  frameBoundary: (flush) => frames.request(flush),
  timer: () => performance.now(),
});
```

Give the workspace and the presenter (step 4) the same frame source, so a drag's preview is
announced and presented in the same animation frame. The workspace owns the scene: nodes
(windows and groups), surface associations, cameras, viewports. Change it only through
`workspace.transaction`, which commits every command or none
([Using the kernel](../../README.md#using-the-kernel)).

## 2. Register a projection and create a view

```ts
import { createPresentationRegistry } from '@swf/presentation';
import { cameraRotation, createProjectionRegistry, equirectangular } from '@swf/projections';

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
      id: 'main-view',
      cameraId: 'eye',
      projection: { id: 'equirectangular/1', config: { horizontal: 360, vertical: 120 } },
      size: { width: 1600, height: 800, devicePixelRatio: window.devicePixelRatio },
    },
  },
]);
```

A viewport's `size` is its container's size in CSS pixels: when the container resizes, patch the
viewport (`viewport.patch`) with the new size. Several viewports can show the same scene, each
through its own camera and projection.

## 3. Bind the host's content

Write one adapter per kind of content the host presents (an editor, a video, an image), and
register it with the surface runtime. [Write a surface adapter](write-a-surface-adapter.md) says
what each method must do.

```ts
import { createSurfaceRuntime } from '@swf/surfaces';

const surfaces = createSurfaceRuntime(workspace, { bindingTimeoutMs: 15_000 });
const unregister = surfaces.registerAdapter(editorAdapter);
```

Then attach a surface to a window for each piece of content, naming its adapter type and the
binding key the adapter resolves:

```ts
workspace.transaction([
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
```

The binding key is the host's stable name for the content, saved with the layout: choose keys
that still mean the same content after a reload. A key the adapter does not know, or a surface
whose adapter is not registered yet, stays an `unbound` placeholder and binds in place when it
can ([Binding surfaces](../../README.md#binding-surfaces)).

## 4. Present the viewport

```ts
import { createPresenter } from '@swf/presentation';
import {
  DOM_COMPOSITOR_ID,
  DOM_RENDERER_ID,
  DomCompositor,
  DomRenderer,
  showDegraded,
} from '@swf/backend-dom';

presentation.registerRenderer(new DomRenderer({ document, chrome: { projections } }));
presentation.registerCompositor(new DomCompositor());
const presenter = createPresenter({
  workspace,
  runtime: surfaces,
  registry: presentation,
  frames,
  showDegraded,
});
const view = await presenter.open({
  viewportId: 'main-view',
  container: document.querySelector('#main-view'),
  backends: [{ renderer: DOM_RENDERER_ID, compositor: DOM_COMPOSITOR_ID }],
});
```

The container is the host's element; the presenter fills it and leaves it in place when
disposed. List more than one backend pair in `backends` to have a fallback: with
`@swf/backend-geometry`'s `LayeredRenderer` and `LayerCompositor` registered too, a viewport that
loses its DOM backend continues drawn on canvases
([Drawing and layering](../../README.md#drawing-and-layering)). When no backend works, the
viewport shows why and the scene keeps taking commands.

## 5. Route input

```ts
import { createInteractionRouter } from '@swf/interaction';
import { createDomInput } from '@swf/backend-dom';

const router = createInteractionRouter({
  workspace,
  projections,
  presentation: (surfaceId) => view.presentation(surfaceId),
});
const stopInput = router.registerInputAdapter(
  createDomInput({
    root: document.querySelector('#main-view'),
    viewportId: 'main-view',
    events: (listener) => router.subscribe(listener),
  }),
);
```

The router's built-in policies drag windows by their frames, turn the camera by the background,
resize by the edges, and act on the keyboard
([Interaction](../../README.md#interaction)). Input over live content stays with the content
unless the takeover modifier (Alt) is held. Every gesture is also a command, dispatched as an
intent (`router.dispatch({ kind: 'command', command: 'node.move', args: { viewportId: 'main-view', right: 0.2 }, deviceId: 'menu', timestamp: performance.now() })`),
so a host's own controls, menus and assistive technology can do what the pointer does.

## 6. Save and restore the layout

```ts
import { createIndexedDbStore, createPersistence, createSaver } from '@swf/persistence';

const persistence = createPersistence({ workspace: workspace.persistence() });
const store = createIndexedDbStore(indexedDB, { database: 'my-app' });
const stored = await store.load('main');
if (stored !== null) await persistence.restore(stored.document);
const saver = createSaver({
  persistence,
  store,
  key: 'main',
  ...(stored === null
    ? {}
    : { saved: { revision: stored.revision, changes: persistence.changes() } }),
});
```

Save when the host chooses (after each commit, on a timer, on leaving the page) with
`saver.save()`. A snapshot holds the layout and the binding keys, never the content: after a
restore each surface binds again through its adapter. Register the host's own state that belongs
with the layout as an extension (`persistence.registerExtension`) under a `host.*` namespace
([Saving layouts](../../README.md#saving-layouts)).

## 7. Take it all down

Dispose in the reverse order of creation, awaiting each, and release what the host subscribed
to itself:

```ts
stopInput();
router.dispose();
saver.dispose();
persistence.dispose();
await presenter.dispose();
await surfaces.dispose();
await workspace.dispose();
```

Nothing of the host's is touched: its container elements stay in the page and its content keeps
running. [Lifecycle and ownership](../reference/lifecycle-and-ownership.md) lists what each
disposal releases.

## Next

- Check the integration with `@swf/conformance`
  ([Checking an implementation](../../README.md#checking-an-implementation)).
- Report what a running presentation is doing with `@swf/diagnostics`
  ([Diagnostics](../../README.md#diagnostics)).
- Load a projection, backend or adapter only when it is needed:
  [Load modules on demand](load-modules-on-demand.md).
