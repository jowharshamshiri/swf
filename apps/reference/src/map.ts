import type {
  Id,
  SceneCommand,
  SceneState,
  TxResult,
  WorkspaceMutator,
  WorkspaceReader,
} from '@swf/core';
import { effectiveState, nodeFrameGeometry, worldMatrix } from '@swf/core';
import { headingOf, placementOf, translatedBy, turnedAbout, worldOrigin } from '@swf/interaction';
import type { Transform3D, Vec3 } from '@swf/math';
import type { SnapSettings } from './features.js';
import type { Snap, SnapBox } from './magnetic.js';
import {
  boxOf,
  NO_SNAP,
  resolveSnap,
  snapNeighbours,
  snappedTransform,
  worldAt,
} from './magnetic.js';
import { viewGeometryOf } from '@swf/presentation';
import type { ProjectionModule } from '@swf/projections';
import { headingPitchOf, projectionFor } from '@swf/projections';

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
  /** The map's size in CSS pixels. */
  readonly width: number;
  readonly height: number;
}

export const MAP_SCALE = Object.freeze({ min: 8, max: 480, initial: 60, step: 1.25 });

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
  readonly x: number;
  readonly z: number;
  /** Radians right of straight ahead (-Z). */
  readonly heading: number;
}

/** A window as the map shows it. */
export interface MapMarker {
  readonly id: Id;
  readonly label: string;
  /** World position. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** The ends of the window's width on the ground plane: the line it stands on, from above. */
  readonly ends: readonly [readonly [number, number], readonly [number, number]];
  /** In front of the camera's heading, or behind it. */
  readonly side: 'front' | 'behind';
  /** World units from the camera on the ground plane. */
  readonly distance: number;
  readonly visible: boolean;
  readonly selected: boolean;
  readonly focused: boolean;
}

export interface MapScene {
  readonly camera: MapCamera;
  readonly markers: readonly MapMarker[];
}

/** The scene from above, as the viewport's camera sees it: every active window, in scene order. */
export function mapScene(state: SceneState, viewportId: Id): MapScene {
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
    });
  }
  return { camera: { x: ex, z: ez, heading }, markers };
}

/**
 * Whether the viewport shows any of a window now, as its projection places it: false for one
 * wholly outside the view (behind the camera when the field of view is narrow, say).
 */
export function inView(
  state: SceneState,
  viewportId: Id,
  projections: { get(id: string): ProjectionModule | undefined },
  nodeId: Id,
): boolean {
  const view = viewGeometryOf(state, viewportId);
  const module = projections.get(view.projectionId);
  const frame = nodeFrameGeometry(state, nodeId);
  if (module === undefined || frame === undefined) {
    throw new Error(`window "${nodeId}" cannot be placed in the view`);
  }
  return projectionFor(module, view).clipVisibility(frame, view).state !== 'outside';
}

/**
 * The view that lays a radar out: centred on the camera, at the scale that keeps every window
 * within its rim, `margin` pixels inside the smaller side, out to {@link radarReach}.
 */
export function radarView(scene: MapScene, width: number, height: number, margin: number): MapView {
  const radius = Math.max(1, Math.min(width, height) / 2 - margin);
  return {
    centre: [scene.camera.x, scene.camera.z],
    scale: radius / radarReach(scene),
    width,
    height,
  };
}

/**
 * How far from the camera a radar reaches, in world units: past the farthest window by a little,
 * rounded up to a ring ({@link ringStep}), and never less than two units.
 */
