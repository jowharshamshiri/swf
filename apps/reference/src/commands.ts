import type { JsonValue, PreviewResult, SceneState, TxResult } from '@swf/core';
import type { ReferenceApp } from './app.js';
import type { BackendId } from './config.js';
import { BACKEND_IDS } from './config.js';
import { CompositionRefusal } from './composition.js';
import type { FeatureId } from './features.js';
import { ALL_ENABLED, DEFAULT_FEATURES, FEATURE_IDS, FeatureError } from './features.js';
import { FOCUS_ID } from './focus.js';
import type { MessageId } from './messages.js';
import { ModeRefusal, PANORAMA } from './modes.js';
import { PolicyRefusal } from './policies.js';
import type { PresetId } from './presets.js';
import { PRESET_IDS } from './presets.js';
import { seedIssue } from '@swf/math';
import { WorkspaceRefusal } from './workspaces.js';
import type { ScenarioId } from './scenarios.js';
import { SCENARIO_IDS } from './scenarios.js';
import type { MethodId } from './challenge.js';
import { ChallengeRefusal, METHOD_IDS } from './challenge.js';

/**
 * The application's own commands, by stable ID, each with the message that names it. Every
 * control and keyboard binding of the shell runs one of these, so each action is reachable the
 * same way from any of them, and a command palette can list them all.
 */
export interface AppCommandSpecs {
  'reference.preset.load': { readonly preset: PresetId; readonly seed?: number };
  'reference.scene.reset': Readonly<Record<string, never>>;
  'reference.scene.reseed': { readonly seed?: number };
  'reference.mode.switch': { readonly mode: string };
  /** Leaves the view shown for the one it was opened from, or the panorama when there is none. */
  'reference.mode.back': Readonly<Record<string, never>>;
  'reference.backend.switch': { readonly backend: BackendId };
  'reference.window.reveal': { readonly id: string };
  'reference.focus.enter': { readonly id?: string };
  'reference.focus.exit': Readonly<Record<string, never>>;
  'reference.focus.step': { readonly direction: 'left' | 'right' };
  'reference.window.map': { readonly id: string };
  'reference.window.inspect': { readonly id: string };
  /** Adds a window to the selection, first, or takes it out if it is in it. */
  'reference.selection.toggle': { readonly id: string };
  'reference.window.place': {
    readonly id: string;
    readonly x?: number;
    readonly y?: number;
    readonly z?: number;
  };
  /**
   * Poses a window: round the camera (`heading`, degrees right of straight ahead), out from it
   * across the ground (`reach`, world units), up (`y`, its centre's world height), turned from
   * facing the camera (`turned`, degrees to the right) and sized (`width`, `height`, world units);
   * each left out stays as it is. With `preview`, it is shown and not committed.
   */
  'reference.window.pose': {
    readonly id: string;
    readonly heading?: number;
    readonly reach?: number;
    readonly y?: number;
    readonly turned?: number;
    readonly width?: number;
    readonly height?: number;
    readonly preview?: boolean;
  };
  'reference.window.lock': { readonly id: string; readonly locked: boolean };
  'reference.feature.set': { readonly feature: FeatureId; readonly enabled: boolean };
  'reference.feature.reset': Readonly<Record<string, never>>;
  'reference.feature.combine': Readonly<Record<string, never>>;
  'reference.snap.configure': {
    readonly linear?: number;
    readonly angular?: number;
    readonly padding?: number;
    readonly spoke?: number;
    readonly ring?: number;
  };
  'reference.depth.configure': { readonly full?: number; readonly compact?: number };
  'reference.navigation.set': { readonly target: 'camera' | 'orbit' };
  'reference.orbit.designate': { readonly id: string | null };
  'reference.orbit.turn': { readonly degrees: number };
  /**
   * Turns the workspace to stand this many degrees to the right of where it was placed: a preview
   * while a control is dragged (`preview`), then one undoable change.
   */
  'reference.orbit.turnTo': { readonly degrees: number; readonly preview?: boolean };
  /** Sets the panorama's horizontal field of view, in degrees. */
  'reference.view.fov': { readonly degrees: number };
  /** Turns the camera to a heading, in degrees to the right of straight ahead. */
  'reference.view.heading': { readonly degrees: number };
  /** Arranges the windows round the camera on three rings, by what they show. */
  'reference.window.arrange': Readonly<Record<string, never>>;
  /** Puts a window straight ahead of the camera, at its distance. */
  'reference.window.bringFront': { readonly id: string };
  /** Puts a window straight behind the camera, at its distance. */
  'reference.window.sendBehind': { readonly id: string };
  'reference.history.undo': Readonly<Record<string, never>>;
  'reference.history.redo': Readonly<Record<string, never>>;
  'reference.gesture.cancel': Readonly<Record<string, never>>;
  /** Picks a window up: its moves preview until it is put down or the gesture is cancelled. */
  'reference.gesture.grab': { readonly id: string };
  'reference.gesture.drop': Readonly<Record<string, never>>;
  /** Removes windows, and what they hold, as one undoable change. */
  'reference.window.remove': { readonly ids: readonly string[] };
  /** Adds a blank note window straight ahead of the camera. */
  'reference.window.add': Readonly<Record<string, never>>;
  'reference.surface.detach': { readonly surfaceId: string };
  'reference.surface.move': { readonly surfaceId: string; readonly windowId: string };
  'reference.window.merge': { readonly id: string; readonly targetId: string };
  /** Breaks a window into parts: each surface but its first into a window of its own. */
  'reference.window.split': { readonly id: string };
  /** Puts every part back into the window it came from, as one change. */
  'reference.window.recombine': { readonly id: string };
  /** Into a group by its ID, or into a new group of its own named `label` when `groupId` is null. */
  'reference.window.regroup': {
    readonly id: string;
    readonly groupId: string | null;
    readonly label?: string;
  };
  /** Gathers windows into a new group named `label`, each keeping its place: one change. */
  'reference.window.group': { readonly windowIds: readonly string[]; readonly label: string };
  'reference.workspace.save': { readonly name: string };
  'reference.workspace.open': { readonly name: string };
  'reference.workspace.delete': { readonly name: string };
  'reference.workspace.deleteAll': Readonly<Record<string, never>>;
  'reference.workspace.export': Readonly<Record<string, never>>;
  'reference.workspace.import': { readonly fileName: string; readonly text: string };
  /** Saves the workspace as it is now, without waiting for the save that follows a change. */
  'reference.workspace.saveNow': Readonly<Record<string, never>>;
  /** Starts a guided scenario from the studio as it is planned. */
  'reference.scenario.start': { readonly scenario: ScenarioId };
  'reference.scenario.stop': Readonly<Record<string, never>>;
  /** Starts a run of the timed window-finding task, navigated by a method. */
  'reference.challenge.start': { readonly method: MethodId };
  'reference.challenge.cancel': Readonly<Record<string, never>>;
  'reference.challenge.clear': Readonly<Record<string, never>>;
}

