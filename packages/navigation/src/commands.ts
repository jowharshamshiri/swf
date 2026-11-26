import type { JsonValue, PreviewResult, SceneState, TxResult } from '@swf/core';
import { CompositionRefusal } from './composition.js';
import type { ExperimentId } from './experiments.js';
import { EXPERIMENT_IDS } from './experiments.js';
import type { FeatureId } from './features.js';
import { DEFAULT_FEATURES, FEATURE_IDS, FeatureError } from './features.js';
import { FOCUS_ID } from './focus.js';
import { ModeRefusal, PANORAMA } from './modes.js';
import type { BackendId, Navigation } from './navigation.js';
import { BACKEND_IDS } from './navigation.js';
import { PolicyRefusal } from './policies.js';

/**
 * Navigation's commands, by stable ID: every action of the navigation controls, so each is
 * reachable the same way from a control, a key or a host's command palette, which can list them
 * all ({@link NAVIGATION_COMMAND_IDS}). Each command's parameters are its entry here; a command
 * checks them and the scene, and says what it refused by field, never throwing for either.
 */
export interface NavigationCommandSpecs {
  /** Shows a view mode. */
  'swf.mode.switch': {
    /** The mode's ID, one registered: `panorama`, `focus` or `map` while on, `overview`. */
    readonly mode: string;
  };
  /** Leaves the view shown for the one it was opened from, or the panorama when there is none. */
  'swf.mode.back': Readonly<Record<string, never>>;
  /** Presents the viewport with a backend, handing its live content over. */
  'swf.backend.switch': {
    /** The backend: `dom` or `geometry`. */
    readonly backend: BackendId;
  };
  /** Selects and focuses a window and turns the camera to face it, in the panorama. */
  'swf.window.reveal': {
    /** The window's ID. */
    readonly id: string;
  };
  /** Shows a window in focus: the one named, or the selected one. Refused while focus is off. */
  'swf.focus.enter': {
    /** The window's ID; left out, the selected window. */
    readonly id?: string;
  };
  /** Leaves focus for the view it was entered from, putting the view back. */
  'swf.focus.exit': Readonly<Record<string, never>>;
  /** Focuses the next window round the reader that way, round the circle past the last. */
  'swf.focus.step': {
    /** Which way: `left` or `right`. */
    readonly direction: 'left' | 'right';
  };
  /** Selects a window and shows the map. Refused while the map is off. */
  'swf.window.map': {
    /** The window's ID. */
    readonly id: string;
  };
  /** Selects a window, so the inspector shows it. */
  'swf.window.inspect': {
    /** The window's ID. */
    readonly id: string;
  };
  /** Adds a window to the selection, first, or takes it out if it is in it. */
  'swf.selection.toggle': {
    /** The window's ID. */
    readonly id: string;
  };
  /** Puts a window at a world position, turning it to keep facing the camera; one undoable change. */
  'swf.window.place': {
    /** The window's ID. */
    readonly id: string;
    /** Its centre's world x, given with `z`. */
    readonly x?: number;
    /** Its centre's world height. */
    readonly y?: number;
    /** Its centre's world z, given with `x`. */
    readonly z?: number;
  };
  /**
   * Poses a window: round the camera, out from it, up, turned and sized; each left out stays as it
   * is. Refused for a locked window, or one its host does not let be moved, turned or sized so.
   */
  'swf.window.pose': {
    /** The window's ID. */
    readonly id: string;
    /** Degrees right of straight ahead. */
    readonly heading?: number;
    /** World units out from the camera across the ground, at least the router's least distance. */
    readonly reach?: number;
    /** Its centre's world height. */
    readonly y?: number;
    /** Degrees to the right it is turned from facing the camera. */
    readonly turned?: number;
    /** World units wide, at least the router's least size. */
    readonly width?: number;
    /** World units high, at least the router's least size. */
    readonly height?: number;
    /** Shown and not committed: a control being dragged. A pose without it commits. */
    readonly preview?: boolean;
  };
  /** Locks a window, or unlocks it: a locked window is not moved, turned or sized. */
  'swf.window.lock': {
    /** The window's ID. */
    readonly id: string;
    /** Locked, or not. */
    readonly locked: boolean;
  };
  /** Turns a capability on or off. */
  'swf.feature.set': {
    /** The capability. */
    readonly feature: FeatureId;
    /** On, or off. */
    readonly enabled: boolean;
  };
  /** Puts every capability and its settings back as they start. */
  'swf.feature.reset': Readonly<Record<string, never>>;
  /**
   * Applies an experiment: one capability alone, or every one, with the view set up to show it.
   * Configuration alone: no window changes.
   */
  'swf.experiment.run': {
    /** The experiment. */
    readonly experiment: ExperimentId;
  };
  /** Changes magnetic snapping's settings (`SnapSettings`); each left out stays as it is. */
  'swf.snap.configure': {
    /** World units within which an edge snaps to a neighbour's. */
    readonly linear?: number;
    /** Degrees within which a window's centre lines up with a neighbour's, or the horizon. */
    readonly angular?: number;
    /** World units of gap kept between snapped edges. */
    readonly padding?: number;
    /** Degrees between the spokes round the camera a window's heading snaps to: 0 for none. */
    readonly spoke?: number;
    /** World units within which a window's distance from the camera snaps to a ring: 0 for none. */
    readonly ring?: number;
  };
  /** Changes the distances semantic depth draws by (`DepthBands`); each left out stays. */
  'swf.depth.configure': {
    /** Nearer than this many world units from the camera, a window shows its content. */
    readonly full?: number;
    /** Nearer than this, a compact preview; farther, its label alone. */
    readonly compact?: number;
  };
  /** Sets what a background drag turns. Refused while workspace orbit is off. */
  'swf.navigation.set': {
    /** The camera, or the orbit group about it. */
    readonly target: 'camera' | 'orbit';
  };
  /** Designates the group workspace orbit turns, or none. */
  'swf.orbit.designate': {
    /** The group's ID, or null for none. */
    readonly id: string | null;
  };
  /** Turns the workspace about the camera: one undoable change. */
  'swf.orbit.turn': {
    /** Degrees to the right. */
    readonly degrees: number;
  };
  /**
   * Turns the workspace to stand this many degrees to the right of where it was placed: a preview
   * while a control is dragged (`preview`), then one undoable change.
   */
  'swf.orbit.turnTo': {
    /** Degrees to the right of where it was placed. */
    readonly degrees: number;
    /** Shown and not committed: a control being dragged. */
    readonly preview?: boolean;
  };
  /** Sets the panorama's horizontal field of view, in degrees. */
  'swf.view.fov': {
    /** Degrees, within `FIELD_OF_VIEW`. */
    readonly degrees: number;
  };
  /** Turns the camera to a heading, in degrees to the right of straight ahead. */
  'swf.view.heading': {
    /** Degrees to the right of straight ahead. */
    readonly degrees: number;
  };
  /** Arranges the windows round the camera on three rings, by what they show. */
  'swf.window.arrange': Readonly<Record<string, never>>;
  /** Puts a window straight ahead of the camera, at its distance. */
  'swf.window.bringFront': {
    /** The window's ID. */
    readonly id: string;
  };
  /** Puts a window straight behind the camera, at its distance. */
  'swf.window.sendBehind': {
    /** The window's ID. */
    readonly id: string;
  };
  /** Undoes the last undoable change. */
  'swf.history.undo': Readonly<Record<string, never>>;
  /** Redoes the last change undone. */
  'swf.history.redo': Readonly<Record<string, never>>;
  /** Cancels the gesture running, leaving what it moved where it was. */
  'swf.gesture.cancel': Readonly<Record<string, never>>;
  /** Picks a window up: its moves preview until it is put down or the gesture is cancelled. */
  'swf.gesture.grab': {
    /** The window's ID. */
    readonly id: string;
  };
  /** Puts the window held down where it is: one undoable change. */
  'swf.gesture.drop': Readonly<Record<string, never>>;
  /** Removes windows, and what they hold, as one undoable change. */
  'swf.window.remove': {
    /** The windows' IDs: at least one. */
    readonly ids: readonly string[];
  };
  /** Detaches a surface from its window into a window of its own. Refused while composition is off. */
  'swf.surface.detach': {
    /** The surface's ID. */
    readonly surfaceId: string;
  };
  /** Moves a surface into another window. Refused while composition is off. */
  'swf.surface.move': {
    /** The surface's ID. */
    readonly surfaceId: string;
    /** The window it goes into. */
    readonly windowId: string;
  };
  /** Merges a window's surfaces into another window. Refused while composition is off. */
  'swf.window.merge': {
    /** The window whose surfaces go. */
    readonly id: string;
    /** The window they go into. */
    readonly targetId: string;
  };
  /** Breaks a window into parts: each surface but its first into a window of its own. */
  'swf.window.split': {
    /** The window's ID. */
    readonly id: string;
  };
  /** Puts every part back into the window it came from, as one change. */
  'swf.window.recombine': {
    /** The window's ID: the one the parts came from, or one of them. */
    readonly id: string;
  };
  /** Into a group by its ID, or into a new group of its own named `label` when `groupId` is null. */
  'swf.window.regroup': {
    /** The window's ID. */
    readonly id: string;
    /** The group it goes into, or null for a new one. */
    readonly groupId: string | null;
    /** A new group's name. */
    readonly label?: string;
  };
  /** Gathers windows into a new group named `label`, each keeping its place: one change. */
  'swf.window.group': {
    /** The windows' IDs. */
    readonly windowIds: readonly string[];
    /** The new group's name. */
    readonly label: string;
  };
}

