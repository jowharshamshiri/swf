# Integrate SWF into a host

This guide takes a web application (the host) from no SWF to windows of its own content
presented, manipulated, saved and restored, and taken down cleanly. Each step names the package
and links to the README's description of its behaviour. The finished code of a minimal host is
[`examples/browser-host/host.js`](../../examples/browser-host/host.js).

The host keeps everything it shows: SWF places, arranges and presents it, and never creates,
runs, pauses or stops it. Whatever the host gives SWF to present is an opaque endpoint behind a
binding key.

## Install the packages

The packages are not on a package registry. Each is released as a git ref of the repository,
`<folder>/v<version>`, and installed by its git URL; it requires its sibling packages by their
refs of the same release, so npm brings them too. Install the packages a host uses from one
release: that release's `COMPATIBILITY.md` lists every package with its URL
([Versions and compatibility](../reference/versions-and-compatibility.md)). For a browser host of
release 0.1.0 of each package:

```sh
npm install \
  git+https://github.com/jowharshamshiri/swf.git#core/v0.1.0 \
  git+https://github.com/jowharshamshiri/swf.git#surfaces/v0.1.0 \
  git+https://github.com/jowharshamshiri/swf.git#presentation/v0.1.0 \
  git+https://github.com/jowharshamshiri/swf.git#projections/v0.1.0 \
  git+https://github.com/jowharshamshiri/swf.git#interaction/v0.1.0 \
  git+https://github.com/jowharshamshiri/swf.git#backend-dom/v0.1.0
```

The packages keep their names, so the host imports `@swf/core` and the rest as usual. npm
records each package's commit in the host's lock, so a reinstall gets the very same files.

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

## Show the whole navigation experience

Steps 1 to 5 build a viewport by hand. A host that wants what the reference application shows (the
view modes and the view moving between them, focus with its strip, the map and the radar, the
overview with search, workspace orbit, magnetic snapping, semantic depth, composition, and every
action as a named command) makes it with `@swf/navigation` in one call, with its own adapters:

```ts
import { createNavigation, createNavigationCommands } from '@swf/navigation';

const navigation = await createNavigation({
  root: element, // the host's element; the viewport is as large as it, always
  id: 'workbench',
  adapters: [myAdapter],
  windows: {
    partOfKey: 'host.partOf', // where a window made from another's surface keeps its origin
    searchKeys: ['host.kind'], // the host's metadata search reads
    category: (node) => kindOf(node), // the overview's grouping
    arrangeKey: (node) => kindOf(node) ?? '', // what arranging round the camera orders by
    newWindowFor: (surface) => ({ tags: [], metadata: {} }), // a composed window's own
  },
  backend: 'geometry',
  chrome: KIT_CHROME, // the custom properties window chrome is drawn in
  words: navigationWords(messages), // what the viewport says, in the host's language
});
navigation.workspace.transaction(myOpeningCommands);
const commands = createNavigationCommands(() => navigation); // every swf.* command
```

A host on the wsb UI kit takes the controls from `@swf/navigation-ui`: a `NavigationModel` bound
to the navigation, and the components it wants, each taking only that model.

```svelte
<script lang="ts">
  const model = new NavigationModel({ messages, content: myContent });
  // In the panorama's onsurface: make the navigation there, then
  // model.attach(navigation, createNavigationCommands(() => navigation), NAVIGATION_COMMAND_NAMES);
</script>

{#snippet panorama()}
  <Panorama {model} onsurface={start} />
{/snippet}
<NavigationCentre {model} {panorama} />
<ModeSwitcher {model} />
<Radar {model} open ontoggle={…} />
<Inspector {model} />
<ExperimentPanel {model} />
```

- **Turn one off** by not mounting it; the rest work on. `NavigationCentre` takes `strip`, `map`
  and `overview` as `null` to leave each out (its mode then shows the panorama whole), and
  `Panorama` takes `controls` as `null` to show no view controls.
- **Replace one** with a component of the host's own that reads the same model and runs the same
  commands (`model.runNavigation`): `Panorama`'s `controls`, and `NavigationCentre`'s `strip`, `map`
  and `overview`, take the host's snippet in the package's place.
- **Style them** through the kit's theme, which every control draws from, and window chrome through
  the `ChromeTokens` the host gives `createNavigation`.
- **Give them the host's words** for its content in `HostContent` (what a surface and a window show,
  and the strip's pictures), its own notices, bars and empty state through `Panorama`'s snippets,
  and navigation's keys through `navigationKey(model, event)` in its page's key handler.

The content stays the host's: an element is attached where the view shows it and detached into the
host's keeping when a backend hands the viewport to another, which moves it between backends' slots.
What a browser forgets when an element leaves the page (where it was scrolled) the host's adapter
keeps across `detach` and `attach`. [`examples/navigation-host`](../../examples/navigation-host/)
is a host page doing all of this with content of its own.

## Next

- Check the integration with `@swf/conformance`
  ([Checking an implementation](../../README.md#checking-an-implementation)).
- Report what a running presentation is doing with `@swf/diagnostics`
  ([Diagnostics](../../README.md#diagnostics)).
- Load a projection, backend or adapter only when it is needed:
  [Load modules on demand](load-modules-on-demand.md).
