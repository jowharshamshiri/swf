import type {
  Id,
  NodeRecord,
  SceneCommand,
  SceneState,
  TxResult,
  WorkspaceMutator,
  WorkspaceReader,
} from '@swf/core';
import { effectiveState, worldMatrix } from '@swf/core';
import type { RoomPlace } from '@swf/interaction';
import {
  placementOf,
  ROOM_LIMITS,
  roomPlaceOf,
  standingInRoom,
  worldOrigin,
} from '@swf/interaction';
import { models } from '@swf/models';
import type { Transform3D, Vec3 } from '@swf/math';
import { partOf } from './composition.js';
import type { SnapSettings } from './features.js';
import type { CardMeasure, Snap, SnapBox } from './magnetic.js';
import {
  boxOf,
  NO_SNAP,
  resolveSnap,
  snapNeighbours,
  snappedPlace,
  spacedPlace,
} from './magnetic.js';
import type { ViewGeometry } from '@swf/presentation';
import { viewGeometryOf } from '@swf/presentation';
import type { GeometryOf, Projection, ProjectionModule } from '@swf/projections';
import { headingPitchOf, projectionFor, projectorOf } from '@swf/projections';

/**
 * The spatial map: the scene seen from above. A window is a marker where it stands on the ground
 * plane (world X across, world Z down the page, so straight ahead of the default camera, -Z, is
 * up), the camera a marker with its heading, and the ground split into what lies in front of the
 * camera and what lies behind it. Moving a marker moves the window in the world, as one scene
 * transaction; the map's own placement (its centre and scale) is view state of its own.
 */

/** How the map is laid on the screen. */
export interface MapView {
  /** The world X and Z at the map's centre. */
  readonly centre: readonly [number, number];
  /** CSS pixels per world unit. */
  readonly scale: number;
  /** The map's width in CSS pixels. */
  readonly width: number;
  /** The map's height in CSS pixels. */
  readonly height: number;
}

/** How far the map zooms, in CSS pixels per world unit, and by what factor a step zooms it. */
export const MAP_SCALE: {
  /** The farthest out. */
  readonly min: number;
  /** The nearest in. */
  readonly max: number;
  /** The factor one step of zoom multiplies or divides by. */
  readonly step: number;
} = Object.freeze({ min: 8, max: 480, step: 1.25 });

/** Where a world point on the ground plane (X, Z) is on the map. */
export function toMap(view: MapView, x: number, z: number): [number, number] {
  return [
    view.width / 2 + (x - view.centre[0]) * view.scale,
    view.height / 2 + (z - view.centre[1]) * view.scale,
  ];
}

/** The ground-plane world point (X, Z) under a map point. */
export function toGround(view: MapView, px: number, py: number): [number, number] {
  return [
    view.centre[0] + (px - view.width / 2) / view.scale,
    view.centre[1] + (py - view.height / 2) / view.scale,
  ];
}

/** The view zoomed by a factor about a map point, which stays over the same ground; clamped. */
export function zoomed(view: MapView, factor: number, px: number, py: number): MapView {
  const scale = Math.min(MAP_SCALE.max, Math.max(MAP_SCALE.min, view.scale * factor));
  const [x, z] = toGround(view, px, py);
  return {
    ...view,
    scale,
    centre: [x - (px - view.width / 2) / scale, z - (py - view.height / 2) / scale],
  };
}

/** The camera as the map shows it. */
export interface MapCamera {
  /** Its world X. */
  readonly x: number;
  /** Its world Z. */
  readonly z: number;
  /** Radians right of straight ahead (-Z). */
  readonly heading: number;
}

/** A window as the map shows it. */
export interface MapMarker {
  /** The window's ID. */
  readonly id: Id;
  /** Its name. */
  readonly label: string;
  /** Its centre's world X. */
  readonly x: number;
  /** Its centre's world height. */
  readonly y: number;
  /** Its centre's world Z. */
  readonly z: number;
  /** The ends of the window's width on the ground plane: the line it stands on, from above. */
  readonly ends: readonly [readonly [number, number], readonly [number, number]];
  /** In front of the camera's heading, or behind it. */
  readonly side: 'front' | 'behind';
  /** World units from the camera on the ground plane. */
  readonly distance: number;
  /** Shown, as its own and its groups' visibility have it. */
  readonly visible: boolean;
  /** Selected. */
  readonly selected: boolean;
  /** Focused. */
  readonly focused: boolean;
  /** The window it is a part of ({@link partOf}), or null for one that is no part. */
  readonly partOf: Id | null;
}

