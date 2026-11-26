import type { PreviewResult, TxResult } from '@swf/core';
import { seedIssue } from '@swf/math';
import type { CommandResult, NavigationCommandId, NavigationCommandSpecs } from '@swf/navigation';
import { committed, createNavigationCommands, refusalOf, rejected } from '@swf/navigation';
import type { RestoreOutcome, SwitchOutcome } from '@swf/persistence';
import type { ReferenceApp } from './app.js';
import type { MessageId } from './messages.js';
import { NAVIGATION_COMMAND_NAMES } from '@swf/navigation-ui';
import type { PresetId } from './presets.js';
import { PRESET_IDS } from './presets.js';
import { WorkspaceRefusal } from './workspaces.js';
import type { ScenarioId } from './scenarios.js';
import { SCENARIO_IDS } from './scenarios.js';
import type { MethodId } from './challenge.js';
import { ChallengeRefusal, METHOD_IDS } from './challenge.js';

/**
 * The application's own commands, by stable ID: its scenes, workspaces, scenarios and the timed
 * task. With navigation's (`swf.*`) they are every command of the shell: every control and
 * keyboard binding runs one of them, so each action is reachable the same way from any of them,
 * and the command palette lists them all.
 */
export interface ReferenceCommandSpecs {
  'reference.preset.load': { readonly preset: PresetId; readonly seed?: number };
  'reference.scene.reset': Readonly<Record<string, never>>;
  'reference.scene.reseed': { readonly seed?: number };
  /** Adds a blank note window straight ahead of the camera. */
  'reference.window.add': Readonly<Record<string, never>>;
  /** Shows a space in place of the one shown, saving the one shown first. */
  'reference.space.switch': { readonly name: string };
  /**
   * Answers a switch that could not save the space shown first: `discard` switches anyway, giving
   * up its unsaved changes; otherwise the space shown stays.
   */
  'reference.space.answer': { readonly discard: boolean };
  /** Saves what is shown as a space of the operator's, and shows it from then on. */
  'reference.space.saveAs': { readonly name: string };
  /** Deletes a space of the operator's, or puts a seeded one back as it was seeded. */
  'reference.space.remove': { readonly name: string };
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

/** The message naming each command: navigation's, then the application's own. */
export const APP_COMMAND_NAMES: Readonly<Record<AppCommandId, MessageId>> = Object.freeze({
  ...NAVIGATION_COMMAND_NAMES,
  'reference.preset.load': 'command.preset.load',
  'reference.scene.reset': 'command.scene.reset',
  'reference.scene.reseed': 'command.scene.reseed',
  'reference.window.add': 'command.window.add',
  'reference.space.switch': 'command.space.switch',
  'reference.space.answer': 'command.space.answer',
  'reference.space.saveAs': 'command.space.saveAs',
  'reference.space.remove': 'command.space.remove',
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

/** A command of the application's own. */
export type ReferenceCommandId = keyof ReferenceCommandSpecs;

/** Every command of the shell, navigation's and the application's, with its parameters. */
export type AppCommandSpecs = NavigationCommandSpecs & ReferenceCommandSpecs;

/** Every command of the shell, by ID. */
export type AppCommandId = keyof AppCommandSpecs;

/** The shell's commands: navigation's and the application's own, in one list. */
export interface AppCommands {
  /** Every command's ID, in a stable order. */
  ids(): readonly AppCommandId[];
  run<K extends AppCommandId>(id: K, params: AppCommandSpecs[K]): Promise<CommandResult>;
}

const DONE: CommandResult = Object.freeze({ status: 'done' });

/**
 * A change that a mode, a policy, the capabilities' validation, composition or the timed task may
 * refuse: its refusal said as the command's, by its field.
 */
async function viewChange(change: () => TxResult | PreviewResult | null): Promise<CommandResult> {
  let result: TxResult | PreviewResult | null;
  try {
    result = change();
  } catch (error) {
    const refusal =
      error instanceof ChallengeRefusal
        ? { field: error.field, message: error.message }
        : refusalOf(error);
    if (refusal !== null) {
      return rejected(refusal.field, refusal.message);
    }
    throw error;
  }
  return result === null ? DONE : committed(result);
}

type Handlers = {
  readonly [K in ReferenceCommandId]: (params: ReferenceCommandSpecs[K]) => Promise<CommandResult>;
};

/** What a store or a snapshot refused, said as the command's refusal by its field. */
async function stored(work: () => Promise<unknown>): Promise<CommandResult> {
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
function restoredOutcome(outcome: RestoreOutcome) {
  return outcome.status === 'restored'
    ? DONE
    : rejected(outcome.error.path ?? 'snapshot', outcome.error.message);
}

/**
 * How a switch ended, as the command's outcome: done once the space is shown, or when the switch
 * waits for the operator's answer (the shell asks); rejected when the space would not open.
 */
function switchOutcome(outcome: SwitchOutcome): CommandResult {
  return outcome.status === 'failed'
    ? rejected(
        outcome.error.path ?? 'space',
        `“${outcome.name}” could not be opened: ${outcome.error.message}`,
      )
    : DONE;
}

/**
 * The shell's commands over the application, read when each runs: navigation's run by the
 * framework's navigation commands, the rest here.
 */
export function createAppCommands(app: () => ReferenceApp): AppCommands {
  const ids = Object.freeze(Object.keys(APP_COMMAND_NAMES) as AppCommandId[]);
  const navigation = createNavigationCommands(app);
  /** Why a seed cannot be used, or null when it can (or none is given). */
  const badSeed = (seed: unknown): CommandResult | null => {
    const issue = seed === undefined ? null : seedIssue(seed);
    return issue === null ? null : rejected('seed', issue);
  };
  /** Saving's refusal when the persistence capability is off: its commands go with it. */
  const saving = (): CommandResult | null =>
    app().policies.status().features.enabled.persistence
      ? null
      : rejected('feature', 'saving and opening workspaces is turned off');
  /** A command that is done at once, as every command is: its outcome, as a promise. */
  const now =
    <P>(run: (params: P) => CommandResult) =>
    (params: P): Promise<CommandResult> =>
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
    'reference.window.add': () => viewChange(() => app().addWindow()),
    'reference.space.switch': async ({ name }) => {
      const refusal = saving();
      if (refusal !== null) {
        return refusal;
      }
      try {
        return switchOutcome(await app().workspaces.switchTo(name));
      } catch (error) {
        if (error instanceof WorkspaceRefusal) {
          return rejected(error.field, error.message);
        }
        throw error;
      }
    },
    'reference.space.answer': async ({ discard }) => {
      if (typeof discard !== 'boolean') {
        return rejected('discard', 'discard must be true or false');
      }
      try {
        return switchOutcome(await app().workspaces.answer(discard));
      } catch (error) {
        if (error instanceof WorkspaceRefusal) {
          return rejected(error.field, error.message);
        }
        throw error;
      }
    },
    'reference.space.saveAs': async ({ name }) =>
      saving() ?? stored(() => app().workspaces.saveAs(name)),
    'reference.space.remove': async ({ name }) =>
      saving() ?? stored(() => app().workspaces.remove(name)),
    'reference.workspace.deleteAll': async () =>
      saving() ?? stored(() => app().workspaces.deleteAll()),
    'reference.workspace.export': async () =>
      saving() ??
      stored(async () => {
        app().saveFile(exportName(new Date()), await app().workspaces.exportText());
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
    'reference.workspace.saveNow': async () =>
      saving() ??
      stored(async () => {
        await app().workspaces.saveNow();
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
  };
  const own = (id: AppCommandId): id is ReferenceCommandId => Object.hasOwn(handlers, id);
  return Object.freeze({
    ids: () => ids,
    run<K extends AppCommandId>(id: K, params: AppCommandSpecs[K]): Promise<CommandResult> {
      if (own(id)) {
        return (handlers[id] as (p: AppCommandSpecs[K]) => Promise<CommandResult>)(params);
      }
      return navigation.run(id, params as NavigationCommandSpecs[NavigationCommandId]);
    },
  });
}

/** The name an exported workspace is offered under: the day it was exported. */
export function exportName(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `workspace-${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.json`;
}
