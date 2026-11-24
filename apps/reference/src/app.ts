import {
  animationFrames,
  createDomInput,
  DOM_COMPOSITOR_ID,
  DOM_RENDERER_ID,
  DomCompositor,
  DomRenderer,
  showDegraded,
} from '@swf/backend-dom';
import {
  GEOMETRY_RENDERER_ID,
  GeometryRenderer,
  LAYER_COMPOSITOR_ID,
  LayerCompositor,
  LayeredRenderer,
} from '@swf/backend-geometry';
import type { SceneCommand, TxResult, Workspace } from '@swf/core';
import { createWorkspace } from '@swf/core';
import type { InteractionRouter } from '@swf/interaction';
import { createInteractionRouter } from '@swf/interaction';
import type {
  BackendChoice,
  PresentationRegistry,
  PresentedViewport,
  Presenter,
  SwitchOutcome,
} from '@swf/presentation';
import { createPresentationRegistry, createPresenter } from '@swf/presentation';
import type { ProjectionRegistry } from '@swf/projections';
import { createProjectionRegistry, equirectangular } from '@swf/projections';
import type { SurfaceRuntime } from '@swf/surfaces';
import { createSurfaceRuntime } from '@swf/surfaces';
import type { AppCommands } from './commands.js';
import { createAppCommands } from './commands.js';
import type { AppConfig, BackendId } from './config.js';
import type { DemoContent } from './content.js';
import { createDemoContent } from './content.js';
import type { Messages } from './messages.js';
import { createMessages } from './messages.js';
import type { Modes } from './modes.js';
import { createModes, PANORAMA } from './modes.js';
import type { PresetId } from './presets.js';
import { CAMERA_ID, planPreset, PRESETS, windowCommands } from './presets.js';
import { MAX_SEED, seedIssue } from './random.js';

/** The viewport the application presents. */
export const VIEWPORT_ID = 'main';

/**
 * CSS pixels a live element lays out per world unit. A whole 360° panorama shows windows small,
 * so content lays out small and is scaled down less.
 */
const PIXELS_PER_UNIT = 160;

/** The layered renderer: live content from the DOM, everything else drawn on canvases. */
export const LAYERED_RENDERER_ID = 'swf.layered-renderer/1';

/** Each backend, with the other as its fallback. */
const BACKENDS: Readonly<Record<BackendId, readonly BackendChoice[]>> = Object.freeze({
  dom: [
    { renderer: DOM_RENDERER_ID, compositor: DOM_COMPOSITOR_ID },
    { renderer: LAYERED_RENDERER_ID, compositor: LAYER_COMPOSITOR_ID },
  ],
  geometry: [
    { renderer: LAYERED_RENDERER_ID, compositor: LAYER_COMPOSITOR_ID },
    { renderer: DOM_RENDERER_ID, compositor: DOM_COMPOSITOR_ID },
  ],
});

/** Which backend a renderer belongs to. */
function backendOf(renderer: string | undefined): BackendId | null {
  switch (renderer) {
    case DOM_RENDERER_ID:
      return 'dom';
    case LAYERED_RENDERER_ID:
    case GEOMETRY_RENDERER_ID:
      return 'geometry';
    default:
      return null;
  }
}

/** The seeded scene the workspace shows: the preset and seed it was last loaded from. */
export interface SceneSource {
  readonly preset: PresetId;
  readonly seed: number;
}

/** What the shell shows of the application. */
export interface AppStatus {
  readonly scene: SceneSource;
  /** Windows in the scene, archived ones aside. */
  readonly windows: number;
  /** The backend the viewport is presented with, or null while it has none (degraded). */
  readonly backend: BackendId | null;
  readonly mode: string;
}

