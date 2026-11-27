import type { Id, SceneState } from '@swf/core';
import { effectiveState, worldMatrix } from '@swf/core';
import type { RoomPlace } from '@swf/interaction';
import { ROOM_LIMITS, roomPlaceOf } from '@swf/interaction';
import type { Vec3 } from '@swf/math';
import type * as Lean from '@swf/models';
import { models } from '@swf/models';
import type { Representation } from '@swf/presentation';
import { windowCard } from '@swf/presentation';
import type { DepthBands, SnapSettings } from './features.js';
import { SNAP_SPACING } from './features.js';
import { representationAt } from './semantic-depth.js';

/**
 * Magnetic positioning, worked out around the camera. Windows in a panorama stand around the
 * viewer, so where a window is means its heading and elevation seen from the camera, and how far
 * away it is. A window being moved snaps, within the thresholds, to the windows beside it:
 * - an edge within the snap distance of a neighbour's facing edge (short of it or over it) goes
 *   to that edge, leaving the padding between them, so windows that nearly touch or slightly
 *   overlap end side by side with the gap: the linear threshold, in world units at the moving
 *   window's distance;
 * - its centre's heading or elevation to a neighbour's, its elevation to the horizon, or its
 *   heading to a spoke round the camera (every so many degrees): the angular threshold, in degrees;
 * - its distance from the camera along the floor to a ring ({@link SNAP_RINGS}): the ring threshold, in world units.
 * Each axis (across, down, out) takes the nearest snap on it; at the same distance edges win over
 * line-ups, line-ups over the horizon, the spokes and the rings, and then the first neighbour. Only neighbours side by side with the window
 * snap: those whose distance from the camera is within a quarter of its own; farther ones lie
 * behind it. The snap is decided by the Lean model `Swf.AppSnap` (models/Swf/AppSnap.lean),
 * where it is proved to be the nearest within reach; this module measures where the windows stand
 * in the room and the angles their cards span, and moves the window round the camera, up or down
 * and along the floor by the snap, inside the room. A window the snap put on a spoke is kept clear
 * of the windows near it on the floor when it is dropped ({@link spacedPlace}, decided by
 * `Swf.AppSpacing`).
 * Nothing here touches a scene.
 */

/** A window as snapping sees it: where it stands in the room, and the angles its card spans. */
export interface SnapBox {
  /** The window's ID. */
  readonly id: Id;
  /** Its name. */
  readonly label: string;
  /** Where it stands in the room. */
  readonly place: RoomPlace;
  /** Half the angle its card spans across, in radians, as the view draws it. */
  readonly halfWidth: number;
  /** Half the angle its card spans up and down, in radians, as the view draws it. */
  readonly halfHeight: number;
}

/**
 * How the view a window is snapped in draws its cards: its size in CSS pixels, the angles it spans
 * across and down in degrees, and semantic depth's bands when the view represents windows by
 * distance (null when it shows every window in full).
 */
export interface CardMeasure {
  /** The view's width, in CSS pixels. */
  readonly width: number;
  /** The view's height, in CSS pixels. */
  readonly height: number;
  /** The angle the view spans across, in degrees. */
  readonly horizontal: number;
  /** The angle the view spans down, in degrees. */
  readonly vertical: number;
  /** Semantic depth's bands, or null when every window is shown in full. */
  readonly depth: DepthBands | null;
}

/** A snap in force: what the moving window lines up with. */
export type SnapConstraint =
  | {
      /** An edge against a neighbour's. */
      readonly kind: 'edge';
      /** The moving window's edge that snapped. */
      readonly side: 'left' | 'right' | 'top' | 'bottom';
      /** The neighbour's ID. */
      readonly neighbourId: Id;
      /** The neighbour's name. */
      readonly neighbourLabel: string;
    }
  | {
      /** Its centre lined up with a neighbour's. */
      readonly kind: 'align';
      /** Which way: in heading or in elevation. */
      readonly axis: 'heading' | 'elevation';
      /** The neighbour's ID. */
      readonly neighbourId: Id;
      /** The neighbour's name. */
      readonly neighbourLabel: string;
    }
  | {
      /** Its centre on the horizon. */
      readonly kind: 'horizon';
    }
  | {
      /** Its heading on a spoke round the camera. */
      readonly kind: 'spoke';
      /** The spoke, in degrees right of straight ahead. */
      readonly degrees: number;
    }
  | {
      /** Its distance on a ring round the camera. */
      readonly kind: 'ring';
      /** The ring, in world units from the camera. */
      readonly distance: number;
    };

