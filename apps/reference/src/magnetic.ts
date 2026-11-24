import type { Id, SceneState } from '@swf/core';
import { effectiveState, worldMatrix } from '@swf/core';
import type { Placement } from '@swf/interaction';
import type { Mat4, Transform3D, Vec3 } from '@swf/math';
import {
  add,
  cross,
  dot,
  length,
  mat4Decompose,
  mat4FromTransform,
  mat4InvertAffine,
  mat4Multiply,
  normalize,
  quatFromAxisAngle,
  quatMultiply,
  quatNormalize,
  quatRotate,
  sub,
} from '@swf/math';
import type * as Lean from '@swf/models';
import { models } from '@swf/models';
import type { SnapSettings } from './features.js';

/**
 * Magnetic positioning, worked out around the camera. Windows in a panorama stand around the
 * viewer, so where a window is means its heading and elevation seen from the camera, and how far
 * away it is. A window being moved snaps, within the thresholds, to the windows beside it:
 * - an edge within the snap distance of a neighbour's facing edge (short of it or over it) goes
 *   to that edge, leaving the padding between them, so windows that nearly touch or slightly
 *   overlap end side by side with the gap: the linear threshold, in world units at the moving
 *   window's distance;
 * - its centre's heading or elevation to a neighbour's, or its elevation to the horizon: the
 *   angular threshold, in degrees.
 * Each axis takes the nearest snap on it; at the same distance edges win over line-ups, line-ups
 * over the horizon, and then the first neighbour. Only neighbours side by side with the window
 * snap: those whose distance from the camera is within a quarter of its own; farther ones lie
 * behind it. The snap is decided by the Lean model `Swf.AppSnap` (models/Swf/AppSnap.lean),
 * where it is proved to be the nearest within reach; this module measures where the windows are
 * seen from the camera, and turns the window by the snap: it keeps its distance and keeps facing
 * the camera as it did. Nothing here touches a scene.
 */

/** A window as snapping sees it. */
export interface SnapBox {
  readonly id: Id;
  readonly label: string;
  /** World centre. */
  readonly centre: Vec3;
  /** Half its width and height, in world units. */
  readonly halfWidth: number;
  readonly halfHeight: number;
}

/** A snap in force: what the moving window lines up with. */
export type SnapConstraint =
  | {
      readonly kind: 'edge';
      /** The moving window's edge that snapped. */
      readonly side: 'left' | 'right' | 'top' | 'bottom';
      readonly neighbourId: Id;
      readonly neighbourLabel: string;
    }
  | {
      readonly kind: 'align';
      readonly axis: 'heading' | 'elevation';
      readonly neighbourId: Id;
      readonly neighbourLabel: string;
    }
  | { readonly kind: 'horizon' };

/** The snap for a proposed place: how far to turn the window, in radians, and why. */
export interface Snap {
  /** To the right about the camera's vertical. */
  readonly heading: number;
  /** Up about the camera. */
  readonly elevation: number;
  readonly constraints: readonly SnapConstraint[];
}

export const NO_SNAP: Snap = Object.freeze({
  heading: 0,
  elevation: 0,
  constraints: Object.freeze([]),
});

/** A box as seen from the eye: its centre's heading, elevation and distance, and its angular half sizes. */
function seen(box: SnapBox, eye: Vec3): Lean.SnapSeen {
  const [x, y, z] = sub(box.centre, eye);
  const distance = Math.hypot(x, y, z);
  return {
    heading: Math.atan2(x, -z),
    elevation: Math.atan2(y, Math.hypot(x, z)),
    distance,
    halfWidth: Math.atan2(box.halfWidth, distance),
    halfHeight: Math.atan2(box.halfHeight, distance),
  };
}

/**
 * The snap for a window proposed at `moving`, among `neighbours` (in a stable order: ties go to
 * the first), as seen from `eye`. Throws a RangeError when a number it weighs is not finite.
 */
export function resolveSnap(
  moving: SnapBox,
  neighbours: readonly SnapBox[],
  eye: Vec3,
  settings: SnapSettings,
): Snap {
  const outcome = models.snapResolve(
    moving.id,
    seen(moving, eye),
    neighbours.map((neighbour) => ({ id: neighbour.id, seen: seen(neighbour, eye) })),
    { linear: settings.linear, angular: settings.angular, padding: settings.padding },
  );
  switch (outcome.kind) {
    case 'invalid':
      throw new RangeError(`magnetic positioning weighs finite numbers; ${outcome.field} is not`);
    case 'unsnapped':
      return NO_SNAP;
    case 'snapped': {
      const constraintOf = (candidate: Lean.SnapCandidate): SnapConstraint => {
        const c = candidate.constraint;
        if (c.kind === 'horizon') {
          return Object.freeze({ kind: 'horizon' });
        }
        const neighbour = neighbours[Number(c.neighbour)];
        if (neighbour === undefined) {
          throw new Error(`the snap names neighbour ${String(c.neighbour)}, which is not given`);
        }
        const named = { neighbourId: neighbour.id, neighbourLabel: neighbour.label };
        return Object.freeze(
          c.kind === 'edge'
            ? { kind: 'edge', side: c.side.kind, ...named }
            : { kind: 'align', axis: c.line.kind, ...named },
        );
      };
      const chosen = [outcome.across, outcome.down].filter(
        (c): c is Lean.SnapCandidate => c !== null,
      );
      return Object.freeze({
        heading: outcome.across?.delta ?? 0,
        elevation: outcome.down?.delta ?? 0,
        constraints: Object.freeze(chosen.map(constraintOf)),
      });
    }
  }
}

