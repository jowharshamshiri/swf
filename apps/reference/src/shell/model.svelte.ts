import type { HostContent, Refusal } from '@swf/navigation-ui';
import { NavigationModel } from '@swf/navigation-ui';
import type { ReferenceApp, ReferenceAppOptions, SceneSource } from '../app.js';
import { createReferenceApp } from '../app.js';
import type { AppCommandSpecs } from '../commands.js';
import { APP_COMMAND_NAMES } from '../commands.js';
import type { AppConfig } from '../config.js';
import { ConfigError } from '../config.js';
import type { Messages } from '../messages.js';
import { contentOf } from '../presets.js';
import type { SpaceEntry } from '@swf/persistence';
import type { SnapshotPreview, WorkspacesStatus } from '../workspaces.js';
import { WorkspaceRefusal } from '../workspaces.js';
import type { ScenarioStatus } from '../scenarios.js';
import { ScenarioRefusal } from '../scenarios.js';
import type { ChallengeStatus } from '../challenge.js';

/** An import waiting for the operator to confirm it replaces the space shown (FR-201, UX-016). */
export interface PendingReplace {
  readonly fileName: string;
  readonly text: string;
  readonly preview: SnapshotPreview;
}

/** What the workspaces view says after an action. */
export type WorkspaceNote =
  | { readonly kind: 'saved'; readonly name: string }
  | { readonly kind: 'opened'; readonly name: string }
  | { readonly kind: 'deleted'; readonly name: string }
  | { readonly kind: 'reset'; readonly name: string }
  | { readonly kind: 'deleted-all' }
  | { readonly kind: 'problem'; readonly text: string };

/** What the shell passes the application besides its root, its configuration and its messages. */
export type ShellAppOptions = Omit<ReferenceAppOptions, 'root' | 'config' | 'messages'>;

/** Where the application's own commands' refusals are said: the view that runs each. */
const PLACES: Readonly<Record<string, string>> = Object.freeze({
  'reference.preset.load': 'scene',
  'reference.scene.reset': 'scene',
  'reference.scene.reseed': 'scene',
  'reference.space.saveAs': 'workspaces',
  'reference.space.remove': 'workspaces',
  'reference.workspace.deleteAll': 'workspaces',
  'reference.workspace.export': 'workspaces',
  'reference.workspace.import': 'workspaces',
});

/**
 * The commands of the scenarios and the timed task: their refusals are said in their view, and
 * over the panorama too, where what they show happens.
 */
const SCENARIO_COMMANDS: readonly string[] = Object.freeze([
  'reference.scenario.start',
  'reference.scenario.stop',
  'reference.challenge.start',
  'reference.challenge.cancel',
  'reference.challenge.clear',
]);

/**
 * What the demo says of its content: a note or a tile, in the application's words, and the
 * pictures it draws of each for the focus strip.
 */
function demoContent(messages: Messages, app: () => ReferenceApp | null): HostContent {
  return {
    describe: (surface) => {
      const kind = contentOf(surface.adapterTypeId);
      return kind === null ? null : messages.format(`content.${kind}`);
    },
    kind: (node) => {
      const tag = node.tags.find((t) => t === 'note' || t === 'tile');
      return tag === undefined ? null : messages.format(`content.${tag}`);
    },
    preview: (key) => app()?.content.preview(key) ?? null,
  };
}

/**
 * The shell's model: the navigation controls' model of the application's navigation, with what the
 * application's own views show (its scene, its saving and its spaces, the guided scenarios
 * and the timed task) and its own commands run through the same `run`. Nothing of the UI framework
 * reaches the application or the framework's packages.
 */
