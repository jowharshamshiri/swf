import type { Workspace } from '@swf/core';
import { createWorkspace } from '@swf/core';
import {
  CARD_PIXELS_PER_UNIT,
  createPresentationRegistry,
  TITLE_BAR_HEIGHT,
  viewGeometryOf,
} from '@swf/presentation';
import {
  createProjectionRegistry,
  equirectangular,
  headingPitchOf,
  projectorOf,
} from '@swf/projections';
import { describe, expect, it } from 'vitest';
import { planPreset, presetCommands } from '../src/presets.js';
import type { FocusOptions } from '@swf/navigation';
import {
  CAMERA_ID,
  DEFAULT_FEATURES,
  FOCUS_ID,
  MAP,
  ModeRefusal,
  OVERVIEW,
  PANORAMA,
  createFocusMode,
  createModes,
  focusContext,
  focusFrame,
  semanticDepth,
} from '@swf/navigation';

const OPTIONS: FocusOptions = { fill: 0.75, maxMagnification: 2.5 };

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

/** The heading of a window's centre from the camera at the centre, in radians. */
function headingOf(ws: Workspace, id: string) {
  const node = ws.getState().nodes.get(id);
  if (node === undefined) throw new Error('no window');
  const [x, , z] = node.transform.position;
  return Math.atan2(x, -z);
}

/**
 * How a card of a window's size at `scale` fits a view: the share of its width and height it
 * takes, each way.
 */
function fit(ws: Workspace, id: string, scale: number, size: { width: number; height: number }) {
  const node = ws.getState().nodes.get(id);
  if (node === undefined) throw new Error('no window');
  return {
    across: (node.bounds[0] * CARD_PIXELS_PER_UNIT * scale) / size.width,
    down: (node.bounds[1] * CARD_PIXELS_PER_UNIT * scale) / size.height,
  };
}

/**
 * Focus's frame fills the view by its binding side, its card across and its outline (the card with
 * its title bar) down, unless the magnification limit stops it.
 */
function expectFramed(
  fits: { across: number; down: number },
  scale: number,
  size: { width: number; height: number },
) {
  const outline = fits.down + TITLE_BAR_HEIGHT / size.height;
  expect(fits.across).toBeLessThanOrEqual(0.75 + 1e-9);
  expect(outline).toBeLessThanOrEqual(0.75 + 1e-9);
  expect(scale).toBeLessThanOrEqual(2.5);
  expect(Math.max(fits.across, outline) > 0.75 - 1e-9 || scale === 2.5).toBe(true);
}

/** The card the panorama draws a window on, with semantic depth and focus as the app has them. */
function drawnCard(ws: Workspace, id: string) {
  const state = ws.getState();
  const policy = semanticDepth({
    bands: DEFAULT_FEATURES.depth,
    focusModeId: FOCUS_ID,
    focus: OPTIONS,
  });
  const card = projectorOf(equirectangular)
    .project(state, viewGeometryOf(state, 'v'), (s) => ws.surfaceGeometry(s), policy)
    .find((f) => f.nativeOwner && state.surfaces.get(f.surfaceId)?.ownerNodeId === id)?.card;
  if (card === undefined) throw new Error(`no card for ${id}`);
  return card;
}

describe('focus and context (FR-120, UX-003, WF-04)', () => {
  it('frames a window facing it, its card scaled to fill the view by its binding side, unstretched', () => {
    const { ws } = scene();
    const size = { width: 640, height: 360 };
    const frame = focusFrame(ws.getState(), 'window-03', [0, 0, 0], size, OPTIONS);
    expect(frame.heading).toBeCloseTo(headingOf(ws, 'window-03'), 12);
    // One scale across and down: the card keeps its proportion.
    expectFramed(fit(ws, 'window-03', frame.scale, size), frame.scale, size);
    // A narrow view binds by its width.
    const narrow = { width: 200, height: 900 };
    const tall = focusFrame(ws.getState(), 'window-03', [0, 0, 0], narrow, OPTIONS);
    expect(fit(ws, 'window-03', tall.scale, narrow).across).toBeCloseTo(0.75, 9);
  });

  it('stands a focused window’s whole outline in the middle of the view, its title bar too, however high or low it stands', () => {
    const { ws, modes } = scene();
    const size = viewport(ws).size;
    const lift = (id: string, height: number) => {
      const node = ws.getState().nodes.get(id);
      const [x, , z] = node?.transform.position ?? [0, 0, 0];
      expect(
        ws.dispatch({
          type: 'node.patch',
          id,
          transform: { ...(node?.transform ?? {}), position: [x, height, z] },
        } as never).status,
      ).toBe('committed');
    };
    // Raised a little, as high as the room allows, and as low: the outline in the middle each
    // time, the panorama narrowed down only as far as the window needs.
    for (const height of [0.6, 4, -3]) {
      lift('window-03', height);
      expect(modes.switchTo(FOCUS_ID, { target: 'window-03' }).status).toBe('committed');
      const [, y, , h] = drawnCard(ws, 'window-03');
      expect(y - TITLE_BAR_HEIGHT, `${String(height)} up`).toBeGreaterThanOrEqual(0);
      expect(y + h, `${String(height)} up`).toBeLessThanOrEqual(size.height);
      expect((y - TITLE_BAR_HEIGHT + y + h) / 2, `${String(height)} up`).toBeCloseTo(
        size.height / 2,
        6,
      );
      const span = (viewport(ws).projection.config as { vertical: number }).vertical;
      expect(span).toBeLessThanOrEqual(130);
      if (height === 0.6) {
        expect(span).toBe(130);
      }
      expect(modes.back().status).toBe('committed');
      // Back in the panorama, its own span and horizon.
      expect(viewport(ws).projection).toEqual(PANORAMA.projection);
    }
  });

  it('never magnifies content past its limit, however large the view', () => {
    const { ws } = scene();
    const huge = { width: 8000, height: 4000 };
    const frame = focusFrame(ws.getState(), 'window-01', [0, 0, 0], huge, OPTIONS);
    expect(frame.scale).toBe(2.5);
    expect(fit(ws, 'window-01', frame.scale, huge).across).toBeLessThan(0.75);
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
    // The camera faces it, level, and the panorama draws its card at focus's scale.
    expect(headingPitchOf(camera(ws))).toMatchObject({ pitch: 0 });
    expect(headingPitchOf(camera(ws)).heading).toBeCloseTo(headingOf(ws, 'window-04'), 9);
    const size = viewport(ws).size;
    const frame = focusFrame(state, 'window-04', [0, 0, 0], size, OPTIONS);
    const [x, , w] = drawnCard(ws, 'window-04');
    expect(w / size.width).toBeCloseTo(fit(ws, 'window-04', frame.scale, size).across, 9);
    expectFramed(fit(ws, 'window-04', frame.scale, size), frame.scale, size);
    // Centred in the view.
    expect(x + w / 2).toBeCloseTo(size.width / 2, 6);
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
    expect(headingPitchOf(camera(ws)).heading).toBeCloseTo(headingOf(ws, 'window-05'), 9);
    // A narrower viewport draws the card to fit it again, the camera kept where it faces.
    const facing = camera(ws);
    const size = { width: 300, height: 600 };
    ws.dispatch({ type: 'viewport.patch', id: 'v', size: { ...size, devicePixelRatio: 1 } });
    expect(camera(ws)).toEqual(facing);
    const [, , w, h] = drawnCard(ws, 'window-05');
    expectFramed(
      { across: w / size.width, down: h / size.height },
      focusFrame(ws.getState(), 'window-05', [0, 0, 0], size, OPTIONS).scale,
      size,
    );
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
