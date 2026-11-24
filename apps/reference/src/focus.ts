import type { Id, SceneCommand, SceneState } from '@swf/core';
import { effectiveState, worldTransform } from '@swf/core';
import type { Vec3 } from '@swf/math';
import { cameraRotation } from '@swf/projections';
import type { ViewMode } from './modes.js';
import { ModeRefusal, PANORAMA } from './modes.js';

/**
 * Focus and context: one window shown large enough to read, centred, with the windows around it
 * still in view and reachable. It is a view of the panorama, not a placement: entering it turns
 * the viewport's camera to face the window and narrows the projection to frame it, and no window
 * moves. Leaving it puts the camera back.
 */

export const FOCUS_ID = 'focus';

export interface FocusOptions {
  /** Share of the viewport's width or height the focused window fills, whichever binds first. */
  readonly fill: number;
  /**
   * The most a window is magnified, against the size its content is laid out at
   * (`pixelsPerUnit` per world unit): content larger than this reads no better.
   */
  readonly maxMagnification: number;
  /** CSS pixels the presentation lays a window's content out at per world unit. */
  readonly pixelsPerUnit: number;
}

/** How the viewport frames a focused window. */
export interface FocusFrame {
  /** The camera's heading and pitch to face the window, in radians. */
  readonly heading: number;
  readonly pitch: number;
  /** The equirectangular coverage that frames it, in degrees. */
  readonly horizontal: number;
  readonly vertical: number;
}

const DEGREES = 180 / Math.PI;

/** The window's world centre, size and distance from an eye; throws for anything else. */
function placed(state: SceneState, windowId: Id, eye: Vec3) {
  const node = state.nodes.get(windowId);
  if (node?.kind !== 'window' || effectiveState(state.nodes, windowId)?.active !== true) {
    throw new ModeRefusal('id', `no window "${windowId}" to focus`);
  }
  const world = worldTransform(state.nodes, windowId);
  if (!world?.ok) {
    throw new ModeRefusal('id', `window "${windowId}" has no world placement to focus`);
  }
  const { position, scale } = world.transform;
  const offset: Vec3 = [position[0] - eye[0], position[1] - eye[1], position[2] - eye[2]];
  const distance = Math.hypot(...offset);
  if (!(distance > 0)) {
    throw new ModeRefusal('id', `window "${windowId}" is at the camera and cannot be framed`);
  }
  return {
    offset,
    distance,
    width: node.bounds[0] * scale[0],
    height: node.bounds[1] * scale[1],
  };
}

/**
 * The frame that shows a window readably in a viewport of a size, seen from an eye: facing it,
 * with the coverage at which it fills `fill` of the viewport (no more than `maxMagnification` of
 * its content's own size), the same angle per pixel across and down so it is not stretched.
 * Coverage is rounded to hundredths of a degree.
 */
export function focusFrame(
  state: SceneState,
  windowId: Id,
  eye: Vec3,
  size: { readonly width: number; readonly height: number },
  options: FocusOptions,
): FocusFrame {
  const { offset, distance, width, height } = placed(state, windowId, eye);
  const across = 2 * Math.atan(width / (2 * distance));
  const down = 2 * Math.atan(height / (2 * distance));
  // Radians per CSS pixel: as large as framing it needs, no smaller than the magnification allows.
  let perPixel = Math.max(
    across / (options.fill * size.width),
    down / (options.fill * size.height),
    across / (options.maxMagnification * options.pixelsPerUnit * width),
  );
  perPixel = Math.min(perPixel, (2 * Math.PI) / size.width, Math.PI / size.height);
  const round = (radians: number) => Math.max(0.01, Math.round(radians * DEGREES * 100) / 100);
  return {
    heading: Math.atan2(offset[0], -offset[2]),
    pitch: Math.atan2(offset[1], Math.hypot(offset[0], offset[2])),
    horizontal: round(perPixel * size.width),
    vertical: round(perPixel * size.height),
  };
}

/** Another window, as the focus's context shows it. */
export interface Neighbour {
  readonly id: Id;
  readonly label: string;
  /** Degrees it lies to the right of the focused window as the camera sees them (left negative). */
  readonly bearing: number;
}

/** The windows around a focused one: those to its left and to its right, each nearest first. */
export interface FocusContext {
  readonly left: readonly Neighbour[];
  readonly right: readonly Neighbour[];
}

/**
 * Every other active window by where it lies around the focused one, seen from the eye: by heading
 * first, so the context reads as the panorama does, then by ID. A window straight behind the
 * focused one is on its right.
 */
