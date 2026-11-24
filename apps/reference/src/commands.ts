import type { TxResult } from '@swf/core';
import type { ReferenceApp } from './app.js';
import type { BackendId } from './config.js';
import { BACKEND_IDS } from './config.js';
import type { MessageId } from './messages.js';
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
}

export type AppCommandId = keyof AppCommandSpecs;

export const APP_COMMAND_NAMES: Readonly<Record<AppCommandId, MessageId>> = Object.freeze({
  'reference.preset.load': 'command.preset.load',
  'reference.scene.reset': 'command.scene.reset',
  'reference.scene.reseed': 'command.scene.reseed',
  'reference.mode.switch': 'command.mode.switch',
  'reference.backend.switch': 'command.backend.switch',
  'reference.window.reveal': 'command.window.reveal',
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

type Handlers = {
  readonly [K in AppCommandId]: (params: AppCommandSpecs[K]) => Promise<AppCommandOutcome>;
};

export function createAppCommands(app: () => ReferenceApp): AppCommands {
  const ids = Object.freeze(Object.keys(APP_COMMAND_NAMES) as AppCommandId[]);
  /** Why a seed cannot be used, or null when it can (or none is given). */
  const badSeed = (seed: unknown): AppCommandOutcome | null => {
    const issue = seed === undefined ? null : seedIssue(seed);
    return issue === null ? null : rejected('seed', issue);
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
      return committed(app().modes.switchTo(mode));
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
