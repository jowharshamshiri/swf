import type { Workspace } from '@swf/core';
import { cameraRotation, headingPitchOf } from '@swf/projections';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FEATURES } from '../src/features.js';
import { FOCUS_ID } from '../src/focus.js';
import {
  aroundCamera,
  arrangedAround,
  mapScene,
  MarkerDrag,
  radarReach,
  radarView,
  ringStep,
} from '../src/map.js';
import { FIELD_OF_VIEW, MAP, ModeRefusal, OVERVIEW, panoramaProjection } from '../src/modes.js';
import { orbitHeading } from '../src/orbit.js';
import { PolicyRefusal } from '../src/policies.js';
import { CAMERA_ID } from '../src/presets.js';
import { centreOf, note, policyWorld, VIEWPORT, worldOf } from './policy-world.js';

const DEGREES = 180 / Math.PI;

/** Heading of a point round the camera at the origin, in degrees to the right. */
const headingOf = ([x, , z]: readonly number[]) => Math.atan2(x ?? 0, -(z ?? 0)) * DEGREES;
/** Distance of a point from the camera at the origin, on the ground. */
const groundDistance = ([x, , z]: readonly number[]) => Math.hypot(x ?? 0, z ?? 0);

/** Every node's world matrix: where everything in the scene is. */
function worldPlaces(ws: Workspace): Record<string, readonly number[]> {
  return Object.fromEntries(
    [...ws.getState().nodes.values()].map((n) => [n.id, [...worldOf(ws, n.id)]]),
  );
}

/** The scene's layout: everything but view state. */
function layout(ws: Workspace): string {
  const s = ws.serialize();
  return JSON.stringify([s.rootIds, s.nodes, s.surfaces, s.selection, s.focusedId, s.orbitRootId]);
}

const turnCamera = (ws: Workspace, degrees: number) => {
  const result = ws.dispatch(
    { type: 'camera.patch', id: CAMERA_ID, rotation: cameraRotation(degrees / DEGREES, 0) },
    { source: 'user' },
  );
  expect(result.status).toBe('committed');
};

describe('the panorama’s field of view', () => {
  it('zooms the panorama, keeping its proportion, and changes nothing but the view', () => {
    const { ws, modes } = policyWorld('sparse');
    const before = layout(ws);
    const history = ws.history().length;
    expect(modes.fieldOfView(150).status).toBe('committed');
    expect(ws.getState().viewports.get(VIEWPORT)?.projection).toEqual({
      id: 'equirectangular/1',
      config: { horizontal: 150, vertical: 50 },
    });
    expect(modes.panorama()).toEqual(panoramaProjection(150));
    expect(layout(ws)).toBe(before);
    // View state: nothing to undo.
    expect(ws.history()).toHaveLength(history);
  });

  it('is kept by every panoramic view, and by focus going back', () => {
    const { ws, modes, policies } = policyWorld('sparse');
    modes.register(OVERVIEW);
    expect(modes.fieldOfView(120).status).toBe('committed');
    const projection = () => ws.getState().viewports.get(VIEWPORT)?.projection;
    expect(modes.switchTo(MAP.id).status).toBe('committed');
    expect(projection()).toEqual(panoramaProjection(120));
    expect(modes.switchTo(OVERVIEW.id).status).toBe('committed');
    expect(projection()).toEqual(panoramaProjection(120));
    expect(modes.switchTo('panorama').status).toBe('committed');
    expect(projection()).toEqual(panoramaProjection(120));
    // Focus frames its window with a projection of its own; leaving it, the panorama's comes back.
    expect(policies.status().features.enabled.focus).toBe(true);
    expect(modes.switchTo(FOCUS_ID, { target: 'window-01' }).status).toBe('committed');
    expect(projection()).not.toEqual(panoramaProjection(120));
    expect(modes.panorama()).toEqual(panoramaProjection(120));
    expect(modes.back().status).toBe('committed');
    expect(projection()).toEqual(panoramaProjection(120));
    // Focus left for another view by a switch shows that view at the panorama's field of view.
    expect(modes.switchTo(FOCUS_ID, { target: 'window-01' }).status).toBe('committed');
    expect(modes.switchTo(MAP.id).status).toBe('committed');
    expect(projection()).toEqual(panoramaProjection(120));
  });

  it('refuses a field of view out of range, or while focus frames its own view', () => {
    const { ws, modes } = policyWorld('sparse');
    for (const degrees of [FIELD_OF_VIEW.min - 1, FIELD_OF_VIEW.max + 1, Number.NaN]) {
      expect(() => modes.fieldOfView(degrees)).toThrow(
        expect.objectContaining({ name: 'ModeRefusal', field: 'degrees' }) as Error,
      );
    }
    modes.switchTo(FOCUS_ID, { target: 'window-01' });
    const framed = ws.getState().viewports.get(VIEWPORT)?.projection;
    expect(() => modes.fieldOfView(200)).toThrow(ModeRefusal);
    expect(() => modes.fieldOfView(200)).toThrow(
      expect.objectContaining({ field: 'mode' }) as Error,
    );
    expect(ws.getState().viewports.get(VIEWPORT)?.projection).toEqual(framed);
  });
});

