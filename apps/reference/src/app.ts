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
  DEFAULT_GEOMETRY_INKS,
  GEOMETRY_RENDERER_ID,
  GeometryRenderer,
  LAYER_COMPOSITOR_ID,
  LayerCompositor,
  LayeredRenderer,
} from '@swf/backend-geometry';
import type {
  Id,
  JsonValue,
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
  SwitchOutcome,
} from '@swf/presentation';
import type { StandInReason } from '@swf/presentation';
import { createPresentationRegistry, createPresenter } from '@swf/presentation';
import type { RestoreOutcome, SnapshotStore } from '@swf/persistence';
import { createWebStorageStore } from '@swf/persistence';
import type { ProjectionRegistry } from '@swf/projections';
import {
  cameraRotation,
  createProjectionRegistry,
  equirectangular,
  headingPitchOf,
} from '@swf/projections';
import type { SurfaceRuntime } from '@swf/surfaces';
import { createSurfaceRuntime } from '@swf/surfaces';
import type { AppCommands } from './commands.js';
import { createAppCommands } from './commands.js';
import type { CompositionPlan, GroupTarget } from './composition.js';
import {
  CompositionRefusal,
  detachSurface,
  freeId,
  groupWindows,
  mergeWindow,
  moveSurface,
  PART_OF_KEY,
  partOf,
  recombineParts,
  regroupWindow,
  splitWindow,
} from './composition.js';
import type { AppConfig, BackendId } from './config.js';
import { BACKEND_IDS } from './config.js';
import type { DemoContent, NoteTexts } from './content.js';
import { createDemoContent, webNoteTexts } from './content.js';
import type { Messages } from './messages.js';
import { createMessages } from './messages.js';
import type { FocusContext } from './focus.js';
import { createFocusMode, FOCUS_ID, focusContext } from './focus.js';
import { MANIPULATION_POLICIES } from './manipulation.js';
import type { ViewTransitions } from './transition.js';
import { createViewTransitions } from './transition.js';
import type { AroundSide } from './map.js';
import { aroundCamera, arrangedAround, inView, placedAt } from './map.js';
import type { Modes } from './modes.js';
import { createModes, FIELD_OF_VIEW, fieldOfViewOf, MAP, OVERVIEW, PANORAMA } from './modes.js';
import type { ExperimentId } from './experiments.js';
import { experimentPlan } from './experiments.js';
import type { FeaturePatch } from './features.js';
import { ringsOf } from './features.js';
import type { Policies } from './policies.js';
import { createPolicies } from './policies.js';
import type { PresetId } from './presets.js';
import {
  ADDED_KEY,
  addedWindow,
  CAMERA_ID,
  CATEGORY_KEY,
  COLOUR_KEY,
  colourName,
  composites,
  contentOf,
  planPreset,
  presetIssue,
  PRESETS,
  SEARCHABLE_METADATA,
  presetCommands,
  windowCommands,
  WORKSPACE_GROUP_ID,
} from './presets.js';
import type { Attachment, Search } from './search.js';
import { createSearch } from './search.js';
import type { Vec3 } from '@swf/math';
import { MAX_SEED, seedIssue } from '@swf/math';
import type { Pose, PoseTarget } from './pose.js';
import { posedPatch, poseOf } from './pose.js';
import type { Workspaces } from './workspaces.js';
import { createWorkspaces, hostExtension } from './workspaces.js';
import type { Scenarios, ScenarioId, ScenarioWorld } from './scenarios.js';
import { BEHIND, createScenarios, offCamera, SCENARIOS } from './scenarios.js';
import type { Challenge, ChallengeRun, MethodId } from './challenge.js';
import { ChallengeRefusal, createChallenge } from './challenge.js';
import { cameraHeading, nodeHeading } from './orbit.js';

/** The viewport the application presents. */
export const VIEWPORT_ID = 'main';

/**
 * CSS pixels a live element lays out per world unit. A whole 360° panorama shows windows small,
 * so content lays out small and is scaled down less.
 */
const PIXELS_PER_UNIT = 160;

/** How focus frames a window: three-quarters of the view, at most two and a half times its size. */
const FOCUS = Object.freeze({ fill: 0.75, maxMagnification: 2.5, pixelsPerUnit: PIXELS_PER_UNIT });

