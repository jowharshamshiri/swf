import type { Framing } from '@swf/models';
import type { ChromeInks } from '@swf/backend-dom';
import {
  animationFrames,
  createDomInput,
  DOM_COMPOSITOR_ID,
  DOM_RENDERER_ID,
  DomCompositor,
  DomRenderer,
  showDegraded,
} from '@swf/backend-dom';
import type { GeometryInks } from '@swf/backend-geometry';
import {
  GEOMETRY_RENDERER_ID,
  GeometryRenderer,
  LAYER_COMPOSITOR_ID,
  LayerCompositor,
  LayeredRenderer,
} from '@swf/backend-geometry';
import type {
  Id,
  JsonValue,
  NodeRecord,
  PreviewResult,
  SceneCommand,
  SceneState,
  TxResult,
  Workspace,
} from '@swf/core';
import { createWorkspace, worldMatrix } from '@swf/core';
import type {
  CommandOutcome,
  DispatchResult,
  InputAdapter,
  InputIntent,
  InteractionRouter,
} from '@swf/interaction';
import { createInteractionRouter, DEFAULT_KEYBOARD_STEPS } from '@swf/interaction';
import type {
  BackendChoice,
  PresentationRegistry,
  PresentedViewport,
  Presenter,
  StandInReason,
  SwitchOutcome,
  TitleBarColours,
  WindowHover,
} from '@swf/presentation';
import { createPresentationRegistry, createPresenter } from '@swf/presentation';
import type { ProjectionRegistry } from '@swf/projections';
import {
  cameraRotation,
  createProjectionRegistry,
  equirectangular,
  headingPitchOf,
} from '@swf/projections';
import type { SurfaceAdapter, SurfaceRuntime } from '@swf/surfaces';
import { createSurfaceRuntime } from '@swf/surfaces';
import type { CompositionPlan, GroupTarget } from './composition.js';
import {
  CompositionRefusal,
  detachSurface,
  groupWindows,
  mergeWindow,
  moveSurface,
  partOf,
  recombineParts,
  regroupWindow,
  splitWindow,
} from './composition.js';
import type { ExperimentId } from './experiments.js';
import { experimentPlan } from './experiments.js';
import { ARRANGE_RINGS } from './features.js';
import type { FocusContext } from './focus.js';
import { createFocusMode, FOCUS_ID, focusContext } from './focus.js';
import { MANIPULATION_POLICIES } from './manipulation.js';
import type { AroundSide } from './map.js';
import { aroundCamera, arrangedAround, inView, placedAt } from './map.js';
import type { Modes } from './modes.js';
import { createModes, FIELD_OF_VIEW, fieldOfViewOf, MAP, OVERVIEW, PANORAMA } from './modes.js';
import type { Policies } from './policies.js';
import { createPolicies } from './policies.js';
import type { Pose, PoseTarget } from './pose.js';
import { posedPatch, poseOf } from './pose.js';
import type { Attachment, Search } from './search.js';
import { createSearch } from './search.js';
import type { ViewTransitions } from './transition.js';
import { createViewTransitions } from './transition.js';

/** The viewport navigation presents the workspace in. */
export const VIEWPORT_ID = 'main';

/**
 * What the viewport frames in a state, as the focus model (`Swf.AppFocus`) takes it: its mode, and
 * the window in focus while it shows the focus.
 */
export function framingOf(state: SceneState): Framing {
  const mode = state.viewports.get(VIEWPORT_ID)?.mode ?? PANORAMA.id;
  return { mode, framed: mode === FOCUS_ID ? state.focusedId : null };
}

/** The camera the viewport looks through. */
export const CAMERA_ID = 'camera';

/** The presentation backends the viewport can be shown with. */
export const BACKEND_IDS = ['dom', 'geometry'] as const;

/** A presentation backend: `dom` places live elements; `geometry` also draws what it can. */
export type BackendId = (typeof BACKEND_IDS)[number];

/** The layered renderer: live content from the DOM, everything else drawn on canvases. */
export const LAYERED_RENDERER_ID = 'swf.layered-renderer/1';

/** How focus shows a window: three-quarters of the view, at most two and a half times its size. */
const FOCUS = Object.freeze({ fill: 0.75, maxMagnification: 2.5 });

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

/**
 * The colours window chrome is drawn in, each named by a CSS custom property of the host's page
 * (such as `--vscode-focusBorder`): frames, the selected window's frame, the focused window's,
 * names, and the ground names are written on. The DOM backend lays chrome out with the properties
 * themselves; the geometry backend draws with the colours they resolve to, again whenever the
 * page's appearance changes.
 */
export interface ChromeTokens {
  /** Every window's frame. */
  readonly frame: string;
  /** The selected window's frame. */
  readonly selected: string;
  /** The focused window's frame. */
  readonly focused: string;
  /** Windows' names. */
  readonly text: string;
  /** The ground names are written on. */
  readonly ground: string;
}

