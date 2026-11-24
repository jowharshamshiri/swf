import { DEFAULT_SETTINGS } from '@swf/interaction';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FEATURES } from '../src/features.js';
import type { OrbitState } from '../src/orbit.js';
import {
  cameraHeading,
  orbitHeading,
  orbitKeymap,
  orbitRepair,
  orbitStateOf,
  orbitTransition,
} from '../src/orbit.js';
import { PolicyRefusal } from '../src/policies.js';
import { CAMERA_ID, WORKSPACE_GROUP_ID } from '../src/presets.js';
import { centreOf, drag, policyWorld, VIEWPORT } from './policy-world.js';

const DEGREES = 180 / Math.PI;

/** Heading of a point round the camera at the origin, in degrees to the right. */
const headingOf = ([x, , z]: readonly number[]) => Math.atan2(x ?? 0, -(z ?? 0)) * DEGREES;

/** The background, high above every window of the sparse scene. */
const SKY_Y = 30;

describe('workspace orbit as plain transitions', () => {
  const world = policyWorld('sparse');
  const scene = world.ws.getState();
  const on: OrbitState = { enabled: true, navigation: 'camera', rootId: WORKSPACE_GROUP_ID };

  it('switches background drags to the orbit group only when orbit is on and a group is designated', () => {
    expect(orbitTransition(scene, VIEWPORT, on, { kind: 'navigate', to: 'orbit' })).toEqual({
      kind: 'next',
      state: { ...on, navigation: 'orbit' },
      commands: [{ type: 'viewport.patch', id: VIEWPORT, navigation: 'orbit' }],
    });
    expect(
      orbitTransition(
        scene,
        VIEWPORT,
        { ...on, enabled: false },
        { kind: 'navigate', to: 'orbit' },
      ),
    ).toEqual({ kind: 'refused', field: 'navigation', reason: 'workspace orbit is turned off' });
    expect(
      orbitTransition(scene, VIEWPORT, { ...on, rootId: null }, { kind: 'navigate', to: 'orbit' }),
    ).toMatchObject({ kind: 'refused', field: 'navigation' });
    // Already so: nothing to commit.
    expect(orbitTransition(scene, VIEWPORT, on, { kind: 'navigate', to: 'camera' })).toMatchObject({
      kind: 'next',
      commands: [],
    });
  });

  it('designates only an active group, and taking the group away returns drags to the camera', () => {
    expect(
      orbitTransition(scene, VIEWPORT, on, { kind: 'designate', nodeId: 'window-01' }),
    ).toMatchObject({
      kind: 'refused',
      field: 'nodeId',
      reason: expect.stringMatching(/ is a window, not a group$/) as string,
    });
    expect(
      orbitTransition(scene, VIEWPORT, on, { kind: 'designate', nodeId: 'nowhere' }),
    ).toMatchObject({ kind: 'refused', reason: 'no node "nowhere"' });
    const orbiting = { ...on, navigation: 'orbit' as const };
    expect(orbitTransition(scene, VIEWPORT, orbiting, { kind: 'designate', nodeId: null })).toEqual(
      {
        kind: 'next',
        state: { enabled: true, navigation: 'camera', rootId: null },
        commands: [
          { type: 'orbitRoot.set', nodeId: null },
          { type: 'viewport.patch', id: VIEWPORT, navigation: 'camera' },
        ],
      },
    );
    // Turning orbit off returns drags to the camera, and keeps the designation (scene data).
    expect(orbitTransition(scene, VIEWPORT, orbiting, { kind: 'enable', enabled: false })).toEqual({
      kind: 'next',
      state: { enabled: false, navigation: 'camera', rootId: WORKSPACE_GROUP_ID },
      commands: [{ type: 'viewport.patch', id: VIEWPORT, navigation: 'camera' }],
    });
    expect(orbitRepair({ ...orbiting, rootId: null }, VIEWPORT)).toEqual([
      { type: 'viewport.patch', id: VIEWPORT, navigation: 'camera' },
    ]);
    expect(orbitRepair(orbiting, VIEWPORT)).toEqual([]);
  });

  it('takes the keys that turn the orbit group out of the keymap while orbit is off', () => {
    const keymap = DEFAULT_SETTINGS.keymap;
    expect(keymap.some((b) => b.command === 'orbit.turn')).toBe(true);
    expect(orbitKeymap(keymap, false).some((b) => b.command === 'orbit.turn')).toBe(false);
    expect(orbitKeymap(keymap, false)).toHaveLength(
      keymap.filter((b) => b.command !== 'orbit.turn').length,
    );
    expect(orbitKeymap(keymap, true)).toEqual(keymap);
  });
});

