import type { JsonValue, NodeRecord, SceneCommand, TxResult } from '@swf/core';
import { worldMatrix } from '@swf/core';
import { MAX_SEED, seedIssue } from '@swf/math';
import type { FeaturePatch, Navigation, NavigationStatus, WindowTraits } from '@swf/navigation';
import {
  CAMERA_ID,
  cameraHeading,
  CompositionRefusal,
  createNavigation,
  FOCUS_ID,
  freeId,
  MAP,
  nodeHeading,
  OVERVIEW,
  PANORAMA,
  poseOf,
  VIEWPORT_ID,
} from '@swf/navigation';
import { KIT_CHROME, navigationWords } from '@swf/navigation-ui';
import type { RestoreOutcome, SnapshotStore } from '@swf/persistence';
import { createWebStorageStore } from '@swf/persistence';
import type { AppCommands } from './commands.js';
import { createAppCommands } from './commands.js';
import type { AppConfig } from './config.js';
import type { DemoContent, NoteTexts } from './content.js';
import { createDemoContent, webNoteTexts } from './content.js';
import type { Messages } from './messages.js';
import { createMessages } from './messages.js';
import type { PresetId } from './presets.js';
import {
  ADDED_KEY,
  addedWindow,
  CATEGORY_KEY,
  categoryOf,
  PART_OF_KEY,
  COLOUR_KEY,
  colourName,
  colourOf,
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
import type { Workspaces } from './workspaces.js';
import { createWorkspaces, hostExtension } from './workspaces.js';
import type { Scenarios, ScenarioId, ScenarioWorld } from './scenarios.js';
import { BEHIND, createScenarios, offCamera, SCENARIOS } from './scenarios.js';
import type { Challenge, ChallengeRun, MethodId } from './challenge.js';
import { ChallengeRefusal, createChallenge } from './challenge.js';

/** The seeded scene the workspace shows: the preset and seed it was last loaded from. */
export interface SceneSource {
  readonly preset: PresetId;
  readonly seed: number;
}

/** What the shell shows of the application: navigation's status, and the scene's source. */
export interface AppStatus extends NavigationStatus {
  readonly scene: SceneSource;
}

/**
 * The reference application: the framework's navigation over the demo content, with the seeded
 * scenes, saving and named workspaces, the guided scenarios and the timed task of its own.
 */
export interface ReferenceApp extends Omit<Navigation, 'status' | 'subscribe'> {
  readonly content: DemoContent;
  readonly messages: Messages;
  readonly commands: AppCommands;
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
   * the scenario once it is committed. Throws a `FeatureError` when a feature cannot be turned on.
   */
  prepareScenario(id: ScenarioId): TxResult;
  /**
   * Starts a run of the timed task navigated by a method: shows the view the method navigates
   * in, then names a window to find. Throws {@link ChallengeRefusal} when the method's feature is
   * off or there is no window to name, a `ModeRefusal` or a `PolicyRefusal` when the view cannot
   * be shown.
   */
  startChallenge(method: MethodId): ChallengeRun;
  /** Loads the current preset from another seed: the next one unless one is given. */
  reseed(seed?: number): TxResult;
  /**
   * Adds a new window to the workspace, a blank native note straight ahead of the camera, and
   * selects it: one undoable change. Throws a `CompositionRefusal` when the workspace group it
   * goes into is gone or no longer stands at the camera.
   */
  addWindow(): TxResult;
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
 * What the demo says of its windows: a part keeps the window it came from under
 * {@link PART_OF_KEY}; the overview groups by category, arrangement orders by colour, search reads
 * both; and a window composition makes for a surface is tagged with what the surface shows and
 * given its colour and category.
 */
function demoTraits(content: DemoContent): WindowTraits {
  return Object.freeze({
    partOfKey: PART_OF_KEY,
    searchKeys: SEARCHABLE_METADATA,
    category: categoryOf,
    arrangeKey: (node: NodeRecord) => colourOf(node) ?? '',
    newWindowFor(surface: { readonly adapterTypeId: string; readonly bindingKey: string | null }) {
      const kind = contentOf(surface.adapterTypeId);
      const planned = surface.bindingKey === null ? null : content.find(surface.bindingKey);
      const metadata: Record<string, JsonValue> =
        planned === null
          ? {}
          : {
              [COLOUR_KEY]: colourName(planned.hue),
              ...(planned.detail === undefined ? {} : { [CATEGORY_KEY]: planned.detail.category }),
            };
      return { tags: kind === null ? [] : [kind], metadata };
    },
  });
}

/**
 * Starts the reference application in an element: the framework's navigation with the demo
 * content's adapters, every one registered through the framework's public API as any host would,
 * then the saved workspace or the configured scene.
 */
export async function createReferenceApp(options: ReferenceAppOptions): Promise<ReferenceApp> {
  const { root, config } = options;
  const document = root.ownerDocument;
  const view = options.window ?? document.defaultView;
  if (view === null) {
    throw new Error('the root element is not in a window');
  }
  const messages = options.messages ?? createMessages();
  /** A monotonic clock with sub-millisecond resolution. */
  const timer = () => view.performance.now();
  const content = createDemoContent(
    document,
    messages,
    options.noteTexts ?? webNoteTexts(view.localStorage),
  );
  const navigation = await createNavigation({
    root,
    id: 'reference',
    window: view,
    adapters: [content.notes, content.tiles],
    windows: demoTraits(content),
    backend: config.backend,
    chrome: KIT_CHROME,
    words: navigationWords(messages),
  });
  const { workspace, modes, policies } = navigation;

  let scene: SceneSource = { preset: config.preset, seed: config.seed };
  /** Those told when the scene source changes: the host extension that saves it. */
  const sceneWatchers = new Set<() => void>();
  const listeners = new Set<(status: AppStatus) => void>();
  let lastStatus: AppStatus | null = null;
  const status = (): AppStatus => Object.freeze({ ...navigation.status(), scene });
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
  const setScene = (next: SceneSource) => {
    scene = Object.freeze(next);
    for (const watcher of sceneWatchers) {
      watcher();
    }
    announce();
  };
  const unwatch = navigation.subscribe(() => {
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
    ...navigation,
    content,
    messages,
    commands: createAppCommands(() => app),
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
      unwatch();
      listeners.clear();
      await navigation.dispose();
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