/** The DOM backend's inks: each token as the browser resolves it. */
function domInks(tokens: ChromeTokens): ChromeInks {
  return Object.freeze({
    frame: `var(${tokens.frame})`,
    selected: `var(${tokens.selected})`,
    focused: `var(${tokens.focused})`,
    text: `var(${tokens.text})`,
    ground: `var(${tokens.ground})`,
  });
}

/**
 * The geometry backend's inks: each token resolved to a colour as the page's appearance has it, and
 * again whenever the appearance (the colour scheme, or the root's `data-appearance`) changes.
 * Throws an Error naming a token that resolves to no colour.
 */
function resolvedInks(document: Document, tokens: ChromeTokens): () => GeometryInks {
  const view = document.defaultView;
  if (view === null) {
    throw new Error('the document is not in a window');
  }
  const dark = view.matchMedia('(prefers-color-scheme: dark)');
  let resolvedFor: string | null = null;
  let inks: GeometryInks | null = null;
  const resolve = (token: string, probe: HTMLElement): string => {
    probe.style.setProperty('color', `var(${token})`);
    const colour = view.getComputedStyle(probe).color;
    if (colour === '') {
      throw new Error(`the chrome token ${token} does not resolve to a colour`);
    }
    return colour;
  };
  return () => {
    const appearance = `${String(dark.matches)}/${document.documentElement.dataset['appearance'] ?? ''}`;
    if (inks === null || appearance !== resolvedFor) {
      // Never shown: it only lets the browser resolve a token as this page has it.
      const probe = document.createElement('span');
      probe.hidden = true;
      document.body.append(probe);
      try {
        inks = Object.freeze({
          frame: resolve(tokens.frame, probe),
          selected: resolve(tokens.selected, probe),
          focused: resolve(tokens.focused, probe),
          text: resolve(tokens.text, probe),
          ground: resolve(tokens.ground, probe),
        });
      } finally {
        probe.remove();
      }
      resolvedFor = appearance;
    }
    return inks;
  };
}

/**
 * What the viewport's element says to assistive technology, and what a stand-in says, in the
 * host's words and language.
 */
export interface NavigationWords {
  /** What the viewport's element is, said as its role (`aria-roledescription`). */
  readonly role: string;
  /** Its name (`aria-label`). */
  readonly label: string;
  /** Which keys act there (`aria-description`). */
  readonly keys: string;
  /** What a stand-in for a window's content says, for each reason it stands in. */
  standIn(reason: StandInReason): string;
}

/**
 * Makes the element the panorama is presented in the view: one stop of the page's keyboard order,
 * a spatial workspace the keyboard operates (FR-109, UX-012, UX-013), saying what it is and which
 * keys act there; and ground no scroll carries past (`overscroll-behavior: none`), so a trackpad's
 * swipe sideways over it turns the view instead of going back a page. A press in it that is not in
 * a window's live content gives it the keyboard, as a press in any list does, though the framework
 * keeps that press from the page: so a window clicked is then moved, removed or focused by its
 * keys. Returns what puts the element back as it was.
 */
function asView(element: HTMLElement, words: NavigationWords): () => void {
  const attributes: Readonly<Record<string, string>> = {
    tabindex: '0',
    role: 'application',
    'aria-roledescription': words.role,
    'aria-label': words.label,
    'aria-description': words.keys,
  };
  const before = Object.keys(attributes).map((name) => [name, element.getAttribute(name)] as const);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  const overscroll = element.style.getPropertyValue('overscroll-behavior');
  element.style.setProperty('overscroll-behavior', 'none');
  const take = (event: Event) => {
    const target = event.target;
    const live = target instanceof Element && target.closest('[data-swf-slot]') !== null;
    if (!live && element.ownerDocument.activeElement !== element) {
      element.focus({ preventScroll: true });
    }
  };
  // Before the framework hears the press, which may keep it from the page.
  element.addEventListener('pointerdown', take, { capture: true });
  return () => {
    element.removeEventListener('pointerdown', take, { capture: true });
    element.style.setProperty('overscroll-behavior', overscroll);
    for (const [name, value] of before) {
      if (value === null) {
        element.removeAttribute(name);
      } else {
        element.setAttribute(name, value);
      }
    }
  };
}

/**
 * What the host says of its windows, which navigation never looks into: how a window made from
 * another's surface is linked to it, what the overview groups and arrangement orders by, which
 * metadata search reads, and what a window composition makes for a surface is given.
 */
export interface WindowTraits {
  /**
   * The metadata key (`host.<name>` or `ext.<extension-id>.<name>`) under which a window made from
   * another window's surface keeps that window's ID: the window it is a part of.
   */
  readonly partOfKey: string;
  /** The metadata keys of the host's that search matches text against. */
  readonly searchKeys: readonly string[];
  /** The category the overview shows a window in, or null for none. */
  readonly category: (node: NodeRecord) => string | null;
  /**
   * The colours a window's title bar is drawn in (the colour of what it holds, say), or null for a
   * bar in the chrome's own colours.
   */
  readonly titleBar: (node: NodeRecord, state: SceneState) => TitleBarColours | null;
  /**
   * What windows arranged round the camera are ordered by after what they show: such as a colour.
   * Windows with the same key stand together.
   */
  readonly arrangeKey: (node: NodeRecord) => string;
  /**
   * The tags and metadata a window composition makes for a surface is given, besides the link to
   * the window it is a part of, which navigation adds under {@link partOfKey}.
   */
  newWindowFor(
    surface: {
      readonly id: Id;
      readonly adapterTypeId: string;
      readonly bindingKey: string | null;
    },
    state: SceneState,
  ): {
    /** The window's tags. */
    readonly tags: readonly string[];
    /** Its metadata, under the host's keys. */
    readonly metadata: Readonly<Record<string, JsonValue>>;
  };
}