/** The scene from above: the camera and every active window. */
export interface MapScene {
  /** The camera. */
  readonly camera: MapCamera;
  /** Every active window, in scene order. */
  readonly markers: readonly MapMarker[];
}

/**
 * The scene from above, as the viewport's camera sees it: every active window, in scene order, with
 * the window it is a part of read under the host's `partKey`.
 */
export function mapScene(state: SceneState, viewportId: Id, partKey: string): MapScene {
  const viewport = state.viewports.get(viewportId);
  const camera = viewport === undefined ? undefined : state.cameras.get(viewport.cameraId);
  if (camera === undefined) {
    throw new Error(`viewport "${viewportId}" has no camera`);
  }
  const { heading } = headingPitchOf(camera.rotation);
  const [ex, , ez] = camera.position;
  const ahead: [number, number] = [Math.sin(heading), -Math.cos(heading)];
  const markers: MapMarker[] = [];
  for (const node of state.nodes.values()) {
    const effective = effectiveState(state.nodes, node.id);
    if (node.kind !== 'window' || effective?.active !== true) {
      continue;
    }
    const world = worldMatrix(state.nodes, node.id);
    if (world === undefined) {
      continue;
    }
    const [x, y, z] = [world[12], world[13], world[14]];
    // The window's own X axis carries its width (scale included) across the world.
    const half: [number, number] = [
      (world[0] * node.bounds[0]) / 2,
      (world[2] * node.bounds[0]) / 2,
    ];
    const dx = x - ex;
    const dz = z - ez;
    markers.push({
      id: node.id,
      label: node.label ?? node.id,
      x,
      y,
      z,
      ends: [
        [x - half[0], z - half[1]],
        [x + half[0], z + half[1]],
      ],
      side: dx * ahead[0] + dz * ahead[1] >= 0 ? 'front' : 'behind',
      distance: Math.hypot(dx, dz),
      visible: effective.visible,
      selected: state.selection.includes(node.id),
      focused: state.focusedId === node.id,
      partOf: partOf(node, partKey),
    });
  }
  return { camera: { x: ex, z: ez, heading }, markers };
}

/**
 * Whether the viewport shows any of a window now, its card as the projection places it, shown in
 * full: false for one wholly outside the view (behind the camera when the field of view is narrow,
 * say). `geometry` gives each surface's geometry as placed in `state`.
 */
export function inView(
  state: SceneState,
  viewportId: Id,
  projections: { get(id: string): ProjectionModule | undefined },
  geometry: GeometryOf,
  nodeId: Id,
): boolean {
  const view = viewGeometryOf(state, viewportId);
  const module = projections.get(view.projectionId);
  const node = state.nodes.get(nodeId);
  if (module === undefined || node === undefined) {
    throw new Error(`window "${nodeId}" cannot be placed in the view`);
  }
  const surfaces = new Set(node.surfaceIds);
  return projectorOf(module)
    .project(state, view, geometry, null)
    .some((f) => surfaces.has(f.surfaceId));
}

/**
 * How far from the camera the radar reaches along the floor, in world units: just past the room's
 * farthest place (`ROOM_LIMITS.farthest`), so every window is within its rim, wherever it stands.
 */
export const MAP_REACH = 14;

/**
 * The view that lays a radar out: centred on the camera, at the scale that brings
 * {@link MAP_REACH} to its rim, `margin` pixels inside the smaller side.
 */
export function radarView(scene: MapScene, width: number, height: number, margin: number): MapView {
  const radius = Math.max(1, Math.min(width, height) / 2 - margin);
  return {
    centre: [scene.camera.x, scene.camera.z],
    scale: radius / MAP_REACH,
    width,
    height,
  };
}

/** How far inside a map's smaller side the room's reach comes, in CSS pixels. */
const MAP_MARGIN = 12;

/**
 * The view a map starts with, `width` by `height` CSS pixels: centred on the world's origin, at the
 * scale that holds the whole room ({@link MAP_REACH} along the floor) inside its smaller side,
 * 12 pixels in, within {@link MAP_SCALE}'s range.
 */
