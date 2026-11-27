import type { SceneCommand, Workspace } from '@swf/core';
import { createWorkspace, worldMatrix } from '@swf/core';
import type { InteractionEvent, InteractionRouter } from '@swf/interaction';
import { createInteractionRouter } from '@swf/interaction';
import type { Vec3 } from '@swf/math';
import { mat4TransformPoint, quatFromAxisAngle, sub } from '@swf/math';
import { ManualFrames } from '@swf/conformance';
import type { ProjectionRegistry } from '@swf/projections';
import type {
  FrameSource,
  PresentationRegistry,
  PresentedViewport,
  Presenter,
  ViewportFrame,
} from '@swf/presentation';
import { createPresentationRegistry, createPresenter, viewGeometryOf } from '@swf/presentation';
import { createProjectionRegistry, equirectangular } from '@swf/projections';
import type { SurfaceAdapter, SurfaceCapabilities, SurfaceRuntime } from '@swf/surfaces';
import { createSurfaceRuntime } from '@swf/surfaces';
import { commands } from 'vitest/browser';
import type { ChromeInks } from '../../src/index.js';
import {
  animationFrames,
  createDomInput,
  DOM_COMPOSITOR_ID,
  DOM_RENDERER_ID,
  DomCompositor,
  DomRenderer,
  showDegraded,
} from '../../src/index.js';

declare module 'vitest/browser' {
  interface BrowserCommands {
    mouse: (
      action: 'move' | 'down' | 'up' | 'release',
      x: number,
      y: number,
      modifiers?: readonly string[],
    ) => Promise<void>;
  }
}

export const W = 800;
export const H = 400;

/** A live DOM endpoint: a box with a button and a text field, counted when mounted. */
export interface Live {
  readonly key: string;
  readonly element: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly input: HTMLInputElement;
  /** Events the button received, with whether the browser marked them trusted. */
  readonly received: { readonly type: string; readonly trusted: boolean }[];
}

/** A native-DOM adapter whose endpoints are real elements; `sharing` is what it declares. */
export function domAdapter(sharing: SurfaceCapabilities['viewportSharing'] = 'single-owner') {
  const lives = new Map<string, Live>();
  const capabilities: SurfaceCapabilities = Object.freeze({
    attachStrategy: 'native-dom',
    nativeInteraction: 'full',
    uvAddressing: true,
    transformFidelity: 'approximate',
    transparency: false,
    clipping: true,
    cursorMapping: true,
    resize: 'intrinsic',
    viewportSharing: sharing,
    safeDetach: true,
    rebinding: true,
    placeholder: false,
    snapshotHooks: false,
  });
  const make = (key: string): Live => {
    const element = document.createElement('div');
    element.dataset['testContent'] = key;
    element.style.setProperty('width', '100%');
    element.style.setProperty('height', '100%');
    element.style.setProperty('background', '#eee');
    const button = document.createElement('button');
    button.textContent = 'Press';
    button.style.setProperty('width', '100%');
    button.style.setProperty('height', '50%');
    const input = document.createElement('input');
    input.style.setProperty('width', '90%');
    element.append(button, input);
    const received: Live['received'] = [];
    for (const type of ['pointerdown', 'pointerup', 'click']) {
      button.addEventListener(type, (e) => {
        received.push({ type, trusted: e.isTrusted });
      });
    }
    return { key, element, button, input, received };
  };
  const adapter: SurfaceAdapter<{ key: string; serial: number }> = {
    id: 'test.dom/1',
    apiVersion: 1,
    declaredCapabilities: capabilities,
    resolve: (key) => Promise.resolve({ key, serial: lives.size }),
    capabilities: () => capabilities,
    attach(handle, target) {
      const container = target.container;
      if (!(container instanceof HTMLElement)) {
        throw new Error('the target container is not an element');
      }
      // A shared endpoint gets one element per viewport; a single-owner one only ever one.
      const key = sharing === 'shared' ? `${handle.key}@${target.viewportId}` : handle.key;
      const live = lives.get(key) ?? make(handle.key);
      lives.set(key, live);
      container.append(live.element);
    },
    update: () => undefined,
    detach(handle, target) {
      const key = sharing === 'shared' ? `${handle.key}@${target.viewportId}` : handle.key;
      lives.get(key)?.element.remove();
    },
  };
  return { adapter, lives };
}

export interface WindowPlacement {
  readonly id: string;
  readonly heading: number;
  readonly distance: number;
  readonly y?: number;
  readonly size?: readonly [number, number];
  /** How much smaller the surface is than its frame, each way. Default 0.4. */
  readonly inset?: number;
  readonly label?: string;
  readonly surfaceLabel?: string;
}