/** The snap for a proposed place: how far to turn the window, in radians, and move it, and why. */
export interface Snap {
  /** To the right about the camera's vertical. */
  readonly heading: number;
  /** Up about the camera. */
  readonly elevation: number;
  /** Away from the camera, in world units. */
  readonly distance: number;
  /** What it lines up with. */
  readonly constraints: readonly SnapConstraint[];
}

/** No snap: nothing moves, nothing lines up. */
export const NO_SNAP: Snap = Object.freeze({
  heading: 0,
  elevation: 0,
  distance: 0,
  constraints: Object.freeze([]),
});

/** A box as the snap model sees it: its heading, elevation and floor distance, and its card's angles. */
function seen(box: SnapBox): Lean.SnapSeen {
  return {
    heading: box.place.heading,
    elevation: models.elevationOf(box.place),
    distance: box.place.floor,
    halfWidth: box.halfWidth,
    halfHeight: box.halfHeight,
  };
}

/**
 * The snap for a window proposed at `moving`, among `neighbours` (in a stable order: ties go to
 * the first) and the `rings` (distances along the floor, in world units). Throws a RangeError when
 * a number it weighs is not finite.
 */
export function resolveSnap(
  moving: SnapBox,
  neighbours: readonly SnapBox[],
  settings: SnapSettings,
  rings: readonly number[],
): Snap {
  const m = seen(moving);
  const outcome = models.snapResolve(
    moving.id,
    m,
    neighbours.map((neighbour) => ({ id: neighbour.id, seen: seen(neighbour) })),
    {
      linear: settings.linear,
      angular: settings.angular,
      padding: settings.padding,
      spoke: settings.spoke,
      ring: settings.ring,
    },
    [...rings],
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
        if (c.kind === 'spoke') {
          return Object.freeze({
            kind: 'spoke',
            degrees: ((m.heading + candidate.delta) * 180) / Math.PI,
          });
        }
        if (c.kind === 'ring') {
          const ring = rings[Number(c.ring)];
          if (ring === undefined) {
            throw new Error(`the snap names ring ${String(c.ring)}, which is not given`);
          }
          return Object.freeze({ kind: 'ring', distance: ring });
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
      const chosen = [outcome.across, outcome.down, outcome.out].filter(
        (c): c is Lean.SnapCandidate => c !== null,
      );
      return Object.freeze({
        heading: outcome.across?.delta ?? 0,
        elevation: outcome.down?.delta ?? 0,
        distance: outcome.out?.delta ?? 0,
        constraints: Object.freeze(chosen.map(constraintOf)),
      });
    }
  }
}

/**
 * Where a window proposed at `place` stands once a snap has turned it round the camera, raised or
 * lowered it to the elevation the snap gives (at its floor distance), and moved it along the floor
 * by the snap's distance; inside the room.
 */
export function snappedPlace(place: RoomPlace, snap: Snap): RoomPlace {
  const floor = place.floor + snap.distance;
  const elevation = models.elevationOf(place) + snap.elevation;
  return models.keepInRoom(ROOM_LIMITS, {
    heading: place.heading + snap.heading,
    floor,
    height: floor * Math.tan(elevation),
  });
}

/** Where a snapped window stands, and the snap that put it there. */
export interface SnappedPlace {
  /** Where it stands, inside the room. */
  readonly place: RoomPlace;
  /** The snap in force there: what it lines up with, the spoke it ends on included. */
  readonly snap: Snap;
}

/**
 * Where a window dropped at `snapped`, the place `snap` gave it, stands kept clear of `others`:
 * when the snap put it on a spoke and another window stands nearer than {@link SNAP_SPACING} to it
 * along the floor, it goes on to the first clear spoke of the ones beside, tried left and right in
 * turn, or stays where its snap put it when none is clear (`Swf.AppSpacing`). The snap given back
 * says the spoke it ends on. A move applies it when it ends, not while it goes, so a window being
 * dragged never hops away from the pointer.
 */