export type AppCommandId = keyof AppCommandSpecs;

export const APP_COMMAND_NAMES: Readonly<Record<AppCommandId, MessageId>> = Object.freeze({
  'reference.preset.load': 'command.preset.load',
  'reference.scene.reset': 'command.scene.reset',
  'reference.scene.reseed': 'command.scene.reseed',
  'reference.mode.switch': 'command.mode.switch',
  'reference.mode.back': 'command.mode.back',
  'reference.backend.switch': 'command.backend.switch',
  'reference.window.reveal': 'command.window.reveal',
  'reference.focus.enter': 'command.focus.enter',
  'reference.focus.exit': 'command.focus.exit',
  'reference.focus.step': 'command.focus.step',
  'reference.window.map': 'command.window.map',
  'reference.window.inspect': 'command.window.inspect',
  'reference.selection.toggle': 'command.selection.toggle',
  'reference.window.place': 'command.window.place',
  'reference.window.pose': 'command.window.pose',
  'reference.window.lock': 'command.window.lock',
  'reference.feature.set': 'command.feature.set',
  'reference.feature.reset': 'command.feature.reset',
  'reference.feature.combine': 'command.feature.combine',
  'reference.snap.configure': 'command.snap.configure',
  'reference.depth.configure': 'command.depth.configure',
  'reference.navigation.set': 'command.navigation.set',
  'reference.orbit.designate': 'command.orbit.designate',
  'reference.orbit.turn': 'command.orbit.turn',
  'reference.orbit.turnTo': 'command.orbit.turnTo',
  'reference.view.fov': 'command.view.fov',
  'reference.view.heading': 'command.view.heading',
  'reference.window.arrange': 'command.window.arrange',
  'reference.window.bringFront': 'command.window.bringFront',
  'reference.window.sendBehind': 'command.window.sendBehind',
  'reference.history.undo': 'command.history.undo',
  'reference.history.redo': 'command.history.redo',
  'reference.gesture.cancel': 'command.gesture.cancel',
  'reference.gesture.grab': 'command.gesture.grab',
  'reference.gesture.drop': 'command.gesture.drop',
  'reference.window.remove': 'command.window.remove',
  'reference.window.add': 'command.window.add',
  'reference.surface.detach': 'command.surface.detach',
  'reference.surface.move': 'command.surface.move',
  'reference.window.merge': 'command.window.merge',
  'reference.window.split': 'command.window.split',
  'reference.window.recombine': 'command.window.recombine',
  'reference.window.regroup': 'command.window.regroup',
  'reference.window.group': 'command.window.group',
  'reference.workspace.save': 'command.workspace.save',
  'reference.workspace.open': 'command.workspace.open',
  'reference.workspace.delete': 'command.workspace.delete',
  'reference.workspace.deleteAll': 'command.workspace.deleteAll',
  'reference.workspace.export': 'command.workspace.export',
  'reference.workspace.import': 'command.workspace.import',
  'reference.workspace.saveNow': 'command.workspace.saveNow',
  'reference.scenario.start': 'command.scenario.start',
  'reference.scenario.stop': 'command.scenario.stop',
  'reference.challenge.start': 'command.challenge.start',
  'reference.challenge.cancel': 'command.challenge.cancel',
  'reference.challenge.clear': 'command.challenge.clear',
});

