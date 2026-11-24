import type { FrameMetrics } from '@swf/presentation';
import type { AppStatus, ReferenceApp } from '../app.js';
import { createReferenceApp, VIEWPORT_ID } from '../app.js';
import type { AppCommandId, AppCommandSpecs } from '../commands.js';
import { APP_COMMAND_NAMES } from '../commands.js';
import type { AppConfig } from '../config.js';
import { ConfigError } from '../config.js';
import type { Messages } from '../messages.js';

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

  readonly messages: Messages;
  readonly #config: AppConfig | ConfigError;
  #app = $state.raw<ReferenceApp | null>(null);
  #stops: (() => void)[] = [];
  #disposed = false;
  /** The application starting, once it is asked to: a disposal waits for it, then disposes it. */
  #starting: Promise<void> | null = null;

  constructor(messages: Messages, config: AppConfig | ConfigError) {
    this.messages = messages;
    this.#config = config;
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

  /**
   * Presents the workspace in the element the panorama's view gives it: the first starts the
   * application, and each later one (the view shown elsewhere, or again) moves it there.
   */
  async present(root: HTMLElement): Promise<void> {
    if (this.#disposed) {
      return;
    }
    if (this.#starting === null) {
      this.#starting = this.#start(root);
      await this.#starting;
      return;
    }
    await this.#starting;
    await this.#app?.rehome(root);
  }

  async #start(root: HTMLElement): Promise<void> {
    if (this.#config instanceof ConfigError) {
      return;
    }
    let app: ReferenceApp;
    try {
      app = await createReferenceApp({ root, config: this.#config, messages: this.messages });
    } catch (error) {
      this.startProblem = this.messages.format('error.start', {
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.#app = app;
    this.status = app.status();
    this.#readSelection();
    this.#stops.push(
      app.subscribe((status) => {
        this.status = status;
      }),
      app.workspace.subscribe((event) => {
        if (event.type === 'transaction.committed') {
          this.#readSelection();
        }
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

  /** The refusal, said in words. */
  refusalText(refusal: Refusal): string {
    return this.messages.format('error.command', {
      command: this.messages.format(APP_COMMAND_NAMES[refusal.command]),
      reason: refusal.message,
    });
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
    const [x, y, z] = node.transform.position;
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
    };
    const last = this.selected;
    if (
      last?.id !== next.id ||
      last.label !== next.label ||
      last.heading !== next.heading ||
      last.elevation !== next.elevation ||
      last.distance !== next.distance ||
      last.presentation !== next.presentation
    ) {
      this.selected = next;
    }
  }
}
