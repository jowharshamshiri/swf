# Your first host page

In this tutorial we build a web page that shows two of its own elements, a text box and a list,
as windows in a panorama you can turn and rearrange with the mouse. We use the framework's
packages straight from the browser, with no bundler. At the end we will have the page in
[`examples/browser-host`](../../examples/browser-host/), written by ourselves.

It takes about half an hour. You need Node.js 24 and a clone of this repository.

## Prepare the packages

In the repository, install the tools and build the packages:

```sh
npm ci
npm run build:packages
```

Each package now has a `dist/` folder of JavaScript modules. Make a folder for our page:

```sh
mkdir -p tutorial-page
```

## Write the page

Create `tutorial-page/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>My first SWF page</title>
    <script type="importmap">
      {
        "imports": {
          "@swf/math": "/packages/math/dist/index.js",
          "@swf/models": "/packages/models/dist/index.js",
          "@swf/core": "/packages/core/dist/index.js",
          "@swf/surfaces": "/packages/surfaces/dist/index.js",
          "@swf/presentation": "/packages/presentation/dist/index.js",
          "@swf/projections": "/packages/projections/dist/index.js",
          "@swf/interaction": "/packages/interaction/dist/index.js",
          "@swf/backend-dom": "/packages/backend-dom/dist/index.js",
          "lungo-ts": "/node_modules/lungo-ts/index.js",
          "lungo-ts/wasi.js": "/node_modules/lungo-ts/wasi.js"
        }
      }
    </script>
    <style>
      html,
      body {
        margin: 0;
        height: 100%;
      }
      #view {
        position: absolute;
        inset: 0;
        overflow: hidden;
        background: #f4f5f7;
      }
    </style>
  </head>
  <body>
    <div id="view"></div>
    <script type="module" src="./page.js"></script>
  </body>
</html>
```

The import map tells the browser where each package's module is. The `#view` element is where
the panorama will be drawn.

Start the example's small server from the repository's root, which serves every file under it:

```sh
node examples/browser-host/serve.mjs
```

Open <http://127.0.0.1:8317/tutorial-page/>. The page is grey and empty, and the browser's
console says `page.js` was not found. That is next.

## Make a workspace with a view

Create `tutorial-page/page.js`:

```js
import { animationFrames } from '@swf/backend-dom';
import { createWorkspace } from '@swf/core';
import { createPresentationRegistry } from '@swf/presentation';
import { cameraRotation, createProjectionRegistry, equirectangular } from '@swf/projections';

const container = document.getElementById('view');
const frames = animationFrames(window);
const workspace = createWorkspace({
  id: 'tutorial',
  frameBoundary: (flush) => frames.request(flush),
});

const presentation = createPresentationRegistry();
const projections = createProjectionRegistry({
  kinds: workspace.mutator(),
  projectors: presentation.registrar(),
});
projections.register(equirectangular);

const { width, height } = container.getBoundingClientRect();
const result = workspace.transaction([
  { type: 'camera.create', camera: { id: 'eye', rotation: cameraRotation(0, 0) } },
  {
    type: 'viewport.create',
    viewport: {
      id: 'main',
      cameraId: 'eye',
      projection: {
        id: 'equirectangular/1',
        config: { horizontal: 120, vertical: (120 * height) / width },
      },
      size: { width, height, devicePixelRatio: devicePixelRatio },
    },
  },
]);
console.log(result.status, 'at revision', result.revision);
```

Reload. The console says `committed at revision 1`: the workspace holds a camera and a viewport
looking through it, 120° across. Nothing shows yet, because nothing is in the scene.

## Add two windows

Add to `page.js`:

```js
function windowAt(id, label, degrees) {
  const a = (degrees * Math.PI) / 180;
  return {
    id,
    kind: 'window',
    bounds: [1.6, 1, 0.01],
    transform: {
      position: [3 * Math.sin(a), 0, -3 * Math.cos(a)],
      rotation: cameraRotation(a, 0),
      scale: [1, 1, 1],
    },
    label,
  };
}

workspace.transaction([
  { type: 'node.create', node: windowAt('notes-window', 'Notes', -25) },
  { type: 'node.create', node: windowAt('tips-window', 'Tips', 25) },
  {
    type: 'surface.attach',
    surface: {
      id: 'notes-view',
      ownerNodeId: 'notes-window',
      bindingKey: 'notes',
      adapterTypeId: 'tutorial.element/1',
      bounds: [1.6, 1, 0.01],
    },
  },
  {
    type: 'surface.attach',
    surface: {
      id: 'tips-view',
      ownerNodeId: 'tips-window',
      bindingKey: 'tips',
      adapterTypeId: 'tutorial.element/1',
      bounds: [1.6, 1, 0.01],
    },
  },
]);
```