/** What running a command did. */
export type AppCommandOutcome =
  | { readonly status: 'done' }
  | { readonly status: 'rejected'; readonly field: string; readonly message: string };

export interface AppCommands {
  /** Every command's ID, in a stable order. */
  ids(): readonly AppCommandId[];
  run<K extends AppCommandId>(id: K, params: AppCommandSpecs[K]): Promise<AppCommandOutcome>;
}

const DONE: AppCommandOutcome = Object.freeze({ status: 'done' });

const rejected = (field: string, message: string): AppCommandOutcome =>
  Object.freeze({ status: 'rejected', field, message });

/** The outcome of a scene change, once it is made (a change asked for during another one waits). */
async function committed(result: TxResult | PreviewResult): Promise<AppCommandOutcome> {
  const outcome = result.status === 'queued' ? await result.completion : result;
  return outcome.status === 'committed' || outcome.status === 'previewed'
    ? DONE
    : rejected(outcome.error.path ?? 'scene', outcome.error.message);
}

/**
 * A change that a mode, a policy or the features' validation may refuse: its refusal said as the
 * command's, by its field. A change that needs no commit (it is already so) is done.
 */
async function viewChange(
  change: () => TxResult | PreviewResult | null,
): Promise<AppCommandOutcome> {
  let result: TxResult | PreviewResult | null;
  try {
    result = change();
  } catch (error) {
    if (
      error instanceof ModeRefusal ||
      error instanceof PolicyRefusal ||
      error instanceof FeatureError ||
      error instanceof CompositionRefusal ||
      error instanceof ChallengeRefusal
    ) {
      return rejected(error.field, error.message);
    }
    throw error;
  }
  return result === null ? DONE : committed(result);
}

/** A finite number of the given unit, or the reason it is not. */
const finite = (value: unknown, field: string, unit: string): AppCommandOutcome | null =>
  typeof value === 'number' && Number.isFinite(value)
    ? null
    : rejected(field, `${field} must be a finite number of ${unit}`);

type Handlers = {
  readonly [K in AppCommandId]: (params: AppCommandSpecs[K]) => Promise<AppCommandOutcome>;
};

