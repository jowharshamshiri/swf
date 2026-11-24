import type {
  Id,
  SceneCommand,
  SceneState,
  TxResult,
  WorkspaceMutator,
  WorkspaceReader,
} from '@swf/core';
import { effectiveState, worldMatrix } from '@swf/core';
import { headingOf, placementOf, translatedBy, turnedAbout, worldOrigin } from '@swf/interaction';
import type { Transform3D, Vec3 } from '@swf/math';
import { headingPitchOf } from '@swf/projections';

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

/**
 * A marker being dragged: each move previews the window at the ground point under the pointer,
 * and letting go commits the last accepted one as one transaction; cancelling discards it, and
 * the window is where it was. Nothing moves before the pointer does.
 */
export class MarkerDrag {
  readonly nodeId: Id;
  readonly #workspace: WorkspaceReader & WorkspaceMutator;
  readonly #previewId: string;
  readonly #eye: Vec3;
  #last: SceneCommand[] | null = null;
  #ended = false;

  constructor(workspace: WorkspaceReader & WorkspaceMutator, viewportId: Id, nodeId: Id) {
    const state = workspace.getState();
    const viewport = state.viewports.get(viewportId);
    const camera = viewport === undefined ? undefined : state.cameras.get(viewport.cameraId);
    if (camera === undefined) {
      throw new Error(`viewport "${viewportId}" has no camera`);
    }
    if (state.nodes.get(nodeId)?.kind !== 'window') {
      throw new Error(`no window "${nodeId}" to drag`);
    }
    this.#workspace = workspace;
    this.nodeId = nodeId;
    this.#eye = camera.position;
    this.#previewId = `reference.map/${nodeId}/${String(state.revision)}`;
  }

  /** Previews the window standing at a ground point; false when it was refused (a lock, say). */
  moveTo(x: number, z: number): boolean {
    if (this.#ended) {
      throw new Error('the drag has ended');
    }
    const transform = standingAt(this.#workspace.getState(), this.nodeId, this.#eye, x, z);
    if (transform === null) {
      return false;
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