/** A navigation command's ID. */
export type NavigationCommandId = keyof NavigationCommandSpecs;

/** What running a command did: done, or rejected naming the field at fault and why. */
export type CommandResult =
  | {
      /** Done. */
      readonly status: 'done';
    }
  | {
      /** Rejected: nothing changed. */
      readonly status: 'rejected';
      /** The parameter or the part of the scene at fault. */
      readonly field: string;
      /** Why. */
      readonly message: string;
    };

/** Navigation's commands, run against one {@link Navigation}. */
export interface NavigationCommands {
  /** Every command's ID, in a stable order. */
  ids(): readonly NavigationCommandId[];
  /**
   * Runs a command once the scene change it makes is made (a change asked for during another one
   * waits): what it did. An unknown ID is rejected by `command`.
   */
  run<K extends NavigationCommandId>(
    id: K,
    params: NavigationCommandSpecs[K],
  ): Promise<CommandResult>;
}

const DONE: CommandResult = Object.freeze({ status: 'done' });

/** A command rejected, naming the field at fault. */
export const rejected = (field: string, message: string): CommandResult =>
  Object.freeze({ status: 'rejected', field, message });

/**
 * The outcome of a scene change as a command's, once it is made (a change asked for during
 * another one waits): done, or rejected naming the path at fault.
 */
