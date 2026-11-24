import type { Id, SceneState } from '@swf/core';
import { worldMatrix } from '@swf/core';
import type { Vec3 } from '@swf/math';
import { mat4Decompose } from '@swf/math';
import { headingPitchOf } from '@swf/projections';

/**
 * Where a window is around the camera and how it stands, as an operator reads it: what the
 * inspector shows, what is announced when it changes, and what the inspector's exact entries set.
 */
export interface Pose {
  /** Degrees to the right of straight ahead, from −180 to 180. */
  readonly heading: number;
  /** Degrees above the horizon. */
  readonly elevation: number;
  /** World units from the camera. */
  readonly distance: number;
  /**
   * Degrees it is turned to the right from facing the camera, from −180 to 180: 0 when it faces
   * the camera squarely.
   */
  readonly turned: number;
  /** Its world position. */
  readonly position: Vec3;
  /** Its frame's width and height, in world units. */
  readonly width: number;
  readonly height: number;
  readonly locked: boolean;
  readonly movable: boolean;
  readonly rotatable: boolean;
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
  const decomposed = mat4Decompose(world);
  if (!decomposed.ok) {
    throw new Error(`window "${id}" has a placement that is not a rotation and a scale`);
  }
  const position: Vec3 = [world[12], world[13], world[14]];
  const [x, y, z] = [position[0] - eye[0], position[1] - eye[1], position[2] - eye[2]];
  const heading = Math.atan2(x, -z) * DEGREES;
  const yaw = headingPitchOf(decomposed.transform.rotation).heading * DEGREES;
  return Object.freeze({
    heading: wrapDegrees(heading),
    elevation: Math.atan2(y, Math.hypot(x, z)) * DEGREES,
    distance: Math.hypot(x, y, z),
    turned: wrapDegrees(yaw - heading),
    position,
    width: node.bounds[0],
    height: node.bounds[1],
    locked: node.flags.locked,
    movable: node.flags.draggable,
    rotatable: node.flags.rotatable,
    resizable: node.flags.resizable,
  });
}