describe('turning the camera or the workspace', () => {
  it('switching what a background drag turns leaves every scene coordinate as it was', () => {
    const { ws, policies } = policyWorld('sparse');
    turnCamera(ws, 40);
    const places = worldPlaces(ws);
    const before = layout(ws);
    const history = ws.history().length;
    for (const target of ['orbit', 'camera', 'orbit', 'camera'] as const) {
      policies.navigate(target);
      expect(ws.getState().viewports.get(VIEWPORT)?.navigation).toBe(target);
      expect(worldPlaces(ws)).toEqual(places);
      expect(layout(ws)).toBe(before);
    }
    const camera = ws.getState().cameras.get(CAMERA_ID);
    if (camera === undefined) {
      throw new Error('no camera');
    }
    expect(headingPitchOf(camera.rotation).heading).toBeCloseTo(40 / DEGREES, 12);
    expect(ws.history()).toHaveLength(history);
  });

  it('turns the workspace to a heading: previewed while dragged, then one undoable change', () => {
    const { ws, policies } = policyWorld('sparse');
    const history = ws.history().length;
    const revision = ws.getState().revision;
    const before = centreOf(ws, 'window-01');
    expect(policies.turnWorkspaceTo(30, { preview: true })?.status).toBe('previewed');
    expect(policies.turnWorkspaceTo(60, { preview: true })?.status).toBe('previewed');
    // Nothing is committed while it is dragged; every view reads the preview.
    expect(ws.getState().revision).toBe(revision);
    expect(headingOf(centreOf(ws, 'window-01', true)) - headingOf(before)).toBeCloseTo(60, 9);
    expect(policies.turnWorkspaceTo(75, { preview: false })?.status).toBe('committed');
    expect(ws.history()).toHaveLength(history + 1);
    expect((orbitHeading(ws.getState()) ?? Number.NaN) * DEGREES).toBeCloseTo(75, 9);
    const after = centreOf(ws, 'window-01');
    expect(headingOf(after) - headingOf(before)).toBeCloseTo(75, 9);
    // Turned about the camera: as far away as it was, as high.
    expect(groundDistance(after)).toBeCloseTo(groundDistance(before), 12);
    expect(after[1]).toBeCloseTo(before[1], 12);
    // The shorter way round, past the seam behind the camera too.
    expect(policies.turnWorkspaceTo(-170, { preview: false })?.status).toBe('committed');
    expect((orbitHeading(ws.getState()) ?? Number.NaN) * DEGREES).toBeCloseTo(-170, 9);
    ws.undo();
    ws.undo();
    expect(centreOf(ws, 'window-01')[0]).toBeCloseTo(before[0], 12);
    expect(centreOf(ws, 'window-01')[2]).toBeCloseTo(before[2], 12);
    // Already so: nothing to commit.
    expect(policies.turnWorkspaceTo(0, { preview: false })).toBeNull();
  });

  it('refuses to turn the workspace with orbit off or no group designated', () => {
    const off = policyWorld('sparse', {
      ...DEFAULT_FEATURES,
      enabled: { ...DEFAULT_FEATURES.enabled, orbit: false },
    });
    expect(() => off.policies.turnWorkspaceTo(20, { preview: true })).toThrow(
      expect.objectContaining({ field: 'feature' }) as Error,
    );
    const { policies } = policyWorld('sparse');
    policies.designate(null);
    expect(() => policies.turnWorkspaceTo(20, { preview: false })).toThrow(PolicyRefusal);
    expect(() => policies.turnWorkspaceTo(Number.POSITIVE_INFINITY, { preview: false })).toThrow(
      expect.objectContaining({ field: 'degrees' }) as Error,
    );
  });
});

