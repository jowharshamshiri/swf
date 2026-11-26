import type { Workspace } from '@swf/core';
import { createWorkspace } from '@swf/core';
import { createPresentationRegistry } from '@swf/presentation';
import { createProjectionRegistry, equirectangular, headingPitchOf } from '@swf/projections';
import { describe, expect, it } from 'vitest';
import { planPreset, presetCommands } from '../src/presets.js';
import type { FocusOptions } from '@swf/navigation';
import {
  CAMERA_ID,
  FOCUS_ID,
  MAP,
  ModeRefusal,
  OVERVIEW,
  PANORAMA,
  createFocusMode,
  createModes,
  focusContext,
  focusFrame,
} from '@swf/navigation';

const OPTIONS: FocusOptions = { fill: 0.75, maxMagnification: 2.5, pixelsPerUnit: 160 };
const DEGREES = 180 / Math.PI;

function scene(preset: 'sparse' | 'seam' = 'sparse') {
  const ws = createWorkspace({ id: 'test' });
  const projections = createProjectionRegistry({
    kinds: ws.mutator(),
    projectors: createPresentationRegistry().registrar(),
  });
  projections.register(equirectangular);
  const result = ws.transaction([
    { type: 'camera.create', camera: { id: CAMERA_ID } },
    {
      type: 'viewport.create',
      viewport: {
        id: 'v',
        cameraId: CAMERA_ID,
        mode: PANORAMA.id,
        projection: PANORAMA.projection,
        size: { width: 640, height: 360, devicePixelRatio: 1 },
      },
    },
    ...presetCommands(planPreset(preset, 1)),
  ]);
  expect(result.status).toBe('committed');
  const modes = createModes(ws, 'v');
  modes.register(PANORAMA);
  modes.register(createFocusMode(OPTIONS));
  modes.register(MAP);
  modes.register(OVERVIEW);
  return { ws, modes };
}

/** Everything spatial and attached: nodes and surfaces, as the snapshot holds them. */
function layout(ws: Workspace) {
  const s = ws.serialize();
  return JSON.stringify([s.rootIds, s.nodes, s.surfaces]);
}

function camera(ws: Workspace) {
  const rotation = ws.getState().cameras.get(CAMERA_ID)?.rotation;
  if (rotation === undefined) throw new Error('no camera');
  return rotation;
}

function viewport(ws: Workspace) {
  const record = ws.getState().viewports.get('v');
  if (record === undefined) throw new Error('no viewport');
  return record;
}

/** The angle the window takes across the viewport's width, as a share of it. */
function share(ws: Workspace, id: string) {
  const state = ws.getState();
  const node = state.nodes.get(id);
  const config = viewport(ws).projection.config as { horizontal: number; vertical: number };
  if (node === undefined) throw new Error('no window');
  const [x, y, z] = node.transform.position;
  const across = 2 * Math.atan(node.bounds[0] / (2 * Math.hypot(x, y, z))) * DEGREES;
  const down = 2 * Math.atan(node.bounds[1] / (2 * Math.hypot(x, y, z))) * DEGREES;
  return { across: across / config.horizontal, down: down / config.vertical };
}

