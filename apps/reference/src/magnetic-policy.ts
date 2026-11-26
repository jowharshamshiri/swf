import type { CancelReason, Id, SceneCommand, SwfError } from '@swf/core';
import type {
  ClaimContext,
  DragFrame,
  GestureClaim,
  GestureFinish,
  GestureHandler,
  GestureSession,
  InteractionPolicy,
  Placement,
  PointerIntent,
  WheelIntent,
} from '@swf/interaction';
import {
  dragAnchor,
  dragFrame,
  eyeOf,
  INTERACTION_API_VERSION,
  movedTransform,
  placementOf,
  wheelTurn,
  windowMovePolicy,
  withDepth,
} from '@swf/interaction';
import type { Vec3 } from '@swf/math';
import type { SnapSettings } from './features.js';
import type { Snap, SnapBox } from './magnetic.js';
import {
  boxOf,
  NO_SNAP,
  resolveSnap,
  snapNeighbours,
  snappedTransform,
  worldAt,
} from './magnetic.js';

/**
 * Moving a window with magnetic positioning: the same presses as the framework's own window move
 * start it, and it moves the window the same way, but each place proposed is snapped first. The
 * snapped place is previewed (so the snap can be seen, and undone by moving on or cancelling) and
 * the last one is committed once, when the pointer is released.
 */

export const MAGNETIC_POLICY_ID = 'reference.magnetic-move/1';

/** What a running snapping move reports, as it goes: which window, and the snap in force. */
export interface SnapReport {
  readonly gestureId: string;
  readonly nodeId: Id;
  readonly snap: Snap;
}

export interface MagneticOptions {
  /** The settings now: read at every proposal, so a change applies to the next move. */
  readonly settings: () => SnapSettings;
  /** The rings round the camera now, nearest first, in world units: read at every proposal. */
  readonly rings: () => readonly number[];
  /** Hears each preview's snap. */
  readonly report: (report: SnapReport) => void;
}

const reasonOf = (error: SwfError): CancelReason =>
  error.code === 'CONSTRAINT_REJECTED' || error.code === 'LOCKED'
    ? 'constraint-rejected'
    : 'commit-rejected';

class MagneticMove implements GestureHandler {
  readonly #session: GestureSession;
  readonly #options: MagneticOptions;
  readonly #nodeId: Id;
  readonly #placement: Placement;
  readonly #frame: DragFrame;
  readonly #eye: Vec3;
  readonly #neighbours: readonly SnapBox[];
  #depth = 0;
  #pointer: PointerIntent | null = null;
  #last: SceneCommand[] | null = null;

  constructor(session: GestureSession, options: MagneticOptions, nodeId: Id, grabbed: Vec3) {
    this.#session = session;
    this.#options = options;
    this.#nodeId = nodeId;
    const scene = session.scene();
    this.#placement = placementOf(scene, nodeId);
    const s = session.settings;
    this.#eye = eyeOf(session.view());
    this.#frame = dragFrame(s.dragMode, this.#eye, grabbed, s.worldPlaneNormal, s.minDistance);
    this.#neighbours = snapNeighbours(scene, nodeId);
  }

  update(pointers: readonly PointerIntent[]): void {
    const pointer = pointers[0];
    if (pointer === undefined) {
      return;
    }
    this.#pointer = pointer;
    const ray = this.#session.ray(pointer);
    if (ray.kind !== 'ray') {
      // Outside the image or where it has no inverse: hold the last place, keep the capture.
      return;
    }
    const anchor = dragAnchor(this.#frame, ray.ray, this.#depth);
    if (anchor !== null) {
      this.#propose(anchor);
    }
  }

  wheel(intent: WheelIntent): boolean {
    this.#depth -= wheelTurn(intent) * this.#session.settings.wheelDepthPerPixel;
    if (this.#pointer === null) {
      this.#propose(
        withDepth(this.#frame.eye, this.#frame.anchor, this.#depth, this.#frame.minDistance),
      );
    } else {
      this.update([this.#pointer]);
    }
    return true;
  }

  finish(): GestureFinish {
    if (this.#last === null) {
      return { outcome: 'unchanged' };
    }
    const result = this.#session.commit(this.#last);
    return result.status === 'committed'
      ? { outcome: 'committed', transactionId: result.transactionId }
      : { outcome: 'cancelled', reason: reasonOf(result.error), error: result.error };
  }

  cancel(): void {
    // Everything this gesture changed is in its preview.
  }

  #propose(anchor: Vec3): void {
    const moved = movedTransform(this.#placement, this.#frame, anchor);
    if (moved === null) {
      return;
    }
    const world = worldAt(this.#placement, moved);
    const box = boxOf(this.#session.scene(), this.#nodeId, world);
    const snap =
      box === null
        ? NO_SNAP
        : resolveSnap(
            box,
            this.#neighbours,
            this.#eye,
            this.#options.settings(),
            this.#options.rings(),
          );
    const transform =
      snap.constraints.length === 0
        ? moved
        : snappedTransform(this.#placement, world, this.#eye, snap);
    if (transform === null) {
      return;
    }
    const commands: SceneCommand[] = [{ type: 'node.patch', id: this.#nodeId, transform }];
    // A rejected proposal (a constraint said no) leaves the last valid one in place.
    if (this.#session.preview(commands).status === 'previewed') {
      this.#last = commands;
      this.#options.report({ gestureId: this.#session.gestureId, nodeId: this.#nodeId, snap });
    }
  }
}

/**
 * The magnetic move, as an interaction policy above the framework's window move: it claims exactly
 * the presses that one would, so with it registered every window move snaps, and without it none
 * does.
 */
export function magneticMovePolicy(options: MagneticOptions): InteractionPolicy {
  return Object.freeze({
    id: MAGNETIC_POLICY_ID,
    apiVersion: INTERACTION_API_VERSION,
    priority: windowMovePolicy.priority + 1,
    operations: Object.freeze(['node.move']),
    claim(context: ClaimContext): GestureClaim | null {
      const move = windowMovePolicy.claim(context);
      if (move === null || context.pick.kind !== 'hit') {
        return null;
      }
      const target = context.pick.target;
      return {
        kind: 'drag',
        pointers: 1,
        operation: 'node.move',
        nodeId: target.nodeId,
        begin: (session) => new MagneticMove(session, options, target.nodeId, target.worldPoint),
      };
    },
  });
}