export function roomMapView(width: number, height: number): MapView {
  const radius = Math.max(1, Math.min(width, height) / 2 - MAP_MARGIN);
  const scale = Math.min(MAP_SCALE.max, Math.max(MAP_SCALE.min, radius / MAP_REACH));
  return { centre: [0, 0], scale, width, height };
}

/** The distance between rings for a reach: 1, 2 or 5 times a power of ten, four rings or so. */
export function ringStep(reach: number): number {
  const rough = reach / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  const steps = [1, 2, 5, 10].map((n) => n * power);
  return steps.find((step) => step >= rough) ?? 10 * power;
}

/** The marker nearest a map point within `reach` pixels, the selected one first on a tie. */
export function markerAt(
  view: MapView,
  scene: MapScene,
  px: number,
  py: number,
  reach: number,
): MapMarker | null {
  let best: { marker: MapMarker; distance: number } | null = null;
  for (const marker of scene.markers) {
    const [mx, my] = toMap(view, marker.x, marker.z);
    const distance = Math.hypot(mx - px, my - py);
    if (
      distance <= reach &&
      (best === null ||
        distance < best.distance ||
        (distance === best.distance && marker.selected && !best.marker.selected))
    ) {
      best = { marker, distance };
    }
  }
  return best?.marker ?? null;
}

/**
 * The local transform that stands a window at a ground point (X, Z), keeping its height, inside
 * the room round `eye` (`Swf.Room`'s floor drop). Null when its parent's placement cannot be
 * inverted.
 */
export function standingAt(
  state: SceneState,
  nodeId: Id,
  eye: Vec3,
  x: number,
  z: number,
): Transform3D | null {
  const at = roomPlaceOf(state, nodeId, eye);
  const place = models.floorDrop(ROOM_LIMITS, at, x - eye[0], z - eye[2]);
  return standingInRoom(state, nodeId, eye, place);
}

/**
 * The local transform that puts a window at a world position: on the ground at (X, Z) as
 * {@link standingAt} stands it, and at height Y; each left out stays as it is, and the window stays
 * inside the room. Null when its parent's placement cannot be inverted.
 */
export function placedAt(
  state: SceneState,
  nodeId: Id,
  eye: Vec3,
  at: {
    readonly x?: number | undefined;
    readonly y?: number | undefined;
    readonly z?: number | undefined;
  },
): Transform3D | null {
  const now = roomPlaceOf(state, nodeId, eye);
  const height = at.y === undefined ? now : { ...now, height: at.y - eye[1] };
  const place =
    at.x === undefined || at.z === undefined
      ? models.keepInRoom(ROOM_LIMITS, height)
      : models.floorDrop(ROOM_LIMITS, height, at.x - eye[0], at.z - eye[2]);
  return standingInRoom(state, nodeId, eye, place);
}

/** Straight ahead of the camera, or straight behind it: where a quick action puts a window. */
export type AroundSide = 'front' | 'behind';

/**
 * The local transform that puts a window straight ahead of the camera's heading, or straight
 * behind it, at the distance it stands from the camera along the floor and at its own height
 * ({@link standingAt}). Null when its parent's
 * placement cannot be inverted. Throws a RangeError for a window standing at the camera, which has
 * no distance to keep.
 */
export function aroundCamera(
  state: SceneState,
  nodeId: Id,
  viewportId: Id,
  side: AroundSide,
): Transform3D | null {
  const viewport = state.viewports.get(viewportId);
  const camera = viewport === undefined ? undefined : state.cameras.get(viewport.cameraId);
  if (camera === undefined) {
    throw new Error(`viewport "${viewportId}" has no camera`);
  }
  const eye = camera.position;
  const origin = worldOrigin(placementOf(state, nodeId));
  const distance = Math.hypot(origin[0] - eye[0], origin[2] - eye[2]);
  if (distance === 0) {
    throw new RangeError(`window "${nodeId}" stands at the camera: it has no distance to keep`);
  }
  const heading = headingPitchOf(camera.rotation).heading + (side === 'behind' ? Math.PI : 0);
  return standingAt(
    state,
    nodeId,
    eye,
    eye[0] + distance * Math.sin(heading),
    eye[2] - distance * Math.cos(heading),
  );
}

/** Heights above the eye of the near, middle and far rings, in world units: the far ones higher. */
const RING_RISE = Object.freeze([-0.48, 0, 0.48]);