export async function committed(result: TxResult | PreviewResult): Promise<CommandResult> {
  const outcome = result.status === 'queued' ? await result.completion : result;
  return outcome.status === 'committed' || outcome.status === 'previewed'
    ? DONE
    : rejected(outcome.error.path ?? 'scene', outcome.error.message);
}

/**
 * The field and reason of one of navigation's refusals (a mode's, a policy's, the capabilities'
 * validation or composition), or null for any other error, which is no refusal but a fault.
 */
export function refusalOf(error: unknown): {
  /** The field at fault. */
  readonly field: string;
  /** Why it was refused. */
  readonly message: string;
} | null {
  return error instanceof ModeRefusal ||
    error instanceof PolicyRefusal ||
    error instanceof FeatureError ||
    error instanceof CompositionRefusal
    ? { field: error.field, message: error.message }
    : null;
}

/**
 * A change that a mode, a policy or the capabilities' validation may refuse: its refusal said as
 * the command's, by its field. A change that needs no commit (it is already so) is done.
 */
async function viewChange(change: () => TxResult | PreviewResult | null): Promise<CommandResult> {
  let result: TxResult | PreviewResult | null;
  try {
    result = change();
  } catch (error) {
    const refusal = refusalOf(error);
    if (refusal !== null) {
      return rejected(refusal.field, refusal.message);
    }
    throw error;
  }
  return result === null ? DONE : committed(result);
}

