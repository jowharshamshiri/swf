// @ts-check
/* global HTMLElement */
/**
 * A host page presenting its own DOM content in a panorama with the framework's DOM
 * backend: two windows, each showing an element the host made, which stay the host's and stay
 * natively interactive; drag a window by its title bar to move it round the room, and
 * turn the view by dragging the background.
 *
 * It is plain JavaScript loaded by the browser as ES modules, with the packages found through an
 * import map (`index.html`): no bundler, no build of its own. Run `npm run build:packages`, then
 * `node examples/browser-host/serve.mjs` and open the address it prints.
 */
import {
  animationFrames,
  createDomInput,
  DOM_COMPOSITOR_ID,
  DOM_RENDERER_ID,
  DomCompositor,
  DomRenderer,
  showDegraded,
} from '@swf/backend-dom';
import { createWorkspace } from '@swf/core';
import { createInteractionRouter } from '@swf/interaction';
import { createPresentationRegistry, createPresenter } from '@swf/presentation';
import { cameraRotation, createProjectionRegistry, equirectangular } from '@swf/projections';
import { ADAPTER_API_VERSION, createSurfaceRuntime } from '@swf/surfaces';

/** @typedef {import('@swf/surfaces').SurfaceAdapter<HTMLElement>} ElementAdapter */
/** @typedef {import('@swf/surfaces').SurfaceCapabilities} SurfaceCapabilities */

/** @type {SurfaceCapabilities} */
const CAPABILITIES = Object.freeze({
  attachStrategy: 'native-dom',
  nativeInteraction: 'full',
  uvAddressing: true,
  transformFidelity: 'approximate',
  transparency: false,
  clipping: true,
  cursorMapping: true,
  resize: 'spatial',
  // One element can be in one place at a time.
  viewportSharing: 'single-owner',
  safeDetach: true,
  rebinding: true,
  placeholder: false,
  snapshotHooks: false,
});

/**
 * The host's adapter: a binding key names one of the host's elements. Attaching puts the element
 * into the slot the backend gives it; detaching takes it out again. The element is never
 * recreated, so what is typed into it stays.
 *
 * @param {ReadonlyMap<string, HTMLElement>} elements
 * @returns {ElementAdapter}
 */
function elementAdapter(elements) {
  return {
    id: 'example.element/1',
    apiVersion: ADAPTER_API_VERSION,
    declaredCapabilities: CAPABILITIES,
    resolve: (key) => Promise.resolve(elements.get(key) ?? null),
    capabilities: () => CAPABILITIES,
    attach(element, target) {
      if (!(target.container instanceof HTMLElement)) {
        throw new Error('example.element/1 attaches only into an element');
      }
      target.container.append(element);
    },
    update: () => undefined,
    detach(element) {
      element.remove();
    },
  };
}

/** A window's size, which its content fills, in world units. */
const SIZE = /** @type {const} */ ([1.6, 1.0, 0.01]);

/**
 * A window `heading` degrees to the right of straight ahead, 3 units out, upright: the view draws it
 * as a flat card facing the camera, its content filling the card, its title bar across its top.
 *
 * @param {string} id
 * @param {string} label
 * @param {number} heading
 */
function windowAt(id, label, heading) {
  const radians = (heading * Math.PI) / 180;
  return {
    id,
    kind: 'window',
    bounds: SIZE,
    transform: {
      position: /** @type {const} */ ([3 * Math.sin(radians), 0, -3 * Math.cos(radians)]),
      rotation: /** @type {const} */ ([0, 0, 0, 1]),
      scale: /** @type {const} */ ([1, 1, 1]),
    },
    label,
  };
}

/**
 * Starts the host in `container`, which must be laid out at its final size. Resolves once both
 * windows are presented, to what the page holds and how to take it all down again.
 *
 * @param {HTMLElement} container
 */