/**
 * The commands that arrange the windows round the camera, as one change: every window standing on
 * its own (not one nested in another window) that is not locked, in order of what it shows, then
 * the host's key for it (`keyOf`, such as its colour), then its name, spread evenly round the
 * whole circle from straight ahead of the camera, and laid in turn on three rings at the `rings`
 * distances along the floor (near, middle, far), the farther a little higher. Locked windows keep
 * their places. Throws a RangeError for a ring distance that is not
 * positive and finite, or rings not nearest first; an Error for a window whose group's placement
 * cannot be inverted.
 */
export function arrangedAround(
  state: SceneState,
  viewportId: Id,
  rings: readonly [number, number, number],
  keyOf: (node: NodeRecord) => string,
): SceneCommand[] {
  if (!rings.every((r, i) => Number.isFinite(r) && r > 0 && (i === 0 || r > (rings[i - 1] ?? 0)))) {
    throw new RangeError(
      `rings must be positive distances, nearest first (got ${rings.join(', ')})`,
    );
  }
  const viewport = state.viewports.get(viewportId);
  const camera = viewport === undefined ? undefined : state.cameras.get(viewport.cameraId);
  if (camera === undefined) {
    throw new Error(`viewport "${viewportId}" has no camera`);
  }
  const eye = camera.position;
  const start = headingPitchOf(camera.rotation).heading;
  const windows = [...state.nodes.values()].filter((node) => {
    if (node.kind !== 'window' || node.flags.locked) {
      return false;
    }
    if (effectiveState(state.nodes, node.id)?.active !== true) {
      return false;
    }
    // A window inside another window moves with it.
    for (let up = node.parentId; up !== null; up = state.nodes.get(up)?.parentId ?? null) {
      if (state.nodes.get(up)?.kind === 'window') {
        return false;
      }
    }
    return true;
  });
  const key = (node: (typeof windows)[number]) =>
    [[...node.tags].sort().join(','), keyOf(node), node.label ?? node.id, node.id] as const;
  windows.sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    for (let i = 0; i < ka.length; i += 1) {
      const order = (ka[i] ?? '').localeCompare(kb[i] ?? '', 'en', { numeric: true });
      if (order !== 0) {
        return order;
      }
    }
    return 0;
  });
  return windows.map((node, i): SceneCommand => {
    const heading = start + (2 * Math.PI * i) / windows.length;
    const ring = i % 3;
    const distance = rings[ring] ?? rings[0];
    const transform = placedAt(state, node.id, eye, {
      x: eye[0] + distance * Math.sin(heading),
      y: eye[1] + (RING_RISE[ring] ?? 0),
      z: eye[2] - distance * Math.cos(heading),
    });
    if (transform === null) {
      throw new Error(`window "${node.id}" cannot be placed: its group's placement is singular`);
    }
    return { type: 'node.patch', id: node.id, transform };
  });
}

/** What a marker's drag snaps with, while magnetic positioning is on. */
export interface MarkerSnap {
  /** Magnetic positioning's settings. */
  readonly settings: SnapSettings;
  /** The rings round the camera, nearest first, in world units along the floor. */
  readonly rings: readonly number[];
  /** How the panorama draws its cards, to measure windows by. */
  readonly measure: CardMeasure;
}

/**
 * A marker being dragged: each move previews the window moved on the ground as far as the pointer
 * moved from where it grabbed the marker, so the grabbed point stays under the pointer; letting go
 * commits the last accepted one as one transaction; cancelling discards it, and the window is where
 * it was. Nothing moves before the pointer does. While magnetic positioning is on (`snap` gives its
 * settings), each place is snapped to the windows beside it first, as a move in the panorama is.
 */
export class MarkerDrag {
  /** The window dragged. */
  readonly nodeId: Id;
  readonly #workspace: WorkspaceReader & WorkspaceMutator;
  readonly #previewId: string;
  readonly #eye: Vec3;
  /** The ground point the marker was grabbed by, and where the window stood then. */
  readonly #grabbed: readonly [number, number];
  readonly #from: readonly [number, number];
  #last: SceneCommand[] | null = null;
  /** Where the last preview shows the window. */
  #lastPlace: RoomPlace | null = null;
  #ended = false;
  readonly #snap: (() => MarkerSnap | null) | null;
  readonly #neighbours: readonly SnapBox[];
  #snapped: Snap = NO_SNAP;

