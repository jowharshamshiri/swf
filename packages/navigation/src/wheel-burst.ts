import type { Id, SceneCommand, Workspace } from '@swf/core';
import type {
  DispatchResult,
  InputAdapter,
  InputIntent,
  InputRegion,
  InteractionRouter,
  WheelIntent,
} from '@swf/interaction';
import {
  eyeOf,
  INTERACTION_API_VERSION,
  placementOf,
  ROOM_LIMITS,
  ROOM_PACE,
  roomPlaceOf,
  standingInRoom,
  turnedAbout,
  wheelTurn,
} from '@swf/interaction';
import type * as Lean from '@swf/models';
import { models } from '@swf/models';
import { viewGeometryOf } from '@swf/presentation';
import { fieldOfViewOf } from './modes.js';

/**
 * The navigation's wheel. Where the wheel goes is decided by the gesture model's `wheelRoute`, as
 * the router decides it: over a window's title bar, its frame or a picture of its content it
 * brings the window nearer along the floor or sends it farther (turned down, farther, at the room's
 * wheel pace); over the background, a scroll sideways turns the workspace round the camera while
 * that is what a drag on the background turns (the router turns the camera itself otherwise), and
 * Ctrl, a trackpad's pinch included, zooms the panorama's field of view; live content keeps every
 * wheel. A burst of ticks carrying one thing one way is one gesture: shown where the ticks so far
 * take it (a preview) and committed once, as one undoable change, when the wheel rests, when other
 * input comes (a press, a key) or when another window, or the same one another way, is wheeled;
 * Escape, or cancelling the gesture, leaves everything where it was. Each step is decided by the
 * Lean model `Swf.AppWheel` (models/Swf/AppWheel.lean); this module measures how far a tick turns
 * the wheel, keeps the timer, and turns the decision into previews and commits. It sits between
 * the device and the framework, so every other intent passes through as it was, and so does the
 * wheel while a gesture of the framework holds the viewport (a press, pending or running, or a
 * keyboard hold): that gesture's wheel is its own, so no burst changes the scene in the middle of
 * it.
 */

/** How long the wheel rests before its burst is committed, in milliseconds. */
export const WHEEL_REST_MS = 300;

/**
 * How fast the wheel with Ctrl, or a trackpad's pinch, zooms the field of view: by `e` to this
 * times the pixels turned (a mouse's notch of 120 pixels, about a third; a pinch's few pixels a
 * step, a few in a hundred).
 */
export const ZOOM_PACE = 0.0025;

const FLOOR: Lean.Carries = Object.freeze({ kind: 'floor' });
const ORBIT: Lean.Carries = Object.freeze({ kind: 'orbit' });

/** Each input region as the gesture model names it. */
const REGION_KINDS: Readonly<Record<InputRegion, Lean.Region['kind']>> = Object.freeze({
  content: 'content',
  chrome: 'chrome',
  'title-bar': 'titleBar',
  'resize-handle': 'resizeHandle',
  background: 'background',
  'modal-overlay': 'modalOverlay',
});