describe('workspace orbit at work (FR-068, FR-106, FR-121, ARCH-022)', () => {
  it('turns the designated group about the camera in orbit navigation: previewed, committed once, undone exactly', () => {
    const w = policyWorld('sparse');
    expect(w.ws.getState().orbitRootId).toBe(WORKSPACE_GROUP_ID);
    w.policies.navigate('orbit');
    expect(w.ws.getState().viewports.get(VIEWPORT)?.navigation).toBe('orbit');
    const before = w.ws.getState();
    const camera = before.cameras.get(CAMERA_ID)?.rotation;
    const local = before.nodes.get('window-01')?.transform;
    const group = before.nodes.get(WORKSPACE_GROUP_ID)?.transform;
    const at = centreOf(w.ws, 'window-01');
    const history = w.ws.history().length;

    drag(w.input, [400, SKY_Y], [480, SKY_Y], 8, false);
    // While dragging, the turn is a preview: shown, not committed.
    expect(w.ws.getState()).toBe(before);
    expect(headingOf(centreOf(w.ws, 'window-01', true))).not.toBeCloseTo(headingOf(at), 1);
    w.input.pointer('up', VIEWPORT, 480, SKY_Y, { buttons: 0 });

    const after = w.ws.getState();
    expect(w.ws.history()).toHaveLength(history + 1);
    // The camera did not turn: only the group did, and the window kept its place in the group.
    expect(after.cameras.get(CAMERA_ID)?.rotation).toEqual(camera);
    expect(after.nodes.get('window-01')?.transform).toEqual(local);
    const turned = orbitHeading(after);
    expect(turned).not.toBeNull();
    expect(Math.abs((turned ?? 0) * DEGREES)).toBeGreaterThan(20);
    // Every window went round the camera by the group's turn, at its own distance.
    const moved = centreOf(w.ws, 'window-01');
    expect(Math.hypot(...moved)).toBeCloseTo(Math.hypot(...at), 9);
    expect(headingOf(moved) - headingOf(at)).toBeCloseTo((turned ?? 0) * DEGREES, 6);

    expect(w.ws.undo({ source: 'user' }).status).toBe('committed');
    expect(w.ws.getState().nodes.get(WORKSPACE_GROUP_ID)?.transform).toEqual(group);
    expect(centreOf(w.ws, 'window-01')).toEqual(at);
  });

  it('turns only the camera in camera navigation: view state, nothing to undo', () => {
    const w = policyWorld('sparse');
    const before = w.ws.getState();
    const group = before.nodes.get(WORKSPACE_GROUP_ID)?.transform;
    const history = w.ws.history().length;
    expect(before.viewports.get(VIEWPORT)?.navigation).toBe('camera');
    drag(w.input, [400, SKY_Y], [480, SKY_Y]);
    const after = w.ws.getState();
    expect(Math.abs(cameraHeading(after, VIEWPORT) * DEGREES)).toBeGreaterThan(20);
    expect(after.nodes.get(WORKSPACE_GROUP_ID)?.transform).toEqual(group);
    expect(orbitHeading(after)).toBe(0);
    expect(w.ws.history()).toHaveLength(history);
  });

  it('turns the workspace by command and by key, and neither while orbit is off', () => {
    const w = policyWorld('sparse');
    const group = () => w.ws.getState().nodes.get(WORKSPACE_GROUP_ID)?.transform;
    const start = group();
    expect(w.policies.turnWorkspace(30).status).toBe('committed');
    expect((orbitHeading(w.ws.getState()) ?? 0) * DEGREES).toBeCloseTo(30, 9);
    w.input.key('ArrowLeft', { viewportId: VIEWPORT, modifiers: { alt: true, shift: true } });
    const byKey = group();
    expect(byKey).not.toEqual(start);

    w.policies.navigate('orbit');
    w.policies.configure({ enabled: { orbit: false } });
    expect(w.ws.getState().viewports.get(VIEWPORT)?.navigation).toBe('camera');
    expect(orbitStateOf(w.ws.getState(), VIEWPORT, false).rootId).toBe(WORKSPACE_GROUP_ID);
    expect(() => w.policies.turnWorkspace(30)).toThrow(PolicyRefusal);
    expect(() => w.policies.navigate('orbit')).toThrow('workspace orbit is turned off');
    w.input.key('ArrowLeft', { viewportId: VIEWPORT, modifiers: { alt: true, shift: true } });
    expect(group()).toEqual(byKey);

    w.policies.configure({ enabled: { orbit: true } });
    w.input.key('ArrowLeft', { viewportId: VIEWPORT, modifiers: { alt: true, shift: true } });
    expect(group()).not.toEqual(byKey);
  });

  it('returns background drags to the camera when the orbit group is taken away', () => {
    const w = policyWorld('sparse');
    w.policies.navigate('orbit');
    w.ws.transaction([{ type: 'node.delete', id: WORKSPACE_GROUP_ID, mode: 'subtree' }], {
      source: 'user',
    });
    expect(w.ws.getState().orbitRootId).toBeNull();
    expect(w.ws.getState().viewports.get(VIEWPORT)?.navigation).toBe('camera');
    expect(w.policies.status().orbit).toEqual({
      enabled: true,
      navigation: 'camera',
      rootId: null,
    });
    expect(() => w.policies.navigate('orbit')).toThrow('no group is designated');
  });

  it('keeps every feature’s data when orbit is turned off and on', () => {
    const w = policyWorld('sparse', DEFAULT_FEATURES);
    w.policies.turnWorkspace(45);
    const scene = w.ws.getState().nodes;
    w.policies.configure({ enabled: { orbit: false } });
    w.policies.configure({ enabled: { orbit: true } });
    expect(w.ws.getState().nodes).toBe(scene);
  });
});
