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
import type { SceneCommand, SceneState, TxResult, Workspace } from '@swf/core';
import { createWorkspace, nodeFrameGeometry, worldMatrix } from '@swf/core';
import type { InteractionRouter } from '@swf/interaction';
import { createInteractionRouter } from '@swf/interaction';
import type {
  BackendChoice,
  PresentationRegistry,
  PresentedViewport,
  Presenter,
  SwitchOutcome,
} from '@swf/presentation';
import { createPresentationRegistry, createPresenter, viewGeometryOf } from '@swf/presentation';
import type { ProjectionRegistry } from '@swf/projections';
import {
  cameraRotation,
  createProjectionRegistry,
  equirectangular,
  projectionFor,
} from '@swf/projections';
import type { SurfaceRuntime } from '@swf/surfaces';
import { createSurfaceRuntime } from '@swf/surfaces';
import type { AppCommands } from './commands.js';
import { createAppCommands } from './commands.js';
import type { AppConfig, BackendId } from './config.js';
import type { DemoContent } from './content.js';
import { createDemoContent } from './content.js';
import type { Messages } from './messages.js';
import { createMessages } from './messages.js';
import type { FocusContext } from './focus.js';
import { createFocusMode, FOCUS_ID, focusContext } from './focus.js';
import { placedAt } from './map.js';
import type { Modes } from './modes.js';
import { createModes, MAP, OVERVIEW, PANORAMA } from './modes.js';
import type { Policies } from './policies.js';
import { createPolicies } from './policies.js';
import type { PresetId } from './presets.js';
import { CAMERA_ID, planPreset, PRESETS, SEARCHABLE_METADATA, presetCommands } from './presets.js';
import type { Attachment, Search } from './search.js';
import { createSearch } from './search.js';
import { MAX_SEED, seedIssue } from './random.js';

/** The viewport the application presents. */
export const VIEWPORT_ID = 'main';

/**
 * CSS pixels a live element lays out per world unit. A whole 360° panorama shows windows small,
 * so content lays out small and is scaled down less.
 */
const PIXELS_PER_UNIT = 160;

