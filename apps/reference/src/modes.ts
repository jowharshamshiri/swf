import type {
  Id,
  ProjectionSetting,
  SceneCommand,
  TxResult,
  WorkspaceMutator,
  WorkspaceReader,
} from '@swf/core';
import type { MessageId } from './messages.js';
import type { ModeMachine, ModeTraits, ViewSettings } from './mode-machine.js';
import { initialMode, observedMode, transition } from './mode-machine.js';

/**
 * View modes. Every mode shows the same scene: switching one only changes the viewport's view
 * settings (its mode and projection, and the camera when a mode turns it to face what it
 * presents), never a window's or surface's record, so whatever a mode places on screen is derived
 * and never becomes a world transform. The viewport's record is the truth of which mode is active;
 * a mode may run hooks of its own while it is.
 */
export interface ViewMode {
  /** A stable ID, stored as the viewport's mode. */
  readonly id: string;
  readonly name: MessageId;
  /** The projection the viewport shows this mode with. */
  readonly projection: ProjectionSetting;
  /** Leaving the mode by any route puts the camera back as it was when the mode was entered. */
  readonly restoresView?: boolean;
  /**
   * The view commands entering the mode adds after the viewport's mode and projection, worked out
   * from the scene as it is: a camera turn, a projection fitted to what it presents. Throws
   * {@link ModeRefusal} when the mode cannot be entered now.
   */
  enter?(context: EnterContext): readonly SceneCommand[];
  /** Starts what the mode does while active; the returned function stops it. */
  activate?(context: ModeContext): () => void;
}

export interface ModeContext {
  readonly viewportId: Id;
  readonly workspace: WorkspaceReader & WorkspaceMutator;
  /** Leaves the mode for the view it was entered from, as the system: when what it shows is gone. */
  readonly back: () => void;
}

export interface EnterContext {
  readonly viewportId: Id;
  readonly workspace: WorkspaceReader;
  /** The entity the mode is asked to present, when the request names one. */
  readonly target: Id | null;
}

/** A mode that cannot be entered or left as asked, and why, naming the field at fault. */
export class ModeRefusal extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ModeRefusal';
    this.field = field;
  }
}

export interface SwitchOptions {
  /** The entity the mode presents (the window a focus is on). */
  readonly target?: Id;
}

export interface Modes {
  /** Registers a mode; the returned function unregisters it (never the active one). */
  register(mode: ViewMode): () => void;
  /** The registered modes, in registration order. */
  list(): readonly ViewMode[];
  /** The viewport's mode, as its record says. */
  current(): string;
  /** The view the active mode was entered from, or null when there is none to go back to. */
  enteredFrom(): ViewSettings | null;
  /**
   * Switches the viewport to a registered mode at once, as one view-state commit. Throws
   * {@link ModeRefusal} when the mode cannot be entered now.
   */
  switchTo(id: string, options?: SwitchOptions): TxResult;
  /**
   * Leaves the active mode for the view it was entered from (its mode, projection and, for a mode
   * that turned it, camera), as one view-state commit. Throws {@link ModeRefusal} when there is
   * none.
   */
  back(options?: { readonly source?: 'user' | 'system' }): TxResult;
  dispose(): void;
}

export const PANORAMA: ViewMode = Object.freeze({
  id: 'panorama',
  name: 'mode.panorama',
  projection: Object.freeze({
    id: 'equirectangular/1',
    config: Object.freeze({ horizontal: 360, vertical: 120 }),
  }),
});

/** The top-down map: drawn beside the whole panorama, which keeps showing every window. */
export const MAP: ViewMode = Object.freeze({
  id: 'map',
  name: 'mode.map',
  projection: PANORAMA.projection,
});

/** The tiled overview: every window as a tile, beside the whole panorama. */
export const OVERVIEW: ViewMode = Object.freeze({
  id: 'overview',
  name: 'mode.overview',
  projection: PANORAMA.projection,
});