/**
 * Several changes made one after another, each of which a mode, a policy or the capabilities'
 * validation may refuse: the first refusal said as the command's, by its field.
 */
async function viewChanges(changes: () => readonly TxResult[]): Promise<CommandResult> {
  let results: readonly TxResult[] = [];
  const made = await viewChange(() => {
    results = changes();
    return null;
  });
  if (made.status === 'rejected') {
    return made;
  }
  for (const result of results) {
    const outcome = await committed(result);
    if (outcome.status === 'rejected') {
      return outcome;
    }
  }
  return DONE;
}

/** A finite number of the given unit, or the reason it is not. */
const finite = (value: unknown, field: string, unit: string): CommandResult | null =>
  typeof value === 'number' && Number.isFinite(value)
    ? null
    : rejected(field, `${field} must be a finite number of ${unit}`);

type Handlers = {
  readonly [K in NavigationCommandId]: (
    params: NavigationCommandSpecs[K],
  ) => Promise<CommandResult>;
};

/** The first `group-<n>` no node or surface holds: the ID of a group made by a command. */
function newGroupId(state: SceneState): string {
  let n = 1;
  while (state.nodes.has(`group-${String(n)}`) || state.surfaces.has(`group-${String(n)}`)) {
    n += 1;
  }
  return `group-${String(n)}`;
}

/** Every navigation command's ID, in a stable order: the order a command list shows them in. */
export const NAVIGATION_COMMAND_IDS: readonly NavigationCommandId[] = Object.freeze([
  'swf.mode.switch',
  'swf.mode.back',
  'swf.backend.switch',
  'swf.window.reveal',
  'swf.focus.enter',
  'swf.focus.exit',
  'swf.focus.step',
  'swf.window.map',
  'swf.window.inspect',
  'swf.selection.toggle',
  'swf.window.place',
  'swf.window.pose',
  'swf.window.lock',
  'swf.feature.set',
  'swf.feature.reset',
  'swf.experiment.run',
  'swf.snap.configure',
  'swf.depth.configure',
  'swf.navigation.set',
  'swf.orbit.designate',
  'swf.orbit.turn',
  'swf.orbit.turnTo',
  'swf.view.fov',
  'swf.view.heading',
  'swf.window.arrange',
  'swf.window.bringFront',
  'swf.window.sendBehind',
  'swf.history.undo',
  'swf.history.redo',
  'swf.gesture.cancel',
  'swf.gesture.grab',
  'swf.gesture.drop',
  'swf.window.remove',
  'swf.surface.detach',
  'swf.surface.move',
  'swf.window.merge',
  'swf.window.split',
  'swf.window.recombine',
  'swf.window.regroup',
  'swf.window.group',
]);

/**
 * Navigation's commands over a navigation, read when each runs (so the commands can be made
 * before the navigation they act on is).
 */
