import type { Id, SceneCommand, Workspace } from '@swf/core';
import type {
  DispatchResult,
  InputAdapter,
  InputIntent,
  InteractionRouter,
  WheelIntent,
} from '@swf/interaction';
import {
  INTERACTION_API_VERSION,
  ROOM_LIMITS,
  ROOM_PACE,
  roomPlaceOf,
  standingInRoom,
  wheelTurn,
} from '@swf/interaction';
import type * as Lean from '@swf/models';
import { models } from '@swf/models';

/**
 * The wheel over a window with the depth modifier (Shift) held brings it nearer along the floor or
 * sends it farther (turned down, farther, at the room's wheel pace). A burst of ticks over one window is one gesture: the window is shown where the ticks so
 * far take it (a preview) and committed once, as one undoable change, when the wheel rests, when
 * other input comes (a press, a key) or when another window is wheeled; Escape, or cancelling the
 * gesture, leaves it where it was. Each step is decided by the Lean model `Swf.AppWheel`
 * (models/Swf/AppWheel.lean); this module measures how far a tick turns the wheel, keeps the
 * timer, and turns the decision into previews and commits. It sits between the device and the
 * framework, so every other intent passes through as it was, and so does the wheel while a
 * gesture of the framework holds the viewport (a press, pending or running, or a keyboard hold):
 * that gesture's wheel is its own, so no burst changes the scene in the middle of it.
 */

/** How long the wheel rests before its burst is committed, in milliseconds. */
export const WHEEL_REST_MS = 300;

/** What the bursts tell their owner: a burst started, or how one ended. */
export type BurstReport =
  | { readonly kind: 'started'; readonly burstId: string; readonly nodeId: Id }
  | {
      readonly kind: 'ended';
      readonly burstId: string;
      readonly nodeId: Id;
      readonly outcome: 'committed' | 'cancelled';
    };

export interface WheelBurstOptions {
  readonly workspace: Workspace;
  readonly router: InteractionRouter;
  readonly viewportId: Id;
  /**
   * Whether a gesture of the framework holds the viewport: a press pending or running there, or a
   * keyboard hold. Its wheel is its own: the framework gives it to that gesture, or takes it as
   * nothing.
   */
  readonly gestureHeld: () => boolean;
  readonly report: (report: BurstReport) => void;
}

export interface WheelBursts {
  /** A device's adapter with the bursts between it and the framework. */
  input(device: InputAdapter): InputAdapter;
  /** Cancels the burst under way; false when none is. */
  cancel(): boolean;
  /** Commits the burst under way, if one is. */
  settle(): void;
  dispose(): void;
}

