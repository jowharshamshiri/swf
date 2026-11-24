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
 * Each axis takes the nearest snap on it. Only neighbours side by side with the window snap: those
 * whose distance from the camera is within a quarter of its own; farther ones lie behind it.
 * A snap turns the window about the camera, so it keeps its distance and keeps facing the camera
 * as it did. Nothing here touches a scene.
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

/** Neighbours whose distance differs by at most this share of the moving window's lie beside it. */
export const SAME_LAYER = 0.25;

const RADIANS = Math.PI / 180;

/** An angle wrapped to (-π, π]. */
function wrap(angle: number): number {
  const turned = angle - 2 * Math.PI * Math.floor((angle + Math.PI) / (2 * Math.PI));
  return turned === -Math.PI ? Math.PI : turned;
}

/** Where a box is seen from the eye: heading, elevation, distance and angular half sizes. */
interface Seen {
  readonly heading: number;
  readonly elevation: number;
  readonly distance: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

function seen(box: SnapBox, eye: Vec3): Seen | null {
  const [x, y, z] = sub(box.centre, eye);
  const distance = Math.hypot(x, y, z);
  if (!(distance > 0)) {
    return null;
  }
  return {
    heading: Math.atan2(x, -z),
    elevation: Math.atan2(y, Math.hypot(x, z)),
    distance,
    halfWidth: Math.atan2(box.halfWidth, distance),
    halfHeight: Math.atan2(box.halfHeight, distance),
  };
}

interface Candidate {
  readonly delta: number;
  /** Lower ranks win ties: edges, then alignments, then the horizon. */
  readonly rank: number;
  readonly constraint: SnapConstraint;
}

function better(a: Candidate | null, b: Candidate): Candidate {
  if (a === null) {
    return b;
  }
  const da = Math.abs(a.delta);
  const db = Math.abs(b.delta);
  return db < da - 1e-12 || (Math.abs(db - da) <= 1e-12 && b.rank < a.rank) ? b : a;
}

/**
 * The snap for a window proposed at `moving`, among `neighbours` (in a stable order: ties go to
 * the first), as seen from `eye`.
 */
export function resolveSnap(
  moving: SnapBox,
  neighbours: readonly SnapBox[],
  eye: Vec3,
  settings: SnapSettings,
): Snap {
  const m = seen(moving, eye);
  if (m === null) {
    return NO_SNAP;
  }
  const linear = settings.linear / m.distance;
  const pad = settings.padding / m.distance;
  const angular = settings.angular * RADIANS;
  const best: { across: Candidate | null; down: Candidate | null } = { across: null, down: null };
  /** Takes a candidate whose distance (an edge's gap or overlap, or a line-up's offset) is within the threshold. */
  const consider = (
    axis: 'across' | 'down',
    candidate: Candidate,
    distance: number,
    threshold: number,
  ) => {
    if (Math.abs(distance) <= threshold) {
      best[axis] = better(best[axis], candidate);
    }
  };
  for (const neighbour of neighbours) {
    if (neighbour.id === moving.id) {
      continue;
    }
    const n = seen(neighbour, eye);
    if (n === null || Math.abs(n.distance - m.distance) > SAME_LAYER * m.distance) {
      continue;
    }
    const named = { neighbourId: neighbour.id, neighbourLabel: neighbour.label };
    // The neighbour's place relative to the moving window's centre heading.
    const h = wrap(n.heading - m.heading);
    const left = h - n.halfWidth;
    const right = h + n.halfWidth;
    const top = n.elevation + n.halfHeight;
    const bottom = n.elevation - n.halfHeight;
    const rows =
      Math.min(top, m.elevation + m.halfHeight) - Math.max(bottom, m.elevation - m.halfHeight);
    const columns = Math.min(right, m.halfWidth) - Math.max(left, -m.halfWidth);
    if (rows > 0) {
      // Side by side: the moving window's left edge to the neighbour's right, or its right to the left.
      const leftGap = -m.halfWidth - right;
      const rightGap = left - m.halfWidth;
      consider(
        'across',
        { delta: pad - leftGap, rank: 0, constraint: { kind: 'edge', side: 'left', ...named } },
        leftGap,
        linear,
      );
      consider(
        'across',
        { delta: rightGap - pad, rank: 0, constraint: { kind: 'edge', side: 'right', ...named } },
        rightGap,
        linear,
      );
    }
    if (columns > 0) {
      // One above the other: the moving window's bottom edge to the neighbour's top, or its top to the bottom.
      const bottomGap = m.elevation - m.halfHeight - top;
      const topGap = bottom - (m.elevation + m.halfHeight);
      consider(
        'down',
        { delta: pad - bottomGap, rank: 0, constraint: { kind: 'edge', side: 'bottom', ...named } },
        bottomGap,
        linear,
      );
      consider(
        'down',
        { delta: topGap - pad, rank: 0, constraint: { kind: 'edge', side: 'top', ...named } },
        topGap,
        linear,
      );
    }
    const across = { kind: 'align', axis: 'heading', ...named } as const;
    const down = { kind: 'align', axis: 'elevation', ...named } as const;
    consider('across', { delta: h, rank: 1, constraint: across }, h, angular);
    const level = n.elevation - m.elevation;
    consider('down', { delta: level, rank: 1, constraint: down }, level, angular);
  }
  consider(
    'down',
    { delta: -m.elevation, rank: 2, constraint: { kind: 'horizon' } },
    m.elevation,
    angular,
  );
  const chosen = [best.across, best.down].filter((c): c is Candidate => c !== null);
  if (chosen.length === 0) {
    return NO_SNAP;
  }
  return Object.freeze({
    heading: best.across?.delta ?? 0,
    elevation: best.down?.delta ?? 0,
    constraints: Object.freeze(chosen.map((c) => Object.freeze(c.constraint))),
  });
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