/** What a store or a snapshot refused, said as the command's refusal by its field. */
async function stored(work: () => Promise<unknown>): Promise<AppCommandOutcome> {
  try {
    await work();
    return DONE;
  } catch (error) {
    if (error instanceof WorkspaceRefusal) {
      return rejected(error.field, error.message);
    }
    throw error;
  }
}

/** A restore's outcome: done, or rejected naming where the snapshot is at fault. */
function restoredOutcome(outcome: Awaited<ReturnType<ReferenceApp['workspaces']['openNamed']>>) {
  return outcome.status === 'restored'
    ? DONE
    : rejected(outcome.error.path ?? 'snapshot', outcome.error.message);
}

/** The first `group-<n>` no node or surface holds: the ID of a group made by a command. */
function newGroupId(state: SceneState): string {
  let n = 1;
  while (state.nodes.has(`group-${String(n)}`) || state.surfaces.has(`group-${String(n)}`)) {
    n += 1;
  }
  return `group-${String(n)}`;
}

export function createAppCommands(app: () => ReferenceApp): AppCommands {
  const ids = Object.freeze(Object.keys(APP_COMMAND_NAMES) as AppCommandId[]);
  const isWindow = (id: unknown): boolean =>
    typeof id === 'string' && app().workspace.getState().nodes.get(id)?.kind === 'window';
  /** Why a seed cannot be used, or null when it can (or none is given). */
  const badSeed = (seed: unknown): AppCommandOutcome | null => {
    const issue = seed === undefined ? null : seedIssue(seed);
    return issue === null ? null : rejected('seed', issue);
  };
  /** Turns the workspace by degrees to the right, as the named command does. */
  const turnWorkspace = (degrees: number): AppCommandOutcome => {
    const bad = finite(degrees, 'degrees', 'degrees');
    if (bad !== null) {
      return bad;
    }
    try {
      const outcome = app().policies.turnWorkspace(degrees);
      switch (outcome.status) {
        case 'committed':
          return DONE;
        case 'rejected':
          return rejected(outcome.error.path ?? 'orbit', outcome.error.message);
        case 'unchanged':
          return rejected('orbit', outcome.reason);
        case 'cancelled':
          return rejected('orbit', 'the turn was cancelled');
        case 'previewed':
          throw new Error('turning the workspace previewed instead of committing');
      }
    } catch (error) {
      if (error instanceof PolicyRefusal) {
        return rejected(error.field, error.message);
      }
      throw error;
    }
  };
  /** A feature's refusal when it is off: its commands are taken out with it. */
  const off = (feature: FeatureId, what: string): AppCommandOutcome | null =>
    app().policies.status().features.enabled[feature]
      ? null
      : rejected('feature', `${what} is turned off`);
  const saving = () => off('persistence', 'saving and opening workspaces');
  /** What a spatial command of the framework did, said as the command's outcome. */
  const spatial = (command: string, args: Readonly<Record<string, JsonValue>>) => {
    const outcome = app().spatial(command, args);
    switch (outcome.status) {
      case 'committed':
      case 'previewed':
        return DONE;
      case 'rejected':
        return rejected(outcome.error.path ?? 'scene', outcome.error.message);
      case 'unchanged':
        return rejected('id', outcome.reason);
      case 'cancelled':
        throw new Error(`${command} cancelled gestures instead of acting on a window`);
    }
  };
  /** Each value given a finite number, or the refusal naming the first that is not. */
  const numbers = (
    values: readonly (readonly [string, unknown])[],
    unit: string,
  ): AppCommandOutcome | null => {
    for (const [field, value] of values) {
      if (value !== undefined) {
        const bad = finite(value, field, unit);
        if (bad !== null) {
          return bad;
        }
      }
    }
    return null;
  };
  /** Puts a window straight ahead of the camera or behind it, or says why it cannot. */
  const around = (id: string, side: 'front' | 'behind'): Promise<AppCommandOutcome> => {
    if (!isWindow(id)) {
      return Promise.resolve(rejected('id', `no window "${id}"`));
    }
    try {
      return committed(app().placeAround(id, side));
    } catch (error) {
      if (error instanceof RangeError) {
        return Promise.resolve(rejected('id', error.message));
      }
      throw error;
    }
  };
  /** A command that is done at once, as every command is: its outcome, as a promise. */
  const now =
    <P>(run: (params: P) => AppCommandOutcome) =>
    (params: P): Promise<AppCommandOutcome> =>
      Promise.resolve(run(params));
  const handlers: Handlers = {
    'reference.preset.load': async ({ preset, seed }) => {
      if (!(PRESET_IDS as readonly string[]).includes(preset)) {
        return rejected('preset', `a preset must be one of ${PRESET_IDS.join(', ')}`);
      }
      return badSeed(seed) ?? committed(app().loadPreset(preset, seed));
    },
    'reference.scene.reset': () => committed(app().reset()),
    'reference.scene.reseed': async ({ seed }) => badSeed(seed) ?? committed(app().reseed(seed)),
    'reference.mode.switch': async ({ mode }) => {
      if (
        !app()
          .modes.list()
          .some((m) => m.id === mode)
      ) {
        return rejected('mode', `no mode "${mode}" is registered`);
      }
      return viewChange(() => app().modes.switchTo(mode));
    },
    'reference.mode.back': async () => {
      const modes = app().modes;
      if (modes.current() === PANORAMA.id) {
        return rejected('mode', 'the panorama is shown already');
      }
      return viewChange(() =>
        modes.enteredFrom() === null ? modes.switchTo(PANORAMA.id) : modes.back(),
      );
    },
    'reference.backend.switch': async ({ backend }) => {
      if (!(BACKEND_IDS as readonly string[]).includes(backend)) {
        return rejected('backend', `a backend must be one of ${BACKEND_IDS.join(', ')}`);
      }
      const outcome = await app().switchBackend(backend);
      return outcome.status === 'switched' ? DONE : rejected('backend', outcome.error.message);
    },
    'reference.window.reveal': async ({ id }) => {
      if (app().workspace.getState().nodes.get(id)?.kind !== 'window') {
        return rejected('id', `no window "${id}"`);
      }
      return committed(app().revealWindow(id));
    },
    'reference.focus.enter': async ({ id }) => {
      const focusOff = off('focus', 'focus');
      if (focusOff !== null) {
        return focusOff;
      }
      if (id !== undefined && !isWindow(id)) {
        return rejected('id', `no window "${id}"`);
      }
      return viewChange(() =>
        app().modes.switchTo(FOCUS_ID, id === undefined ? {} : { target: id }),
      );
    },
    'reference.focus.exit': async () => {
      if (app().modes.current() !== FOCUS_ID) {
        return rejected('mode', 'no window is in focus');
      }
      return viewChange(() => app().modes.back());
    },
    'reference.focus.step': async ({ direction }) => {
      if (!(['left', 'right'] as readonly string[]).includes(direction)) {
        return rejected('direction', 'a direction must be left or right');
      }
      // Round the circle: past the last window that way, the farthest the other way is next.
      const around = app().focusNeighbours();
      const next =
        around === null
          ? undefined
          : (around[direction][0] ?? around[direction === 'left' ? 'right' : 'left'].at(-1));
      if (next === undefined) {
        return rejected('direction', 'no other window to focus');
      }
      return viewChange(() => app().modes.switchTo(FOCUS_ID, { target: next.id }));
    },
    'reference.window.map': async ({ id }) => {
      const mapOff = off('map', 'the map');
      if (mapOff !== null) {
        return mapOff;
      }
      if (!isWindow(id)) {
        return rejected('id', `no window "${id}"`);
      }
      return committed(app().showInMap(id));
    },
    'reference.window.inspect': async ({ id }) => {
      if (!isWindow(id)) {
        return rejected('id', `no window "${id}"`);
      }
      return committed(
        app().workspace.dispatch({ type: 'selection.set', ids: [id] }, { source: 'user' }),
      );
    },
    'reference.selection.toggle': async ({ id }) => {
      if (!isWindow(id)) {
        return rejected('id', `no window "${id}"`);
      }
      const selection = app().workspace.getState().selection;
      const ids = selection.includes(id)
        ? selection.filter((other) => other !== id)
        : [id, ...selection];
      return committed(
        app().workspace.dispatch({ type: 'selection.set', ids }, { source: 'user' }),
      );
    },
    'reference.window.place': async ({ id, x, y, z }) => {
      if (!isWindow(id)) {
        return rejected('id', `no window "${id}"`);
      }
      for (const [field, value] of [
        ['x', x],
        ['y', y],
        ['z', z],
      ] as const) {
        if (value !== undefined && !(typeof value === 'number' && Number.isFinite(value))) {
          return rejected(field, `${field} must be a finite number of world units`);
        }
      }
      if ((x === undefined) !== (z === undefined)) {
        return rejected(x === undefined ? 'x' : 'z', 'a place on the ground needs both x and z');
      }
      return committed(app().placeWindow(id, { x, y, z }));
    },
    'reference.window.pose': async ({ id, heading, reach, y, turned, width, height, preview }) => {
      const pose = isWindow(id) ? app().poseOf(id) : null;
      if (pose === null) {
        return rejected('id', `no window "${id}"`);
      }
      const asked: unknown = preview;
      if (asked !== undefined && typeof asked !== 'boolean') {
        return rejected('preview', 'preview must be true or false');
      }
      const bad =
        numbers(
          [
            ['heading', heading],
            ['turned', turned],
          ],
          'degrees',
        ) ??
        numbers(
          [
            ['reach', reach],
            ['y', y],
            ['width', width],
            ['height', height],
          ],
          'world units',
        );
      if (bad !== null) {
        return bad;
      }
      const placing = heading !== undefined || reach !== undefined || y !== undefined;
      const sizing = width !== undefined || height !== undefined;
      if (!placing && !sizing && turned === undefined) {
        return rejected('pose', 'a pose sets heading, reach, y, turned, width or height');
      }
      if (pose.locked) {
        return rejected('id', `window "${id}" is locked: unlock it to move, turn or size it`);
      }
      const refusedBy =
        placing && !pose.movable
          ? 'moved'
          : turned !== undefined && !pose.rotatable
            ? 'turned'
            : sizing && !pose.resizable
              ? 'resized'
              : null;
      if (refusedBy !== null) {
        return rejected('id', `the host of window "${id}" does not let it be ${refusedBy}`);
      }
      const { minDistance, minSize } = app().router.settings();
      if (reach !== undefined && reach < minDistance) {
        return rejected('reach', `reach must be at least ${String(minDistance)} world units`);
      }
      for (const [field, value] of [
        ['width', width],
        ['height', height],
      ] as const) {
        if (value !== undefined && value < minSize) {
          return rejected(field, `${field} must be at least ${String(minSize)} world units`);
        }
      }
      return committed(
        app().poseWindow(
          id,
          { heading, reach, y, turned, width, height },
          { preview: preview ?? false },
        ),
      );
    },
    'reference.window.lock': async ({ id, locked }) => {
      if (!isWindow(id)) {
        return rejected('id', `no window "${id}"`);
      }
      const asked: unknown = locked;
      if (typeof asked !== 'boolean') {
        return rejected('locked', 'locked must be true or false');
      }
      return committed(
        app().workspace.dispatch({ type: 'node.patch', id, flags: { locked } }, { source: 'user' }),
      );
    },
    'reference.feature.set': async ({ feature, enabled }) => {
      if (!(FEATURE_IDS as readonly string[]).includes(feature)) {
        return rejected('feature', `a feature must be one of ${FEATURE_IDS.join(', ')}`);
      }
      return viewChange(() => {
        app().policies.configure({ enabled: { [feature]: enabled } });
        return null;
      });
    },
    'reference.feature.reset': async () =>
      viewChange(() => {
        app().policies.configure(DEFAULT_FEATURES);
        return null;
      }),
    'reference.feature.combine': async () =>
      viewChange(() => {
        app().policies.configure({ enabled: ALL_ENABLED });
        return null;
      }),
    'reference.snap.configure': async (snap) =>
      viewChange(() => {
        app().policies.configure({ snap });
        return null;
      }),
    'reference.depth.configure': async (depth) =>
      viewChange(() => {
        app().policies.configure({ depth });
        return null;
      }),
    'reference.navigation.set': async ({ target }) => {
      const asked: unknown = target;
      if (asked !== 'camera' && asked !== 'orbit') {
        return rejected('target', 'a background drag turns the camera or the orbit group');
      }
      return viewChange(() => app().policies.navigate(target));
    },
    'reference.orbit.designate': async ({ id }) => {
      if (id !== null && typeof id !== 'string') {
        return rejected('id', 'the orbit group is named by its ID, or none by null');
      }
      return viewChange(() => app().policies.designate(id));
    },
    'reference.orbit.turn': ({ degrees }) => Promise.resolve(turnWorkspace(degrees)),
    'reference.orbit.turnTo': async ({ degrees, preview }) => {
      const asked: unknown = preview;
      if (asked !== undefined && typeof asked !== 'boolean') {
        return rejected('preview', 'preview must be true or false');
      }
      return viewChange(() =>
        app().policies.turnWorkspaceTo(degrees, { preview: preview ?? false }),
      );
    },
    'reference.view.fov': async ({ degrees }) => viewChange(() => app().modes.fieldOfView(degrees)),
    'reference.view.heading': async ({ degrees }) =>
      finite(degrees, 'degrees', 'degrees') ?? committed(app().turnCamera(degrees)),
    'reference.window.arrange': async () => {
      const result = app().arrangeWindows();
      return result === null
        ? rejected('windows', 'there is no window to arrange: each is locked or inside another')
        : committed(result);
    },
    'reference.window.bringFront': async ({ id }) => around(id, 'front'),
    'reference.window.sendBehind': async ({ id }) => around(id, 'behind'),
    'reference.history.undo': async () => {
      const workspace = app().workspace;
      return workspace.canUndo()
        ? committed(workspace.undo({ source: 'user' }))
        : rejected('history', 'there is nothing to undo');
    },
    'reference.history.redo': async () => {
      const workspace = app().workspace;
      return workspace.canRedo()
        ? committed(workspace.redo({ source: 'user' }))
        : rejected('history', 'there is nothing to redo');
    },
    'reference.gesture.cancel': () =>
      Promise.resolve(
        app().policies.cancelGesture() ? DONE : rejected('gesture', 'no gesture is running'),
      ),
    'reference.gesture.grab': now(({ id }) => {
      if (!isWindow(id)) {
        return rejected('id', `no window "${id}"`);
      }
      return spatial('gesture.grab', { nodeId: id, viewportId: app().viewport.viewportId });
    }),
    'reference.gesture.drop': now(() => {
      if (app().policies.status().gesture?.operation !== 'gesture.grab') {
        return rejected('gesture', 'no window is held');
      }
      const outcome = app().spatial('gesture.drop', {});
      switch (outcome.status) {
        // Put down where it was picked up, it changes nothing: done all the same.
        case 'committed':
        case 'unchanged':
          return DONE;
        case 'rejected':
          return rejected(outcome.error.path ?? 'scene', outcome.error.message);
        case 'previewed':
        case 'cancelled':
          throw new Error(`putting a window down ${outcome.status} instead`);
      }
    }),
    'reference.window.add': () => viewChange(() => app().addWindow()),
    'reference.window.remove': async ({ ids }) => {
      const asked: unknown = ids;
      if (!Array.isArray(asked) || asked.length === 0) {
        return rejected('ids', 'name at least one window to remove');
      }
      const missing: unknown = (asked as unknown[]).find((id) => !isWindow(id));
      if (missing !== undefined) {
        return rejected('ids', `no window ${JSON.stringify(missing)}`);
      }
      return committed(app().removeWindows(ids));
    },
    'reference.surface.detach': async ({ surfaceId }) =>
      viewChange(() => app().compose({ kind: 'detach', surfaceId })),
    'reference.surface.move': async ({ surfaceId, windowId }) =>
      viewChange(() => app().compose({ kind: 'move', surfaceId, windowId })),
    'reference.window.split': async ({ id }) =>
      viewChange(() => app().compose({ kind: 'split', windowId: id })),
    'reference.window.recombine': async ({ id }) =>
      viewChange(() => app().compose({ kind: 'recombine', windowId: id })),
    'reference.window.merge': async ({ id, targetId }) =>
      viewChange(() => app().compose({ kind: 'merge', windowId: id, targetId })),
    'reference.window.regroup': async ({ id, groupId, label }) => {
      if (groupId !== null && typeof groupId !== 'string') {
        return rejected('groupId', 'a group is named by its ID, or a new one by null');
      }
      const state = app().workspace.getState();
      const name = label?.trim() ?? '';
      if (groupId === null && name === '') {
        return rejected('label', 'a new group needs a name');
      }
      return viewChange(() =>
        app().compose({
          kind: 'regroup',
          windowId: id,
          target:
            groupId === null
              ? { kind: 'new', id: newGroupId(state), label: name }
              : { kind: 'group', id: groupId },
        }),
      );
    },
    'reference.window.group': async ({ windowIds, label }) => {
      const asked: unknown = windowIds;
      if (!Array.isArray(asked)) {
        return rejected('windowIds', 'the windows to group are a list of their IDs');
      }
      const named: unknown = label;
      const name = typeof named === 'string' ? named.trim() : '';
      if (name === '') {
        return rejected('label', 'a new group needs a name');
      }
      const state = app().workspace.getState();
      return viewChange(() =>
        app().compose({
          kind: 'group',
          windowIds: asked as readonly string[],
          group: { id: newGroupId(state), label: name },
        }),
      );
    },
    'reference.workspace.save': async ({ name }) =>
      saving() ?? stored(() => app().workspaces.saveAs(name)),
    'reference.workspace.open': async ({ name }) => {
      const refusal = saving();
      if (refusal !== null) {
        return refusal;
      }
      try {
        return restoredOutcome(await app().workspaces.openNamed(name));
      } catch (error) {
        if (error instanceof WorkspaceRefusal) {
          return rejected(error.field, error.message);
        }
        throw error;
      }
    },
    'reference.workspace.delete': async ({ name }) =>
      saving() ?? stored(() => app().workspaces.deleteNamed(name)),
    'reference.workspace.deleteAll': async () =>
      saving() ?? stored(() => app().workspaces.deleteAll()),
    'reference.workspace.export': async () =>
      saving() ??
      stored(async () => {
        app().saveFile(exportName(new Date()), await app().workspaces.exportText());
      }),
    'reference.scenario.start': async ({ scenario }) => {
      if (!(SCENARIO_IDS as readonly string[]).includes(scenario)) {
        return rejected('scenario', `a scenario is one of ${SCENARIO_IDS.join(', ')}`);
      }
      const prepared = await viewChange(() => app().prepareScenario(scenario));
      if (prepared.status === 'done') {
        app().scenarios.start(scenario);
      }
      return prepared;
    },
    'reference.scenario.stop': now(() => {
      if (app().scenarios.status() === null) {
        return rejected('scenario', 'no scenario is under way');
      }
      app().scenarios.stop();
      return DONE;
    }),
    'reference.challenge.start': async ({ method }) => {
      if (!(METHOD_IDS as readonly string[]).includes(method)) {
        return rejected('method', `a method is one of ${METHOD_IDS.join(', ')}`);
      }
      return viewChange(() => {
        app().startChallenge(method);
        return null;
      });
    },
    'reference.challenge.cancel': now(() => {
      if (app().challenge.status().run === null) {
        return rejected('run', 'no run is under way');
      }
      app().challenge.cancel();
      return DONE;
    }),
    'reference.challenge.clear': now(() => {
      app().challenge.clear();
      return DONE;
    }),
    'reference.workspace.saveNow': async () =>
      saving() ??
      stored(async () => {
        await app().workspaces.saveNow();
      }),
    'reference.workspace.import': async ({ fileName, text }) => {
      const refusal = saving();
      if (refusal !== null) {
        return refusal;
      }
      try {
        return restoredOutcome(await app().workspaces.importText(fileName, text));
      } catch (error) {
        if (error instanceof WorkspaceRefusal) {
          return rejected(error.field, error.message);
        }
        throw error;
      }
    },
  };
  return Object.freeze({
    ids: () => ids,
    run<K extends AppCommandId>(id: K, params: AppCommandSpecs[K]): Promise<AppCommandOutcome> {
      if (!Object.hasOwn(handlers, id)) {
        return Promise.resolve(rejected('command', `no command "${id}"`));
      }
      return (handlers[id] as (p: AppCommandSpecs[K]) => Promise<AppCommandOutcome>)(params);
    },
  });
}

/** The name an exported workspace is offered under: the day it was exported. */
export function exportName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `workspace-${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.json`;
}