/** What the bursts tell their owner: a burst started, or how one ended. */
export type BurstReport =
  | {
      readonly kind: 'started';
      readonly burstId: string;
      /** The command its change is: `node.move` along the floor, or `orbit.turn`. */
      readonly operation: 'node.move' | 'orbit.turn';
      readonly nodeId: Id;
    }
  | {
      readonly kind: 'ended';
      readonly burstId: string;
      /** The command its change is: `node.move` along the floor, or `orbit.turn`. */
      readonly operation: 'node.move' | 'orbit.turn';
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
  /**
   * Zooms the panorama's field of view by a factor (above 1, wider), held within its limits: true
   * when the view's field of view is the panorama's to set now (false in a mode that frames its
   * own view, which leaves the wheel to the browser).
   */
  readonly zoom: (factor: number) => boolean;
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

  /**
   * The change that turns the workspace's orbit root round the camera for `turned` pixels of
   * sideways scroll (right, positive), at the panorama's angle a pixel: the windows go the way the
   * view would, turned to the right.
   */
  const turnedBy = (rootId: Id, turned: number): SceneCommand[] => {
    const state = workspace.getState();
    const viewport = state.viewports.get(viewportId);
    if (viewport === undefined) {
      throw new Error(`viewport "${viewportId}" does not exist`);
    }
    const view = viewGeometryOf(state, viewportId);
    const radians = (-turned * fieldOfViewOf(viewport.projection) * Math.PI) / 180 / view.width;
    const transform = turnedAbout(placementOf(state, rootId), eyeOf(view), radians);
    if (transform === null) {
      throw new Error(`the orbit root "${rootId}" cannot be turned: its placement is singular`);
    }
    return [{ type: 'node.patch', id: rootId, transform }];
  };

  /** The change a burst is, as far as it has gone. */
  const changeOf = ({ nodeId, carries, turned }: Lean.Burst): SceneCommand[] =>
    carries.kind === 'floor' ? movedBy(nodeId, turned) : turnedBy(nodeId, turned);
  const operationOf = (burst: Lean.Burst) =>
    burst.carries.kind === 'floor' ? ('node.move' as const) : ('orbit.turn' as const);

  const act = (action: Lean.WheelAction) => {
    switch (action.kind) {
      case 'show': {
        const { nodeId } = action.burst;
        if (shown === null) {
          const burstId = `wheel-${String(next++)}`;
          shown = { burstId, previewId: `swf.${burstId}/${nodeId}` };
          options.report({
            kind: 'started',
            burstId,
            operation: operationOf(action.burst),
            nodeId,
          });
        }
        workspace.preview(shown.previewId, changeOf(action.burst), { source: 'user' });
        return;
      }
      case 'commit': {
        const ending = shown;
        shown = null;
        if (ending === null) {
          throw new Error('a burst is committed that was never shown');
        }
        const { nodeId } = action.burst;
        const result = workspace.transaction(changeOf(action.burst), {
          source: 'user',
          previewId: ending.previewId,
        });
        const ended = (status: string) => {
          options.report({
            kind: 'ended',
            burstId: ending.burstId,
            operation: operationOf(action.burst),
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
            operation: operationOf(current),
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

  /**
   * What a wheel tick is here, as `wheelRoute` decides it: a burst's tick, carrying a movable
   * window along the floor or the workspace's orbit root round the camera; a zoom of the field of
   * view; or neither, for the router (the camera turned, content scrolled, nothing).
   */
  const wheeled = (
    intent: WheelIntent,
  ): { kind: 'tick'; event: Lean.WheelEvent } | { kind: 'zoom' } | null => {
    if (options.gestureHeld()) {
      return null;
    }
    const pick = router.pick(intent.viewportId, intent.x, intent.y);
    const picked = pick.kind === 'hit' || pick.kind === 'background' ? pick : null;
    const target = picked?.kind === 'hit' ? picked.target : null;
    const route = models.wheelRoute({
      pressed: false,
      pick: { kind: picked === null ? 'none' : picked.kind },
      region: { kind: REGION_KINDS[picked?.region ?? 'background'] },
      proxy: target?.proxy === true,
      zoom: intent.modifiers.ctrl,
      sideways: Math.abs(intent.deltaX) > Math.abs(intent.deltaY),
    });
    const state = workspace.getState();
    switch (route.kind) {
      case 'depthMove': {
        const node = target === null ? undefined : state.nodes.get(target.nodeId);
        return node?.kind === 'window' && node.flags.draggable && !node.flags.locked
          ? {
              kind: 'tick',
              event: { kind: 'tick', nodeId: node.id, carries: FLOOR, delta: wheelTurn(intent) },
            }
          : null;
      }
      case 'turnView': {
        const rootId = state.orbitRootId;
        return state.viewports.get(viewportId)?.navigation === 'orbit' && rootId !== null
          ? {
              kind: 'tick',
              event: { kind: 'tick', nodeId: rootId, carries: ORBIT, delta: intent.deltaX },
            }
          : null;
      }
      case 'zoomView':
        return { kind: 'zoom' };
      case 'press':
      case 'ignore':
      case 'blocked':
      case 'native':
      case 'ignored':
        return null;
    }
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
              const what = wheeled(intent);
              if (what?.kind === 'tick') {
                rest();
                step(what.event);
                timer = setTimeout(settle, WHEEL_REST_MS);
                return CONSUMED;
              }
              settle();
              // Turned down (or a pinch closed), wider; up, narrower.
              if (what?.kind === 'zoom' && options.zoom(Math.exp(intent.deltaY * ZOOM_PACE))) {
                return CONSUMED;
              }
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