/** The direction seen at a heading and elevation. */
function direction(heading: number, elevation: number): Vec3 {
  return [
    Math.cos(elevation) * Math.sin(heading),
    Math.sin(elevation),
    -Math.cos(elevation) * Math.cos(heading),
  ];
}

/**
 * The local transform of a window placed at `world` (its proposed world matrix, under the parent
 * of `placement`) once a snap has turned it about the eye: the shortest turn that takes its centre
 * from where it is seen to where the snap puts it, so it keeps its distance and its facing. Null
 * when the parent's placement cannot be inverted or decomposed.
 */
export function snappedTransform(
  placement: Placement,
  world: Mat4,
  eye: Vec3,
  snap: Snap,
): Transform3D | null {
  const toParent = mat4InvertAffine(placement.parentWorld);
  const centre: Vec3 = [world[12], world[13], world[14]];
  const offset = sub(centre, eye);
  const distance = length(offset);
  if (toParent === null || !(distance > 0)) {
    return null;
  }
  const from = normalize(offset);
  const heading = Math.atan2(from[0], -from[2]);
  const elevation = Math.atan2(from[1], Math.hypot(from[0], from[2]));
  const to = direction(heading + snap.heading, elevation + snap.elevation);
  const axis = cross(from, to);
  const sine = length(axis);
  const angle = Math.atan2(sine, dot(from, to));
  const turn = sine < 1e-12 ? null : quatFromAxisAngle(normalize(axis), angle);
  const decomposed = mat4Decompose(world);
  if (!decomposed.ok) {
    return null;
  }
  const placed = decomposed.transform;
  const snappedWorld =
    turn === null
      ? world
      : mat4FromTransform({
          position: add(eye, quatRotate(turn, offset)),
          rotation: quatNormalize(quatMultiply(turn, placed.rotation)),
          scale: placed.scale,
        });
  const local = mat4Decompose(mat4Multiply(toParent, snappedWorld));
  return local.ok ? local.transform : null;
}

/** The world matrix of a node placed at a local transform under its parent. */
export function worldAt(placement: Placement, local: Transform3D): Mat4 {
  return mat4Multiply(placement.parentWorld, mat4FromTransform(local));
}

/**
 * The windows a moving one may snap to, in ID order: every other window shown in the scene, not
 * the moving window's own descendants.
 */
export function snapNeighbours(scene: SceneState, movingId: Id): SnapBox[] {
  const boxes: SnapBox[] = [];
  const nodes = [...scene.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const node of nodes) {
    const id = node.id;
    if (
      id === movingId ||
      node.kind !== 'window' ||
      node.status !== 'active' ||
      effectiveState(scene.nodes, id)?.visible !== true ||
      descends(scene, id, movingId)
    ) {
      continue;
    }
    const box = boxOf(scene, id);
    if (box !== null) {
      boxes.push(box);
    }
  }
  return boxes;
}

/** A node as snapping sees it, from its world placement; null when it has none. */
export function boxOf(scene: SceneState, id: Id, world?: Mat4): SnapBox | null {
  const node = scene.nodes.get(id);
  const matrix = world ?? worldMatrix(scene.nodes, id);
  if (node === undefined || matrix === undefined) {
    return null;
  }
  const scaleX = Math.hypot(matrix[0], matrix[1], matrix[2]);
  const scaleY = Math.hypot(matrix[4], matrix[5], matrix[6]);
  return Object.freeze({
    id,
    label: node.label ?? id,
    centre: [matrix[12], matrix[13], matrix[14]] as Vec3,
    halfWidth: (node.bounds[0] * scaleX) / 2,
    halfHeight: (node.bounds[1] * scaleY) / 2,
  });
}

function descends(scene: SceneState, id: Id, ancestorId: Id): boolean {
  let parent = scene.nodes.get(id)?.parentId ?? null;
  while (parent !== null) {
    if (parent === ancestorId) {
      return true;
    }
    parent = scene.nodes.get(parent)?.parentId ?? null;
  }
  return false;
}