/** A step of multi-surface composition (FR-126). */
export type CompositionStep =
  | {
      /** A surface out of its window into a window of its own. */
      readonly kind: 'detach';
      /** The surface's ID. */
      readonly surfaceId: Id;
    }
  | {
      /** A surface into another window. */
      readonly kind: 'move';
      /** The surface's ID. */
      readonly surfaceId: Id;
      /** The window it goes into. */
      readonly windowId: Id;
    }
  | {
      /** A window's surfaces into another window. */
      readonly kind: 'merge';
      /** The window whose surfaces go. */
      readonly windowId: Id;
      /** The window they go into. */
      readonly targetId: Id;
    }
  | {
      /** Each surface of a window but its first into a window of its own. */
      readonly kind: 'split';
      /** The window's ID. */
      readonly windowId: Id;
    }
  | {
      /** Every part of the window this one came from (or of this one) back into it. */
      readonly kind: 'recombine';
      /** The window's ID. */
      readonly windowId: Id;
    }
  | {
      /** A window into another group. */
      readonly kind: 'regroup';
      /** The window's ID. */
      readonly windowId: Id;
      /** The group it goes into: one that exists, or a new one. */
      readonly target: GroupTarget;
    }
  | {
      /** Windows gathered into a new group, each keeping its place. */
      readonly kind: 'group';
      /** The windows' IDs. */
      readonly windowIds: readonly Id[];
      /** The new group. */
      readonly group: {
        /** Its ID, one no node or surface holds. */
        readonly id: Id;
        /** Its name. */
        readonly label: string;
      };
    };

/** An input intent dispatched, with what the framework did with it, for the host to measure. */
export interface ObservedInput {
  /** The input adapter that dispatched it. */
  readonly adapterId: string;
  /** The intent. */
  readonly intent: InputIntent;
  /** What the framework did with it. */
  readonly result: DispatchResult;
}

/** Where navigation stands: what its status bar and controls show. */
export interface NavigationStatus {
  /** Windows in the scene, archived ones aside. */
  readonly windows: number;
  /** The backend the viewport is presented with, or null while it has none (degraded). */
  readonly backend: BackendId | null;
  /** The view mode shown. */
  readonly mode: string;
}

/** How navigation starts in a host's element. */
export interface NavigationOptions {
  /** The element the viewport fills; navigation keeps the viewport as large as it, always. */
  readonly root: HTMLElement;
  /** The workspace's ID. */
  readonly id: string;
  /** The host's surface adapters, through which its content is attached; at least one. */
  readonly adapters: readonly SurfaceAdapter[];
  /** What the host says of its windows. */
  readonly windows: WindowTraits;
  /** The backend the viewport is first presented with; the other is its fallback. */
  readonly backend: BackendId;
  /** The custom properties window chrome takes its colours from. */
  readonly chrome: ChromeTokens;
  /** What the viewport's element and the stand-ins say. */
  readonly words: NavigationWords;
  /** The window whose animation frames pace presentation. Default: the root's. */
  readonly window?: Window;
}

/**
 * A host's spatial workspace with the whole navigation experience: one viewport in the host's
 * element showing the host's content in a panorama, with the view modes (the panorama, focus, the
 * map and the overview) and moving between them, the eight capabilities (focus, workspace orbit,
 * the map, the wrapped cursor, magnetic snapping, semantic depth, composition, and saving, which
 * the host's own saving follows), search, and the window operations its controls run. Every member
 * is the framework's public API; the host owns its element and its content, and `dispose` gives
 * both back as they were.
 */
