import type { Id, ProjectionSetting, TxResult, WorkspaceMutator, WorkspaceReader } from '@swf/core';
import type { MessageId } from './messages.js';

/**
 * View modes. Every mode shows the same scene: switching one only changes the viewport's view
 * settings (its mode and projection), never a window's or surface's record, so whatever a mode
 * places on screen is derived and never becomes a world transform. The viewport's record is the
 * truth of which mode is active; a mode may run hooks of its own while it is.
 */
export interface ViewMode {
  /** A stable ID, stored as the viewport's mode. */
  readonly id: string;
  readonly name: MessageId;
  /** The projection the viewport shows this mode with. */
  readonly projection: ProjectionSetting;
  /** Starts what the mode does while active; the returned function stops it. */
  activate?(context: ModeContext): () => void;
}

export interface ModeContext {
  readonly viewportId: Id;
  readonly workspace: WorkspaceReader;
}

export interface Modes {
  /** Registers a mode; the returned function unregisters it (never the active one). */
  register(mode: ViewMode): () => void;
  /** The registered modes, in registration order. */
  list(): readonly ViewMode[];
  /** The viewport's mode, as its record says. */
  current(): string;
  /** Switches the viewport to a registered mode at once, as one view-state commit. */
  switchTo(id: string): TxResult;
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

export function createModes(workspace: WorkspaceReader & WorkspaceMutator, viewportId: Id): Modes {
  const modes = new Map<string, ViewMode>();
  let active: { readonly id: string; readonly stop: () => void } | null = null;

  const recorded = (): string => {
    const viewport = workspace.getState().viewports.get(viewportId);
    if (viewport === undefined) {
      throw new Error(`viewport "${viewportId}" does not exist`);
    }
    return viewport.mode;
  };

  /** Runs the hooks of the mode the viewport records, stopping the previous mode's. */
  const follow = () => {
    const id = recorded();
    if (active?.id === id) {
      return;
    }
    active?.stop();
    active = null;
    const mode = modes.get(id);
    if (mode !== undefined) {
      const stop = mode.activate?.({ viewportId, workspace }) ?? (() => undefined);
      active = { id, stop };
    }
  };

  const unsubscribe = workspace.subscribe((event) => {
    if (event.type === 'transaction.committed') {
      follow();
    }
  });

  return Object.freeze({
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
    switchTo(id: string): TxResult {
      const mode = modes.get(id);
      if (mode === undefined) {
        throw new Error(`mode "${id}" is not registered`);
      }
      return workspace.dispatch(
        { type: 'viewport.patch', id: viewportId, mode: mode.id, projection: mode.projection },
        { source: 'user' },
      );
    },
    dispose() {
      unsubscribe();
      active?.stop();
      active = null;
    },
  });
}