  constructor(
    workspace: WorkspaceReader & WorkspaceMutator,
    viewportId: Id,
    nodeId: Id,
    grabbed: readonly [number, number],
    snap: (() => MarkerSnap | null) | null = null,
  ) {
    const state = workspace.getState();
    const viewport = state.viewports.get(viewportId);
    const camera = viewport === undefined ? undefined : state.cameras.get(viewport.cameraId);
    if (camera === undefined) {
      throw new Error(`viewport "${viewportId}" has no camera`);
    }
    if (state.nodes.get(nodeId)?.kind !== 'window') {
      throw new Error(`no window "${nodeId}" to drag`);
    }
    const [gx, gz] = grabbed;
    if (!Number.isFinite(gx) || !Number.isFinite(gz)) {
      throw new RangeError(
        `grabbed must be a finite ground point (got ${String(gx)}, ${String(gz)})`,
      );
    }
    const at = worldOrigin(placementOf(state, nodeId));
    this.#workspace = workspace;
    this.nodeId = nodeId;
    this.#eye = camera.position;
    this.#grabbed = [gx, gz];
    this.#from = [at[0], at[2]];
    this.#previewId = `swf.map/${nodeId}/${String(state.revision)}`;
    this.#snap = snap;
    const magnet = snap?.() ?? null;
    this.#neighbours =
      magnet === null ? [] : snapNeighbours(state, nodeId, camera.position, magnet.measure);
  }

  /** The snap in force at the last place previewed. */
  get snap(): Snap {
    return this.#snapped;
  }

