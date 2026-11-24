import type { TxResult } from '@swf/core';
import type { ReferenceApp } from './app.js';
import type { BackendId } from './config.js';
import { BACKEND_IDS } from './config.js';
import type { FeatureId } from './features.js';
import { DEFAULT_FEATURES, FEATURE_IDS, FeatureError } from './features.js';
import { FOCUS_ID } from './focus.js';
import type { MessageId } from './messages.js';
import { ModeRefusal } from './modes.js';
import { PolicyRefusal } from './policies.js';
import type { PresetId } from './presets.js';
import { PRESET_IDS } from './presets.js';
import { seedIssue } from './random.js';

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
  'reference.backend.switch': { readonly backend: BackendId };
  'reference.window.reveal': { readonly id: string };
  'reference.focus.enter': { readonly id?: string };
  'reference.focus.exit': Readonly<Record<string, never>>;
  'reference.focus.step': { readonly direction: 'left' | 'right' };
  'reference.window.map': { readonly id: string };
  'reference.window.inspect': { readonly id: string };
  'reference.window.place': {
    readonly id: string;
    readonly x?: number;
    readonly y?: number;
    readonly z?: number;
  };
  'reference.feature.set': { readonly feature: FeatureId; readonly enabled: boolean };
  'reference.feature.reset': Readonly<Record<string, never>>;
  'reference.snap.configure': {
    readonly linear?: number;
    readonly angular?: number;
    readonly padding?: number;
  };
  'reference.depth.configure': { readonly full?: number; readonly compact?: number };
  'reference.navigation.set': { readonly target: 'camera' | 'orbit' };
  'reference.orbit.designate': { readonly id: string | null };
  'reference.orbit.turn': { readonly degrees: number };
  'reference.history.undo': Readonly<Record<string, never>>;
  'reference.history.redo': Readonly<Record<string, never>>;
  'reference.gesture.cancel': Readonly<Record<string, never>>;
}

export type AppCommandId = keyof AppCommandSpecs;

export const APP_COMMAND_NAMES: Readonly<Record<AppCommandId, MessageId>> = Object.freeze({
  'reference.preset.load': 'command.preset.load',
  'reference.scene.reset': 'command.scene.reset',
  'reference.scene.reseed': 'command.scene.reseed',
  'reference.mode.switch': 'command.mode.switch',
  'reference.backend.switch': 'command.backend.switch',
  'reference.window.reveal': 'command.window.reveal',
  'reference.focus.enter': 'command.focus.enter',
  'reference.focus.exit': 'command.focus.exit',
  'reference.focus.step': 'command.focus.step',
  'reference.window.map': 'command.window.map',
  'reference.window.inspect': 'command.window.inspect',
  'reference.window.place': 'command.window.place',
  'reference.feature.set': 'command.feature.set',
  'reference.feature.reset': 'command.feature.reset',
  'reference.snap.configure': 'command.snap.configure',
  'reference.depth.configure': 'command.depth.configure',
  'reference.navigation.set': 'command.navigation.set',
  'reference.orbit.designate': 'command.orbit.designate',
  'reference.orbit.turn': 'command.orbit.turn',
  'reference.history.undo': 'command.history.undo',
  'reference.history.redo': 'command.history.redo',
  'reference.gesture.cancel': 'command.gesture.cancel',
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
async function committed(result: TxResult): Promise<AppCommandOutcome> {
  const outcome = result.status === 'queued' ? await result.completion : result;
  return outcome.status === 'committed'
    ? DONE
    : rejected(outcome.error.path ?? 'scene', outcome.error.message);
}

/**
 * A change that a mode, a policy or the features' validation may refuse: its refusal said as the
 * command's, by its field. A change that needs no commit (it is already so) is done.
 */
async function viewChange(change: () => TxResult | null): Promise<AppCommandOutcome> {
  let result: TxResult | null;
  try {
    result = change();
  } catch (error) {
    if (
      error instanceof ModeRefusal ||
      error instanceof PolicyRefusal ||
      error instanceof FeatureError
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
      }
    } catch (error) {
      if (error instanceof PolicyRefusal) {
        return rejected(error.field, error.message);
      }
      throw error;
    }
  };
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
      const next = app().focusNeighbours()?.[direction][0];
      if (next === undefined) {
        return rejected('direction', `no window lies to the ${direction}`);
      }
      return viewChange(() => app().modes.switchTo(FOCUS_ID, { target: next.id }));
    },
    'reference.window.map': async ({ id }) => {
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
        app().router.cancel('host') > 0 ? DONE : rejected('gesture', 'no gesture is running'),
      ),
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