export async function start(container) {
  const document = container.ownerDocument;
  const view = document.defaultView;
  if (view === null) throw new Error('the container is not in a window');

  // The host's content: plain elements it made and keeps.
  const notes = document.createElement('textarea');
  notes.value = 'Type here: this element is the page’s own.';
  notes.setAttribute('aria-label', 'Notes');
  notes.style.cssText =
    'width:100%;height:100%;box-sizing:border-box;padding:0.75em;font:16px sans-serif';
  const list = document.createElement('ul');
  for (const tip of ['Drag a window by its title bar', 'Drag the background to turn']) {
    // Text is set as text: nothing the page shows is parsed as markup.
    const item = document.createElement('li');
    item.textContent = tip;
    list.append(item);
  }
  list.style.cssText =
    'margin:0;padding:0.75em 2em;height:100%;box-sizing:border-box;background:#fff;font:16px sans-serif';
  const elements = new Map([
    ['notes', /** @type {HTMLElement} */ (notes)],
    ['tips', /** @type {HTMLElement} */ (list)],
  ]);

  const frames = animationFrames(view);
  const workspace = createWorkspace({
    id: 'example',
    frameBoundary: (flush) => {
      frames.request(flush);
    },
    timer: () => view.performance.now(),
  });
  const presentation = createPresentationRegistry();
  const projections = createProjectionRegistry({
    kinds: workspace.mutator(),
    projectors: presentation.registrar(),
  });
  projections.register(equirectangular);

  const { width, height } = container.getBoundingClientRect();
  const made = workspace.transaction([
    { type: 'camera.create', camera: { id: 'eye', rotation: cameraRotation(0, 0) } },
    {
      type: 'viewport.create',
      viewport: {
        id: 'main',
        cameraId: 'eye',
        // 120° across, the same degrees per pixel down; drag the background to turn all the way round.
        projection: {
          id: 'equirectangular/1',
          config: { horizontal: 120, vertical: (120 * height) / width },
        },
        size: { width, height, devicePixelRatio: view.devicePixelRatio },
      },
    },
    { type: 'node.create', node: windowAt('notes-window', 'Notes', -25) },
    { type: 'node.create', node: windowAt('tips-window', 'Tips', 25) },
    ...[
      ['notes-view', 'notes-window', 'notes'],
      ['tips-view', 'tips-window', 'tips'],
    ].map(([id, owner, key]) => ({
      type: /** @type {const} */ ('surface.attach'),
      surface: {
        id: String(id),
        ownerNodeId: String(owner),
        bindingKey: String(key),
        adapterTypeId: 'example.element/1',
        bounds: SIZE,
      },
    })),
  ]);
  if (made.status !== 'committed') {
    throw new Error(`the scene was refused: ${JSON.stringify(made)}`);
  }

  const surfaces = createSurfaceRuntime(workspace);
  surfaces.registerAdapter(elementAdapter(elements));
  presentation.registerRenderer(new DomRenderer({ document, chrome: {} }));
  presentation.registerCompositor(new DomCompositor());
  const presenter = createPresenter({
    workspace,
    runtime: surfaces,
    registry: presentation,
    frames,
    showDegraded,
  });
  const viewport = await presenter.open({
    viewportId: 'main',
    container,
    backends: [{ renderer: DOM_RENDERER_ID, compositor: DOM_COMPOSITOR_ID }],
  });

  const router = createInteractionRouter({
    workspace,
    projections,
    presentation: (surfaceId) => viewport.presentation(surfaceId),
  });
  const stopInput = router.registerInputAdapter(
    createDomInput({
      root: container,
      viewportId: 'main',
      events: (listener) => router.subscribe(listener),
    }),
  );

  // Both bindings resolve at once; present the frame that shows them.
  await new Promise((resolve) => {
    const ready = () => surfaces.list().every((s) => s.state === 'presented');
    if (ready()) {
      resolve(undefined);
      return;
    }
    const stop = surfaces.subscribe(() => {
      if (ready()) {
        stop();
        resolve(undefined);
      }
    });
    void viewport.update();
  });

  return {
    workspace,
    surfaces,
    presenter,
    router,
    /** Takes everything down in the reverse order; the host's elements are left to the host. */
    async dispose() {
      stopInput();
      router.dispose();
      await presenter.dispose();
      await surfaces.dispose();
      await workspace.dispose();
    },
  };
}