export function windowCommands(placements: readonly WindowPlacement[]): SceneCommand[] {
  return placements.flatMap((p): SceneCommand[] => {
    const [w, h] = p.size ?? [2, 1.2];
    const inset = p.inset ?? 0.4;
    return [
      {
        type: 'node.create',
        node: {
          id: p.id,
          kind: 'window',
          bounds: [w, h, 0.01],
          ...(p.label === undefined ? {} : { label: p.label }),
          transform: {
            position: [
              p.distance * Math.sin(p.heading),
              p.y ?? 0,
              -p.distance * Math.cos(p.heading),
            ],
            rotation: quatFromAxisAngle([0, 1, 0], -p.heading),
            scale: [1, 1, 1],
          },
        },
      },
      {
        type: 'surface.attach',
        surface: {
          id: `${p.id}-view`,
          ownerNodeId: p.id,
          bindingKey: `key-${p.id}`,
          adapterTypeId: 'test.dom/1',
          bounds: [w - inset, h - inset, 0.01],
          ...(p.surfaceLabel === undefined ? {} : { label: p.surfaceLabel }),
        },
      },
    ];
  });
}

/** One viewport presented in its own container on the page. */
export interface View {
  readonly viewportId: string;
  /** The viewport's container: input is taken over it, and the view is assembled in it. */
  readonly root: HTMLElement;
  readonly viewport: PresentedViewport;
  /** Presents a frame now; throws when the viewport is degraded. */
  update(): Promise<ViewportFrame>;
  presentation(surfaceId: string): 'live' | 'proxy';
  dispose(): Promise<{ readonly retained: readonly string[] }>;
}

export interface Stage {
  readonly ws: Workspace;
  readonly runtime: SurfaceRuntime;
  readonly projections: ProjectionRegistry;
  readonly registry: PresentationRegistry;
  readonly presenter: Presenter;
  /** The frame source: manual, unless the stage runs on animation frames. */
  readonly frames: ManualFrames | FrameSource;
  /** The DOM renderer every viewport uses, and what unregisters it. */
  readonly backend: { readonly renderer: DomRenderer; readonly unregister: () => void };
  readonly lives: Map<string, Live>;
  readonly views: Map<string, View>;
  readonly containers: Map<string, HTMLElement>;
  readonly router: InteractionRouter;
  readonly events: InteractionEvent[];
  dispose(): Promise<void>;
}

/**
 * A workspace with the equirectangular projection, the given windows bound to live DOM endpoints,
 * and one viewport (each 800×400, 360°×120°) presented with the DOM backend in its own container
 * on the page. Frames come only when the test asks (`update` or `frames.flush`). The router
 * takes input from viewport `v` only.
 */
