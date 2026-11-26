import type {
  Id,
  ProjectionSetting,
  SceneCommand,
  SceneState,
  WorkspaceMutator,
  WorkspaceReader,
} from '@swf/core';
import type { Quat } from '@swf/math';
import type * as Lean from '@swf/models';
import { models } from '@swf/models';
import type { FrameSource } from '@swf/presentation';
import { cameraRotation, headingPitchOf } from '@swf/projections';

/**
 * The view's transitions: a change of what the view frames (entering a focus, moving it to another
 * window, leaving it) is committed at once, and the application then shows the view moving there
 * from what was shown, over a few frames, as a preview of the view's own records that the
 * presentation follows; the committed view is the truth throughout, and once the transition ends
 * the preview is gone and the committed view is shown. When to start, carry on, finish or end one
 * is the Lean model `Swf.AppFocus.transitionStep` (models/Swf/AppFocus.lean); this module measures
 * the views and eases between them.
 */

/** The preview a transition shows the view through. */
export const TRANSITION_PREVIEW = 'reference.view.transition';

/** How long a transition lasts, in milliseconds. */
export const TRANSITION_MS = 260;

/** What a viewport shows: its camera's rotation and its projection. */
interface ViewPose {
  readonly cameraId: Id;
  readonly rotation: Quat;
  readonly projection: ProjectionSetting;
}

type Poses = ReadonlyMap<Id, ViewPose>;

export interface ViewTransitionsOptions {
  readonly workspace: WorkspaceReader & WorkspaceMutator;
  /** The viewports whose views move: the application's, then those that come and go with it. */
  readonly viewportIds: readonly Id[];
  /** What the view of the first viewport frames in a scene. */
  readonly framing: (state: SceneState) => Lean.Framing;
  /** Frame boundaries: the presentation's own, so each step is shown in the frame it is made for. */
  readonly frames: FrameSource;
  /** A monotonic clock, in milliseconds. */
  readonly now: () => number;
  /** Whether the reader allows motion; without it the view goes where it is committed at once. */
  readonly motion: () => boolean;
  /** How long a transition lasts, in milliseconds. Default {@link TRANSITION_MS}. */
  readonly durationMs?: number;
}

export interface ViewTransitions {
  /** Whether a transition is under way. */
  running(): boolean;
  dispose(): void;
}

function posesOf(state: SceneState, viewportIds: readonly Id[]): Poses {
  const poses = new Map<Id, ViewPose>();
  for (const id of viewportIds) {
    const viewport = state.viewports.get(id);
    const camera = viewport === undefined ? undefined : state.cameras.get(viewport.cameraId);
    if (viewport !== undefined && camera !== undefined) {
      poses.set(id, {
        cameraId: camera.id,
        rotation: camera.rotation,
        projection: viewport.projection,
      });
    }
  }
  return poses;
}

function samePoses(a: Poses, b: Poses): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const [id, pose] of a) {
    const other = b.get(id);
    if (
      other?.cameraId !== pose.cameraId ||
      !pose.rotation.every((v, i) => v === other.rotation[i]) ||
      JSON.stringify(other.projection) !== JSON.stringify(pose.projection)
    ) {
      return false;
    }
  }
  return true;
}

/** An equirectangular projection's coverage, or null for any other. */
function coverageOf(
  projection: ProjectionSetting,
): { horizontal: number; vertical: number } | null {
  const config = projection.config as Readonly<Record<string, unknown>> | null;
  const horizontal = config?.['horizontal'];
  const vertical = config?.['vertical'];
  return typeof horizontal === 'number' && typeof vertical === 'number'
    ? { horizontal, vertical }
    : null;
}

/** Eases out: quick to leave, settling into place. */
function ease(t: number): number {
  return 1 - (1 - t) ** 3;
}

/**
 * The pose `t` of the way from one to another: the camera turned the short way round and pitched
 * evenly, level throughout; the coverage zoomed evenly (geometrically). A projection of another
 * kind, or of the same with other settings, is shown as the target's.
 */