export interface Navigation {
  /** The element the viewport fills. */
  readonly root: HTMLElement;
  /** The workspace: the scene, its history and its transactions. */
  readonly workspace: Workspace;
  /** The surfaces' runtime, with the host's adapters registered. */
  readonly runtime: SurfaceRuntime;
  /** The projections, the equirectangular one registered. */
  readonly projections: ProjectionRegistry;
  /** The renderers and compositors of both backends. */
  readonly presentation: PresentationRegistry;
  /** What presents the viewport, frame by frame. */
  readonly presenter: Presenter;
  /** The viewport as it is presented in the root. */
  readonly viewport: PresentedViewport;
  /** Input: the keys, pointer gestures, policies and spatial commands. */
  readonly router: InteractionRouter;
  /** The view modes. */
  readonly modes: Modes;
  /** Finding windows by their labels, tags, the host's searchable metadata and groups. */
  readonly search: Search;
  /** The eight capabilities, each turned on and off on its own, and their policies. */
  readonly policies: Policies;
  /** The view's transitions into a focus, between focused windows and out of it. */
  readonly transitions: ViewTransitions;
  /** What the host said of its windows. */
  readonly windows: WindowTraits;
  /** Where navigation stands now. */
  status(): NavigationStatus;
  /** Calls `listener` whenever the status changes; returns what stops it. */
  subscribe(listener: (status: NavigationStatus) => void): () => void;
  /** The window a window is a part of, under the host's {@link WindowTraits.partOfKey}. */
  partOf(node: NodeRecord): Id | null;
  /** Presents the viewport with another backend, handing its live content over. */
  switchBackend(backend: BackendId): Promise<SwitchOutcome>;
  /**
   * Selects and focuses a window and turns the camera to face it, level with the horizon, showing
   * the panorama: the window itself does not move. Throws an Error naming an ID that is no window.
   */
  revealWindow(id: string): TxResult;
  /** Selects a window and shows the map. */
  showInMap(id: string): TxResult;
  /**
   * Puts a window at a world position (each coordinate left out stays as it is), inside the room:
   * one undoable commit.
   */
  placeWindow(
    id: string,
    at: {
      readonly x?: number | undefined;
      readonly y?: number | undefined;
      readonly z?: number | undefined;
    },
  ): TxResult;
  /**
   * Poses a window as the inspector's controls set it: round the camera, out from it, up and
   * sized, each left out staying as it is ({@link posedPatch}). With `preview`, the change is
   * shown and not committed, replacing the pose shown before; without it, it is committed as one
   * undoable change, ending the pose shown. A control dragged previews as it moves and commits
   * once when let go: one undo puts it back. Posing another window ends the pose shown first.
   */
  poseWindow(
    id: string,
    target: PoseTarget,
    options: { readonly preview: boolean },
  ): TxResult | PreviewResult;
  /**
   * Puts a window straight ahead of the camera or straight behind it, at its distance and height,
   * facing the camera as it did: one undoable commit. Throws a RangeError for a window standing at
   * the camera.
   */
  placeAround(id: string, side: AroundSide): TxResult;
  /**
   * Arranges every window that stands on its own and is not locked round the camera, evenly over
   * the whole circle from straight ahead, by what it shows and the host's arrangement key, on three
   * rings: one within each band semantic depth draws by (near enough to show whole, compact, a
   * label alone). One undoable commit; null when there is no window to arrange.
   */
  arrangeWindows(): TxResult | null;
  /**
   * Turns the camera to a heading, in degrees to the right of straight ahead, keeping its pitch:
   * view state, never undone.
   */
  turnCamera(degrees: number): TxResult;
  /** The windows around the focused one while focus is shown; null otherwise. */
  focusNeighbours(): FocusContext | null;
  /** How a window stands as the panorama shows it now (a held window where it is held). */
  poseOf(id: string): Pose | null;
  /**
   * Runs one of the framework's spatial commands as the host's controls do, in the panorama's
   * view: what it did, or why it did nothing. A held window's moves preview. Throws an Error when
   * the command did not run.
   */
  spatial(command: string, args: Readonly<Record<string, JsonValue>>): CommandOutcome;
  /**
   * Removes windows from the workspace, with what they hold, as one undoable change (UX-011). Their
   * surfaces' content is the host's: removing a window never deletes or stops it. A window inside
   * another one named goes with it. Throws an Error naming an ID that is no window.
   */
  removeWindows(ids: readonly string[]): TxResult;
  /**
   * Rearranges supplied surfaces among windows, or a window among groups, as one undoable change.
   * Throws {@link CompositionRefusal} naming the field at fault; a window's only surface is never
   * split from it.
   */
  compose(step: CompositionStep): TxResult;
  /**
   * Applies an experiment ({@link experimentPlan}): turns the capabilities on and off through
   * {@link Policies.configure}, then sets the view up to show the capability it isolates through
   * the modes and the orbit policy, as their own controls do: the view mode, what a background
   * drag turns, and the whole circle in view. Changes no window, and nothing undo puts back: each
   * result is a commit of view state, in the order made. Throws a `FeatureError`, a `ModeRefusal`
   * or a `PolicyRefusal` when a step is refused.
   */
  applyExperiment(id: ExperimentId): readonly TxResult[];
  /** Calls `listener` with every input intent dispatched and its result; returns what stops it. */
  observeInput(listener: (input: ObservedInput) => void): () => void;
  /**
   * Unregisters a backend's renderer, as a host whose renderer went away would: the viewport
   * falls back to the other, or degrades when it has none. Throws an Error when it is removed
   * already. `restoreBackend` registers it again.
   */
  removeBackend(backend: BackendId): void;
  /** Registers a removed backend's renderer again and restores the viewport onto it. */
  restoreBackend(backend: BackendId): Promise<SwitchOutcome>;
  /** The backends whose renderers are removed. */
  removedBackends(): readonly BackendId[];
  /**
   * Stops navigation and gives the host's element and content back: the viewport closed, every
   * surface detached, the workspace disposed.
   */
  dispose(): Promise<void>;
}

