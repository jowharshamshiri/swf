import type {
  Id,
  ProjectionSetting,
  SceneCommand,
  TxResult,
  WorkspaceMutator,
  WorkspaceReader,
} from '@swf/core';
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
  /**
   * Its name, as the ID of the message a host's interface names it by: the navigation interface's
   * messages name the modes this package registers (`mode.<id>`).
   */
  readonly name: string;
  /**
   * The projection the viewport shows this mode with. A panoramic mode shows the panorama's own
   * instead, at the field of view the reader last set ({@link Modes.fieldOfView}); this is the one
   * it starts from.
   */
  readonly projection: ProjectionSetting;
  /**
   * The mode shows the whole panorama at the field of view the reader sets: switching between
   * panoramic modes keeps it, and a mode that frames its own view (focus) leaves it as it was.
   */
  readonly panoramic?: boolean;
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

/** What a mode active in a viewport works with. */
export interface ModeContext {
  /** The viewport it is active in. */
  readonly viewportId: Id;
  /** The workspace it shows. */
  readonly workspace: WorkspaceReader & WorkspaceMutator;
  /** Leaves the mode for the view it was entered from, as the system: when what it shows is gone. */
  readonly back: () => void;
}

/** What a mode being entered works out its view from. */
export interface EnterContext {
  /** The viewport it is entered in. */
  readonly viewportId: Id;
  /** The workspace as it is. */
  readonly workspace: WorkspaceReader;
  /** The entity the mode is asked to present, when the request names one. */
  readonly target: Id | null;
}

/** A mode that cannot be entered or left as asked, and why, naming the field at fault. */
export class ModeRefusal extends Error {
  /** The field at fault. */
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'ModeRefusal';
    this.field = field;
  }
}

/** How a mode is switched to. */
export interface SwitchOptions {
  /** The entity the mode presents (the window a focus is on). */
  readonly target?: Id;
}

/** A viewport's view modes: those registered, the one shown, and moving between them. */
export interface Modes {
  /** Registers a mode; the returned function unregisters it (never the active one). */
  register(mode: ViewMode): () => void;
  /**
   * The registered modes, in the order they were first registered: a mode unregistered and
   * registered again (a feature turned off and on) comes back to its place.
   */
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
  /** The projection panoramic modes show: the panorama at the field of view the reader last set. */
  panorama(): ProjectionSetting;
  /**
   * Sets the panorama's horizontal field of view, in degrees from {@link FIELD_OF_VIEW}'s `min` to
   * its `max`, as one view-state commit: the panorama zooms, its vertical angle keeping the
   * panorama's proportion. Throws {@link ModeRefusal} naming `degrees` for a value out of range,
   * or `mode` while the active mode frames its own view.
   */
  fieldOfView(degrees: number): TxResult;
  /** Stops following the workspace and stops the active mode's work. */
  dispose(): void;
}

/**
 * The panorama's horizontal field of view, in degrees: the whole circle at most, and never so
 * narrow that the panorama stops being one (a quarter of it, about).
 */
export const FIELD_OF_VIEW: {
  /** The narrowest, in degrees. */
  readonly min: number;
  /** The widest: the whole circle. */
  readonly max: number;
} = Object.freeze({ min: 85, max: 360 });

/**
 * The panorama's vertical angle and its horizon: 130° from the top row to the bottom whatever the
 * field of view across, the horizon a little above the middle (0.49 of the height from the top).
 * The vertical span does not follow the field of view: windows are drawn as cards that no span
 * squeezes, and only their centres follow the projection, so a fixed span keeps every height in
 * the room on screen at any field of view, as the room's limits want (its highest window, 4 units
 * up at 2 out, looks 63° up).
 */
export const PANORAMA_VERTICAL: Readonly<{
  /** The angle from the top row to the bottom, in degrees. */
  span: number;
  /** Where the horizon is, as a share of the height from the top. */
  horizon: number;
}> = Object.freeze({ span: 130, horizon: 0.49 });