export class ShellModel extends NavigationModel<AppCommandSpecs> {
  /** The seeded scene the workspace shows, once the application has started. */
  scene = $state<SceneSource | null>(null);
  /** Why the application could not start: the address named something invalid, or it failed. */
  startProblem = $state<string | null>(null);
  /** How saving stands. */
  workspaces = $state<WorkspacesStatus | null>(null);
  /** The spaces, read again after every change of saving or of the spaces. */
  spaces = $state<readonly SpaceEntry[]>([]);
  /** An import waiting to be confirmed or cancelled. */
  pendingReplace = $state<PendingReplace | null>(null);
  /** What the workspaces view says after its last action. */
  workspaceNote = $state<WorkspaceNote | null>(null);
  /** Rises each time a scenario is started: the shell shows its steps. */
  scenarioStarts = $state(0);
  /** The guided scenario under way, and how far it has come. */
  scenario = $state<ScenarioStatus | null>(null);
  /** Why the step due could not be shown, until the next is asked for or the scenario changes. */
  scenarioProblem = $state<string | null>(null);
  /** The timed task: the run under way and the runs recorded. */
  challenge = $state<ChallengeStatus | null>(null);

  override readonly messages: Messages;
  readonly #config: AppConfig | ConfigError;
  readonly #appOptions: ShellAppOptions;
  #app = $state.raw<ReferenceApp | null>(null);
  /** The application the content's pictures are drawn by, once it has started. */
  readonly #started: { app: ReferenceApp | null };
  #stops: (() => void)[] = [];
  #disposed = false;
  /** The application starting, once it is asked to: a disposal waits for it, then disposes it. */
  #starting: Promise<void> | null = null;

  constructor(
    messages: Messages,
    config: AppConfig | ConfigError,
    appOptions: ShellAppOptions = {},
  ) {
    // The content's pictures are the application's, once it has started.
    const started: { app: ReferenceApp | null } = { app: null };
    super({ messages, content: demoContent(messages, () => started.app), places: PLACES });
    this.messages = messages;
    this.#config = config;
    this.#appOptions = appOptions;
    this.#started = started;
    if (config instanceof ConfigError) {
      this.startProblem = messages.format('error.config', {
        field: config.field,
        reason: config.reason,
      });
    }
  }

  /** The running application; null until it starts, and when it could not. */
  get app(): ReferenceApp | null {
    return this.#app;
  }

  /** Starts the application in the element the panorama's view gives it, once. */
  async start(root: HTMLElement): Promise<void> {
    if (this.#disposed || this.#starting !== null) {
      throw new Error('the application is started once, and never after the shell is disposed');
    }
    this.#starting = this.#start(root);
    await this.#starting;
  }

  async #start(root: HTMLElement): Promise<void> {
    if (this.#config instanceof ConfigError) {
      return;
    }
    let app: ReferenceApp;
    try {
      app = await createReferenceApp({
        root,
        config: this.#config,
        messages: this.messages,
        ...this.#appOptions,
      });
    } catch (error) {
      this.startProblem = this.messages.format('error.start', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.#app = app;
    this.#started.app = app;
    this.attach(app, app.commands, APP_COMMAND_NAMES);
    this.scene = app.status().scene;
    this.workspaces = app.workspaces.status();
    this.scenario = app.scenarios.status();
    this.challenge = app.challenge.status();
    void this.refreshSpaces();
    this.#stops.push(
      app.scenarios.subscribe(() => {
        this.scenario = app.scenarios.status();
        this.scenarioProblem = null;
      }),
      app.challenge.subscribe(() => {
        this.challenge = app.challenge.status();
      }),
      app.workspaces.subscribe(() => {
        this.workspaces = app.workspaces.status();
        void this.refreshSpaces();
      }),
      app.subscribe((status) => {
        this.scene = status.scene;
      }),
    );
  }