export function spacedPlace(
  snapped: RoomPlace,
  snap: Snap,
  others: readonly SnapBox[],
  settings: SnapSettings,
): SnappedPlace {
  if (!(settings.spoke > 0) || !snap.constraints.some((c) => c.kind === 'spoke')) {
    return { place: snapped, snap };
  }
  const heading = models.spacedHeading(
    SNAP_SPACING,
    (settings.spoke * Math.PI) / 180,
    others.map((o) => ({
      x: o.place.floor * Math.sin(o.place.heading),
      z: -o.place.floor * Math.cos(o.place.heading),
    })),
    snapped.floor,
    snapped.heading,
  );
  if (heading === snapped.heading) {
    return { place: snapped, snap };
  }
  const turned = heading - snapped.heading;
  return {
    place: models.keepInRoom(ROOM_LIMITS, { ...snapped, heading }),
    snap: Object.freeze({
      ...snap,
      heading: snap.heading + turned,
      constraints: Object.freeze(
        snap.constraints.map((c) =>
          c.kind === 'spoke'
            ? Object.freeze({ ...c, degrees: c.degrees + (turned * 180) / Math.PI })
            : c,
        ),
      ),
    }),
  };
}

/**
 * How a viewport draws its cards: its size and the angles its equirectangular projection spans,
 * with semantic depth's `depth` bands when it represents windows by distance. Throws an Error for
 * a viewport that is not there or not shown equirectangularly.
 */
export function cardMeasureOf(
  scene: SceneState,
  viewportId: Id,
  depth: DepthBands | null,
): CardMeasure {
  const viewport = scene.viewports.get(viewportId);
  const config = viewport?.projection.config as Readonly<Record<string, unknown>> | undefined;
  const horizontal = config?.['horizontal'];
  const vertical = config?.['vertical'];
  if (viewport === undefined || typeof horizontal !== 'number' || typeof vertical !== 'number') {
    throw new Error(`viewport "${viewportId}" is not shown by an equirectangular projection`);
  }
  return Object.freeze({
    width: viewport.size.width,
    height: viewport.size.height,
    horizontal,
    vertical,
    depth,
  });
}

/**
 * The windows a moving one may snap to, in ID order: every other window shown in the scene, not
 * the moving window's own descendants, each measured as `measure` draws it round `eye`.
 */
export function snapNeighbours(
  scene: SceneState,
  movingId: Id,
  eye: Vec3,
  measure: CardMeasure,
): SnapBox[] {
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
    const box = boxOf(scene, id, eye, measure);
    if (box !== null) {
      boxes.push(box);
    }
  }
  return boxes;
}

/**
 * A window as snapping sees it round `eye`: at `place` (where it stands, when not given), its card
 * as `measure` draws it there (represented by semantic depth's bands along the floor, when the
 * view represents windows by distance); null when it has no placement.
 */
export function boxOf(
  scene: SceneState,
  id: Id,
  eye: Vec3,
  measure: CardMeasure,
  place?: RoomPlace,
): SnapBox | null {
  const node = scene.nodes.get(id);
  const world = worldMatrix(scene.nodes, id);
  if (node === undefined || world === undefined) {
    return null;
  }
  const at = place ?? roomPlaceOf(scene, id, eye);
  // Represented as semantic depth represents it, by its distance along the floor.
  const representation: Representation =
    measure.depth === null ? 'full' : representationAt(at.floor, measure.depth);
  const card = windowCard({
    bounds: [node.bounds[0], node.bounds[1]],
    worldScale: [
      Math.hypot(world[0], world[1], world[2]),
      Math.hypot(world[4], world[5], world[6]),
    ],
    floor: at.floor,
    representation,
    fieldOfView: measure.horizontal,
    semantic: measure.depth !== null,
  });
  const radians = Math.PI / 180;
  return Object.freeze({
    id,
    label: node.label ?? id,
    place: at,
    halfWidth: ((card.width / 2) * measure.horizontal * radians) / measure.width,
    halfHeight: ((card.height / 2) * measure.vertical * radians) / measure.height,
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