/** The viewport presented in one element: its view, the input taken there, its size kept. */
interface Mount {
  readonly viewport: PresentedViewport;
  release(): Promise<void>;
}

/**
 * Starts navigation in a host's element: a workspace with the equirectangular projection, the
 * host's adapters, the DOM and geometry backends, the presenter, input with the panorama's direct
 * manipulation, the view modes, the capabilities' policies, the view's transitions and search,
 * every one registered through the framework's public API. The workspace starts empty but for
 * its camera and viewport: the host adds its windows by transactions. Throws an Error when the
 * root is not in a window, a `ValidationError` from the workspace for an option it refuses.
 */
export async function createNavigation(options: NavigationOptions): Promise<Navigation> {
  const { root, windows } = options;
  const document = root.ownerDocument;
  const view = options.window ?? document.defaultView;
  if (view === null) {
    throw new Error('the root element is not in a window');
  }
  if (options.adapters.length === 0) {
    throw new Error('adapters: navigation needs at least one of the host’s surface adapters');
  }
  if (!/^(?:host\.|ext\.[^.]+\.)./.test(windows.partOfKey)) {
    throw new Error(
      `windows.partOfKey: "${windows.partOfKey}" must be a host.<name> or ext.<extension-id>.<name> metadata key`,
    );
  }
  /** A monotonic clock with sub-millisecond resolution: operations and hit queries are timed by it. */
  const timer = () => view.performance.now();
  // One frame source paces the workspace's announcements and the presenter's frames, so a drag
  // preview announced at an animation frame is presented in that frame.
  const frames = animationFrames(view);
  const workspace = createWorkspace({
    id: options.id,
    // Drag previews are announced once per animation frame.
    frameBoundary: (flush) => {
      frames.request(flush);
    },
    timer,
  });
  const presentation = createPresentationRegistry();
  const projections = createProjectionRegistry({
    kinds: workspace.mutator(),
    projectors: presentation.registrar(),
  });
  projections.register(equirectangular);

  const sizeOf = (width: number, height: number) => ({
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    devicePixelRatio: view.devicePixelRatio,
  });
  const box = root.getBoundingClientRect();
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

  const runtime = createSurfaceRuntime(workspace);
  for (const adapter of options.adapters) {
    runtime.registerAdapter(adapter);
  }

  const { words } = options;
  const domChrome = domInks(options.chrome);
  const geometryInks = resolvedInks(document, options.chrome);
  const standIn = (reason: StandInReason) => words.standIn(reason);
  /**
   * The window the pointer hovers over where a press would take it, as the router last said it:
   * both backends show it before anything is pressed.
   */
  let hovered: WindowHover | null = null;
  const hover = (viewportId: Id): WindowHover | null =>
    viewportId === VIEWPORT_ID ? hovered : null;
  const titleBars = (nodeId: Id): TitleBarColours | null => {
    const state = workspace.getState();
    const node = state.nodes.get(nodeId);
    return node === undefined ? null : options.windows.titleBar(node, state);
  };
  const renderers: Readonly<Record<BackendId, () => () => void>> = {
    dom: () =>
      presentation.registerRenderer(
        new DomRenderer({
          document,
          chrome: { inks: domChrome, titleBars, hover },
          standIn,
        }),
      ),
    geometry: () =>
      presentation.registerRenderer(
        new LayeredRenderer({
          id: LAYERED_RENDERER_ID,
          native: new DomRenderer({ document, standIn }),
          geometry: new GeometryRenderer({
            projections,
            drawables: (surfaceId) => runtime.handleOf(surfaceId),
            standIn,
            inks: geometryInks,
            titleBars,
            hover,
            // Names in the page's typeface, as the page writes its own text.
            typeface: () => view.getComputedStyle(document.body).fontFamily,
          }),
        }),
      ),
  };
  /** Each backend's renderer's unregistration, while it is registered. */
  const registered = new Map<BackendId, () => void>(
    BACKEND_IDS.map((backend) => [backend, renderers[backend]()]),
  );
  presentation.registerCompositor(new DomCompositor());
  presentation.registerCompositor(new LayerCompositor());

  const presenter = createPresenter({
    workspace,
    runtime,
    registry: presentation,
    frames,
    showDegraded,
    now: timer,
  });

  const router = createInteractionRouter({
    workspace,
    projections,
    presentation: (surfaceId) => mount.viewport.presentation(surfaceId),
    // Picking finds the cards the panorama draws, sized as semantic depth shows them.
    representation: () => mount.viewport.representation(),
    timer,
  });
  // What a press would take where the pointer hovers, shown before anything is pressed: a window
  // by its title bar, its card or its content with the takeover held, or the edge of its band.
  const stopHover = router.subscribe((event) => {
    if (event.type !== 'pointer.hovered' || event.viewportId !== VIEWPORT_ID) {
      return;
    }
    const { nodeId, shows } = event;
    const next =
      nodeId !== null && (shows === 'grab' || shows === 'resize' || shows === 'takeover')
        ? { nodeId, edge: shows === 'resize' ? event.edge : null }
        : null;
    if (JSON.stringify(next) !== JSON.stringify(hovered)) {
      hovered = next;
      if (mount.viewport.state === 'active') {
        mount.viewport.invalidate();
      }
    }
  });
  // Ctrl (⌘) and click to select more: the panorama's direct manipulation beyond the framework's
  // own move (Shift along the floor) and resize.
  for (const policy of MANIPULATION_POLICIES) {
    router.registerPolicy(policy);
  }
  // A and D turn the camera as Alt+← and Alt+→ do, the keys a game turns with, kept to the
  // panorama as every framework key is. Set before the policies read the keymap they keep.
  router.configure({
    keymap: [
      ...router.settings().keymap,
      {
        key: 'a',
        modifiers: [],
        command: 'camera.turn',
        args: { heading: -DEFAULT_KEYBOARD_STEPS.turn },
      },
      {
        key: 'd',
        modifiers: [],
        command: 'camera.turn',
        args: { heading: DEFAULT_KEYBOARD_STEPS.turn },
      },
    ],
  });
  /** The pose the inspector's controls show and have not committed yet, by window. */
  let posePreview: { readonly nodeId: Id; readonly previewId: string } | null = null;
  const modes = createModes(workspace, VIEWPORT_ID);
  modes.register(PANORAMA);
  // Focus and the map are capabilities: the policies register them while they are on, after the
  // panorama and before the overview, which is where a mode switcher lists them.
  const policies = createPolicies({
    workspace,
    router,
    projections,
    viewportId: VIEWPORT_ID,
    modes,
    focusMode: createFocusMode(FOCUS),
    focusOptions: FOCUS,
    mapMode: MAP,
    homeModeId: PANORAMA.id,
  });
  modes.register(OVERVIEW);
  // Into a focus, from one focused window to another, and out of it, the view moves there.
  const reducedMotion = view.matchMedia('(prefers-reduced-motion: reduce)');
  const transitions = createViewTransitions({
    workspace,
    viewportIds: [VIEWPORT_ID],
    framing: framingOf,
    frames,
    now: timer,
    motion: () => !reducedMotion.matches,
  });
  const inputs = new Set<(input: ObservedInput) => void>();
  /** The device's adapter, with every dispatch it makes told to those observing input. */
  const observed = (device: InputAdapter): InputAdapter => ({
    id: device.id,
    apiVersion: device.apiVersion,
    connect: (dispatch) =>
      device.connect((intent) => {
        const result = dispatch(intent);
        for (const listener of inputs) {
          listener({ adapterId: device.id, intent, result });
        }
        return result;
      }),
  });

  const mountIn = async (
    element: HTMLElement,
    backends: readonly BackendChoice[],
  ): Promise<Mount> => {
    // The viewport is as large as its element, always: when the element is resized, and when a
    // change of the scene (a restored space, an undo) gives it another size.
    const box = element.getBoundingClientRect();
    let measured = sizeOf(box.width, box.height);
    let mounted = true;
    const fit = () => {
      if (!mounted) {
        return;
      }
      const current = workspace.getState().viewports.get(VIEWPORT_ID)?.size;
      if (
        current !== undefined &&
        (current.width !== measured.width ||
          current.height !== measured.height ||
          current.devicePixelRatio !== measured.devicePixelRatio)
      ) {
        workspace.dispatch(
          { type: 'viewport.patch', id: VIEWPORT_ID, size: measured },
          { source: 'system' },
        );
      }
    };
    const resizes = new ResizeObserver((entries) => {
      const entry = entries.at(-1);
      if (entry === undefined) {
        return;
      }
      measured = sizeOf(entry.contentRect.width, entry.contentRect.height);
      fit();
    });
    fit();
    const unwatchSize = workspace.watch(
      (state) => state.viewports.get(VIEWPORT_ID)?.size,
      () => {
        // After the change that set it has been told to everyone.
        queueMicrotask(fit);
      },
    );
    const opened = await presenter.open({ viewportId: VIEWPORT_ID, container: element, backends });
    const detach = policies.attach(opened, element);
    const dom = createDomInput({
      root: element,
      viewportId: VIEWPORT_ID,
      events: (listener) => router.subscribe(listener),
    });
    const unregisterInput = router.registerInputAdapter(
      observed(policies.input(dom, dom.pointerLock)),
    );
    resizes.observe(element);
    const restoreElement = asView(element, words);
    return {
      viewport: opened,
      async release() {
        mounted = false;
        restoreElement();
        resizes.disconnect();
        unwatchSize();
        unregisterInput();
        detach();
        await opened.dispose();
      },
    };
  };

  const mount = await mountIn(root, BACKENDS[options.backend]);

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
  const coverageOf = (state: SceneState, nodeId: string) =>
    inView(state, VIEWPORT_ID, projections, (id) => workspace.presentedGeometry(id), nodeId)
      ? ('in-view' as const)
      : ('out-of-view' as const);
  const search = createSearch({
    workspace,
    viewportId: VIEWPORT_ID,
    metadataKeys: windows.searchKeys,
    attachment: attachmentOf,
    coverage: coverageOf,
    watch: (refresh) => runtime.subscribe(refresh),
  });

  const listeners = new Set<(status: NavigationStatus) => void>();
  let lastStatus: NavigationStatus | null = null;
  const status = (): NavigationStatus => {
    let count = 0;
    for (const node of workspace.getState().nodes.values()) {
      if (node.kind === 'window' && node.status !== 'archived') {
        count += 1;
      }
    }
    return Object.freeze({
      windows: count,
      backend:
        mount.viewport.state === 'active' ? backendOf(mount.viewport.backend?.renderer) : null,
      mode: modes.current(),
    });
  };
  const announce = () => {
    const next = status();
    if (
      lastStatus !== null &&
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

  /** A composition plan committed, or its refusal thrown. */
  const commitPlan = (plan: CompositionPlan): TxResult => {
    if (plan.kind === 'refused') {
      throw new CompositionRefusal(plan.field, plan.reason);
    }
    return workspace.transaction(plan.commands, { source: 'user' });
  };
  const partKey = windows.partOfKey;
  /**
   * What a window made for a surface is given: the host's tags and metadata, and a link to the
   * window it is a part of (the first one, when a part is broken again).
   */
  const newWindowFor = (surfaceId: Id) => {
    const state = workspace.getState();
    const surface = state.surfaces.get(surfaceId);
    if (surface === undefined) {
      throw new Error(`no surface "${surfaceId}"`);
    }
    const given = windows.newWindowFor(
      { id: surface.id, adapterTypeId: surface.adapterTypeId, bindingKey: surface.bindingKey },
      state,
    );
    const owner = state.nodes.get(surface.ownerNodeId);
    const origin = owner === undefined ? null : (partOf(owner, partKey) ?? owner.id);
    return {
      tags: given.tags,
      metadata: { ...given.metadata, ...(origin === null ? {} : { [partKey]: origin }) },
    };
  };
  const camera = () => {
    const found = workspace.getState().cameras.get(CAMERA_ID);
    if (found === undefined) {
      throw new Error(`no camera "${CAMERA_ID}"`);
    }
    return found;
  };

  const navigation: Navigation = {
    root,
    workspace,
    runtime,
    projections,
    presentation,
    presenter,
    viewport: mount.viewport,
    router,
    modes,
    search,
    policies,
    transitions,
    windows,
    status,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    partOf: (node) => partOf(node, partKey),
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
      const transform = placedAt(state, id, camera().position, at);
      if (transform === null) {
        throw new Error(`window "${id}" cannot be placed: its group's placement is singular`);
      }
      return workspace.dispatch({ type: 'node.patch', id, transform }, { source: 'user' });
    },
    poseWindow(id, target, { preview }) {
      const state = workspace.getState();
      const eye = camera().position;
      const open = posePreview;
      // Another window's pose shown is ended first: a pose shows one window at a time.
      if (open !== null && open.nodeId !== id) {
        workspace.cancelPreview(open.previewId, 'host');
        posePreview = null;
      }
      const patch = posedPatch(state, id, eye, target);
      if (patch === null) {
        throw new Error(`window "${id}" cannot be posed: its group's placement is singular`);
      }
      const shown = posePreview;
      if (preview) {
        const previewId = shown?.previewId ?? `swf.window.pose/${id}/${String(state.revision)}`;
        posePreview = { nodeId: id, previewId };
        return workspace.preview(previewId, [patch], { source: 'user' });
      }
      posePreview = null;
      return workspace.transaction([patch], {
        source: 'user',
        ...(shown === null ? {} : { previewId: shown.previewId }),
      });
    },
    placeAround(id, side) {
      const state = workspace.getState();
      if (state.nodes.get(id)?.kind !== 'window') {
        throw new Error(`no window "${id}"`);
      }
      const transform = aroundCamera(state, id, VIEWPORT_ID, side);
      if (transform === null) {
        throw new Error(`window "${id}" cannot be placed: its group's placement is singular`);
      }
      return workspace.dispatch({ type: 'node.patch', id, transform }, { source: 'user' });
    },
    arrangeWindows() {
      const commands = arrangedAround(workspace.getState(), VIEWPORT_ID, ARRANGE_RINGS, (node) =>
        windows.arrangeKey(node),
      );
      return commands.length === 0 ? null : workspace.transaction(commands, { source: 'user' });
    },
    turnCamera(degrees) {
      const { pitch } = headingPitchOf(camera().rotation);
      return workspace.dispatch(
        {
          type: 'camera.patch',
          id: CAMERA_ID,
          rotation: cameraRotation((degrees * Math.PI) / 180, pitch),
        },
        { source: 'user' },
      );
    },
    focusNeighbours() {
      const state = workspace.getState();
      const eye = state.cameras.get(CAMERA_ID);
      return modes.current() !== FOCUS_ID || state.focusedId === null || eye === undefined
        ? null
        : focusContext(state, state.focusedId, eye.position);
    },
    poseOf(id) {
      const scene = workspace.getPresented();
      const eye = scene.cameras.get(CAMERA_ID);
      if (eye === undefined) {
        throw new Error(`no camera "${CAMERA_ID}"`);
      }
      return poseOf(scene, id, eye.position);
    },
    spatial(command, args) {
      const result = router.dispatch({
        kind: 'command',
        command,
        args: { ...args },
        deviceId: 'swf.navigation.controls',
        timestamp: view.performance.now(),
      });
      const outcome = result.operation?.outcome;
      if (outcome === undefined || !('status' in outcome)) {
        throw new Error(`${command} did not run: ${String(result.reason)}`);
      }
      return outcome;
    },
    removeWindows(ids) {
      const state = workspace.getState();
      for (const id of ids) {
        if (state.nodes.get(id)?.kind !== 'window') {
          throw new Error(`no window "${id}"`);
        }
      }
      const named = new Set(ids);
      /** Whether a window is inside another one named: removing that one takes it too. */
      const within = (id: string): boolean => {
        for (
          let up = state.nodes.get(id)?.parentId ?? null;
          up !== null;
          up = state.nodes.get(up)?.parentId ?? null
        ) {
          if (named.has(up)) {
            return true;
          }
        }
        return false;
      };
      // Focus is on a window about to go: leave it first, putting its view back.
      const focused = state.focusedId;
      if (
        modes.current() === FOCUS_ID &&
        focused !== null &&
        (named.has(focused) || within(focused))
      ) {
        modes.back({ source: 'system' });
      }
      return workspace.transaction(
        [...named]
          .filter((id) => !within(id))
          .map((id): SceneCommand => ({ type: 'node.delete', id, mode: 'subtree' })),
        { source: 'user' },
      );
    },
    compose(step) {
      if (!policies.status().features.enabled.composition) {
        throw new CompositionRefusal('feature', 'composition is turned off');
      }
      const state = workspace.getState();
      switch (step.kind) {
        case 'detach':
          return commitPlan(detachSurface(state, step.surfaceId, newWindowFor));
        case 'split':
          return commitPlan(splitWindow(state, step.windowId, newWindowFor));
        case 'recombine': {
          // The window the parts came from, and every window that is a part of it.
          const node = state.nodes.get(step.windowId);
          const origin = node === undefined ? step.windowId : (partOf(node, partKey) ?? node.id);
          const parts = [...state.nodes.values()]
            .filter(
              (n) => n.kind === 'window' && n.status === 'active' && partOf(n, partKey) === origin,
            )
            .map((n) => n.id);
          return commitPlan(recombineParts(state, origin, parts));
        }
        case 'move':
          return commitPlan(moveSurface(state, step.surfaceId, step.windowId));
        case 'merge':
          return commitPlan(mergeWindow(state, step.windowId, step.targetId));
        case 'regroup':
          return commitPlan(regroupWindow(state, step.windowId, step.target, camera().position));
        case 'group':
          return commitPlan(groupWindows(state, step.windowIds, step.group, camera().position));
      }
    },
    applyExperiment(id) {
      const state = workspace.getState();
      const shown = state.focusedId ?? state.selection[0] ?? null;
      const plan = experimentPlan(id, {
        target: shown !== null && state.nodes.get(shown)?.kind === 'window',
        orbitRoot: state.orbitRootId !== null,
      });
      policies.configure({ enabled: plan.enabled });
      const changes: TxResult[] = [];
      const target = { panorama: PANORAMA.id, focus: FOCUS_ID, map: MAP.id }[plan.view];
      if (modes.current() !== target) {
        changes.push(modes.switchTo(target));
      }
      if (policies.status().orbit.navigation !== plan.navigation) {
        const navigated = policies.navigate(plan.navigation);
        if (navigated !== null) {
          changes.push(navigated);
        }
      }
      if (plan.wholeCircle && fieldOfViewOf(modes.panorama()) !== FIELD_OF_VIEW.max) {
        changes.push(modes.fieldOfView(FIELD_OF_VIEW.max));
      }
      return changes;
    },
    observeInput(listener) {
      inputs.add(listener);
      return () => {
        inputs.delete(listener);
      };
    },
    removeBackend(backend) {
      const unregister = registered.get(backend);
      if (unregister === undefined) {
        throw new Error(`the ${backend} backend's renderer is already removed`);
      }
      registered.delete(backend);
      unregister();
      announce();
    },
    async restoreBackend(backend) {
      if (registered.has(backend)) {
        throw new Error(`the ${backend} backend's renderer is registered`);
      }
      registered.set(backend, renderers[backend]());
      const outcome = await mount.viewport.restore();
      announce();
      return outcome;
    },
    removedBackends: () => BACKEND_IDS.filter((backend) => !registered.has(backend)),
    dispose() {
      disposed ??= release();
      return disposed;
    },
  };
  /** Navigation's disposal, once it has begun: every later call returns it. */
  let disposed: Promise<void> | null = null;
  async function release(): Promise<void> {
    inputs.clear();
    search.dispose();
    transitions.dispose();
    await mount.release();
    unwatch();
    unwatchPresenter();
    listeners.clear();
    modes.dispose();
    policies.dispose();
    stopHover();
    router.dispose();
    await presenter.dispose();
    await runtime.dispose();
    await workspace.dispose();
  }
  return navigation;
}