export function createModes(workspace: WorkspaceReader & WorkspaceMutator, viewportId: Id): Modes {
  const modes = new Map<string, ViewMode>();
  let active: { readonly id: string; readonly stop: () => void } | null = null;

  const viewport = () => {
    const record = workspace.getState().viewports.get(viewportId);
    if (record === undefined) {
      throw new Error(`viewport "${viewportId}" does not exist`);
    }
    return record;
  };
  const recorded = (): string => viewport().mode;
  let machine: ModeMachine = initialMode(recorded());

  const view = (): ViewSettings => {
    const record = viewport();
    const camera = workspace.getState().cameras.get(record.cameraId);
    if (camera === undefined) {
      throw new Error(`viewport "${viewportId}" has no camera "${record.cameraId}"`);
    }
    return { mode: record.mode, projection: record.projection, camera: camera.rotation };
  };
  const traits = (id: string): ModeTraits => ({
    restoresView: modes.get(id)?.restoresView === true,
  });

  /** Runs the hooks of the mode the viewport records, stopping the previous mode's. */
  const follow = () => {
    const id = recorded();
    machine = observedMode(machine, id);
    if (active?.id === id) {
      return;
    }
    active?.stop();
    active = null;
    const mode = modes.get(id);
    if (mode !== undefined) {
      const stop =
        mode.activate?.({
          viewportId,
          workspace,
          back: () => {
            if (machine.from !== null) {
              api.back({ source: 'system' });
            }
          },
        }) ?? (() => undefined);
      active = { id, stop };
    }
  };

  const unsubscribe = workspace.subscribe((event) => {
    if (event.type === 'transaction.committed') {
      follow();
    }
  });

  /** Commits a transition: the camera put back, the mode and projection, then what entering adds. */
  const commit = (
    event: Parameters<typeof transition>[1],
    options: SwitchOptions & { readonly source?: 'user' | 'system' },
  ): TxResult => {
    const next = transition(machine, event, view(), traits);
    if (next.kind === 'refused') {
      throw new ModeRefusal('mode', next.reason);
    }
    const mode = modes.get(next.mode);
    if (mode === undefined) {
      throw new ModeRefusal('mode', `mode "${next.mode}" is not registered`);
    }
    const { cameraId } = viewport();
    const commands: SceneCommand[] = [];
    if (next.camera !== null) {
      commands.push({ type: 'camera.patch', id: cameraId, rotation: next.camera });
    }
    commands.push({
      type: 'viewport.patch',
      id: viewportId,
      mode: mode.id,
      projection: next.projection ?? mode.projection,
    });
    if (event.kind === 'switch' && mode.enter !== undefined) {
      commands.push(...mode.enter({ viewportId, workspace, target: options.target ?? null }));
    }
    const result = workspace.transaction(commands, { source: options.source ?? 'user' });
    const settle = (status: string) => {
      if (status === 'committed') {
        machine = next.machine;
      }
    };
    if (result.status === 'queued') {
      void result.completion.then((outcome) => {
        settle(outcome.status);
      });
    } else {
      settle(result.status);
    }
    return result;
  };

  const api: Modes = Object.freeze({
    register(mode: ViewMode) {
      if (modes.has(mode.id)) {
        throw new Error(`mode "${mode.id}" is already registered`);
      }
      modes.set(mode.id, mode);
      follow();
      return () => {
        if (active?.id === mode.id) {
          throw new Error(`mode "${mode.id}" is active and cannot be unregistered`);
        }
        modes.delete(mode.id);
      };
    },
    list: () => [...modes.values()],
    current: recorded,
    enteredFrom: () => (machine.mode === recorded() ? machine.from : null),
    switchTo(id: string, options: SwitchOptions = {}): TxResult {
      if (!modes.has(id)) {
        throw new Error(`mode "${id}" is not registered`);
      }
      return commit({ kind: 'switch', to: id }, options);
    },
    back(options: { readonly source?: 'user' | 'system' } = {}): TxResult {
      return commit({ kind: 'back' }, options);
    },
    dispose() {
      unsubscribe();
      active?.stop();
      active = null;
    },
  });
  return api;
}