export function focusContext(state: SceneState, focusedId: Id, eye: Vec3): FocusContext {
  const headingOf = (id: Id): number | null => {
    const world = worldTransform(state.nodes, id);
    if (!world?.ok) {
      return null;
    }
    const [x, , z] = world.transform.position;
    return Math.atan2(x - eye[0], -(z - eye[2]));
  };
  const centre = headingOf(focusedId);
  if (centre === null) {
    throw new ModeRefusal('id', `window "${focusedId}" has no world placement`);
  }
  const left: Neighbour[] = [];
  const right: Neighbour[] = [];
  for (const node of state.nodes.values()) {
    if (
      node.id === focusedId ||
      node.kind !== 'window' ||
      effectiveState(state.nodes, node.id)?.active !== true
    ) {
      continue;
    }
    const heading = headingOf(node.id);
    if (heading === null) {
      continue;
    }
    // Wrapped into (-180, 180].
    let bearing = (heading - centre) * DEGREES;
    bearing = bearing - 360 * Math.ceil((bearing - 180) / 360);
    const neighbour = { id: node.id, label: node.label ?? node.id, bearing };
    (bearing < 0 ? left : right).push(neighbour);
  }
  const nearest = (a: Neighbour, b: Neighbour) =>
    Math.abs(a.bearing) - Math.abs(b.bearing) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { left: left.sort(nearest), right: right.sort(nearest) };
}

/** The camera eye of a viewport. */
function eyeOf(state: SceneState, viewportId: Id): { cameraId: Id; eye: Vec3 } {
  const viewport = state.viewports.get(viewportId);
  const camera = viewport === undefined ? undefined : state.cameras.get(viewport.cameraId);
  if (viewport === undefined || camera === undefined) {
    throw new Error(`viewport "${viewportId}" has no camera`);
  }
  return { cameraId: camera.id, eye: camera.position };
}

/** The view commands that frame a window in a viewport as focus shows it. */
export function focusCommands(
  state: SceneState,
  viewportId: Id,
  windowId: Id,
  options: FocusOptions,
): SceneCommand[] {
  const { cameraId, eye } = eyeOf(state, viewportId);
  const viewport = state.viewports.get(viewportId);
  if (viewport === undefined) {
    throw new Error(`viewport "${viewportId}" does not exist`);
  }
  const frame = focusFrame(state, windowId, eye, viewport.size, options);
  return [
    { type: 'camera.patch', id: cameraId, rotation: cameraRotation(frame.heading, frame.pitch) },
    {
      type: 'viewport.patch',
      id: viewportId,
      projection: {
        id: PANORAMA.projection.id,
        config: { horizontal: frame.horizontal, vertical: frame.vertical },
      },
    },
  ];
}

/**
 * The focus mode. Entering it focuses and selects the window asked for (else the focused one, else
 * the first selected) and frames it. While it is active it follows the workspace's focus: when
 * another window takes the focus, from any view or list, the viewport frames that one; when the
 * viewport is resized the frame is fitted again; and when the focused window is gone, the mode is
 * left for the view it was entered from.
 */
export function createFocusMode(options: FocusOptions): ViewMode {
  const mode: ViewMode = {
    id: FOCUS_ID,
    name: 'mode.focus',
    projection: PANORAMA.projection,
    restoresView: true,
    enter({ viewportId, workspace, target }) {
      const state = workspace.getState();
      const id = target ?? state.focusedId ?? state.selection[0] ?? null;
      if (id === null) {
        throw new ModeRefusal('id', 'select a window to focus');
      }
      return [
        { type: 'selection.set', ids: [id] },
        { type: 'focus.set', id },
        ...focusCommands(state, viewportId, id, options),
      ];
    },
    activate({ viewportId, workspace, back }) {
      let framed = workspace.getState().focusedId;
      let size = workspace.getState().viewports.get(viewportId)?.size;
      return workspace.subscribe((event) => {
        if (event.type !== 'transaction.committed') {
          return;
        }
        const state = workspace.getState();
        const viewport = state.viewports.get(viewportId);
        if (viewport?.mode !== FOCUS_ID) {
          return;
        }
        const focused = state.focusedId;
        const node = focused === null ? undefined : state.nodes.get(focused);
        if (
          focused === null ||
          node?.kind !== 'window' ||
          effectiveState(state.nodes, focused)?.active !== true
        ) {
          back();
          return;
        }
        const resized = size?.width !== viewport.size.width || size.height !== viewport.size.height;
        const refocused = focused !== framed;
        if (!refocused && !resized) {
          return;
        }
        framed = focused;
        size = viewport.size;
        const commands = focusCommands(state, viewportId, focused, options);
        // Only resized, the camera keeps facing where the reader turned it: the frame is fitted.
        workspace.transaction(refocused ? commands : commands.slice(1), { source: 'system' });
      });
    },
  };
  return Object.freeze(mode);
}