describe('quick actions: in front of the camera and behind it', () => {
  it('puts a window straight ahead or straight behind, at its distance and height, facing the camera', () => {
    const { ws } = policyWorld('sparse');
    turnCamera(ws, 30);
    const before = centreOf(ws, 'window-03');
    for (const [side, heading] of [
      ['front', 30],
      ['behind', -150],
    ] as const) {
      const transform = aroundCamera(ws.getState(), 'window-03', VIEWPORT, side);
      if (transform === null) {
        throw new Error('window-03 cannot be placed');
      }
      ws.dispatch({ type: 'node.patch', id: 'window-03', transform }, { source: 'user' });
      const after = centreOf(ws, 'window-03');
      expect(headingOf(after)).toBeCloseTo(heading, 9);
      expect(groundDistance(after)).toBeCloseTo(groundDistance(before), 12);
      expect(after[1]).toBeCloseTo(before[1], 12);
      // It faces the camera: its front (+Z) points back at the eye.
      const m = worldOf(ws, 'window-03');
      expect(Math.atan2(-m[8], m[10]) * DEGREES).toBeCloseTo(heading, 9);
    }
  });

  it('refuses a window standing at the camera, which has no distance to keep', () => {
    const { ws } = policyWorld([note('n', { heading: 0, distance: 3 })]);
    ws.dispatch(
      {
        type: 'node.patch',
        id: 'n',
        transform: { position: [0, 0.5, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
      { source: 'user' },
    );
    expect(() => aroundCamera(ws.getState(), 'n', VIEWPORT, 'front')).toThrow(RangeError);
  });
});

describe('arranging the windows round the camera', () => {
  it('spreads them evenly from straight ahead, by what they show, on three rings', () => {
    const { ws } = policyWorld('sparse');
    turnCamera(ws, 10);
    ws.dispatch(
      { type: 'node.patch', id: 'window-04', flags: { locked: true } },
      { source: 'user' },
    );
    const locked = centreOf(ws, 'window-04');
    const commands = arrangedAround(ws.getState(), VIEWPORT, [3, 4.75, 6.3], () => '');
    expect(commands).toHaveLength(5);
    expect(ws.transaction(commands, { source: 'user' }).status).toBe('committed');
    const state = ws.getState();
    const order = commands.map((c) => (c.type === 'node.patch' ? c.id : ''));
    // Notes first, then tiles, each by name.
    const kinds = order.map((id) => state.nodes.get(id)?.tags[0]);
    expect(kinds).toEqual([...kinds].sort());
    order.forEach((id, i) => {
      const at = centreOf(ws, id);
      const expected = 10 + (360 * i) / 5;
      const delta = ((((headingOf(at) - expected) % 360) + 540) % 360) - 180;
      expect(delta).toBeCloseTo(0, 9);
      expect(groundDistance(at)).toBeCloseTo([3, 4.75, 6.3][i % 3] ?? 0, 9);
    });
    // The locked window keeps its place.
    expect(centreOf(ws, 'window-04')).toEqual(locked);
    expect(() => arrangedAround(state, VIEWPORT, [3, 2, 5], () => '')).toThrow(RangeError);
  });
});

describe('the radar', () => {
  it('reaches past the farthest window to a ring, and fits that reach inside its rim', () => {
    expect(ringStep(4)).toBe(1);
    expect(ringStep(9)).toBe(5);
    expect(ringStep(0.3)).toBeCloseTo(0.1, 12);
    const { ws } = policyWorld([
      note('near', { heading: 0, distance: 2 }),
      note('far', { heading: 170, distance: 6 }),
    ]);
    const scene = mapScene(ws.getState(), VIEWPORT);
    // 6 × 1.1 = 6.6, rounded up to the next 2-unit ring.
    expect(radarReach(scene)).toBe(8);
    const view = radarView(scene, 300, 200, 20);
    expect(view.centre).toEqual([0, 0]);
    expect(view.scale).toBeCloseTo((100 - 20) / 8, 12);
  });

  it('snaps a window dragged on it to the windows beside it while magnetic positioning is on', () => {
    const { ws, policies } = policyWorld([
      note('a', { heading: 0, distance: 3 }),
      note('b', { heading: 40, distance: 3, elevation: 20 }),
    ]);
    const [bx, , bz] = centreOf(ws, 'b');
    const settings = () => policies.status().features.snap;
    const drag = new MarkerDrag(ws, VIEWPORT, 'b', [bx, bz], settings);
    // On the ground to 1.2° right of straight ahead: within the 2° line-up with a's heading.
    const target = 1.2 / DEGREES;
    const r = Math.hypot(bx, bz);
    expect(drag.moveTo(r * Math.sin(target), -r * Math.cos(target))).toBe(true);
    expect(drag.snap.constraints).toContainEqual(
      expect.objectContaining({ kind: 'align', axis: 'heading', neighbourId: 'a' }),
    );
    expect(drag.commit()?.status).toBe('committed');
    expect(headingOf(centreOf(ws, 'b'))).toBeCloseTo(0, 6);
    // Without it, the same drag lands where the pointer put it.
    const [cx, , cz] = centreOf(ws, 'b');
    const free = new MarkerDrag(ws, VIEWPORT, 'b', [cx, cz], () => null);
    expect(free.moveTo(r * Math.sin(target), -r * Math.cos(target))).toBe(true);
    expect(free.snap.constraints).toEqual([]);
    expect(free.commit()?.status).toBe('committed');
    expect(headingOf(centreOf(ws, 'b'))).toBeCloseTo(1.2, 6);
  });
});