/**
 * The projection the panorama is shown with at a horizontal field of view, in degrees, spanning
 * `vertical.span` degrees down with its horizon `vertical.horizon` of its height from the top: the
 * panorama's own (`PANORAMA_VERTICAL`), or as focus stands the window it shows.
 */
export function panoramaProjection(
  horizontal: number,
  vertical: { readonly span: number; readonly horizon: number } = PANORAMA_VERTICAL,
): ProjectionSetting {
  return Object.freeze({
    id: 'equirectangular/1',
    config: Object.freeze({ horizontal, vertical: vertical.span, horizon: vertical.horizon }),
  });
}

/** The horizontal field of view a panorama projection shows, in degrees. */
export function fieldOfViewOf(projection: ProjectionSetting): number {
  const config = projection.config as Readonly<Record<string, unknown>> | null;
  const horizontal = config?.['horizontal'];
  if (projection.id !== 'equirectangular/1' || typeof horizontal !== 'number') {
    throw new Error(
      `the panorama is shown with an equirectangular projection (got ${JSON.stringify(projection)})`,
    );
  }
  return horizontal;
}

/** The panorama: the whole circle round the camera, at the field of view the reader sets. */
export const PANORAMA: ViewMode = Object.freeze({
  id: 'panorama',
  name: 'mode.panorama',
  projection: panoramaProjection(FIELD_OF_VIEW.max),
  panoramic: true,
});

/** The top-down map: drawn beside the panorama, which keeps showing every window. */
export const MAP: ViewMode = Object.freeze({
  id: 'map',
  name: 'mode.map',
  projection: PANORAMA.projection,
  panoramic: true,
});

/** The tiled overview: every window as a tile, beside the panorama. */
export const OVERVIEW: ViewMode = Object.freeze({
  id: 'overview',
  name: 'mode.overview',
  projection: PANORAMA.projection,
  panoramic: true,
});

/**
 * The view modes of one viewport of a workspace, none registered yet: the viewport's record says
 * which is shown.
 */
export function createModes(workspace: WorkspaceReader & WorkspaceMutator, viewportId: Id): Modes {
  const modes = new Map<string, ViewMode>();
  /** Every mode ID in the order it was first registered. */
  const order: string[] = [];
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
  /**
   * The projection panoramic modes show: the viewport's own whenever it shows one of them (the
   * reader's field of view, or a restored workspace's), kept while another mode frames its own.
   */
  let panorama: ProjectionSetting = PANORAMA.projection;
  const keepPanorama = () => {
    const record = viewport();
    if (modes.get(record.mode)?.panoramic === true) {
      panorama = record.projection;
    }
  };

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
    keepPanorama();
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
      projection: next.projection ?? (mode.panoramic === true ? panorama : mode.projection),
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
      if (!order.includes(mode.id)) {
        order.push(mode.id);
      }
      follow();
      return () => {
        if (active?.id === mode.id) {
          throw new Error(`mode "${mode.id}" is active and cannot be unregistered`);
        }
        modes.delete(mode.id);
      };
    },
    list: () => order.flatMap((id) => modes.get(id) ?? []),
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
    panorama: () => panorama,
    fieldOfView(degrees: number): TxResult {
      if (
        typeof degrees !== 'number' ||
        !Number.isFinite(degrees) ||
        degrees < FIELD_OF_VIEW.min ||
        degrees > FIELD_OF_VIEW.max
      ) {
        throw new ModeRefusal(
          'degrees',
          `the field of view is a number of degrees from ${String(FIELD_OF_VIEW.min)} to ${String(FIELD_OF_VIEW.max)} (got ${String(degrees)})`,
        );
      }
      const id = recorded();
      if (modes.get(id)?.panoramic !== true) {
        throw new ModeRefusal(
          'mode',
          `the ${id} mode frames its own view: leave it to set the panorama's field of view`,
        );
      }
      return workspace.transaction(
        [{ type: 'viewport.patch', id: viewportId, projection: panoramaProjection(degrees) }],
        { source: 'user' },
      );
    },
    dispose() {
      unsubscribe();
      active?.stop();
      active = null;
    },
  });
  return api;
}
