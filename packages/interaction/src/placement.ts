import type { Id, SceneState } from '@swf/core';
import { makeError, SwfFailure, worldMatrix } from '@swf/core';
import type { Mat4, Quat, Transform3D, Vec3 } from '@swf/math';
import {
  add,
  IDENTITY_MAT4,
  mat4Decompose,
  mat4InvertAffine,
  mat4TransformPoint,
  quatFromAxisAngle,
  quatInvert,
  quatMultiply,
  quatNormalize,
  quatRotate,
  sub,
} from '@swf/math';

/** A node's placement: its local transform and the world it lives in. */
export interface Placement {
  /** The node's transform relative to its parent, as the scene holds it. */
  readonly local: Transform3D;
  /** The world matrix of the node's parent (identity for a root). */
  readonly parentWorld: Mat4;
  /** The node's world matrix. */
  readonly world: Mat4;
}

/** The node's placement in `scene`; throws {@link SwfFailure} (`UNKNOWN_ENTITY`) if absent. */
export function placementOf(scene: SceneState, nodeId: Id): Placement {
  const node = scene.nodes.get(nodeId);
  const world = worldMatrix(scene.nodes, nodeId);
  const parentWorld =
    node === undefined || node.parentId === null
      ? IDENTITY_MAT4
      : worldMatrix(scene.nodes, node.parentId);
  if (node === undefined || world === undefined || parentWorld === undefined) {
    throw new SwfFailure(
      makeError('UNKNOWN_ENTITY', `no node "${nodeId}" in this workspace`, { entityId: nodeId }),
    );
  }
  return { local: node.transform, parentWorld, world };
}

/** The node's world origin: the translation of its world matrix. */
export function worldOrigin(placement: Placement): Vec3 {
  return [placement.world[12], placement.world[13], placement.world[14]];
}

/**
 * The local transform that turns the node by `yaw` radians about the world vertical through
 * `pivot`; positive turns to the right (clockwise seen from above). Null when the parent's
 * placement cannot be decomposed or inverted.
 */
export function turnedAbout(placement: Placement, pivot: Vec3, yaw: number): Transform3D | null {
  const toParent = mat4InvertAffine(placement.parentWorld);
  const parent = mat4Decompose(placement.parentWorld);
  if (toParent === null || !parent.ok) {
    return null;
  }
  const q = quatFromAxisAngle([0, 1, 0], -yaw);
  const position = add(pivot, quatRotate(q, sub(worldOrigin(placement), pivot)));
  const p = parent.transform.rotation;
  // World rotation W = P·L turns to Q·W, so the local one becomes P⁻¹·Q·P·L.
  const rotation: Quat = quatNormalize(
    quatMultiply(quatMultiply(quatInvert(p), q), quatMultiply(p, placement.local.rotation)),
  );
  return { ...placement.local, position: mat4TransformPoint(toParent, position), rotation };
}