export interface ReferenceApp {
  readonly workspace: Workspace;
  readonly runtime: SurfaceRuntime;
  readonly projections: ProjectionRegistry;
  readonly presentation: PresentationRegistry;
  readonly presenter: Presenter;
  readonly viewport: PresentedViewport;
  readonly router: InteractionRouter;
  readonly modes: Modes;
  readonly content: DemoContent;
  readonly messages: Messages;
  readonly commands: AppCommands;
  status(): AppStatus;
  subscribe(listener: (status: AppStatus) => void): () => void;
  /**
   * Replaces every window with the preset's, planned from the seed (by default the preset's
   * own), and turns the camera back to straight ahead: one undoable commit.
   */
  loadPreset(preset: PresetId, seed?: number): TxResult;
  /** Loads the current scene's preset and seed again. */
  reset(): TxResult;
  /** Loads the current preset from another seed: the next one unless one is given. */
  reseed(seed?: number): TxResult;
  /** Presents the viewport with the other backend, handing its live content over. */
  switchBackend(backend: BackendId): Promise<SwitchOutcome>;
  dispose(): Promise<void>;
}

export interface ReferenceAppOptions {
  /** The element the viewport fills. */
  readonly root: HTMLElement;
  readonly config: AppConfig;
  readonly messages?: Messages;
  /** The window whose animation frames pace presentation. Default: the root's. */
  readonly window?: Window;
}

/**
 * Starts the reference application in an element: a workspace with the equirectangular
 * projection, the demo content's adapters, the DOM and geometry backends, the presenter, input
 * and the panorama mode, every one registered through the framework's public API as any host
 * would, then loads the configured scene.
 */