export function createNavigationCommands(navigation: () => Navigation): NavigationCommands {
  const isWindow = (id: unknown): boolean =>
    typeof id === 'string' && navigation().workspace.getState().nodes.get(id)?.kind === 'window';
  /** Turns the workspace by degrees to the right, as the named command does. */
  const turnWorkspace = (degrees: number): CommandResult => {
    const bad = finite(degrees, 'degrees', 'degrees');
    if (bad !== null) {
      return bad;
    }
    try {
      const outcome = navigation().policies.turnWorkspace(degrees);
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
  /** A capability's refusal when it is off: its commands are taken out with it. */
  const off = (feature: FeatureId, what: string): CommandResult | null =>
    navigation().policies.status().features.enabled[feature]
      ? null
      : rejected('feature', `${what} is turned off`);
  /** What a spatial command of the framework did, said as the command's outcome. */
  const spatial = (command: string, args: Readonly<Record<string, JsonValue>>) => {
    const outcome = navigation().spatial(command, args);
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
  ): CommandResult | null => {
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
  const around = (id: string, side: 'front' | 'behind'): Promise<CommandResult> => {
    if (!isWindow(id)) {
      return Promise.resolve(rejected('id', `no window "${id}"`));
    }
    try {
      return committed(navigation().placeAround(id, side));
    } catch (error) {
      if (error instanceof RangeError) {
        return Promise.resolve(rejected('id', error.message));
      }
      throw error;
    }
  };
  /** A command that is done at once, as every command is: its outcome, as a promise. */
  const now =
    <P>(run: (params: P) => CommandResult) =>
    (params: P): Promise<CommandResult> =>
      Promise.resolve(run(params));
  const handlers: Handlers = {
    'swf.mode.switch': async ({ mode }) => {
      if (
        !navigation()
          .modes.list()
          .some((m) => m.id === mode)
      ) {
        return rejected('mode', `no mode "${mode}" is registered`);
      }
      return viewChange(() => navigation().modes.switchTo(mode));
    },
    'swf.mode.back': async () => {
      const modes = navigation().modes;
      if (modes.current() === PANORAMA.id) {
        return rejected('mode', 'the panorama is shown already');
      }
      return viewChange(() =>
        modes.enteredFrom() === null ? modes.switchTo(PANORAMA.id) : modes.back(),
      );
    },
    'swf.backend.switch': async ({ backend }) => {
      if (!(BACKEND_IDS as readonly string[]).includes(backend)) {
        return rejected('backend', `a backend must be one of ${BACKEND_IDS.join(', ')}`);
      }
      const outcome = await navigation().switchBackend(backend);
      return outcome.status === 'switched' ? DONE : rejected('backend', outcome.error.message);
    },
    'swf.window.reveal': async ({ id }) => {
      if (navigation().workspace.getState().nodes.get(id)?.kind !== 'window') {
        return rejected('id', `no window "${id}"`);
      }
      return committed(navigation().revealWindow(id));
    },
    'swf.focus.enter': async ({ id }) => {
      const focusOff = off('focus', 'focus');
      if (focusOff !== null) {
        return focusOff;
      }
      if (id !== undefined && !isWindow(id)) {
        return rejected('id', `no window "${id}"`);
      }
      return viewChange(() =>
        navigation().modes.switchTo(FOCUS_ID, id === undefined ? {} : { target: id }),
      );
    },
    'swf.focus.exit': async () => {
      if (navigation().modes.current() !== FOCUS_ID) {
        return rejected('mode', 'no window is in focus');
      }
      return viewChange(() => navigation().modes.back());
    },
    'swf.focus.step': async ({ direction }) => {
      if (!(['left', 'right'] as readonly string[]).includes(direction)) {
        return rejected('direction', 'a direction must be left or right');
      }
      // Round the circle: past the last window that way, the farthest the other way is next.
      const around = navigation().focusNeighbours();
      const next =
        around === null
          ? undefined
          : (around[direction][0] ?? around[direction === 'left' ? 'right' : 'left'].at(-1));
      if (next === undefined) {
        return rejected('direction', 'no other window to focus');
      }
      return viewChange(() => navigation().modes.switchTo(FOCUS_ID, { target: next.id }));
    },
    'swf.window.map': async ({ id }) => {
      const mapOff = off('map', 'the map');
      if (mapOff !== null) {
        return mapOff;
      }
      if (!isWindow(id)) {
        return rejected('id', `no window "${id}"`);
      }
      return committed(navigation().showInMap(id));
    },
    'swf.window.inspect': async ({ id }) => {
      if (!isWindow(id)) {
        return rejected('id', `no window "${id}"`);
      }
      return committed(
        navigation().workspace.dispatch({ type: 'selection.set', ids: [id] }, { source: 'user' }),
      );
    },
    'swf.selection.toggle': async ({ id }) => {
      if (!isWindow(id)) {
        return rejected('id', `no window "${id}"`);
      }
      const selection = navigation().workspace.getState().selection;
      const ids = selection.includes(id)
        ? selection.filter((other) => other !== id)
        : [id, ...selection];
      return committed(
        navigation().workspace.dispatch({ type: 'selection.set', ids }, { source: 'user' }),
      );
    },
    'swf.window.place': async ({ id, x, y, z }) => {
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
      return committed(navigation().placeWindow(id, { x, y, z }));
    },
    'swf.window.pose': async ({ id, heading, reach, y, turned, width, height, preview }) => {
      const pose = isWindow(id) ? navigation().poseOf(id) : null;
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
      const { minDistance, minSize } = navigation().router.settings();
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
        navigation().poseWindow(
          id,
          { heading, reach, y, turned, width, height },
          { preview: preview ?? false },
        ),
      );
    },
    'swf.window.lock': async ({ id, locked }) => {
      if (!isWindow(id)) {
        return rejected('id', `no window "${id}"`);
      }
      const asked: unknown = locked;
      if (typeof asked !== 'boolean') {
        return rejected('locked', 'locked must be true or false');
      }
      return committed(
        navigation().workspace.dispatch(
          { type: 'node.patch', id, flags: { locked } },
          { source: 'user' },
        ),
      );
    },
    'swf.feature.set': async ({ feature, enabled }) => {
      if (!(FEATURE_IDS as readonly string[]).includes(feature)) {
        return rejected('feature', `a feature must be one of ${FEATURE_IDS.join(', ')}`);
      }
      return viewChange(() => {
        navigation().policies.configure({ enabled: { [feature]: enabled } });
        return null;
      });
    },
    'swf.feature.reset': async () =>
      viewChange(() => {
        navigation().policies.configure(DEFAULT_FEATURES);
        return null;
      }),
    'swf.experiment.run': async ({ experiment }) => {
      if (!(EXPERIMENT_IDS as readonly string[]).includes(experiment)) {
        return rejected('experiment', `an experiment is one of ${EXPERIMENT_IDS.join(', ')}`);
      }
      return viewChanges(() => navigation().applyExperiment(experiment));
    },
    'swf.snap.configure': async (snap) =>
      viewChange(() => {
        navigation().policies.configure({ snap });
        return null;
      }),
    'swf.depth.configure': async (depth) =>
      viewChange(() => {
        navigation().policies.configure({ depth });
        return null;
      }),
    'swf.navigation.set': async ({ target }) => {
      const asked: unknown = target;
      if (asked !== 'camera' && asked !== 'orbit') {
        return rejected('target', 'a background drag turns the camera or the orbit group');
      }
      return viewChange(() => navigation().policies.navigate(target));
    },
    'swf.orbit.designate': async ({ id }) => {
      if (id !== null && typeof id !== 'string') {
        return rejected('id', 'the orbit group is named by its ID, or none by null');
      }
      return viewChange(() => navigation().policies.designate(id));
    },
    'swf.orbit.turn': ({ degrees }) => Promise.resolve(turnWorkspace(degrees)),
    'swf.orbit.turnTo': async ({ degrees, preview }) => {
      const asked: unknown = preview;
      if (asked !== undefined && typeof asked !== 'boolean') {
        return rejected('preview', 'preview must be true or false');
      }
      return viewChange(() =>
        navigation().policies.turnWorkspaceTo(degrees, { preview: preview ?? false }),
      );
    },
    'swf.view.fov': async ({ degrees }) =>
      viewChange(() => navigation().modes.fieldOfView(degrees)),
    'swf.view.heading': async ({ degrees }) =>
      finite(degrees, 'degrees', 'degrees') ?? committed(navigation().turnCamera(degrees)),
    'swf.window.arrange': async () => {
      const result = navigation().arrangeWindows();
      return result === null
        ? rejected('windows', 'there is no window to arrange: each is locked or inside another')
        : committed(result);
    },
    'swf.window.bringFront': async ({ id }) => around(id, 'front'),
    'swf.window.sendBehind': async ({ id }) => around(id, 'behind'),
    'swf.history.undo': async () => {
      const workspace = navigation().workspace;
      return workspace.canUndo()
        ? committed(workspace.undo({ source: 'user' }))
        : rejected('history', 'there is nothing to undo');
    },
    'swf.history.redo': async () => {
      const workspace = navigation().workspace;
      return workspace.canRedo()
        ? committed(workspace.redo({ source: 'user' }))
        : rejected('history', 'there is nothing to redo');
    },
    'swf.gesture.cancel': () =>
      Promise.resolve(
        navigation().policies.cancelGesture() ? DONE : rejected('gesture', 'no gesture is running'),
      ),
    'swf.gesture.grab': now(({ id }) => {
      if (!isWindow(id)) {
        return rejected('id', `no window "${id}"`);
      }
      return spatial('gesture.grab', { nodeId: id, viewportId: navigation().viewport.viewportId });
    }),
    'swf.gesture.drop': now(() => {
      if (navigation().policies.status().gesture?.operation !== 'gesture.grab') {
        return rejected('gesture', 'no window is held');
      }
      const outcome = navigation().spatial('gesture.drop', {});
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
    'swf.window.remove': async ({ ids }) => {
      const asked: unknown = ids;
      if (!Array.isArray(asked) || asked.length === 0) {
        return rejected('ids', 'name at least one window to remove');
      }
      const missing: unknown = (asked as unknown[]).find((id) => !isWindow(id));
      if (missing !== undefined) {
        return rejected('ids', `no window ${JSON.stringify(missing)}`);
      }
      return committed(navigation().removeWindows(ids));
    },
    'swf.surface.detach': async ({ surfaceId }) =>
      viewChange(() => navigation().compose({ kind: 'detach', surfaceId })),
    'swf.surface.move': async ({ surfaceId, windowId }) =>
      viewChange(() => navigation().compose({ kind: 'move', surfaceId, windowId })),
    'swf.window.merge': async ({ id, targetId }) =>
      viewChange(() => navigation().compose({ kind: 'merge', windowId: id, targetId })),
    'swf.window.split': async ({ id }) =>
      viewChange(() => navigation().compose({ kind: 'split', windowId: id })),
    'swf.window.recombine': async ({ id }) =>
      viewChange(() => navigation().compose({ kind: 'recombine', windowId: id })),
    'swf.window.regroup': async ({ id, groupId, label }) => {
      if (groupId !== null && typeof groupId !== 'string') {
        return rejected('groupId', 'a group is named by its ID, or a new one by null');
      }
      const state = navigation().workspace.getState();
      const name = label?.trim() ?? '';
      if (groupId === null && name === '') {
        return rejected('label', 'a new group needs a name');
      }
      return viewChange(() =>
        navigation().compose({
          kind: 'regroup',
          windowId: id,
          target:
            groupId === null
              ? { kind: 'new', id: newGroupId(state), label: name }
              : { kind: 'group', id: groupId },
        }),
      );
    },
    'swf.window.group': async ({ windowIds, label }) => {
      const asked: unknown = windowIds;
      if (!Array.isArray(asked)) {
        return rejected('windowIds', 'the windows to group are a list of their IDs');
      }
      const named: unknown = label;
      const name = typeof named === 'string' ? named.trim() : '';
      if (name === '') {
        return rejected('label', 'a new group needs a name');
      }
      const state = navigation().workspace.getState();
      return viewChange(() =>
        navigation().compose({
          kind: 'group',
          windowIds: asked as readonly string[],
          group: { id: newGroupId(state), label: name },
        }),
      );
    },
  };
  return Object.freeze({
    ids: () => NAVIGATION_COMMAND_IDS,
    run<K extends NavigationCommandId>(
      id: K,
      params: NavigationCommandSpecs[K],
    ): Promise<CommandResult> {
      if (!Object.hasOwn(handlers, id)) {
        return Promise.resolve(rejected('command', `no command "${id}"`));
      }
      return (handlers[id] as (p: NavigationCommandSpecs[K]) => Promise<CommandResult>)(params);
    },
  });
}
