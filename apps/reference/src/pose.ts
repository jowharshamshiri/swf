import type { Id, SceneCommand, SceneState } from '@swf/core';
import { worldMatrix } from '@swf/core';
import { placementOf, turnedAbout, worldOrigin } from '@swf/interaction';
import type { Vec3 } from '@swf/math';
import { mat4Decompose, mat4FromTransform, mat4Multiply } from '@swf/math';
import { headingPitchOf } from '@swf/projections';
import { placedAt } from './map.js';

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
   * World units from the camera across the ground: how far out it stands, whatever its height.
   * With its heading and its height it says where the window is, each set on its own.
   */
  readonly reach: number;
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
    reach: Math.hypot(x, z),
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

/** What the inspector sets of a window's pose; each left out stays as it is. */
export interface PoseTarget {
  /** Degrees to the right of straight ahead, round the camera. */
  readonly heading?: number | undefined;
  /** World units from the camera across the ground. */
  readonly reach?: number | undefined;
  /** The world height of its centre. */
  readonly y?: number | undefined;
  /** Degrees it is turned to the right from facing the camera. */
  readonly turned?: number | undefined;
  /** Its frame's width and height, in world units. */
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

/**
 * The one change that poses a window as `target` says, seen from `eye`: a `node.patch` of its
 * transform, its bounds, or both. Moved round the camera or out from it, it keeps facing the
 * camera as it did, unless `turned` is given; resized, it keeps its centre. Null when its group's
 * placement cannot be inverted. Throws an Error when there is no such window; the values are the
 * caller's to check.
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
  let local = placementOf(scene, id).local;
  if (placed) {
    const heading = (target.heading ?? pose.heading) / DEGREES;
    const reach = target.reach ?? pose.reach;
    const ground = placedAt(scene, id, eye, {
      x: eye[0] + reach * Math.sin(heading),
      y: target.y,
      z: eye[2] - reach * Math.cos(heading),
    });
    if (ground === null) {
      return null;
    }
    local = ground;
  }
  if (target.turned !== undefined) {
    // Turned about its own centre, from where it now stands, by as much as it is short of the turn.
    const { parentWorld } = placementOf(scene, id);
    const standing = {
      local,
      parentWorld,
      world: mat4Multiply(parentWorld, mat4FromTransform(local)),
    };
    const turned = turnedAbout(
      standing,
      worldOrigin(standing),
      wrapDegrees(target.turned - pose.turned) / DEGREES,
    );
    if (turned === null) {
      return null;
    }
    local = turned;
  }
  const sized = target.width !== undefined || target.height !== undefined;
  const [width, height, depth] = node.bounds;
  return {
    type: 'node.patch',
    id,
    ...(placed || target.turned !== undefined ? { transform: local } : {}),
    ...(sized ? { bounds: [target.width ?? width, target.height ?? height, depth] as const } : {}),
  };
}