  /**
   * Previews the window moved as far as the pointer moved, the pointer now over ground point
   * (x, z); back where it grabbed, the window is where it was. False when the move was refused (a
   * lock, say).
   */
  moveTo(x: number, z: number): boolean {
    if (this.#ended) {
      throw new Error('the drag has ended');
    }
    const [dx, dz] = [x - this.#grabbed[0], z - this.#grabbed[1]];
    if (dx === 0 && dz === 0) {
      if (this.#last !== null) {
        this.#workspace.cancelPreview(this.#previewId, 'host');
        this.#last = null;
      }
      return true;
    }
    const state = this.#workspace.getState();
    const eye = this.#eye;
    let place = models.floorDrop(
      ROOM_LIMITS,
      roomPlaceOf(state, this.nodeId, eye),
      this.#from[0] + dx - eye[0],
      this.#from[1] + dz - eye[2],
    );
    const magnet = this.#snap?.() ?? null;
    this.#snapped = NO_SNAP;
    if (magnet !== null) {
      const box = boxOf(state, this.nodeId, eye, magnet.measure, place);
      const resolved =
        box === null ? NO_SNAP : resolveSnap(box, this.#neighbours, magnet.settings, magnet.rings);
      place = resolved.constraints.length === 0 ? place : snappedPlace(place, resolved);
      this.#snapped = resolved;
    }
    const transform = standingInRoom(state, this.nodeId, eye, place);
    if (transform === null) {
      return false;
    }
    const commands: SceneCommand[] = [{ type: 'node.patch', id: this.nodeId, transform }];
    const result = this.#workspace.preview(this.#previewId, commands, { source: 'user' });
    if (result.status === 'previewed') {
      this.#last = commands;
      this.#lastPlace = place;
      return true;
    }
    return false;
  }

  /**
   * Commits where it was last previewed, kept clear of the windows near it on the floor when
   * magnetic positioning put it on a spoke ({@link spacedPlace}); null when it never moved.
   */
  commit(): TxResult | null {
    this.#ended = true;
    if (this.#last === null) {
      return null;
    }
    let commands = this.#last;
    const magnet = this.#snap?.() ?? null;
    if (magnet !== null && this.#lastPlace !== null) {
      const spaced = spacedPlace(this.#lastPlace, this.#snapped, this.#neighbours, magnet.settings);
      if (spaced.place !== this.#lastPlace) {
        const state = this.#workspace.getState();
        const transform = standingInRoom(state, this.nodeId, this.#eye, spaced.place);
        if (transform !== null) {
          commands = [{ type: 'node.patch', id: this.nodeId, transform }];
          this.#snapped = spaced.snap;
        }
      }
    }
    return this.#workspace.transaction(commands, { source: 'user', previewId: this.#previewId });
  }

  /** Ends the drag without a change: the preview is discarded, and the window is where it was. */
  cancel(): void {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    if (this.#last !== null) {
      this.#workspace.cancelPreview(this.#previewId, 'escape');
    }
  }
}

/** A part linked to the window it came from, as the panorama draws it. */
export interface PartLink {
  /** The part's ID. */
  readonly part: Id;
  /** The ID of the window it came from. */
  readonly origin: Id;
  /**
   * The line between them in the view's CSS pixels, along the shortest way round seen from the
   * camera: in runs, broken where it leaves the view or crosses the seam.
   */
  readonly runs: readonly (readonly (readonly [number, number])[])[];
}

/** How many pieces a link's line is drawn in. */
/**
 * The runs a line through these directions, in order, is drawn in, in view pixels: each direction
 * at its image nearest the one before, a run broken where the line leaves the view or jumps across
 * it (at the seam).
 */
export function traced(
  projection: Projection,
  view: ViewGeometry,
  directions: readonly Vec3[],
): [number, number][][] {
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  for (const direction of directions) {
    const images = projection.projectDirection(direction, view).images;
    const last = run.at(-1);
    const image =
      last === undefined
        ? images[0]
        : [...images].sort((p, q) => Math.abs(p[0] - last[0]) - Math.abs(q[0] - last[0]))[0];
    if (
      image === undefined ||
      (last !== undefined && Math.abs(image[0] - last[0]) > view.width / 2)
    ) {
      if (run.length > 1) {
        runs.push(run);
      }
      run = image === undefined ? [] : [[image[0], image[1]]];
    } else {
      run.push([image[0], image[1]]);
    }
  }
  if (run.length > 1) {
    runs.push(run);
  }
  return runs;
}

const LINK_STEPS = 32;

/**
 * Every part in the scene linked to the window it came from ({@link partOf}, under the host's
 * `partKey`), as the viewport's projection draws the line between their centres: directions from the camera turned
 * evenly from one to the other, each placed at its image nearest the last one, so the line follows
 * the view and breaks only where it leaves it or crosses the seam.
 */
export function partLinks(
  state: SceneState,
  viewportId: Id,
  projections: { get(id: string): ProjectionModule | undefined },
  partKey: string,
): PartLink[] {
  const view = viewGeometryOf(state, viewportId);
  const module = projections.get(view.projectionId);
  const viewport = state.viewports.get(viewportId);
  const camera = viewport === undefined ? undefined : state.cameras.get(viewport.cameraId);
  if (module === undefined || camera === undefined) {
    throw new Error(`viewport "${viewportId}" cannot be drawn in`);
  }
  const projection = projectionFor(module, view);
  const eye = camera.position;
  const directionTo = (id: Id): Vec3 | null => {
    const world = worldMatrix(state.nodes, id);
    if (world === undefined) {
      return null;
    }
    const d: Vec3 = [world[12] - eye[0], world[13] - eye[1], world[14] - eye[2]];
    const length = Math.hypot(...d);
    return length > 0 ? [d[0] / length, d[1] / length, d[2] / length] : null;
  };
  const links: PartLink[] = [];
  for (const node of state.nodes.values()) {
    const origin = partOf(node, partKey);
    if (
      node.kind !== 'window' ||
      effectiveState(state.nodes, node.id)?.active !== true ||
      origin === null
    ) {
      continue;
    }
    const from = directionTo(node.id);
    const to = directionTo(origin);
    if (from === null || to === null) {
      continue;
    }
    const cosine = from[0] * to[0] + from[1] * to[1] + from[2] * to[2];
    const angle = Math.acos(Math.max(-1, Math.min(1, cosine)));
    const directions: Vec3[] = [];
    for (let i = 0; i <= LINK_STEPS; i += 1) {
      const t = i / LINK_STEPS;
      // Turned evenly between the two; straight along when they (nearly) coincide.
      const [a, b] =
        angle < 1e-9
          ? [1 - t, t]
          : [Math.sin((1 - t) * angle) / Math.sin(angle), Math.sin(t * angle) / Math.sin(angle)];
      directions.push([a * from[0] + b * to[0], a * from[1] + b * to[1], a * from[2] + b * to[2]]);
    }
    const runs = traced(projection, view, directions);
    links.push({ part: node.id, origin, runs });
  }
  return links;
}