function between(from: ViewPose, to: ViewPose, t: number): ViewPose {
  const a = headingPitchOf(from.rotation);
  const b = headingPitchOf(to.rotation);
  let turn = b.heading - a.heading;
  turn -= 2 * Math.PI * Math.round(turn / (2 * Math.PI));
  const rotation = cameraRotation(a.heading + turn * t, a.pitch + (b.pitch - a.pitch) * t);
  const ca = coverageOf(from.projection);
  const cb = coverageOf(to.projection);
  const projection =
    ca === null || cb === null || from.projection.id !== to.projection.id
      ? to.projection
      : {
          id: to.projection.id,
          config: {
            horizontal: ca.horizontal * (cb.horizontal / ca.horizontal) ** t,
            vertical: ca.vertical * (cb.vertical / ca.vertical) ** t,
          },
        };
  return { cameraId: to.cameraId, rotation, projection };
}

/**
 * Follows a workspace's commits and moves its views between them as the model says. Only the
 * viewports in both the view moved from and the one committed move; one that comes with the
 * commit (the focus strip) is shown where it is committed.
 */
export function createViewTransitions(options: ViewTransitionsOptions): ViewTransitions {
  const { workspace, viewportIds, frames, now } = options;
  const duration = options.durationMs ?? TRANSITION_MS;
  const clock = () => BigInt(Math.max(0, Math.round(now())));
  let committed = posesOf(workspace.getState(), viewportIds);
  let machine: Lean.Transition = {
    framing: options.framing(workspace.getState()),
    phase: { kind: 'idle' },
    duration: BigInt(duration),
  };
  /**
   * The run under way: the view it moves from and what is shown now. It moves to the view as
   * committed, which the application may fit (to a new size) while it runs.
   */
  let run: { from: Poses; shown: Poses } | null = null;
  let cancelFrame: (() => void) | null = null;

  const show = (poses: Poses) => {
    const commands: SceneCommand[] = [];
    for (const pose of poses.values()) {
      commands.push({ type: 'camera.patch', id: pose.cameraId, rotation: pose.rotation });
    }
    for (const [id, pose] of poses) {
      commands.push({ type: 'viewport.patch', id, projection: pose.projection });
    }
    workspace.preview(TRANSITION_PREVIEW, commands, { source: 'system' });
  };
  const posesAt = (from: Poses, to: Poses, t: number): Poses => {
    const poses = new Map<Id, ViewPose>();
    for (const [id, target] of to) {
      const start = from.get(id);
      if (start?.cameraId === target.cameraId) {
        poses.set(id, between(start, target, ease(t)));
      }
    }
    return poses;
  };
  const end = () => {
    cancelFrame?.();
    cancelFrame = null;
    run = null;
    workspace.cancelPreview(TRANSITION_PREVIEW, 'host');
  };
  const act = (answer: Lean.TransitionAnswer, from: Poses) => {
    machine = answer.transition;
    switch (answer.action.kind) {
      case 'none':
        return;
      case 'start':
        run = { from, shown: from };
        show(posesAt(from, committed, 0));
        request();
        return;
      case 'progress': {
        if (run === null) {
          throw new Error('a transition is under way with nothing to move');
        }
        const shown = posesAt(run.from, committed, Number(answer.action.elapsed) / duration);
        run.shown = shown;
        show(shown);
        request();
        return;
      }
      case 'jump':
      case 'finish':
        end();
        return;
    }
  };
  const request = () => {
    cancelFrame?.();
    cancelFrame = frames.request(() => {
      cancelFrame = null;
      act(models.transitionStep(machine, { kind: 'frame', time: clock() }), committed);
    });
  };

  const unsubscribe = workspace.subscribe((event) => {
    if (event.type === 'transaction.committed') {
      const state = workspace.getState();
      const before = committed;
      const after = posesOf(state, viewportIds);
      committed = after;
      // What is shown now: the transition's step under way, else the view as it was committed.
      const shown = run === null ? before : run.shown;
      act(
        models.transitionStep(machine, {
          kind: 'commit',
          framing: options.framing(state),
          viewChanged: !samePoses(before, after),
          fitted: event.source === 'system',
          motion: options.motion(),
        }),
        shown,
      );
    } else if (
      event.type === 'transform.preview' &&
      event.payload.previewId !== TRANSITION_PREVIEW
    ) {
      // The operator took the view in hand. (A commit that removes a viewport the transition's
      // preview moves ends that preview; its next step moves only the viewports there are.)
      act(models.transitionStep(machine, { kind: 'interrupt' }), committed);
    }
  });

  return Object.freeze({
    running: () => run !== null,
    dispose() {
      unsubscribe();
      if (run !== null) {
        end();
      }
    },
  });
}