export async function stage(
  placements: readonly WindowPlacement[],
  options: {
    readonly viewports?: readonly string[];
    readonly sharing?: SurfaceCapabilities['viewportSharing'];
    readonly update?: boolean;
    /** Run frames, and the workspace's preview coalescing, on the browser's animation frames. */
    readonly animationFrames?: boolean;
    /** The inks window chrome is drawn in; default the renderer's own. */
    readonly inks?: ChromeInks;
  } = {},
): Promise<Stage> {
  const viewports = options.viewports ?? ['v'];
  const animated = options.animationFrames === true;
  // One frame source paces both the workspace's preview announcements and the presenter.
  const frames = animated ? animationFrames(window) : new ManualFrames();
  const ws = createWorkspace({
    id: 'ws',
    ...(animated
      ? {
          frameBoundary: (flush: () => void) => {
            frames.request(flush);
          },
        }
      : {}),
  });
  const presentation = createPresentationRegistry();
  const projections = createProjectionRegistry({
    kinds: ws.mutator(),
    projectors: presentation.registrar(),
  });
  projections.register(equirectangular);
  const result = ws.transaction([
    { type: 'camera.create', camera: { id: 'cam' } },
    ...viewports.map((id): SceneCommand => ({
      type: 'viewport.create',
      viewport: {
        id,
        cameraId: 'cam',
        projection: { id: 'equirectangular/1', config: { horizontal: 360, vertical: 120 } },
        size: { width: W, height: H, devicePixelRatio: 1 },
      },
    })),
    ...windowCommands(placements),
  ]);
  if (result.status !== 'committed') {
    throw new Error(`stage failed: ${JSON.stringify(result)}`);
  }
  const runtime = createSurfaceRuntime(ws, { autoBind: false });
  const { adapter, lives } = domAdapter(options.sharing);
  runtime.registerAdapter(adapter);
  for (const surface of ws.getState().surfaces.values()) {
    const bound = await runtime.bind(surface.id);
    if (bound.status !== 'ok') {
      throw new Error(`could not bind ${surface.id}`);
    }
  }
  const renderer = new DomRenderer({
    document,
    chrome: { projections, ...(options.inks === undefined ? {} : { inks: options.inks }) },
  });
  const unregister = presentation.registerRenderer(renderer);
  presentation.registerCompositor(new DomCompositor());
  const presenter = createPresenter({
    workspace: ws,
    runtime,
    registry: presentation,
    frames,
    showDegraded,
  });
  const views = new Map<string, View>();
  const containers = new Map<string, HTMLElement>();
  for (const viewportId of viewports) {
    const container = document.createElement('div');
    container.style.setProperty('margin', '0');
    container.style.setProperty('width', `${String(W)}px`);
    container.style.setProperty('height', `${String(H)}px`);
    document.body.append(container);
    containers.set(viewportId, container);
    const viewport = await presenter.open({
      viewportId,
      container,
      backends: [{ renderer: DOM_RENDERER_ID, compositor: DOM_COMPOSITOR_ID }],
    });
    views.set(viewportId, {
      viewportId,
      root: container,
      viewport,
      async update() {
        const update = await viewport.update();
        if (update.status !== 'presented') {
          throw new Error(`viewport "${viewportId}" is degraded: ${update.error.message}`);
        }
        return update;
      },
      presentation: (surfaceId) => viewport.presentation(surfaceId),
      dispose: () => viewport.dispose(),
    });
  }
  const main = views.get(viewports[0] ?? 'v');
  if (main === undefined) {
    throw new Error('no main view');
  }
  const router = createInteractionRouter({
    workspace: ws,
    projections,
    presentation: (surfaceId) => main.presentation(surfaceId),
  });
  const events: InteractionEvent[] = [];
  router.subscribe((event) => events.push(event));
  router.registerInputAdapter(
    createDomInput({
      root: main.root,
      viewportId: main.viewportId,
      events: (listener) => router.subscribe(listener),
    }),
  );
  if (options.update !== false) {
    for (const view of views.values()) {
      await view.update();
    }
  }
  return {
    ws,
    runtime,
    projections,
    registry: presentation,
    presenter,
    frames,
    backend: { renderer, unregister },
    lives,
    views,
    containers,
    router,
    events,
    async dispose() {
      router.dispose();
      await presenter.dispose();
      await runtime.dispose();
      for (const container of containers.values()) {
        container.remove();
      }
    },
  };
}

/** A point of a view's root, in the test frame's coordinates. */
export function pageOf(root: HTMLElement, x: number, y: number): [number, number] {
  const box = root.getBoundingClientRect();
  return [box.left + x, box.top + y];
}

/** Presses, moves (in steps) and releases the real mouse, in the root's coordinates. */
export async function drag(
  root: HTMLElement,
  from: readonly [number, number],
  path: readonly (readonly [number, number])[],
  modifiers: readonly string[] = [],
): Promise<void> {
  const [x, y] = pageOf(root, from[0], from[1]);
  await commands.mouse('move', x, y);
  await commands.mouse('down', x, y, modifiers);
  for (const [px, py] of path) {
    const [qx, qy] = pageOf(root, px, py);
    await commands.mouse('move', qx, qy);
  }
  const last = path.at(-1) ?? from;
  const [ex, ey] = pageOf(root, last[0], last[1]);
  await commands.mouse('up', ex, ey);
}

/** A point on a window, in its local frame (x right, y up), placed in the world. */
export function onWindow(s: Stage, nodeId: string, local: Vec3): Vec3 {
  const m = worldMatrix(s.ws.getState().nodes, nodeId);
  if (m === undefined) {
    throw new Error(`no node ${nodeId}`);
  }
  return mat4TransformPoint(m, local);
}

/** Where a world point appears in a view, in its root's coordinates. */
export function screenOf(s: Stage, point: Vec3, viewportId = 'v'): [number, number] {
  const view = viewGeometryOf(s.ws.getState(), viewportId);
  const projection = equirectangular.create(view.projectionConfig);
  const eye: Vec3 = [view.camera[12], view.camera[13], view.camera[14]];
  const image = projection.projectDirection(sub(point, eye), view).images[0];
  if (image === undefined) {
    throw new Error(`${JSON.stringify(point)} is not in view`);
  }
  return [image[0], image[1]];
}