Each window stands 3 units from the camera, 25° to either side, turned to face it. Each has a
surface: a slot for content, which names its content only by a binding key (`notes`, `tips`) and
the kind of adapter that understands that key.

## Present them

Replace the first line of `page.js`, `import { animationFrames } from '@swf/backend-dom';`, with
these imports:

```js
import {
  animationFrames,
  createDomInput,
  DOM_COMPOSITOR_ID,
  DOM_RENDERER_ID,
  DomCompositor,
  DomRenderer,
  showDegraded,
} from '@swf/backend-dom';
import { createInteractionRouter } from '@swf/interaction';
import { createPresenter } from '@swf/presentation';
import { createSurfaceRuntime } from '@swf/surfaces';
```

Then add at the end:

```js
presentation.registerRenderer(
  new DomRenderer({ document, pixelsPerUnit: 240, chrome: { projections } }),
);
presentation.registerCompositor(new DomCompositor());
const surfaces = createSurfaceRuntime(workspace);
const presenter = createPresenter({
  workspace,
  runtime: surfaces,
  registry: presentation,
  frames,
  showDegraded,
});
const view = await presenter.open({
  viewportId: 'main',
  container,
  backends: [{ renderer: DOM_RENDERER_ID, compositor: DOM_COMPOSITOR_ID }],
});
```

Reload. Two framed boxes appear, titled Notes and Tips, each saying “Unsupported: this content
cannot be presented here”. The frames are the windows; the boxes are their surfaces, shown as
stand-ins because no adapter of the type they name (`tutorial.element/1`) is registered yet, so
nothing knows what `notes` and `tips` are.

## Give them content

The adapter is where our page tells the framework what a binding key means. Add these lines
right after `const surfaces = createSurfaceRuntime(workspace);`:

```js
const notes = document.createElement('textarea');
notes.value = 'Type here.';
notes.style.cssText =
  'width:100%;height:100%;box-sizing:border-box;padding:1.75em 0.75em 0.75em;font:16px sans-serif';
const tips = document.createElement('p');
tips.textContent = 'Drag a window by its frame. Drag the background to turn.';
tips.style.cssText =
  'margin:0;padding:1.75em 1em;height:100%;box-sizing:border-box;background:#fff;font:16px sans-serif';
const elements = new Map([
  ['notes', notes],
  ['tips', tips],
]);

const capabilities = {
  attachStrategy: 'native-dom',
  nativeInteraction: 'full',
  uvAddressing: true,
  transformFidelity: 'approximate',
  transparency: false,
  clipping: true,
  cursorMapping: true,
  resize: 'spatial',
  viewportSharing: 'single-owner',
  safeDetach: true,
  rebinding: true,
  placeholder: false,
  snapshotHooks: false,
};
surfaces.registerAdapter({
  id: 'tutorial.element/1',
  apiVersion: 1,
  declaredCapabilities: capabilities,
  resolve: async (key) => elements.get(key) ?? null,
  capabilities: () => capabilities,
  attach: (element, target) => target.container.append(element),
  update: () => {},
  detach: (element) => element.remove(),
});
```

Reload. The text box and the paragraph now fill their windows. Click into the text box and type:
it is your page's own element, working as it always does.

## Move things

Add at the end:

```js
const router = createInteractionRouter({
  workspace,
  projections,
  presentation: (surfaceId) => view.presentation(surfaceId),
});
router.registerInputAdapter(
  createDomInput({
    root: container,
    viewportId: 'main',
    events: (listener) => router.subscribe(listener),
  }),
);
```

Reload. Drag a window by its frame: it follows the pointer and settles where you let go. Drag the
empty background: the whole view turns, all the way round. Press Escape in the middle of a drag:
the window goes back. Type in the text box again: input over content still goes to the content.

## What we built

Our page made a workspace (the scene), a camera and a viewport looking into it, and two windows
with surfaces. An adapter told the framework what the page's binding keys mean, a presenter drew
the viewport with the DOM backend, and an interaction router turned the mouse into moves of the
scene. The elements stayed the page's own throughout.

From here, [Integrate SWF into a host](../how-to/integrate-a-host.md) adds saving the layout and
taking everything down cleanly, and [`examples/browser-host/host.js`](../../examples/browser-host/host.js)
is this page, finished. Delete `tutorial-page/` when you are done.