export async function createReferenceApp(options: ReferenceAppOptions): Promise<ReferenceApp> {
  const { root, config } = options;
  const document = root.ownerDocument;
  const view = options.window ?? document.defaultView;
  if (view === null) {
    throw new Error('the root element is not in a window');
  }
  const messages = options.messages ?? createMessages();

  const workspace = createWorkspace({
    id: 'reference',
    // Drag previews are announced once per animation frame.
    frameBoundary: (flush) => view.requestAnimationFrame(flush),
  });
  const presentation = createPresentationRegistry();
  const projections = createProjectionRegistry({
    kinds: workspace.mutator(),
    projectors: presentation.registrar(),
  });
  projections.register(equirectangular);

  const box = root.getBoundingClientRect();
  const sizeOf = (width: number, height: number) => ({
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    devicePixelRatio: view.devicePixelRatio,
  });
  const created = workspace.transaction([
    { type: 'camera.create', camera: { id: CAMERA_ID, label: 'Camera' } },
    {
      type: 'viewport.create',
      viewport: {
        id: VIEWPORT_ID,
        cameraId: CAMERA_ID,
        mode: PANORAMA.id,
        projection: PANORAMA.projection,
        size: sizeOf(box.width, box.height),
      },
    },
  ]);
  if (created.status !== 'committed') {
    throw new Error(`the viewport could not be created: ${JSON.stringify(created)}`);
  }

  const content = createDemoContent(document, messages);
  const runtime = createSurfaceRuntime(workspace);
  runtime.registerAdapter(content.notes);
  runtime.registerAdapter(content.tiles);

  presentation.registerRenderer(
    new DomRenderer({ document, pixelsPerUnit: PIXELS_PER_UNIT, chrome: { projections } }),
  );
  presentation.registerRenderer(
    new LayeredRenderer({
      id: LAYERED_RENDERER_ID,
      native: new DomRenderer({ document, pixelsPerUnit: PIXELS_PER_UNIT }),
      geometry: new GeometryRenderer({
        projections,
        drawables: (surfaceId) => runtime.handleOf(surfaceId),
      }),
    }),
  );
  presentation.registerCompositor(new DomCompositor());
  presentation.registerCompositor(new LayerCompositor());

  const presenter = createPresenter({
    workspace,
    runtime,
    registry: presentation,
    frames: animationFrames(view),
    showDegraded,
  });
  const viewport = await presenter.open({
    viewportId: VIEWPORT_ID,
    container: root,
    backends: BACKENDS[config.backend],
  });

  const router = createInteractionRouter({
    workspace,
    projections,
    presentation: (surfaceId) => viewport.presentation(surfaceId),
  });
  router.registerInputAdapter(
    createDomInput({
      root,
      viewportId: VIEWPORT_ID,
      events: (listener) => router.subscribe(listener),
    }),
  );

  const modes = createModes(workspace, VIEWPORT_ID);
  modes.register(PANORAMA);

  // The viewport is as large as its element, always.
  const resizes = new ResizeObserver((entries) => {
    const entry = entries.at(-1);
    if (entry === undefined) {
      return;
    }
    const size = sizeOf(entry.contentRect.width, entry.contentRect.height);
    const current = workspace.getState().viewports.get(VIEWPORT_ID)?.size;
    if (
      current?.width !== size.width ||
      current.height !== size.height ||
      current.devicePixelRatio !== size.devicePixelRatio
    ) {
      workspace.dispatch({ type: 'viewport.patch', id: VIEWPORT_ID, size }, { source: 'system' });
    }
  });
  resizes.observe(root);

  let scene: SceneSource = { preset: config.preset, seed: config.seed };
  const listeners = new Set<(status: AppStatus) => void>();
  let lastStatus: AppStatus | null = null;

  const status = (): AppStatus => {
    let windows = 0;
    for (const node of workspace.getState().nodes.values()) {
      if (node.kind === 'window' && node.status !== 'archived') {
        windows += 1;
      }
    }
    return Object.freeze({
      scene,
      windows,
      backend: viewport.state === 'active' ? backendOf(viewport.backend?.renderer) : null,
      mode: modes.current(),
    });
  };
  const announce = () => {
    const next = status();
    if (
      lastStatus !== null &&
      lastStatus.scene === next.scene &&
      lastStatus.windows === next.windows &&
      lastStatus.backend === next.backend &&
      lastStatus.mode === next.mode
    ) {
      return;
    }
    lastStatus = next;
    for (const listener of listeners) {
      listener(next);
    }
  };
  const unwatch = workspace.subscribe((event) => {
    if (event.type === 'transaction.committed') {
      announce();
    }
  });
  const unwatchPresenter = presenter.subscribe(() => {
    announce();
  });

  const loadPreset = (preset: PresetId, seed: number = PRESETS[preset].defaultSeed): TxResult => {
    const issue = seedIssue(seed);
    if (issue !== null) {
      throw new RangeError(`${issue} (got ${String(seed)})`);
    }
    const windows = planPreset(preset, seed);
    content.add(windows);
    const state = workspace.getState();
    const commands: SceneCommand[] = [
      { type: 'selection.set', ids: [] },
      { type: 'focus.set', id: null },
      ...state.rootIds.map((id): SceneCommand => ({ type: 'node.delete', id, mode: 'subtree' })),
      {
        type: 'camera.patch',
        id: CAMERA_ID,
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
      },
      ...windows.flatMap(windowCommands),
    ];
    const result = workspace.transaction(commands, { source: 'user' });
    if (result.status === 'committed') {
      scene = Object.freeze({ preset, seed });
      announce();
    }
    return result;
  };

  const app: ReferenceApp = {
    workspace,
    runtime,
    projections,
    presentation,
    presenter,
    viewport,
    router,
    modes,
    content,
    messages,
    commands: createAppCommands(() => app),
    status,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    loadPreset,
    reset: () => loadPreset(scene.preset, scene.seed),
    reseed: (seed?: number) =>
      loadPreset(scene.preset, seed ?? (scene.seed === MAX_SEED ? 0 : scene.seed + 1)),
    async switchBackend(backend) {
      const [choice] = BACKENDS[backend];
      if (choice === undefined) {
        throw new Error(`backend "${backend}" has no renderer`);
      }
      const outcome = await viewport.switchBackend(choice);
      announce();
      return outcome;
    },
    async dispose() {
      resizes.disconnect();
      unwatch();
      unwatchPresenter();
      listeners.clear();
      modes.dispose();
      router.dispose();
      await presenter.dispose();
      await runtime.dispose();
      await workspace.dispose();
    },
  };

  const loaded = loadPreset(config.preset, config.seed);
  if (loaded.status !== 'committed') {
    await app.dispose();
    throw new Error(`the ${config.preset} preset could not be loaded: ${JSON.stringify(loaded)}`);
  }
  return app;
}