export function createWheelBursts(options: WheelBurstOptions): WheelBursts {
  const { workspace, router, viewportId } = options;
  let current: Lean.Burst | null = null;
  let shown: { readonly burstId: string; readonly previewId: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let next = 1;

  const rest = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /**
   * The change that moves a window along the floor by the room's wheel pace for `turned` pixels of
   * wheel (down is farther), from where it stands, inside the room.
   */
  const movedBy = (nodeId: Id, turned: number): SceneCommand[] => {
    const state = workspace.getState();
    const viewport = state.viewports.get(viewportId);
    const eye = viewport === undefined ? undefined : state.cameras.get(viewport.cameraId)?.position;
    if (eye === undefined) {
      throw new Error(`viewport "${viewportId}" has no camera`);
    }
    const place = models.wheelOnFloor(
      ROOM_LIMITS,
      ROOM_PACE,
      roomPlaceOf(state, nodeId, eye),
      turned,
    );
    const transform = standingInRoom(state, nodeId, eye, place);
    if (transform === null) {
      throw new Error(`window "${nodeId}" cannot be moved: its group's placement is singular`);
    }
    return [{ type: 'node.patch', id: nodeId, transform }];
  };

  const act = (action: Lean.WheelAction) => {
    switch (action.kind) {
      case 'show': {
        const { nodeId, turned } = action.burst;
        if (shown === null) {
          const burstId = `wheel-${String(next++)}`;
          shown = { burstId, previewId: `swf.${burstId}/${nodeId}` };
          options.report({ kind: 'started', burstId, nodeId });
        }
        workspace.preview(shown.previewId, movedBy(nodeId, turned), { source: 'user' });
        return;
      }
      case 'commit': {
        const ending = shown;
        shown = null;
        if (ending === null) {
          throw new Error('a burst is committed that was never shown');
        }
        const { nodeId, turned } = action.burst;
        const result = workspace.transaction(movedBy(nodeId, turned), {
          source: 'user',
          previewId: ending.previewId,
        });
        const ended = (status: string) => {
          options.report({
            kind: 'ended',
            burstId: ending.burstId,
            nodeId,
            outcome: status === 'committed' ? 'committed' : 'cancelled',
          });
        };
        if (result.status === 'queued') {
          void result.completion.then((outcome) => {
            ended(outcome.status);
          });
        } else {
          ended(result.status);
        }
        return;
      }
      case 'discard': {
        const ending = shown;
        shown = null;
        if (ending !== null && current !== null) {
          workspace.cancelPreview(ending.previewId, 'escape');
          options.report({
            kind: 'ended',
            burstId: ending.burstId,
            nodeId: current.nodeId,
            outcome: 'cancelled',
          });
        }
        return;
      }
    }
  };

  const step = (event: Lean.WheelEvent) => {
    const outcome = models.wheelStep(current, event);
    if (outcome.kind === 'invalidDelta') {
      throw new RangeError('a wheel tick turns the wheel a finite number of pixels');
    }
    for (const action of outcome.s.actions) {
      act(action);
    }
    current = outcome.s.burst;
  };

  const settle = () => {
    rest();
    if (current !== null) {
      step({ kind: 'settle' });
    }
  };

  /** The window a wheel tick moves, when it is a burst's: the depth modifier over a movable window. */
  const wheeled = (intent: WheelIntent): Id | null => {
    if (!intent.modifiers[router.settings().depthModifier] || options.gestureHeld()) {
      return null;
    }
    const pick = router.pick(intent.viewportId, intent.x, intent.y);
    if (pick.kind !== 'hit' || pick.region === 'modal-overlay') {
      return null;
    }
    const node = workspace.getState().nodes.get(pick.target.nodeId);
    return node?.kind === 'window' && node.flags.draggable && !node.flags.locked ? node.id : null;
  };

  /** A tick the burst took: kept from the platform, and no command run until the burst ends. */
  const CONSUMED: DispatchResult = Object.freeze({
    consumed: true,
    route: 'command',
    region: null,
    target: null,
    gestureId: null,
    operation: null,
    reason: null,
    pick: null,
  });

  return Object.freeze({
    input(device: InputAdapter): InputAdapter {
      return Object.freeze({
        id: 'swf.navigation.wheel-burst/1',
        apiVersion: INTERACTION_API_VERSION,
        connect(dispatch: (intent: InputIntent) => DispatchResult): () => void {
          return device.connect((intent) => {
            if (intent.kind === 'wheel') {
              const nodeId = wheeled(intent);
              if (nodeId !== null) {
                rest();
                step({
                  kind: 'tick',
                  nodeId,
                  delta: wheelTurn(intent),
                });
                timer = setTimeout(settle, WHEEL_REST_MS);
                return CONSUMED;
              }
              settle();
            } else if (current !== null) {
              const escape =
                intent.kind === 'key' && intent.phase === 'down' && intent.key === 'Escape';
              const press =
                intent.kind === 'key' || (intent.kind === 'pointer' && intent.phase === 'down');
              if (escape) {
                rest();
                step({ kind: 'cancel' });
                return dispatch(intent);
              }
              if (press) {
                settle();
              }
            }
            return dispatch(intent);
          });
        },
      });
    },
    cancel() {
      if (current === null) {
        return false;
      }
      rest();
      step({ kind: 'cancel' });
      return true;
    },
    settle,
    dispose() {
      rest();
      if (current !== null) {
        step({ kind: 'cancel' });
      }
    },
  });
}
