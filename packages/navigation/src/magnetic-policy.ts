import type { CancelReason, Id, SceneCommand, SwfError } from '@swf/core';
import type {
  ClaimContext,
  GestureClaim,
  GestureFinish,
  GestureHandler,
  GestureSession,
  InteractionPolicy,
  PickCandidate,
  PointerIntent,
  RoomPlace,
  WheelIntent,
} from '@swf/interaction';
import {
  eyeOf,
  INTERACTION_API_VERSION,
  RoomMotion,
  roomPlaceOf,
  standingInRoom,
  wheelTurn,
  windowMovePolicy,
} from '@swf/interaction';
import type { Vec3 } from '@swf/math';
import type { SnapSettings } from './features.js';
import type { CardMeasure, Snap, SnapBox } from './magnetic.js';
import type { SnappedPlace } from './magnetic.js';
import {
  boxOf,
  NO_SNAP,
  resolveSnap,
  snapNeighbours,
  snappedPlace,
  spacedPlace,
} from './magnetic.js';

/**
 * Moving a window with magnetic positioning: the same presses as the framework's own window move
 * start it, and it moves the window round the room the same way (across turns it, up and down
 * raise and lower it, Shift moves it along the floor, and so does the wheel), but each place
 * proposed is snapped first, measured on the cards the view draws. The snapped place is previewed
 * (so the snap can be seen, and undone by moving on or cancelling) and the last one is committed
 * once, when the pointer is released.
 */
export const MAGNETIC_POLICY_ID = 'swf.navigation.magnetic-move/1';

/** What a running snapping move reports, as it goes: which window, and the snap in force. */
export interface SnapReport {
  readonly gestureId: string;
  readonly nodeId: Id;
  readonly snap: Snap;
}

export interface MagneticOptions {
  /** The settings now: read at every proposal, so a change applies to the next move. */
  readonly settings: () => SnapSettings;
  /** The rings round the camera now, nearest first, in world units along the floor. */
  readonly rings: () => readonly number[];
  /** How the view draws its cards now, to measure windows by. */
  readonly measure: () => CardMeasure;
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
  readonly #eye: Vec3;
  readonly #neighbours: readonly SnapBox[];
  /** The pointer's motion of the window: where it is shown, before its snap. */
  readonly #motion: RoomMotion;
  #last: SceneCommand[] | null = null;
  /** Where the last preview shows the window, and the snap that put it there. */
  #shown: SnappedPlace | null = null;

  constructor(
    session: GestureSession,
    options: MagneticOptions,
    target: PickCandidate,
    down: PointerIntent,
  ) {
    this.#session = session;
    this.#options = options;
    this.#nodeId = target.nodeId;
    const scene = session.scene();
    this.#eye = eyeOf(session.view());
    this.#motion = new RoomMotion(roomPlaceOf(scene, target.nodeId, this.#eye), down);
    this.#neighbours = snapNeighbours(scene, target.nodeId, this.#eye, options.measure());
  }

  update(pointers: readonly PointerIntent[]): void {
    const pointer = pointers[0];
    if (pointer === undefined) {
      return;
    }
    const fieldOfView = this.#session.projection().describeDomain().horizontalCoverage;
    this.#propose(this.#motion.moved(pointer, this.#session.view().width, fieldOfView));
  }

  wheel(intent: WheelIntent): boolean {
    this.#propose(this.#motion.wheeled(wheelTurn(intent)));
    this.#motion.restart();
    return true;
  }

  finish(): GestureFinish {
    if (this.#last === null || this.#shown === null) {
      return { outcome: 'unchanged' };
    }
    // Dropped: kept clear of the windows near it on the floor.
    let commands = this.#last;
    const spaced = spacedPlace(
      this.#shown.place,
      this.#shown.snap,
      this.#neighbours,
      this.#options.settings(),
    );
    if (spaced.place !== this.#shown.place) {
      const transform = standingInRoom(
        this.#session.scene(),
        this.#nodeId,
        this.#eye,
        spaced.place,
      );
      if (transform !== null) {
        commands = [{ type: 'node.patch', id: this.#nodeId, transform }];
        this.#options.report({
          gestureId: this.#session.gestureId,
          nodeId: this.#nodeId,
          snap: spaced.snap,
        });
      }
    }
    const result = this.#session.commit(commands);
    return result.status === 'committed'
      ? { outcome: 'committed', transactionId: result.transactionId }
      : { outcome: 'cancelled', reason: reasonOf(result.error), error: result.error };
  }

  cancel(): void {
    // Everything this gesture changed is in its preview.
  }

  #propose(place: RoomPlace): void {
    const scene = this.#session.scene();
    const box = boxOf(scene, this.#nodeId, this.#eye, this.#options.measure(), place);
    const settings = this.#options.settings();
    const resolved =
      box === null ? NO_SNAP : resolveSnap(box, this.#neighbours, settings, this.#options.rings());
    const snap = resolved;
    const shown = snap.constraints.length === 0 ? place : snappedPlace(place, snap);
    const transform = standingInRoom(scene, this.#nodeId, this.#eye, shown);
    if (transform === null) {
      return;
    }
    const commands: SceneCommand[] = [{ type: 'node.patch', id: this.#nodeId, transform }];
    // A rejected proposal (a constraint said no) leaves the last valid one in place.
    if (this.#session.preview(commands).status === 'previewed') {
      this.#last = commands;
      this.#shown = { place: shown, snap };
      this.#motion.accept(place);
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
      const down = context.pointers[0];
      if (move === null || context.pick.kind !== 'hit' || down === undefined) {
        return null;
      }
      const target = context.pick.target;
      return {
        kind: 'drag',
        pointers: 1,
        operation: 'node.move',
        nodeId: target.nodeId,
        begin: (session) => new MagneticMove(session, options, target, down),
      };
    },
  });
}
