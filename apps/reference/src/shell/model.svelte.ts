import { worldMatrix } from '@swf/core';
import type { FrameMetrics, Representation } from '@swf/presentation';
import type { AppStatus, ReferenceApp, ReferenceAppOptions } from '../app.js';
import { createReferenceApp, VIEWPORT_ID } from '../app.js';
import type { AppCommandId, AppCommandSpecs } from '../commands.js';
import { APP_COMMAND_NAMES } from '../commands.js';
import type { AppConfig } from '../config.js';
import { ConfigError } from '../config.js';
import type { Messages } from '../messages.js';
import type { PolicyStatus } from '../policies.js';
import type { NamedWorkspace, SnapshotPreview, WorkspacesStatus } from '../workspaces.js';
import { WorkspaceRefusal } from '../workspaces.js';

/** A replacement of the workspace waiting for the operator to confirm it (FR-201, UX-016). */
export type PendingReplace =
  | {
      readonly kind: 'import';
      readonly fileName: string;
      readonly text: string;
      readonly preview: SnapshotPreview;
    }
  | { readonly kind: 'open'; readonly name: string; readonly preview: SnapshotPreview };

/** A window removed from the workspace, said until dismissed or undone (UX-011). */
export interface Removal {
  readonly id: string;
  readonly label: string;
  /** The transaction that removed it: undo is offered while it is the last undoable one. */
  readonly transactionId: string;
}

/** What the workspaces view says after an action. */
export type WorkspaceNote =
  | { readonly kind: 'saved'; readonly name: string }
  | { readonly kind: 'opened'; readonly name: string }
  | { readonly kind: 'deleted-all' }
  | { readonly kind: 'problem'; readonly text: string };

/** What the shell passes the application besides its root, its configuration and its messages. */
export type ShellAppOptions = Omit<ReferenceAppOptions, 'root' | 'config' | 'messages'>;

/**
 * The thin binding between the application and the shell's view: the application's state as
 * reactive values the shell reads, and its commands as the one way the shell changes anything.
 * Nothing of the UI framework reaches the application or the framework's packages.
 */

/** The selected window, as the inspector shows it. */
export interface SelectedWindow {
  readonly id: string;
  readonly label: string | null;
  readonly content: 'note' | 'tile' | null;
  /** Degrees to the right of straight ahead. */
  readonly heading: number;
  /** Degrees above the horizon. */
  readonly elevation: number;
  /** World units from the camera. */
  readonly distance: number;
  readonly presentation: 'live' | 'proxy';
  /** How the view represents it (by semantic depth), or null while it is not shown. */
  readonly representation: Representation | null;
}

/** A command that was refused, as the shell says it. */
export interface Refusal {
  readonly command: AppCommandId;
  readonly field: string;
  readonly message: string;
}

/** A window, as the command list offers it. */
export interface WindowEntry {
  readonly id: string;
  readonly label: string;
}

const DEGREES = 180 / Math.PI;

/** The commands the scene view runs: their refusals are said there, the rest over the centre. */
const SCENE_COMMANDS: readonly AppCommandId[] = Object.freeze([
  'reference.preset.load',
  'reference.scene.reset',
  'reference.scene.reseed',
]);

/** The commands the features view runs: their refusals are said there, by their field. */
const FEATURE_COMMANDS: readonly AppCommandId[] = Object.freeze([
  'reference.feature.set',
  'reference.feature.reset',
  'reference.feature.combine',
  'reference.snap.configure',
  'reference.depth.configure',
  'reference.navigation.set',
  'reference.orbit.designate',
  'reference.orbit.turn',
]);

/** The commands the workspaces view runs: their refusals are said there. */
const WORKSPACE_COMMANDS: readonly AppCommandId[] = Object.freeze([
  'reference.workspace.save',
  'reference.workspace.open',
  'reference.workspace.delete',
  'reference.workspace.deleteAll',
  'reference.workspace.export',
  'reference.workspace.import',
]);

/** The commands the inspector runs: their refusals are said there. */
const INSPECTOR_COMMANDS: readonly AppCommandId[] = Object.freeze([
  'reference.window.remove',
  'reference.surface.detach',
  'reference.surface.move',
  'reference.window.merge',
  'reference.window.regroup',
]);

export class ShellModel {
  /** What the application shows, once it has started. */
  status = $state<AppStatus | null>(null);
  selected = $state<SelectedWindow | null>(null);
  frame = $state<FrameMetrics | null>(null);
  fallbacks = $state(0);
  /** The last command refused, until the next one runs. */
  refusal = $state<Refusal | null>(null);
  /** Why the application could not start: the address named something invalid, or it failed. */
  startProblem = $state<string | null>(null);
  /** The scene's revision, read again on every commit: what views of the scene follow. */
  revision = $state(0);
  /** Rises whenever the search's query or results change. */
  searchVersion = $state(0);
  /** Rises each time a window is asked to be inspected: the shell opens the inspector. */
  inspections = $state(0);
  /** The optional policies: which are on, their settings, the gesture running and the last one. */
  policies = $state<PolicyStatus | null>(null);
  /** Whether there is something to undo and to redo. */
  history = $state({ undo: false, redo: false });
  /** The window the map was last asked to show, and how many times it has been asked. */
  mapRequest = $state<{ readonly id: string; readonly count: number } | null>(null);
  /** How saving stands. */
  workspaces = $state<WorkspacesStatus | null>(null);
  /** The named workspaces, read again after every change to them. */
  named = $state<readonly NamedWorkspace[]>([]);
  /** A replacement waiting to be confirmed or cancelled. */
  pendingReplace = $state<PendingReplace | null>(null);
  /** The last window removed, while it can be undone. */
  removal = $state<Removal | null>(null);
  /** What the workspaces view says after its last action. */
  workspaceNote = $state<WorkspaceNote | null>(null);