/**
 * The kit's colours window chrome is drawn in (UX-013): frames in the kit's quiet ink, the selected
 * window in its focus ring's, the focused one in its warning ink, text in the editor's ink. The kit
 * checks each against the grounds it is drawn on, in both appearances.
 */
const KIT_INKS = Object.freeze({
  frame: '--vscode-descriptionForeground',
  selected: '--vscode-focusBorder',
  focused: '--vscode-editorWarning-foreground',
  text: '--vscode-editor-foreground',
});

/** The kit's inks for chrome laid out as DOM: its custom properties, resolved by the browser. */
const DOM_INKS: ChromeInks = Object.freeze({
  frame: `var(${KIT_INKS.frame})`,
  selected: `var(${KIT_INKS.selected})`,
  focused: `var(${KIT_INKS.focused})`,
});

/**
 * The kit's inks for chrome drawn on a canvas, which takes no custom property: each resolved to a
 * colour as the page's appearance has it, again whenever the appearance changes.
 */
function kitInks(document: Document): () => GeometryInks {
  const view = document.defaultView;
  if (view === null) {
    throw new Error('the document is not in a window');
  }
  const dark = view.matchMedia('(prefers-color-scheme: dark)');
  let resolvedFor: string | null = null;
  let inks: GeometryInks = DEFAULT_GEOMETRY_INKS;
  const resolve = (token: string, probe: HTMLElement): string => {
    probe.style.setProperty('color', `var(${token})`);
    const colour = view.getComputedStyle(probe).color;
    if (colour === '') {
      throw new Error(`the kit's ${token} does not resolve to a colour`);
    }
    return colour;
  };
  return () => {
    const appearance = `${String(dark.matches)}/${document.documentElement.dataset['appearance'] ?? ''}`;
    if (appearance !== resolvedFor) {
      // Never shown: it only lets the browser resolve a token as this page has it.
      const probe = document.createElement('span');
      probe.hidden = true;
      document.body.append(probe);
      try {
        inks = Object.freeze({
          frame: resolve(KIT_INKS.frame, probe),
          selected: resolve(KIT_INKS.selected, probe),
          focused: resolve(KIT_INKS.focused, probe),
          text: resolve(KIT_INKS.text, probe),
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
 * Makes the element the panorama is presented in one stop of the page's keyboard order, a
 * spatial workspace the keyboard operates (FR-109, UX-012, UX-013): it says what it is and which
 * keys act there. A press in it that is not in a window's live content gives it the keyboard, as a
 * press in any list does, though the framework keeps that press from the page: so a window clicked
 * is then moved, removed or focused by its keys. Returns what puts the element back as it was.
 */
function keyboardTarget(element: HTMLElement, messages: Messages): () => void {
  const attributes: Readonly<Record<string, string>> = {
    tabindex: '0',
    role: 'application',
    'aria-roledescription': messages.format('panorama.role'),
    'aria-label': messages.format('panorama.label'),
    'aria-description': messages.format('panorama.keys'),
  };
  const before = Object.keys(attributes).map((name) => [name, element.getAttribute(name)] as const);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
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
    for (const [name, value] of before) {
      if (value === null) {
        element.removeAttribute(name);
      } else {
        element.setAttribute(name, value);
      }
    }
  };
}

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

/** A step of multi-surface composition (FR-126). */
export type CompositionStep =
  | { readonly kind: 'detach'; readonly surfaceId: Id }
  | { readonly kind: 'move'; readonly surfaceId: Id; readonly windowId: Id }
  | { readonly kind: 'merge'; readonly windowId: Id; readonly targetId: Id }
  /** Each surface of a window but its first into a window of its own. */
  | { readonly kind: 'split'; readonly windowId: Id }
  /** Every part of the window this one came from (or of this one) back into it. */
  | { readonly kind: 'recombine'; readonly windowId: Id }
  | { readonly kind: 'regroup'; readonly windowId: Id; readonly target: GroupTarget }
  | {
      readonly kind: 'group';
      readonly windowIds: readonly Id[];
      readonly group: { readonly id: Id; readonly label: string };
    };

/** An input intent dispatched, with what the framework did with it, for the host to measure. */
export interface ObservedInput {
  readonly adapterId: string;
  readonly intent: InputIntent;
  readonly result: DispatchResult;
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
  /** The element the viewport fills. */
  readonly root: HTMLElement;
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
  /** The eight optional modules, each turned on and off on its own. */
  readonly policies: Policies;
  /** The workspaces in local storage: saved as it changes, named, exported and imported. */
  readonly workspaces: Workspaces;
  /** The guided scenarios: the one under way, and how far it has come. */
  readonly scenarios: Scenarios;
  /** The timed window-finding task: the run under way, and the runs recorded. */
  readonly challenge: Challenge;
  status(): AppStatus;
  subscribe(listener: (status: AppStatus) => void): () => void;
  /**
   * Replaces every window with the preset's, planned from the seed (by default the preset's
   * own), and turns the camera back to straight ahead: one undoable commit.
   */
  loadPreset(preset: PresetId, seed?: number): TxResult;
  /** Loads the current scene's preset and seed again. */
  reset(): TxResult;
  /**
   * Makes the studio a scenario starts from, as it is planned, with the features the scenario
   * shows turned on and the panorama shown: one undoable change of the scene. The caller starts
   * the scenario once it is committed. Throws {@link FeatureError} when a feature cannot be turned on.
   */
  prepareScenario(id: ScenarioId): TxResult;
  /**
   * Applies an experiment ({@link experimentPlan}): turns the feature modules on and off through
   * {@link Policies.configure}, then sets the view up to show the capability it isolates through
   * the modes and the orbit policy, as their own controls do: the view mode, what a background
   * drag turns, and the whole circle in view. Changes no window, and nothing undo puts back: each
   * result is a commit of view state, in the order made. Throws {@link FeatureError},
   * {@link ModeRefusal} or {@link PolicyRefusal} when a step is refused.
   */
  applyExperiment(id: ExperimentId): readonly TxResult[];
  /**
   * Starts a run of the timed task navigated by a method: shows the view the method navigates
   * in, then names a window to find. Throws {@link ChallengeRefusal} when the method's feature is
   * off or there is no window to name, {@link ModeRefusal} or {@link PolicyRefusal} when the view
   * cannot be shown.
   */
  startChallenge(method: MethodId): ChallengeRun;
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
   * Adds a new window to the workspace, a blank native note straight ahead of the camera, and
   * selects it: one undoable change. Throws {@link CompositionRefusal} when the workspace group it
   * goes into is gone or no longer stands at the camera.
   */
  addWindow(): TxResult;
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
  /**
   * Poses a window as the inspector's controls set it: round the camera, out from it, up, turned
   * and sized, each left out staying as it is ({@link posedPatch}). With `preview`, the change is
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
   * the whole circle from straight ahead, by what it shows and its colour, on three rings: one
   * within each band semantic depth draws by (near enough to show whole, compact, a label alone).
   * One undoable commit; null when there is no window to arrange.
   */
  arrangeWindows(): TxResult | null;
  /**
   * Turns the camera to a heading, in degrees to the right of straight ahead, keeping its pitch:
   * view state, never undone.
   */
  turnCamera(degrees: number): TxResult;
  /** The windows around the focused one while focus is shown; null otherwise. */
  focusNeighbours(): FocusContext | null;
  /**
   * The window a press at a point of the panorama, in CSS pixels from its top-left, chooses: the
   * window whose frame or stand-in is there. A window's own live content takes its presses itself,
   * so a point on it chooses none; nor does the background.
   */
  windowAt(x: number, y: number): string | null;
  /** The view's transitions into a focus, between focused windows and out of it. */
  readonly transitions: ViewTransitions;
  /** How a window stands as the panorama shows it now (a held window where it is held). */
  poseOf(id: string): Pose | null;
  /**
   * Runs one of the framework's spatial commands as the application's controls do, in the
   * panorama's view: what it did, or why it did nothing. A held window's moves preview.
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
  /** Calls `listener` with every input intent dispatched and its result; returns what stops it. */
  observeInput(listener: (input: ObservedInput) => void): () => void;
  /**
   * Unregisters a backend's renderer, as a host whose renderer went away would: the viewport
   * falls back to the other, or degrades when it has none. `restoreBackend` registers it again.
   */
  removeBackend(backend: BackendId): void;
  restoreBackend(backend: BackendId): Promise<SwitchOutcome>;
  /** The backends whose renderers are removed. */
  removedBackends(): readonly BackendId[];
  /** Offers JSON text to the operator as a file to save, under a name. */
  saveFile(name: string, text: string): void;
  dispose(): Promise<void>;
}

export interface ReferenceAppOptions {
  /** The element the viewport fills. */
  readonly root: HTMLElement;
  readonly config: AppConfig;
  readonly messages?: Messages;
  /** The window whose animation frames pace presentation. Default: the root's. */
  readonly window?: Window;
  /** Where workspaces are stored. Default: the window's local storage. */
  readonly store?: SnapshotStore;
  /** Where what the operator writes in the notes is kept. Default: the window's local storage. */
  readonly noteTexts?: NoteTexts;
  /** How long after a change the workspace is saved, in milliseconds. Default 800. */
  readonly autosaveDelayMs?: number;
  /** Offers a file to save. Default: the browser downloads it. */
  readonly saveFile?: (name: string, text: string) => void;
}

/** Offers JSON text to save as a file, as the browser downloads one. */
function download(document: Document, name: string, text: string): void {
  const view = document.defaultView;
  if (view === null) {
    throw new Error('the document is not in a window');
  }
  const url = view.URL.createObjectURL(new view.Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  view.URL.revokeObjectURL(url);
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
  /** A monotonic clock with sub-millisecond resolution: operations and hit queries are timed by it. */
  const timer = () => view.performance.now();

  // One frame source paces the workspace's announcements and the presenter's frames, so a drag
  // preview announced at an animation frame is presented in that frame.
  const frames = animationFrames(view);
  const workspace = createWorkspace({
    id: 'reference',
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

  const content = createDemoContent(
    document,
    messages,
    options.noteTexts ?? webNoteTexts(view.localStorage),
  );
  const runtime = createSurfaceRuntime(workspace);
  runtime.registerAdapter(content.notes);
  runtime.registerAdapter(content.tiles);

  const geometryInks = kitInks(document);
  // What a stand-in says, in the application's words.
  const standIn = (reason: StandInReason) => messages.format(`standIn.${reason}`);
  const renderers: Readonly<Record<BackendId, () => () => void>> = {
    dom: () =>
      presentation.registerRenderer(
        new DomRenderer({
          document,
          pixelsPerUnit: PIXELS_PER_UNIT,
          chrome: { projections, inks: DOM_INKS },
          standIn,
        }),
      ),
    geometry: () =>
      presentation.registerRenderer(
        new LayeredRenderer({
          id: LAYERED_RENDERER_ID,
          native: new DomRenderer({ document, pixelsPerUnit: PIXELS_PER_UNIT, standIn }),
          geometry: new GeometryRenderer({
            projections,
            drawables: (surfaceId) => runtime.handleOf(surfaceId),
            standIn,
            inks: geometryInks,
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
    timer,
  });
  // Shift and drag for depth, Ctrl (⌘) and drag to turn, Ctrl (⌘) and click to select more: the
  // panorama's direct manipulation beyond the framework's own move and resize.
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
  // Focus and the map are features: the policies register them while they are on, after the
  // panorama and before the overview, which is where the mode switcher lists them.
  const policies = createPolicies({
    workspace,
    router,
    projections,
    viewportId: VIEWPORT_ID,
    modes,
    focusMode: createFocusMode(FOCUS),
    mapMode: MAP,
    homeModeId: PANORAMA.id,
  });
  modes.register(OVERVIEW);
  // Into a focus, from one focused window to another, and out of it, the view moves there.
  const reducedMotion = view.matchMedia('(prefers-reduced-motion: reduce)');
  const transitions = createViewTransitions({
    workspace,
    viewportIds: [VIEWPORT_ID],
    framing: (state) => {
      const mode = state.viewports.get(VIEWPORT_ID)?.mode ?? PANORAMA.id;
      return { mode, framed: mode === FOCUS_ID ? state.focusedId : null };
    },
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
      observed(
        policies.input(
          createDomInput({
            root: element,
            viewportId: VIEWPORT_ID,
            events: (listener) => router.subscribe(listener),
          }),
        ),
      ),
    );
    resizes.observe(element);
    const restoreElement = keyboardTarget(element, messages);
    return {
      root: element,
      viewport: opened,
      async release() {
        restoreElement();
        resizes.disconnect();
        unregisterInput();
        detach();
        await opened.dispose();
      },
    };
  };

  const mount = await mountIn(root, BACKENDS[config.backend]);

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
    inView(state, VIEWPORT_ID, projections, nodeId)
      ? ('in-view' as const)
      : ('out-of-view' as const);
  const search = createSearch({
    workspace,
    viewportId: VIEWPORT_ID,
    metadataKeys: SEARCHABLE_METADATA,
    attachment: attachmentOf,
    coverage: coverageOf,
    watch: (refresh) => runtime.subscribe(refresh),
  });

  let scene: SceneSource = { preset: config.preset, seed: config.seed };
  /** Those told when the scene source changes: the host extension that saves it. */
  const sceneWatchers = new Set<() => void>();
  const setScene = (next: SceneSource) => {
    scene = Object.freeze(next);
    for (const watcher of sceneWatchers) {
      watcher();
    }
    announce();
  };
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
      setScene({ preset, seed });
    }
    return result;
  };

  const workspaces = createWorkspaces({
    workspace,
    store: options.store ?? createWebStorageStore(view.localStorage, { prefix: 'swf-reference' }),
    now: () => Date.now(),
    timer,
    autosaveDelayMs: options.autosaveDelayMs ?? 800,
    // Which preset and seed the scene came from: the host's own state, opaque to the framework.
    extensions: [
      hostExtension('host.reference.scene', {
        capture: () => ({ preset: scene.preset, seed: scene.seed }),
        restore(data: JsonValue) {
          const record = data as Readonly<Record<string, unknown>> | null;
          const preset = record?.['preset'];
          const seed = record?.['seed'];
          const issue = presetIssue(preset) ?? seedIssue(seed);
          if (issue !== null) {
            throw new Error(`the scene source is not one the application knows: ${issue}`);
          }
          setScene({ preset: preset as PresetId, seed: seed as number });
        },
        watch(changed) {
          sceneWatchers.add(changed);
          return () => {
            sceneWatchers.delete(changed);
          };
        },
      }),
    ],
    // The policies' parameters are saved with the layout; whether each is on is the operator's
    // choice for the session, not part of the layout.
    policies: [
      {
        id: 'reference.policies/1',
        capture: () => {
          const { snap, depth } = policies.status().features;
          return { snap: { ...snap }, depth: { ...depth } };
        },
        restore: (parameters: JsonValue) => {
          policies.configure(parameters as unknown as FeaturePatch);
        },
        watch: (changed: () => void) => {
          let last = policies.status().features;
          return policies.subscribe(() => {
            const now = policies.status().features;
            if (now.snap !== last.snap || now.depth !== last.depth) {
              last = now;
              changed();
            }
          });
        },
      },
    ],
  });
  // Saving as the workspace changes is the persistence feature's hook.
  const followPersistence = () => {
    workspaces.setAutosave(policies.status().features.enabled.persistence);
  };
  const stopPersistence = policies.subscribe(followPersistence);

  /** A composition plan committed, or its refusal thrown. */
  const commitPlan = (plan: CompositionPlan): TxResult => {
    if (plan.kind === 'refused') {
      throw new CompositionRefusal(plan.field, plan.reason);
    }
    return workspace.transaction(plan.commands, { source: 'user' });
  };
  /** What a window made for a detached surface is tagged and described with: its content's. */
  /**
   * What a window made for a surface is given: its content's tag, its colour and category, and a
   * link to the window it is a part of (the first one, when a part is broken again).
   */
  const newWindowFor = (surfaceId: Id) => {
    const state = workspace.getState();
    const surface = state.surfaces.get(surfaceId);
    const kind = surface === undefined ? null : contentOf(surface.adapterTypeId);
    const planned = surface?.bindingKey == null ? null : content.find(surface.bindingKey);
    const owner = surface === undefined ? undefined : state.nodes.get(surface.ownerNodeId);
    const origin = owner === undefined ? null : (partOf(owner) ?? owner.id);
    return {
      tags: kind === null ? [] : [kind],
      metadata: {
        ...(planned === null
          ? {}
          : {
              [COLOUR_KEY]: colourName(planned.hue),
              ...(planned.detail === undefined ? {} : { [CATEGORY_KEY]: planned.detail.category }),
            }),
        ...(origin === null ? {} : { [PART_OF_KEY]: origin }),
      },
    };
  };

  const DEGREES = 180 / Math.PI;
  /** The application as a scenario's step reads it: the named workspaces first, then the rest. */
  const scenarioWorld = async (): Promise<ScenarioWorld> => {
    const named = await workspaces.named();
    const state = workspace.getState();
    const camera = state.cameras.get(CAMERA_ID);
    if (camera === undefined) {
      throw new Error(`no camera "${CAMERA_ID}"`);
    }
    return Object.freeze({
      scene: state,
      mode: modes.current(),
      cameraHeading: cameraHeading(state, VIEWPORT_ID) * DEGREES,
      pose: (id: string) =>
        state.nodes.get(id)?.status === 'active' ? poseOf(state, id, camera.position) : null,
      depth: policies.status().features.depth,
      named,
      restores: workspaces.measures().restores,
    });
  };
  const scenarios = createScenarios({ world: scenarioWorld });
  // A step is looked at again whenever anything it reads may have changed.
  const looks = [
    workspace.subscribe((event) => {
      if (event.type === 'transaction.committed') {
        void scenarios.observe();
      }
    }),
    workspaces.subscribe(() => {
      void scenarios.observe();
    }),
    policies.subscribe(() => {
      void scenarios.observe();
    }),
  ];

  const challenge = createChallenge({ now: timer, random: () => Math.random() });
  // The run counts every press and key the operator makes anywhere in the page, and ends when
  // the window it names is selected; a run whose window is removed ends unfinished.
  const acted = (event: Event) => {
    if (!(event instanceof KeyboardEvent && event.repeat)) {
      challenge.act();
    }
  };
  document.addEventListener('pointerdown', acted, { capture: true });
  document.addEventListener('keydown', acted, { capture: true });
  const unwatchChallenge = workspace.subscribe((event) => {
    const run = challenge.status().run;
    if (event.type !== 'transaction.committed' || run === null) {
      return;
    }
    const state = workspace.getState();
    if (state.nodes.get(run.target)?.status !== 'active') {
      challenge.removed();
      return;
    }
    const selected = state.selection[0];
    if (selected !== undefined) {
      challenge.selected(selected);
    }
  });
  /** The features each way of navigating needs. */
  const METHOD_FEATURES = Object.freeze({
    camera: null,
    orbit: 'orbit',
    map: 'map',
    overview: null,
    search: null,
  } as const);

  const app: ReferenceApp = {
    root,
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
    workspaces,
    scenarios,
    challenge,
    status,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    loadPreset,
    reset: () => loadPreset(scene.preset, scene.seed),
    prepareScenario(id) {
      const enabled = Object.fromEntries(SCENARIOS[id].features.map((f) => [f, true]));
      policies.configure({ enabled });
      const loaded = loadPreset('studio');
      if (loaded.status === 'committed' && modes.current() !== PANORAMA.id) {
        // Loading leaves focus; the map or the overview is left for the panorama.
        return modes.switchTo(PANORAMA.id);
      }
      return loaded;
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
      const view = { panorama: PANORAMA.id, focus: FOCUS_ID, map: MAP.id }[plan.view];
      if (modes.current() !== view) {
        changes.push(modes.switchTo(view));
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
    startChallenge(method) {
      const feature = METHOD_FEATURES[method];
      if (feature !== null && !policies.status().features.enabled[feature]) {
        throw new ChallengeRefusal(
          'method',
          `navigating by ${method} needs the ${feature} feature, which is turned off`,
        );
      }
      // The view the method navigates in; the panorama for the others, with what drags turn.
      const viewFor: Readonly<Record<MethodId, string>> = {
        camera: PANORAMA.id,
        orbit: PANORAMA.id,
        map: MAP.id,
        overview: OVERVIEW.id,
        search: PANORAMA.id,
      };
      if (modes.current() !== viewFor[method]) {
        modes.switchTo(viewFor[method]);
      }
      if (policies.status().features.enabled.orbit) {
        policies.navigate(method === 'orbit' ? 'orbit' : 'camera');
      }
      const state = workspace.getState();
      const camera = state.cameras.get(CAMERA_ID);
      if (camera === undefined) {
        throw new Error(`no camera "${CAMERA_ID}"`);
      }
      const world = { cameraHeading: cameraHeading(state, VIEWPORT_ID) * DEGREES };
      const candidates = [...state.nodes.values()].flatMap((node) => {
        const pose =
          node.kind === 'window' && node.status === 'active'
            ? poseOf(state, node.id, camera.position)
            : null;
        return pose === null
          ? []
          : [
              {
                id: node.id,
                label: node.label ?? node.id,
                behind: offCamera(world, pose) > BEHIND,
              },
            ];
      });
      const run = challenge.start(method, candidates, state.selection[0] ?? null);
      if (run === null) {
        throw new ChallengeRefusal(
          'windows',
          'there is no window to find: the task needs a window besides the one selected',
        );
      }
      return run;
    },
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
    addWindow() {
      const state = workspace.getState();
      const camera = state.cameras.get(CAMERA_ID);
      const group = state.nodes.get(WORKSPACE_GROUP_ID);
      const placed = worldMatrix(state.nodes, WORKSPACE_GROUP_ID);
      if (camera === undefined) {
        throw new Error(`no camera "${CAMERA_ID}"`);
      }
      if (group?.status !== 'active' || placed === undefined) {
        throw new CompositionRefusal(
          'group',
          'the workspace group is gone: load a scene to add windows to it',
        );
      }
      const off = Math.hypot(
        placed[12] - camera.position[0],
        placed[13] - camera.position[1],
        placed[14] - camera.position[2],
      );
      if (off > 1e-9) {
        throw new CompositionRefusal('group', 'the workspace group no longer stands at the camera');
      }
      // The next number no added window has had in this scene.
      const numbers = [...state.surfaces.values()].flatMap((s) => {
        const key = s.bindingKey ?? '';
        return key.startsWith(ADDED_KEY) ? [Number(key.slice(ADDED_KEY.length))] : [];
      });
      const planned = addedWindow(Math.max(0, ...numbers) + 1);
      const id = freeId(state, planned.id);
      // Straight ahead of the camera, in the group's own turn.
      const heading =
        cameraHeading(state, VIEWPORT_ID) - (nodeHeading(state, WORKSPACE_GROUP_ID) ?? 0);
      const window = composites([
        { ...planned, id, heading: (heading * 180) / Math.PI, elevation: 0 },
      ])[0];
      if (window === undefined) {
        throw new Error('an added window was planned as no window');
      }
      return workspace.transaction(
        [...windowCommands(window, WORKSPACE_GROUP_ID), { type: 'selection.set', ids: [id] }],
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
    poseWindow(id, target, { preview }) {
      const state = workspace.getState();
      const camera = state.cameras.get(CAMERA_ID);
      if (camera === undefined) {
        throw new Error(`no camera "${CAMERA_ID}"`);
      }
      const open = posePreview;
      // Another window's pose shown is ended first: a pose shows one window at a time.
      if (open !== null && open.nodeId !== id) {
        workspace.cancelPreview(open.previewId, 'host');
        posePreview = null;
      }
      const patch = posedPatch(state, id, camera.position, target);
      if (patch === null) {
        throw new Error(`window "${id}" cannot be posed: its group's placement is singular`);
      }
      const shown = posePreview;
      if (preview) {
        const previewId =
          shown?.previewId ?? `reference.window.pose/${id}/${String(state.revision)}`;
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
      const commands = arrangedAround(
        workspace.getState(),
        VIEWPORT_ID,
        ringsOf(policies.status().features.depth),
        (node) => {
          const colour = node.metadata[COLOUR_KEY];
          return typeof colour === 'string' ? colour : '';
        },
      );
      return commands.length === 0 ? null : workspace.transaction(commands, { source: 'user' });
    },
    turnCamera(degrees) {
      const camera = workspace.getState().cameras.get(CAMERA_ID);
      if (camera === undefined) {
        throw new Error(`no camera "${CAMERA_ID}"`);
      }
      const { pitch } = headingPitchOf(camera.rotation);
      return workspace.dispatch(
        {
          type: 'camera.patch',
          id: CAMERA_ID,
          rotation: cameraRotation((degrees * Math.PI) / 180, pitch),
        },
        { source: 'user' },
      );
    },
    transitions,
    windowAt(x, y) {
      if (mount.viewport.state !== 'active') {
        return null;
      }
      const picked = router.pick(VIEWPORT_ID, x, y);
      if (picked.kind !== 'hit' || (picked.region === 'content' && !picked.target.proxy)) {
        return null;
      }
      const node = workspace.getState().nodes.get(picked.target.nodeId);
      return node?.kind === 'window' ? node.id : null;
    },
    focusNeighbours() {
      const state = workspace.getState();
      const camera = state.cameras.get(CAMERA_ID);
      return modes.current() !== FOCUS_ID || state.focusedId === null || camera === undefined
        ? null
        : focusContext(state, state.focusedId, camera.position);
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
      const eye = (): Vec3 => {
        const camera = state.cameras.get(CAMERA_ID);
        if (camera === undefined) {
          throw new Error(`no camera "${CAMERA_ID}"`);
        }
        return camera.position;
      };
      switch (step.kind) {
        case 'detach':
          return commitPlan(detachSurface(state, step.surfaceId, newWindowFor));
        case 'split':
          return commitPlan(splitWindow(state, step.windowId, newWindowFor));
        case 'recombine': {
          // The window the parts came from, and every window that is a part of it.
          const node = state.nodes.get(step.windowId);
          const origin = node === undefined ? step.windowId : (partOf(node) ?? node.id);
          const parts = [...state.nodes.values()]
            .filter((n) => n.kind === 'window' && n.status === 'active' && partOf(n) === origin)
            .map((n) => n.id);
          return commitPlan(recombineParts(state, origin, parts));
        }
        case 'move':
          return commitPlan(moveSurface(state, step.surfaceId, step.windowId));
        case 'merge':
          return commitPlan(mergeWindow(state, step.windowId, step.targetId));
        case 'regroup':
          return commitPlan(regroupWindow(state, step.windowId, step.target, eye()));
        case 'group':
          return commitPlan(groupWindows(state, step.windowIds, step.group, eye()));
      }
    },
    poseOf(id) {
      const scene = workspace.getPresented();
      const camera = scene.cameras.get(CAMERA_ID);
      if (camera === undefined) {
        throw new Error(`no camera "${CAMERA_ID}"`);
      }
      return poseOf(scene, id, camera.position);
    },
    spatial(command, args) {
      const result = router.dispatch({
        kind: 'command',
        command,
        args: { ...args },
        deviceId: 'reference.controls',
        timestamp: view.performance.now(),
      });
      const outcome = result.operation?.outcome;
      if (outcome === undefined || !('status' in outcome)) {
        throw new Error(`${command} did not run: ${String(result.reason)}`);
      }
      return outcome;
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
    saveFile:
      options.saveFile ??
      ((name, text) => {
        download(document, name, text);
      }),
    async dispose() {
      for (const stop of looks) {
        stop();
      }
      scenarios.dispose();
      unwatchChallenge();
      document.removeEventListener('pointerdown', acted, { capture: true });
      document.removeEventListener('keydown', acted, { capture: true });
      challenge.dispose();
      stopPersistence();
      workspaces.dispose();
      inputs.clear();
      search.dispose();
      transitions.dispose();
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

  // The workspace saved last comes back (UX-016), unless the address names a scene; a saved
  // workspace that cannot be restored is reported, and the configured scene is loaded instead.
  let restored: RestoreOutcome | null = null;
  if (config.restore) {
    restored = await workspaces.restoreLast();
  }
  if (restored?.status !== 'restored') {
    const loaded = loadPreset(config.preset, config.seed);
    if (loaded.status !== 'committed') {
      await app.dispose();
      throw new Error(`the ${config.preset} preset could not be loaded: ${JSON.stringify(loaded)}`);
    }
  }
  followPersistence();
  return app;
}
