import { createWorkspace, worldMatrix } from '@swf/core';
import { createPresentationRegistry } from '@swf/presentation';
import { cameraRotation, createProjectionRegistry, equirectangular } from '@swf/projections';
import { describe, expect, it } from 'vitest';
import type { MapView } from '../src/map.js';
import {
  MAP_SCALE,
  mapScene,
  MarkerDrag,
  markerAt,
  placedAt,
  toGround,
  toMap,
  zoomed,
} from '../src/map.js';
import { PANORAMA } from '../src/modes.js';
import { CAMERA_ID, planPreset, windowCommands } from '../src/presets.js';

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
    ...planPreset('seam', 1).flatMap(windowCommands),
  ]);
  expect(result.status).toBe('committed');
  return ws;
}

const VIEW: MapView = { centre: [0, 0], scale: 60, width: 600, height: 400 };

function origin(ws: ReturnType<typeof scene>, id: string) {
  const m = worldMatrix(ws.getState().nodes, id);
  if (m === undefined) throw new Error('no node');
  return [m[12], m[13], m[14]] as const;
}

/** The window's facing on the ground plane, as the heading its front (+Z) looks along. */
function facing(ws: ReturnType<typeof scene>, id: string) {
  const m = worldMatrix(ws.getState().nodes, id);
  if (m === undefined) throw new Error('no node');
  return Math.atan2(m[8], -m[10]);
}

describe('the spatial map (FR-124, UX-004, WF-05)', () => {
  it('maps the ground plane both ways, straight ahead up the page', () => {
    expect(toMap(VIEW, 0, -1)).toEqual([300, 140]);
    expect(toMap(VIEW, 1, 0)).toEqual([360, 200]);
    expect(toGround(VIEW, 360, 140)).toEqual([1, -1]);
    const zoom = zoomed(VIEW, 2, 450, 100);
    // The ground under the pointer stays under it.
    expect(toGround(zoom, 450, 100)).toEqual(toGround(VIEW, 450, 100));
    expect(zoomed(VIEW, 1000, 0, 0).scale).toBe(MAP_SCALE.max);
  });

  it('shows the camera, and each window in front of or behind it', () => {
    const ws = scene();
    const ahead = mapScene(ws.getState(), 'v');
    const side = (id: string) => ahead.markers.find((m) => m.id === id)?.side;
    // window-07 is straight ahead; window-01 sits on the seam straight behind.
    expect(side('window-07')).toBe('front');
    expect(side('window-01')).toBe('behind');
    ws.dispatch({ type: 'camera.patch', id: CAMERA_ID, rotation: cameraRotation(Math.PI, 0) });
    const turned = mapScene(ws.getState(), 'v');
    expect(turned.camera.heading).toBeCloseTo(Math.PI, 9);
    expect(turned.markers.find((m) => m.id === 'window-07')?.side).toBe('behind');
    expect(turned.markers.find((m) => m.id === 'window-01')?.side).toBe('front');
  });

  it('picks the marker under a point, within reach', () => {
    const ws = scene();
    const map = mapScene(ws.getState(), 'v');
    const marker = map.markers.find((m) => m.id === 'window-07');
    if (marker === undefined) throw new Error('no marker');
    const [px, py] = toMap(VIEW, marker.x, marker.z);
    expect(markerAt(VIEW, map, px + 3, py - 3, 10)?.id).toBe('window-07');
    expect(markerAt(VIEW, map, px + 40, py, 10)?.id).not.toBe('window-07');
  });

  it('previews a drag without committing, commits once, and keeps the window facing the camera', () => {
    const ws = scene();
    const revision = ws.getState().revision;
    const [, y] = origin(ws, 'window-07');
    const drag = new MarkerDrag(ws, 'v', 'window-07');
    expect(drag.moveTo(1, -1)).toBe(true);
    expect(drag.moveTo(3, 0)).toBe(true);
    // Nothing is committed while it is dragged; every view reads the preview.
    expect(ws.getState().revision).toBe(revision);
    const commit = drag.commit();
    expect(commit?.status).toBe('committed');
    expect(ws.getState().revision).toBe(revision + 1);
    const [x, after, z] = origin(ws, 'window-07');
    expect([x, z]).toEqual([3, 0]);
    // Its height is the depth control's, not the map's.
    expect(after).toBeCloseTo(y, 12);
    // Moved to the right of the camera, it turned to keep facing it.
    expect(Math.abs(facing(ws, 'window-07') - Math.atan2(-3, 0))).toBeLessThan(1e-9);
    // One undo puts it back.
    ws.undo();
    expect(origin(ws, 'window-07')[0]).not.toBe(3);
  });

  it('discards a cancelled drag, and refuses to move a locked window', () => {
    const ws = scene();
    const before = origin(ws, 'window-07');
    const drag = new MarkerDrag(ws, 'v', 'window-07');
    expect(drag.moveTo(2, 2)).toBe(true);
    // Every view shows the preview while it lasts.
    const shown = ws.getPresented().nodes.get('window-07')?.transform.position;
    expect(shown?.[0]).toBeCloseTo(2, 12);
    drag.cancel();
    expect(origin(ws, 'window-07')).toEqual(before);
    expect(ws.getPresented()).toBe(ws.getState());

    expect(
      ws.dispatch({ type: 'node.patch', id: 'window-07', flags: { locked: true } }).status,
    ).toBe('committed');
    const locked = new MarkerDrag(ws, 'v', 'window-07');
    expect(locked.moveTo(2, 2)).toBe(false);
    expect(locked.commit()).toBeNull();
    expect(origin(ws, 'window-07')).toEqual(before);
  });

  it('places a window by height alone, or on the ground, inside a group too', () => {
    const ws = scene();
    const grouped = ws.dispatch({ type: 'node.group', nodeIds: ['window-07'], group: { id: 'g' } });
    expect(grouped.status).toBe('committed');
    expect(ws.getState().nodes.get('window-07')?.parentId).toBe('g');
    const [x, , z] = origin(ws, 'window-07');
    const state = ws.getState();
    const raised = placedAt(state, 'window-07', [0, 0, 0], { y: 1.25 });
    if (raised === null) throw new Error('not placed');
    ws.dispatch({ type: 'node.patch', id: 'window-07', transform: raised });
    const [x2, y2, z2] = origin(ws, 'window-07');
    expect(x2).toBeCloseTo(x, 12);
    expect(z2).toBeCloseTo(z, 12);
    expect(y2).toBeCloseTo(1.25, 12);
    const grounded = placedAt(ws.getState(), 'window-07', [0, 0, 0], { x: -2, z: -2 });
    if (grounded === null) throw new Error('not placed');
    ws.dispatch({ type: 'node.patch', id: 'window-07', transform: grounded });
    const [x3, y3, z3] = origin(ws, 'window-07');
    expect(x3).toBeCloseTo(-2, 12);
    expect(y3).toBeCloseTo(1.25, 12);
    expect(z3).toBeCloseTo(-2, 12);
  });
});