/** How focus frames a window: three-quarters of the view, at most two and a half times its size. */
const FOCUS = Object.freeze({ fill: 0.75, maxMagnification: 2.5, pixelsPerUnit: PIXELS_PER_UNIT });

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
  /** Finding windows by their labels, tags, exposed metadata and groups. */
  readonly search: Search;
  /** The optional policies: workspace orbit, semantic depth, magnetic positioning, wrapped cursor. */
  readonly policies: Policies;
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
  /**
   * Selects and focuses a window and turns the camera to face it, level with the horizon: the
   * window itself does not move.
   */
  revealWindow(id: string): TxResult;
  /** Selects a window and shows the map. */
  showInMap(id: string): TxResult;
  /**
   * Puts a window at a world position (each coordinate left out stays as it is), turning it about
   * the vertical as it moves round the camera so it keeps facing it: one undoable commit.
   */
  placeWindow(
    id: string,
    at: {
      readonly x?: number | undefined;
      readonly y?: number | undefined;
      readonly z?: number | undefined;
    },
  ): TxResult;
  /** The windows around the focused one while focus is shown; null otherwise. */
  focusNeighbours(): FocusContext | null;
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
  /** The viewport presented in one element: its view, the input taken there, its size kept. */
  interface Mount {
    readonly root: HTMLElement;
    readonly viewport: PresentedViewport;
    release(): Promise<void>;
  }

  const router = createInteractionRouter({
    workspace,
    projections,
    presentation: (surfaceId) => mount.viewport.presentation(surfaceId),
  });
  const policies = createPolicies({
    workspace,
    router,
    projections,
    viewportId: VIEWPORT_ID,
    focusModeId: FOCUS_ID,
  });

  const mountIn = async (
    element: HTMLElement,
    backends: readonly BackendChoice[],
  ): Promise<Mount> => {
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
    const box = element.getBoundingClientRect();
    const size = sizeOf(box.width, box.height);
    const current = workspace.getState().viewports.get(VIEWPORT_ID)?.size;
    if (current?.width !== size.width || current.height !== size.height) {
      workspace.dispatch({ type: 'viewport.patch', id: VIEWPORT_ID, size }, { source: 'system' });
    }
    const opened = await presenter.open({ viewportId: VIEWPORT_ID, container: element, backends });
    const detach = policies.attach(opened, element);
    const unregisterInput = router.registerInputAdapter(
      policies.input(
        createDomInput({
          root: element,
          viewportId: VIEWPORT_ID,
          events: (listener) => router.subscribe(listener),
        }),
      ),
    );
    resizes.observe(element);
    return {
      root: element,
      viewport: opened,
      async release() {
        resizes.disconnect();
        unregisterInput();
        detach();
        await opened.dispose();
      },
    };
  };

  const mount = await mountIn(root, BACKENDS[config.backend]);

  const modes = createModes(workspace, VIEWPORT_ID);
  modes.register(PANORAMA);
  modes.register(createFocusMode(FOCUS));
  modes.register(MAP);
  modes.register(OVERVIEW);

  const attachmentOf = (state: SceneState, nodeId: string): Attachment => {
    const surfaceId = state.nodes.get(nodeId)?.surfaceIds[0];
    const presented = surfaceId === undefined ? undefined : runtime.get(surfaceId);
    switch (presented?.state) {
      case 'ready':
      case 'presented':
      case 'hidden':
        return 'attached';
      case 'binding':
      case 'detaching':
        return 'pending';
      case 'error':
        return 'failed';
      default:
        return 'unbound';
    }
  };
  const coverageOf = (state: SceneState, nodeId: string) => {
    const view = viewGeometryOf(state, VIEWPORT_ID);
    const module = projections.get(view.projectionId);
    const frame = nodeFrameGeometry(state, nodeId);
    if (module === undefined || frame === undefined) {
      throw new Error(`window "${nodeId}" cannot be placed in the view`);
    }
    return projectionFor(module, view).clipVisibility(frame, view).state === 'outside'
      ? ('out-of-view' as const)
      : ('in-view' as const);
  };
  const search = createSearch({
    workspace,
    viewportId: VIEWPORT_ID,
    metadataKeys: SEARCHABLE_METADATA,
    attachment: attachmentOf,
    coverage: coverageOf,
    watch: (refresh) => runtime.subscribe(refresh),
  });

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
      backend:
        mount.viewport.state === 'active' ? backendOf(mount.viewport.backend?.renderer) : null,
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
    // Focus is on a window about to go: leave it first, putting its view back.
    if (modes.current() === FOCUS_ID && modes.enteredFrom() !== null) {
      modes.back({ source: 'system' });
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
      ...presetCommands(windows),
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
    viewport: mount.viewport,
    router,
    modes,
    content,
    messages,
    commands: createAppCommands(() => app),
    search,
    policies,
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
      const outcome = await mount.viewport.switchBackend(choice);
      announce();
      return outcome;
    },
    revealWindow(id) {
      const node = workspace.getState().nodes.get(id);
      if (node?.kind !== 'window') {
        throw new Error(`no window "${id}"`);
      }
      if (modes.current() !== PANORAMA.id) {
        modes.switchTo(PANORAMA.id);
      }
      const world = worldMatrix(workspace.getState().nodes, id);
      const [x, z] = world === undefined ? [0, -1] : [world[12], world[14]];
      return workspace.transaction(
        [
          { type: 'selection.set', ids: [id] },
          { type: 'focus.set', id },
          { type: 'camera.patch', id: CAMERA_ID, rotation: cameraRotation(Math.atan2(x, -z), 0) },
        ],
        { source: 'user' },
      );
    },
    showInMap(id) {
      const selected = workspace.dispatch({ type: 'selection.set', ids: [id] }, { source: 'user' });
      if (selected.status !== 'committed' || modes.current() === MAP.id) {
        return selected;
      }
      return modes.switchTo(MAP.id);
    },
    placeWindow(id, at) {
      const state = workspace.getState();
      const camera = state.cameras.get(CAMERA_ID);
      if (camera === undefined) {
        throw new Error(`no camera "${CAMERA_ID}"`);
      }
      const transform = placedAt(state, id, camera.position, at);
      if (transform === null) {
        throw new Error(`window "${id}" cannot be placed: its group's placement is singular`);
      }
      return workspace.dispatch({ type: 'node.patch', id, transform }, { source: 'user' });
    },
    focusNeighbours() {
      const state = workspace.getState();
      const camera = state.cameras.get(CAMERA_ID);
      return modes.current() !== FOCUS_ID || state.focusedId === null || camera === undefined
        ? null
        : focusContext(state, state.focusedId, camera.position);
    },
    async dispose() {
      search.dispose();
      await mount.release();
      unwatch();
      unwatchPresenter();
      listeners.clear();
      modes.dispose();
      policies.dispose();
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
