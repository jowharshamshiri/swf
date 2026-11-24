import { createWorkspace } from '@swf/core';
import { createPresentationRegistry } from '@swf/presentation';
import { createProjectionRegistry, equirectangular } from '@swf/projections';
import { describe, expect, it } from 'vitest';
import type { ViewMode } from '../src/modes.js';
import { createModes, PANORAMA } from '../src/modes.js';
import { CAMERA_ID, planPreset, presetCommands } from '../src/presets.js';

function scene() {
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
        size: { width: 800, height: 400, devicePixelRatio: 1 },
      },
    },
    ...presetCommands(planPreset('seam', 1)),
  ]);
  expect(result.status).toBe('committed');
  return ws;
}

/** A second mode: the half of the panorama in front of the camera. */
function frontMode(log: string[]): ViewMode {
  return {
    id: 'front',
    name: 'mode.panorama',
    projection: { id: 'equirectangular/1', config: { horizontal: 180, vertical: 90 } },
    activate: ({ viewportId }) => {
      log.push(`start front in ${viewportId}`);
      return () => log.push('stop front');
    },
  };
}

/** The scene's layout: everything but view state. */
function layout(ws: ReturnType<typeof scene>) {
  const s = ws.serialize();
  return JSON.stringify([s.rootIds, s.nodes, s.surfaces, s.selection, s.focusedId, s.orbitRootId]);
}

describe('view modes (FR-129, ARCH-022)', () => {
  it('starts in the panorama, the mode the viewport records', () => {
    const ws = scene();
    const modes = createModes(ws, 'v');
    modes.register(PANORAMA);
    expect(modes.current()).toBe('panorama');
    expect(modes.list().map((m) => m.id)).toEqual(['panorama']);
  });

  it('switches at once, changing only the viewport, never a window, a surface or the history', () => {
    const ws = scene();
    const log: string[] = [];
    const modes = createModes(ws, 'v');
    modes.register(PANORAMA);
    modes.register(frontMode(log));
    const before = layout(ws);
    const undoable = ws.canUndo();

    expect(modes.switchTo('front').status).toBe('committed');
    expect(modes.current()).toBe('front');
    expect(ws.getState().viewports.get('v')?.projection).toEqual({
      id: 'equirectangular/1',
      config: { horizontal: 180, vertical: 90 },
    });
    expect(layout(ws)).toBe(before);
    expect(log).toEqual(['start front in v']);

    expect(modes.switchTo('panorama').status).toBe('committed');
    expect(ws.getState().viewports.get('v')?.projection).toEqual(PANORAMA.projection);
    expect(layout(ws)).toBe(before);
    expect(log).toEqual(['start front in v', 'stop front']);
    // View state is not undone: undo still reaches the scene's own last change.
    expect(ws.canUndo()).toBe(undoable);
  });

  it('follows the viewport record when something else changes the mode', () => {
    const ws = scene();
    const log: string[] = [];
    const modes = createModes(ws, 'v');
    modes.register(PANORAMA);
    modes.register(frontMode(log));
    ws.dispatch({ type: 'viewport.patch', id: 'v', mode: 'front' });
    expect(modes.current()).toBe('front');
    expect(log).toEqual(['start front in v']);
    modes.dispose();
    expect(log).toEqual(['start front in v', 'stop front']);
  });

  it('refuses an unknown mode, a second mode of the same ID, and unregistering the active one', () => {
    const ws = scene();
    const modes = createModes(ws, 'v');
    const unregister = modes.register(PANORAMA);
    expect(() => modes.switchTo('map')).toThrow('mode "map" is not registered');
    expect(() => modes.register(PANORAMA)).toThrow('mode "panorama" is already registered');
    expect(() => {
      unregister();
    }).toThrow('mode "panorama" is active and cannot be unregistered');
  });
});