export function radarReach(scene: MapScene): number {
  const farthest = scene.markers.reduce((far, marker) => Math.max(far, marker.distance), 0);
  const reach = Math.max(2, farthest * 1.1);
  const step = ringStep(reach);
  return Math.ceil(reach / step) * step;
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
 * The local transform that stands a window at a ground point (X, Z), keeping its height and
 * turning it about the vertical by as much as its heading from the eye changed, so it still faces
 * the camera as it did. Null when its parent's placement cannot be inverted.
 */
export function standingAt(
  state: SceneState,
  nodeId: Id,
  eye: Vec3,
  x: number,
  z: number,
): Transform3D | null {
  const placement = placementOf(state, nodeId);
  const origin = worldOrigin(placement);
  const target: Vec3 = [x, origin[1], z];
  const level = (p: Vec3): Vec3 => [p[0] - eye[0], 0, p[2] - eye[2]];
  const flat = (p: Vec3) => Math.hypot(p[0], p[2]) === 0;
  const yaw =
    flat(level(origin)) || flat(level(target))
      ? 0
      : headingOf(level(target)) - headingOf(level(origin));
  const turned = turnedAbout(placement, origin, yaw);
  return turned === null
    ? null
    : translatedBy({ ...placement, local: turned }, [x - origin[0], 0, z - origin[2]]);
}

/**
 * The local transform that puts a window at a world position: on the ground at (X, Z) as
 * {@link standingAt} stands it, and at height Y; each left out stays as it is. Null when its
 * parent's placement cannot be inverted.
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
  const placement = placementOf(state, nodeId);
  const origin = worldOrigin(placement);
  const ground =
    at.x === undefined || at.z === undefined
      ? placement.local
      : standingAt(state, nodeId, eye, at.x, at.z);
  if (ground === null) {
    return null;
  }
  return at.y === undefined
    ? ground
    : translatedBy({ ...placement, local: ground }, [0, at.y - origin[1], 0]);
}

/** Straight ahead of the camera, or straight behind it: where a quick action puts a window. */
export type AroundSide = 'front' | 'behind';

/**
 * The local transform that puts a window straight ahead of the camera's heading, or straight
 * behind it, at the distance it stands from the camera on the ground and at its own height, turned
 * as it moves round so it faces the camera as it did ({@link standingAt}). Null when its parent's
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
const RING_RISE = Object.freeze([-0.3, 0, 0.3]);

/**
 * The commands that arrange the windows round the camera, as one change: every window standing on
 * its own (not one nested in another window) that is not locked, in order of what it shows, then
 * its colour, then its name, spread evenly round the whole circle from straight ahead of the
 * camera, and laid in turn on three rings at the `rings` distances (near, middle, far), the farther
 * a little higher; each keeps facing the camera as it did. Locked windows keep their places. Throws
 * a RangeError for a ring distance that is not positive and finite, or rings not nearest first;
 * an Error for a window whose group's placement cannot be inverted.
 */
export function arrangedAround(
  state: SceneState,
  viewportId: Id,
  rings: readonly [number, number, number],
  colourOf: (node: { readonly metadata: Readonly<Record<string, unknown>> }) => string,
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
    [[...node.tags].sort().join(','), colourOf(node), node.label ?? node.id, node.id] as const;
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
  readonly settings: SnapSettings;
  /** The rings round the camera, nearest first, in world units. */
  readonly rings: readonly number[];
}

/**
 * A marker being dragged: each move previews the window moved on the ground as far as the pointer
 * moved from where it grabbed the marker, so the grabbed point stays under the pointer; letting go
 * commits the last accepted one as one transaction; cancelling discards it, and the window is where
 * it was. Nothing moves before the pointer does. While magnetic positioning is on (`snap` gives its
 * settings), each place is snapped to the windows beside it first, as a move in the panorama is.
 */
export class MarkerDrag {
  readonly nodeId: Id;
  readonly #workspace: WorkspaceReader & WorkspaceMutator;
  readonly #previewId: string;
  readonly #eye: Vec3;
  /** The ground point the marker was grabbed by, and where the window stood then. */
  readonly #grabbed: readonly [number, number];
  readonly #from: readonly [number, number];
  #last: SceneCommand[] | null = null;
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
    this.#previewId = `reference.map/${nodeId}/${String(state.revision)}`;
    this.#snap = snap;
    this.#neighbours = snap === null ? [] : snapNeighbours(state, nodeId);
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
    const stood = standingAt(state, this.nodeId, this.#eye, this.#from[0] + dx, this.#from[1] + dz);
    if (stood === null) {
      return false;
    }
    const magnet = this.#snap?.() ?? null;
    let transform = stood;
    this.#snapped = NO_SNAP;
    if (magnet !== null) {
      const placement = placementOf(state, this.nodeId);
      const world = worldAt(placement, stood);
      const box = boxOf(state, this.nodeId, world);
      const snap =
        box === null
          ? NO_SNAP
          : resolveSnap(box, this.#neighbours, this.#eye, magnet.settings, magnet.rings);
      const snapped = snappedTransform(placement, world, this.#eye, snap);
      if (snapped !== null) {
        transform = snapped;
        this.#snapped = snap;
      }
    }
    const commands: SceneCommand[] = [{ type: 'node.patch', id: this.nodeId, transform }];
    const result = this.#workspace.preview(this.#previewId, commands, { source: 'user' });
    if (result.status === 'previewed') {
      this.#last = commands;
      return true;
    }
    return false;
  }

  /** Commits where it was last previewed; null when it never moved. */
  commit(): TxResult | null {
    this.#ended = true;
    if (this.#last === null) {
      return null;
    }
    return this.#workspace.transaction(this.#last, { source: 'user', previewId: this.#previewId });
  }

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
