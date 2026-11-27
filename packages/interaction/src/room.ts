import type { Id, SceneState } from '@swf/core';
import type { Transform3D, Vec3 } from '@swf/math';
import { mat4InvertAffine, mat4TransformPoint } from '@swf/math';
import type * as Lean from '@swf/models';
import { models } from '@swf/models';
import { placementOf, worldOrigin } from './placement.js';

/**
 * The room every window stands in, decided by the Lean model `Swf.Room`. The camera stands at the
 * room's centre: a window's place is its heading round the centre (radians, to the right of
 * straight ahead), its distance from the centre along the floor and its height above the camera's
 * level, in world units. Every window shares the one floor, height scale and horizon; how high a
 * window looks (its elevation) is only derived from its height and its floor distance.
 */
export type RoomPlace = Lean.RoomPlace;

/** How near and far along the floor, and how low and high, a window may stand, in world units. */
export type RoomLimits = Lean.RoomLimits;

/** How a pointer's motion moves a window: height and floor distance a pixel, and the wheel's pace. */
export type RoomPace = Lean.RoomPace;

/** The room's limits: 2 to 13.5 units out along the floor, 3 units below the camera to 4 above. */
export const ROOM_LIMITS: RoomLimits = Object.freeze({
  nearest: 2,
  farthest: 13.5,
  lowest: -3,
  highest: 4,
});

/**
 * How a pointer moves a window in the room: a pixel up or down is 1/68 of a unit of height, or,
 * Shift held, 1/27 of a unit along the floor; the wheel moves it along the floor by a factor of
 * e^(0.0012) a pixel it scrolls.
 */
export const ROOM_PACE: RoomPace = Object.freeze({
  heightPerPixel: 1 / 68,
  floorPerPixel: 1 / 27,
  floorPerWheel: 0.0012,
});

/**
 * Where a window stands in the room around `eye` (the room's centre, where the camera is), kept
 * inside the room. Throws {@link @swf/core!SwfFailure} (`UNKNOWN_ENTITY`) when there is no such node.
 */
export function roomPlaceOf(scene: SceneState, nodeId: Id, eye: Vec3): RoomPlace {
  const [x, y, z] = worldOrigin(placementOf(scene, nodeId));
  return models.placeOf(ROOM_LIMITS, x - eye[0], y - eye[1], z - eye[2]);
}

/**
 * The local transform that stands a window at `place` in the room around `eye`, its own rotation
 * and scale kept; null when its parent's placement cannot be inverted. Throws
 * {@link @swf/core!SwfFailure} (`UNKNOWN_ENTITY`) when there is no such node.
 */
export function standingInRoom(
  scene: SceneState,
  nodeId: Id,
  eye: Vec3,
  place: RoomPlace,
): Transform3D | null {
  const placement = placementOf(scene, nodeId);
  const toParent = mat4InvertAffine(placement.parentWorld);
  if (toParent === null) {
    return null;
  }
  const { x, y, z } = models.pointOf(place);
  const position = mat4TransformPoint(toParent, [eye[0] + x, eye[1] + y, eye[2] + z]);
  return { ...placement.local, position };
}

/** What {@link RoomMotion} reads of a pointer: where it is and whether Shift is held. */
export interface RoomPointer {
  /** Across the view, in CSS pixels. */
  readonly x: number;
  /** Down the view, in CSS pixels. */
  readonly y: number;
  /** The modifier keys held. */
  readonly modifiers: {
    /** Shift is held: the motion moves the window along the floor. */
    readonly shift: boolean;
  };
}

/**
 * A pointer's motion of a window round the room: where each pointer position and each turn of the
 * wheel puts it ({@link models.dragStep}, {@link models.wheelOnFloor}). The motion runs from where
 * the window stood and the pointer was when it began; pressing or letting go of Shift, or a turn of
 * the wheel, starts it afresh from where the window stands and the pointer was last, so no motion
 * is lost or counted twice. A host or gesture says which proposed place it took with
 * {@link RoomMotion.accept}: a place it refused leaves the window where it stood.
 */
export class RoomMotion {
  #start: RoomPlace;
  #from: readonly [number, number];
  #at: readonly [number, number];
  #alongFloor: boolean;
  #place: RoomPlace;

  /** A motion of a window standing at `place`, the pointer pressed at `down`. */
  constructor(place: RoomPlace, down: RoomPointer) {
    this.#start = place;
    this.#place = place;
    this.#from = [down.x, down.y];
    this.#at = this.#from;
    this.#alongFloor = down.modifiers.shift;
  }

  /** Where the window stands: the place last accepted. */
  get place(): RoomPlace {
    return this.#place;
  }

  /**
   * Where the pointer at `pointer` puts the window, in a view `width` CSS pixels across showing
   * `fieldOfView` radians.
   */
  moved(pointer: RoomPointer, width: number, fieldOfView: number): RoomPlace {
    if (pointer.modifiers.shift !== this.#alongFloor) {
      // Shift pressed or let go: the motion since the pointer was last seen is the other kind.
      this.#restart();
      this.#alongFloor = pointer.modifiers.shift;
    }
    this.#at = [pointer.x, pointer.y];
    return models.dragStep(ROOM_LIMITS, ROOM_PACE, {
      start: this.#start,
      dx: pointer.x - this.#from[0],
      dy: pointer.y - this.#from[1],
      width,
      fieldOfView,
      alongFloor: this.#alongFloor,
    });
  }

  /**
   * Where a turn of the wheel by `deltaY` pixels puts the window; the motion then carries on from
   * there, once the place is accepted, and from where the pointer was.
   */
  wheeled(deltaY: number): RoomPlace {
    return models.wheelOnFloor(ROOM_LIMITS, ROOM_PACE, this.#place, deltaY);
  }

  /** The window now stands at `place`, which the motion proposed. */
  accept(place: RoomPlace): void {
    this.#place = place;
  }

  /** Starts the motion afresh from where the window stands and the pointer was last. */
  restart(): void {
    this.#restart();
  }

  #restart(): void {
    this.#start = this.#place;
    this.#from = this.#at;
  }
}