describe('focus and context (FR-120, UX-003, WF-04)', () => {
  it('frames a window facing it, filling the view by its binding side, unstretched', () => {
    const { ws } = scene();
    const state = ws.getState();
    const node = state.nodes.get('window-03');
    if (node === undefined) throw new Error('no window');
    const frame = focusFrame(state, 'window-03', [0, 0, 0], { width: 640, height: 360 }, OPTIONS);
    const [x, y, z] = node.transform.position;
    expect(frame.heading).toBeCloseTo(Math.atan2(x, -z), 12);
    expect(frame.pitch).toBeCloseTo(Math.atan2(y, Math.hypot(x, z)), 12);
    // The same angle per pixel across and down.
    expect(frame.horizontal / 640).toBeCloseTo(frame.vertical / 360, 4);
    const across = 2 * Math.atan(node.bounds[0] / (2 * Math.hypot(x, y, z))) * DEGREES;
    const down = 2 * Math.atan(node.bounds[1] / (2 * Math.hypot(x, y, z))) * DEGREES;
    const fills = Math.max(across / frame.horizontal, down / frame.vertical);
    expect(fills).toBeCloseTo(0.75, 2);
  });

  it('never magnifies content past its limit, however large the view', () => {
    const { ws } = scene();
    const state = ws.getState();
    const node = state.nodes.get('window-01');
    if (node === undefined) throw new Error('no window');
    const huge = { width: 8000, height: 4000 };
    const frame = focusFrame(state, 'window-01', [0, 0, 0], huge, OPTIONS);
    const [x, y, z] = node.transform.position;
    const across = 2 * Math.atan(node.bounds[0] / (2 * Math.hypot(x, y, z))) * DEGREES;
    const onScreen = (across / frame.horizontal) * huge.width;
    expect(onScreen).toBeLessThanOrEqual(2.5 * 160 * node.bounds[0] * 1.001);
  });

  it('enters on a window, focusing and selecting it, without moving anything', () => {
    const { ws, modes } = scene();
    const before = layout(ws);
    expect(modes.switchTo(FOCUS_ID, { target: 'window-04' }).status).toBe('committed');
    const state = ws.getState();
    expect(modes.current()).toBe(FOCUS_ID);
    expect(state.focusedId).toBe('window-04');
    expect(state.selection).toEqual(['window-04']);
    expect(layout(ws)).toBe(before);
    const node = state.nodes.get('window-04');
    if (node === undefined) throw new Error('no window');
    const [x, , z] = node.transform.position;
    expect(headingPitchOf(camera(ws)).heading).toBeCloseTo(Math.atan2(x, -z), 9);
    const { across, down } = share(ws, 'window-04');
    expect(Math.max(across, down)).toBeCloseTo(0.75, 2);
  });

  it('refuses to enter with no window to focus, naming the field', () => {
    const { modes } = scene();
    expect(() => modes.switchTo(FOCUS_ID)).toThrow(ModeRefusal);
    expect(() => modes.switchTo(FOCUS_ID)).toThrow('select a window to focus');
    expect(() => modes.switchTo(FOCUS_ID, { target: 'nothing' })).toThrow('no window "nothing"');
  });

  it('on exit puts back the mode, projection and camera it was entered from', () => {
    const { ws, modes } = scene();
    expect(modes.switchTo(MAP.id).status).toBe('committed');
    const turned = ws.dispatch({
      type: 'camera.patch',
      id: CAMERA_ID,
      rotation: [0, Math.sin(0.4), 0, Math.cos(0.4)],
    });
    expect(turned.status).toBe('committed');
    const view = { projection: viewport(ws).projection, camera: camera(ws) };
    modes.switchTo(FOCUS_ID, { target: 'window-02' });
    expect(camera(ws)).not.toEqual(view.camera);
    expect(modes.back().status).toBe('committed');
    expect(modes.current()).toBe(MAP.id);
    expect(viewport(ws).projection).toEqual(view.projection);
    expect(camera(ws)).toEqual(view.camera);
    // Focus state itself is shared, not a mode's: it stays on the window.
    expect(ws.getState().focusedId).toBe('window-02');
  });

  it('follows the workspace focus, refits on resize, and leaves when the window goes', () => {
    const { ws, modes } = scene();
    const start = camera(ws);
    modes.switchTo(FOCUS_ID, { target: 'window-01' });
    // Another view or list focuses another window: focus frames that one.
    ws.transaction([
      { type: 'selection.set', ids: ['window-05'] },
      { type: 'focus.set', id: 'window-05' },
    ]);
    const node = ws.getState().nodes.get('window-05');
    if (node === undefined) throw new Error('no window');
    const [x, , z] = node.transform.position;
    expect(headingPitchOf(camera(ws)).heading).toBeCloseTo(Math.atan2(x, -z), 9);
    // A narrower viewport fits the frame again, the camera kept where it faces.
    const facing = camera(ws);
    ws.dispatch({
      type: 'viewport.patch',
      id: 'v',
      size: { width: 500, height: 600, devicePixelRatio: 1 },
    });
    expect(camera(ws)).toEqual(facing);
    const { across, down } = share(ws, 'window-05');
    expect(Math.max(across, down)).toBeCloseTo(0.75, 2);
    // The focused window is removed: focus is left for the view it came from.
    ws.dispatch({ type: 'node.delete', id: 'window-05', mode: 'subtree' });
    expect(modes.current()).toBe(PANORAMA.id);
    expect(camera(ws)).toEqual(start);
    expect(viewport(ws).projection).toEqual(PANORAMA.projection);
  });

  it('lists the context left and right of the focused window, nearest first', () => {
    const { ws } = scene('seam');
    const context = focusContext(ws.getState(), 'window-07', [0, 0, 0]);
    const all = [...context.left, ...context.right];
    expect(all.map((n) => n.id).sort()).toEqual(
      ['window-01', 'window-02', 'window-03', 'window-04', 'window-05', 'window-06'].sort(),
    );
    for (const side of [context.left, context.right]) {
      const distances = side.map((n) => Math.abs(n.bearing));
      expect(distances).toEqual([...distances].sort((a, b) => a - b));
    }
    expect(context.left.every((n) => n.bearing < 0)).toBe(true);
    expect(context.right.every((n) => n.bearing >= 0 && n.bearing <= 180)).toBe(true);
  });
});

describe('switching every mode over one scene (FR-129, AC-007, §33.2 scenario 3)', () => {
  it('keeps IDs, attachments and world transforms through focus, map, overview and back', () => {
    const { ws, modes } = scene('seam');
    const before = layout(ws);
    const ids = [...ws.getState().nodes.values()].map((n) => n.id);
    const start = camera(ws);

    modes.switchTo(FOCUS_ID, { target: 'window-01' });
    modes.switchTo(MAP.id);
    // Leaving focus for the map put the camera back.
    expect(camera(ws)).toEqual(start);
    modes.switchTo(OVERVIEW.id);
    // The overview selects and focuses another window by its own ID.
    ws.transaction([
      { type: 'selection.set', ids: ['window-04'] },
      { type: 'focus.set', id: 'window-04' },
    ]);
    modes.switchTo(PANORAMA.id);

    expect(layout(ws)).toBe(before);
    expect([...ws.getState().nodes.values()].map((n) => n.id)).toEqual(ids);
    expect(ws.getState().focusedId).toBe('window-04');
    expect(viewport(ws).projection).toEqual(PANORAMA.projection);
    // No mode switch is a layout change: undo has nothing of theirs.
    expect(ws.canUndo()).toBe(true);
    ws.undo();
    expect(ws.getState().nodes.size).toBe(0);
  });
});
