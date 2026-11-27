import type { Id, SceneCommand, SceneState } from '@swf/core';
import { worldMatrix } from '@swf/core';
import { ROOM_LIMITS, roomPlaceOf, standingInRoom } from '@swf/interaction';
import type { Vec3 } from '@swf/math';
import { models } from '@swf/models';

/**
 * Where a window is in the room around the camera, as an operator reads it: what the
 * inspector shows, what is announced when it changes, and what the inspector's exact entries set.
 */
export interface Pose {
  /** Degrees to the right of straight ahead, from −180 to 180. */
  readonly heading: number;
  /** Degrees above the horizon, derived from its height and its distance along the floor. */
  readonly elevation: number;
  /** World units from the camera. */
  readonly distance: number;
  /**
   * World units from the camera along the floor: how far out it stands, whatever its height. With
   * its heading and its height it says where the window is in the room, each set on its own.
   */
  readonly reach: number;
  /** World units its centre stands above the camera's level (below it, negative). */
  readonly above: number;
  /** Its world position. */
  readonly position: Vec3;
  /** Its frame's width, in world units. */
  readonly width: number;
  /** Its frame's height, in world units. */
  readonly height: number;
  /** Locked: not moved or sized. */
  readonly locked: boolean;
  /** Its host lets it be moved. */
  readonly movable: boolean;
  /** Its host lets it be sized. */
  readonly resizable: boolean;
}

const DEGREES = 180 / Math.PI;

/** An angle in degrees brought into −180 to 180, with no negative zero. */
export function wrapDegrees(degrees: number): number {
  const wrapped = degrees - 360 * Math.round(degrees / 360);
  return wrapped === 0 ? 0 : wrapped;
}

/** A window's pose seen from `eye`; null when there is no such node. */
export function poseOf(scene: SceneState, id: Id, eye: Vec3): Pose | null {
  const node = scene.nodes.get(id);
  const world = worldMatrix(scene.nodes, id);
  if (node === undefined || world === undefined) {
    return null;
  }
  const position: Vec3 = [world[12], world[13], world[14]];
  const [x, y, z] = [position[0] - eye[0], position[1] - eye[1], position[2] - eye[2]];
  const heading = Math.atan2(x, -z);
  return Object.freeze({
    heading: wrapDegrees(heading * DEGREES),
    // Derived from its height and its distance along the floor, as the room derives it.
    elevation: models.elevationOf({ heading, floor: Math.hypot(x, z), height: y }) * DEGREES,
    distance: Math.hypot(x, y, z),
    reach: Math.hypot(x, z),
    above: y,
    position,
    width: node.bounds[0],
    height: node.bounds[1],
    locked: node.flags.locked,
    movable: node.flags.draggable,
    resizable: node.flags.resizable,
  });
}

/** What the inspector sets of a window's pose; each left out stays as it is. */
export interface PoseTarget {
  /** Degrees to the right of straight ahead, round the camera. */
  readonly heading?: number | undefined;
  /** World units from the camera across the ground. */
  readonly reach?: number | undefined;
  /** The world height of its centre. */
  readonly y?: number | undefined;
  /** Its frame's width, in world units. */
  readonly width?: number | undefined;
  /** Its frame's height, in world units. */
  readonly height?: number | undefined;
}

/**
 * The one change that poses a window as `target` says, seen from `eye`: a `node.patch` of its
 * transform, its bounds, or both. Moved round the camera, out along the floor or up, it stays
 * inside the room (`Swf.Room`); resized, it keeps its centre. Null when its group's placement
 * cannot be inverted. Throws an Error when there is no such window; the values are the caller's
 * to check.
 */
export function posedPatch(
  scene: SceneState,
  id: Id,
  eye: Vec3,
  target: PoseTarget,
): Extract<SceneCommand, { type: 'node.patch' }> | null {
  const node = scene.nodes.get(id);
  const pose = poseOf(scene, id, eye);
  if (node === undefined || pose === null) {
    throw new Error(`no window "${id}" to pose`);
  }
  const placed =
    target.heading !== undefined || target.reach !== undefined || target.y !== undefined;
  let transform = null;
  if (placed) {
    const now = roomPlaceOf(scene, id, eye);
    const place = models.keepInRoom(ROOM_LIMITS, {
      heading: target.heading === undefined ? now.heading : target.heading / DEGREES,
      floor: target.reach ?? now.floor,
      height: target.y === undefined ? now.height : target.y - eye[1],
    });
    transform = standingInRoom(scene, id, eye, place);
    if (transform === null) {
      return null;
    }
  }
  const sized = target.width !== undefined || target.height !== undefined;
  const [width, height, depth] = node.bounds;
  return {
    type: 'node.patch',
    id,
    ...(transform === null ? {} : { transform }),
    ...(sized ? { bounds: [target.width ?? width, target.height ?? height, depth] as const } : {}),
  };
}