  readonly messages: Messages;
  readonly #config: AppConfig | ConfigError;
  readonly #appOptions: ShellAppOptions;
  #app = $state.raw<ReferenceApp | null>(null);
  #stops: (() => void)[] = [];
  #disposed = false;
  /** The application starting, once it is asked to: a disposal waits for it, then disposes it. */
  #starting: Promise<void> | null = null;

  constructor(
    messages: Messages,
    config: AppConfig | ConfigError,
    appOptions: ShellAppOptions = {},
  ) {
    this.messages = messages;
    this.#config = config;
    this.#appOptions = appOptions;
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
    this.status = app.status();
    this.policies = app.policies.status();
    this.#readSelection();
    this.#readHistory();
    this.workspaces = app.workspaces.status();
    void this.refreshNamed();
    this.#stops.push(
      app.policies.subscribe(() => {
        this.policies = app.policies.status();
      }),
      app.workspaces.subscribe(() => {
        this.workspaces = app.workspaces.status();
      }),
      app.subscribe((status) => {
        this.status = status;
      }),
      app.workspace.subscribe((event) => {
        if (event.type === 'transaction.committed') {
          this.revision = app.workspace.getState().revision;
          this.#readSelection();
          this.#readHistory();
          // Undo would no longer bring the removed window back: a later change came first.
          if (
            this.removal !== null &&
            app.workspace.history().at(-1)?.transactionId !== this.removal.transactionId
          ) {
            this.removal = null;
          }
        }
      }),
      app.search.subscribe(() => {
        this.searchVersion += 1;
      }),
      app.presenter.subscribe((event) => {
        if (event.type === 'frame' && event.viewportId === VIEWPORT_ID) {
          this.frame = event.metrics;
          this.fallbacks = event.fallbacks.length;
          this.#readSelection();
        }
      }),
    );
  }

  /** Runs one of the application's commands; a refusal is kept to be said. */
  async run<K extends AppCommandId>(id: K, params: AppCommandSpecs[K]): Promise<boolean> {
    const app = this.#app;
    if (app === null) {
      return false;
    }
    this.refusal = null;
    const outcome = await app.commands.run(id, params);
    if (outcome.status === 'rejected') {
      this.refusal = { command: id, field: outcome.field, message: outcome.message };
      return false;
    }
    return true;
  }

  /** Whether a refusal is of a workspaces command, said in the workspaces view. */
  isWorkspaceRefusal(refusal: Refusal): boolean {
    return WORKSPACE_COMMANDS.includes(refusal.command);
  }

  /** Whether a refusal is of a command the inspector runs, said there. */
  isInspectorRefusal(refusal: Refusal): boolean {
    return INSPECTOR_COMMANDS.includes(refusal.command);
  }

  /** Reads the named workspaces again. */
  async refreshNamed(): Promise<void> {
    const app = this.#app;
    if (app !== null) {
      this.named = await app.workspaces.named();
    }
  }

  /**
   * Removes a window from the workspace (UX-011): one undoable change, said with an undo until
   * it is dismissed or something else changes.
   */
  async removeWindow(id: string): Promise<boolean> {
    const label = this.#app?.workspace.getState().nodes.get(id)?.label ?? id;
    const done = await this.run('reference.window.remove', { id });
    if (done) {
      const last = this.#app?.workspace.history().at(-1);
      this.removal = last === undefined ? null : { id, label, transactionId: last.transactionId };
    }
    return done;
  }

  /** Undoes the removal said, while it is still the last change. */
  async undoRemoval(): Promise<boolean> {
    this.removal = null;
    return this.run('reference.history.undo', {});
  }

  dismissRemoval(): void {
    this.removal = null;
  }

  /** Saves the workspace under a name, and lists the named ones again. */
  async saveAs(name: string): Promise<boolean> {
    const done = await this.run('reference.workspace.save', { name });
    this.workspaceNote = done ? { kind: 'saved', name } : null;
    await this.refreshNamed();
    return done;
  }

  async deleteNamed(name: string): Promise<boolean> {
    const done = await this.run('reference.workspace.delete', { name });
    this.workspaceNote = null;
    await this.refreshNamed();
    return done;
  }

  async deleteAll(): Promise<boolean> {
    const done = await this.run('reference.workspace.deleteAll', {});
    this.workspaceNote = done ? { kind: 'deleted-all' } : null;
    await this.refreshNamed();
    return done;
  }

  /** Reads a named workspace and asks to confirm replacing the workspace with it. */
  async beginOpen(name: string): Promise<void> {
    const app = this.#app;
    if (app === null) {
      return;
    }
    this.workspaceNote = null;
    try {
      this.pendingReplace = {
        kind: 'open',
        name,
        preview: await app.workspaces.previewNamed(name),
      };
    } catch (error) {
      this.#problem(error, 'restore.failed');
    }
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
        kind: 'import',
        fileName,
        text,
        preview: app.workspaces.previewImport(fileName, text),
      };
    } catch (error) {
      this.#problem(error, 'import.failed');
    }
  }

  /** Replaces the workspace as the pending replacement says. */
  async confirmReplace(): Promise<boolean> {
    const pending = this.pendingReplace;
    this.pendingReplace = null;
    if (pending === null) {
      return false;
    }
    const done =
      pending.kind === 'import'
        ? await this.run('reference.workspace.import', {
            fileName: pending.fileName,
            text: pending.text,
          })
        : await this.run('reference.workspace.open', { name: pending.name });
    this.workspaceNote = !done
      ? null
      : { kind: 'opened', name: pending.kind === 'import' ? pending.fileName : pending.name };
    return done;
  }

  cancelReplace(): void {
    this.pendingReplace = null;
  }

  #problem(error: unknown, message: 'import.failed' | 'restore.failed'): void {
    if (!(error instanceof WorkspaceRefusal)) {
      throw error;
    }
    this.workspaceNote = {
      kind: 'problem',
      text: this.messages.format(message, { reason: error.message }),
    };
  }

  /** Whether a refusal is of one of the scene's own commands, said where the scene is set. */
  isSceneRefusal(refusal: Refusal): boolean {
    return SCENE_COMMANDS.includes(refusal.command);
  }

  /** Whether a refusal is of a feature's command, said in the features view. */
  isFeatureRefusal(refusal: Refusal): boolean {
    return FEATURE_COMMANDS.includes(refusal.command);
  }

  /** The refusal, said in words. */
  refusalText(refusal: Refusal): string {
    return this.messages.format('error.command', {
      command: this.messages.format(APP_COMMAND_NAMES[refusal.command]),
      reason: refusal.message,
    });
  }

  /** Selects a window, as pressing it in a list or on the map does: nothing else changes. */
  async select(id: string): Promise<boolean> {
    return this.run('reference.window.inspect', { id });
  }

  /** Selects a window and opens the inspector on it. */
  async inspect(id: string): Promise<boolean> {
    const done = await this.run('reference.window.inspect', { id });
    if (done) {
      this.inspections += 1;
    }
    return done;
  }

  /** Selects a window, shows the map, and centres the map on it. */
  async showInMap(id: string): Promise<boolean> {
    const done = await this.run('reference.window.map', { id });
    if (done) {
      this.mapRequest = { id, count: (this.mapRequest?.count ?? 0) + 1 };
    }
    return done;
  }

  /** Every window, in ID order, by its label. */
  windows(): WindowEntry[] {
    const app = this.#app;
    if (app === null) {
      return [];
    }
    return [...app.workspace.getState().nodes.values()]
      .filter((node) => node.kind === 'window' && node.status === 'active')
      .map((node) => ({ id: node.id, label: node.label ?? node.id }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#starting;
    for (const stop of this.#stops.splice(0)) {
      stop();
    }
    const app = this.#app;
    this.#app = null;
    await app?.dispose();
  }

  #readHistory(): void {
    const app = this.#app;
    if (app === null) {
      return;
    }
    const undo = app.workspace.canUndo();
    const redo = app.workspace.canRedo();
    if (undo !== this.history.undo || redo !== this.history.redo) {
      this.history = { undo, redo };
    }
  }

  #readSelection(): void {
    const app = this.#app;
    if (app === null) {
      return;
    }
    const state = app.workspace.getState();
    const id = state.selection[0];
    const node = id === undefined ? undefined : state.nodes.get(id);
    if (node === undefined) {
      this.selected = null;
      return;
    }
    // Where it is in the world, whatever group it is in and however that group is turned.
    const world = worldMatrix(state.nodes, node.id);
    const [x, y, z] =
      world === undefined ? node.transform.position : [world[12], world[13], world[14]];
    const tag = node.tags.find((t) => t === 'note' || t === 'tile');
    const surfaceId = node.surfaceIds[0];
    const next: SelectedWindow = {
      id: node.id,
      label: node.label,
      content: tag ?? null,
      heading: Math.atan2(x, -z) * DEGREES,
      elevation: Math.atan2(y, Math.hypot(x, z)) * DEGREES,
      distance: Math.hypot(x, y, z),
      presentation: surfaceId === undefined ? 'proxy' : app.viewport.presentation(surfaceId),
      representation: app.policies.representationOf(node.id),
    };
    const last = this.selected;
    if (
      last?.id !== next.id ||
      last.label !== next.label ||
      last.heading !== next.heading ||
      last.elevation !== next.elevation ||
      last.distance !== next.distance ||
      last.presentation !== next.presentation ||
      last.representation !== next.representation
    ) {
      this.selected = next;
    }
  }
}