  /** What the application's own commands did, said; navigation's are said by its model. */
  protected override ran(id: string, params: unknown): void {
    switch (id) {
      case 'reference.workspace.saveNow':
        this.announce(this.messages.format('announce.saved'));
        return;
      case 'reference.scenario.start':
        this.scenarioStarts += 1;
        return;
      case 'reference.window.add':
        this.say('announce.added', this.#app?.workspace.getState().selection[0] ?? null);
        return;
      default:
        super.ran(id, params);
    }
  }

  /** Whether a refusal is of a workspaces command, said in the workspaces view. */
  isWorkspaceRefusal(refusal: Refusal): boolean {
    return this.placeOf(refusal) === 'workspaces';
  }

  /** Whether a refusal is of a scenario's or the timed task's command, said in their view. */
  isScenarioRefusal(refusal: Refusal): boolean {
    return SCENARIO_COMMANDS.includes(refusal.command);
  }

  /** Whether a refusal is of one of the scene's own commands, said where the scene is set. */
  isSceneRefusal(refusal: Refusal): boolean {
    return this.placeOf(refusal) === 'scene';
  }

  /**
   * Does the step due of the scenario under way, as the application's own controls would: runs its
   * command, or shows its window on the map. A step that cannot be shown says why.
   */
  async showStep(): Promise<boolean> {
    const app = this.#app;
    if (app === null) {
      return false;
    }
    this.scenarioProblem = null;
    let shown;
    try {
      shown = await app.scenarios.demonstration();
    } catch (error) {
      if (error instanceof ScenarioRefusal) {
        this.scenarioProblem = error.message;
        return false;
      }
      throw error;
    }
    if (shown === null) {
      return false;
    }
    switch (shown.kind) {
      case 'command': {
        const { id, params } = shown.command;
        return this.run(id, params);
      }
      case 'map':
        return this.showInMap(shown.id);
    }
  }

  /** Reads the spaces again. */
  async refreshSpaces(): Promise<void> {
    const app = this.#app;
    if (app !== null) {
      this.spaces = await app.workspaces.list();
    }
  }

  /** Shows a space in place of the one shown: one press of its tab. */
  async switchTo(name: string): Promise<boolean> {
    return this.run('reference.space.switch', { name });
  }

  /** Answers a switch that could not save the space shown first. */
  async answerSwitch(discard: boolean): Promise<boolean> {
    return this.run('reference.space.answer', { discard });
  }

  /** Saves what is shown as a space of the operator's, and lists the spaces again. */
  async saveAs(name: string): Promise<boolean> {
    const done = await this.run('reference.space.saveAs', { name });
    this.workspaceNote = done ? { kind: 'saved', name } : null;
    await this.refreshSpaces();
    return done;
  }

  /** Deletes a space of the operator's, or resets a seeded one. */
  async removeSpace(name: string, seeded: boolean): Promise<boolean> {
    const done = await this.run('reference.space.remove', { name });
    this.workspaceNote = done ? { kind: seeded ? 'reset' : 'deleted', name } : null;
    await this.refreshSpaces();
    return done;
  }

  async deleteAll(): Promise<boolean> {
    const done = await this.run('reference.workspace.deleteAll', {});
    this.workspaceNote = done ? { kind: 'deleted-all' } : null;
    await this.refreshSpaces();
    return done;
  }

  /**
   * Reads a file and asks to confirm replacing the workspace with what it holds; a file that
   * cannot be imported is said, naming its line or path, and nothing changes.
   */
  beginImport(fileName: string, text: string): void {
    const app = this.#app;
    if (app === null) {
      return;
    }
    this.workspaceNote = null;
    try {
      this.pendingReplace = {
        fileName,
        text,
        preview: app.workspaces.previewImport(fileName, text),
      };
    } catch (error) {
      this.#problem(error);
    }
  }

  /** Replaces the space shown with the pending import. */
  async confirmReplace(): Promise<boolean> {
    const pending = this.pendingReplace;
    this.pendingReplace = null;
    if (pending === null) {
      return false;
    }
    const done = await this.run('reference.workspace.import', {
      fileName: pending.fileName,
      text: pending.text,
    });
    this.workspaceNote = done ? { kind: 'opened', name: pending.fileName } : null;
    return done;
  }

  cancelReplace(): void {
    this.pendingReplace = null;
  }

  #problem(error: unknown): void {
    if (!(error instanceof WorkspaceRefusal)) {
      throw error;
    }
    this.workspaceNote = {
      kind: 'problem',
      text: this.messages.format('import.failed', { reason: error.message }),
    };
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#starting;
    for (const stop of this.#stops.splice(0)) {
      stop();
    }
    this.detach();
    const app = this.#app;
    this.#app = null;
    this.#started.app = null;
    await app?.dispose();
  }
}
