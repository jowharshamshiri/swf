import { worldMatrix } from '@swf/core';
import { placementOf } from '@swf/interaction';
import type { Vec3 } from '@swf/math';
import { describe, expect, it } from 'vitest';
import type { SnapSettings } from '../src/features.js';
import type { SnapBox } from '../src/magnetic.js';
import { NO_SNAP, resolveSnap, snappedTransform, worldAt } from '../src/magnetic.js';
import { MAGNETIC_POLICY_ID } from '../src/magnetic-policy.js';
import { centreOf, note, policyWorld, screenOf, VIEWPORT } from './policy-world.js';

const RAD = Math.PI / 180;
const EYE: Vec3 = [0, 0, 0];
const SETTINGS: SnapSettings = { linear: 0.08, angular: 2, padding: 0.04, spoke: 0, ring: 0 };

/** The snap among neighbours alone: no spokes and no rings, as `SETTINGS` sets them. */
const snapAmong = (
  moving: SnapBox,
  neighbours: readonly SnapBox[],
  eye: Vec3,
  settings: SnapSettings,
) => resolveSnap(moving, neighbours, eye, settings, []);

/** A box seen at a heading and elevation (radians) and a distance from the eye. */
function box(
  id: string,
  heading: number,
  distance: number,
  elevation = 0,
  half: readonly [number, number] = [0.5, 0.3],
): SnapBox {
  return {
    id,
    label: id.toUpperCase(),
    centre: [
      distance * Math.cos(elevation) * Math.sin(heading),
      distance * Math.sin(elevation),
      -distance * Math.cos(elevation) * Math.cos(heading),
    ],
    halfWidth: half[0],
    halfHeight: half[1],
  };
}

/** The angular half width of a 0.5-unit half width at 3 units. */
const HALF = Math.atan2(0.5, 3);

describe('magnetic positioning, resolved (FR-125)', () => {
  it('snaps an edge to a neighbour’s within the snap distance, leaving the padding between them', () => {
    // The moving window's right edge is 0.06 units (inside 0.08) short of the neighbour's left.
    const gap = 0.06 / 3;
    const snap = snapAmong(box('m', 0, 3), [box('n', 2 * HALF + gap, 3)], EYE, SETTINGS);
    expect(snap.heading).toBeCloseTo(gap - 0.04 / 3, 12);
    expect(snap.constraints).toContainEqual({
      kind: 'edge',
      side: 'right',
      neighbourId: 'n',
      neighbourLabel: 'N',
    });
  });

  it('pushes a window overlapping a neighbour by less than the snap distance out to the padding', () => {
    const overlap = 0.05 / 3;
    const snap = snapAmong(box('m', 0, 3), [box('n', -(2 * HALF - overlap), 3)], EYE, SETTINGS);
    // Its left edge goes to the neighbour's right edge plus the padding.
    expect(snap.heading).toBeCloseTo(overlap + 0.04 / 3, 12);
    expect(snap.constraints[0]).toMatchObject({ kind: 'edge', side: 'left', neighbourId: 'n' });
  });

  it('leaves alone what lies beyond the thresholds, and windows that lie behind', () => {
    const far = snapAmong(
      box('m', 0, 3, 10 * RAD),
      [box('n', 2 * HALF + 0.2 / 3, 3, 30 * RAD)],
      EYE,
      SETTINGS,
    );
    expect(far).toEqual(NO_SNAP);
    // Edge to edge, but twice as far from the camera: behind it, not beside it.
    const behind = snapAmong(
      box('m', 0, 3, 10 * RAD),
      [box('n', 2 * HALF, 6, 10 * RAD)],
      EYE,
      SETTINGS,
    );
    expect(behind).toEqual(NO_SNAP);
    // A snap distance of zero snaps no edges.
    const none = snapAmong(
      box('m', 0, 3, 10 * RAD),
      [box('n', 2 * HALF + 0.01, 3, 20 * RAD)],
      EYE,
      { ...SETTINGS, linear: 0 },
    );
    expect(none.constraints.filter((c) => c.kind === 'edge')).toEqual([]);
  });

  it('lines a centre up with a neighbour’s, and with the horizon, within the angle', () => {
    // Above the neighbour, 1.5° to its right: the columns line up.
    const column = snapAmong(box('m', 1.5 * RAD, 3, 40 * RAD), [box('n', 0, 3, 0)], EYE, SETTINGS);
    expect(column.heading).toBeCloseTo(-1.5 * RAD, 12);
    expect(column.elevation).toBe(0);
    expect(column.constraints).toEqual([
      { kind: 'align', axis: 'heading', neighbourId: 'n', neighbourLabel: 'N' },
    ]);
    const level = snapAmong(box('m', 0, 3, 1.5 * RAD), [], EYE, SETTINGS);
    expect(level.elevation).toBeCloseTo(-1.5 * RAD, 12);
    expect(level.constraints).toEqual([{ kind: 'horizon' }]);
    expect(snapAmong(box('m', 0, 3, 2.5 * RAD), [], EYE, SETTINGS)).toEqual(NO_SNAP);
  });

  it('takes the nearest snap on each axis, edges before line-ups at the same distance', () => {
    const near = box('near', 2 * HALF + 0.01 / 3, 3);
    const nearer = box('nearer', -(2 * HALF + 0.005 / 3), 3);
    const snap = snapAmong(box('m', 0, 3), [near, nearer], EYE, { ...SETTINGS, padding: 0 });
    expect(snap.heading).toBeCloseTo(-0.005 / 3, 12);
    expect(snap.constraints[0]).toMatchObject({ kind: 'edge', neighbourId: 'nearer' });
    // On the horizon already, level with both neighbours: the line-up with the first one wins.
    expect(snap.constraints[1]).toMatchObject({
      kind: 'align',
      axis: 'elevation',
      neighbourId: 'near',
    });
  });

  it('snaps a heading to the nearest spoke within the angle, and a distance to the nearest ring within reach', () => {
    const spokes = { ...SETTINGS, spoke: 15 };
    // 1° short of the spoke at 15°, well off the horizon.
    const spoke = snapAmong(box('m', 14 * RAD, 3, 10 * RAD), [], EYE, spokes);
    expect(spoke.heading).toBeCloseTo(1 * RAD, 12);
    expect(spoke.constraints).toHaveLength(1);
    expect(spoke.constraints[0]).toMatchObject({ kind: 'spoke' });
    expect(spoke.constraints[0]?.kind === 'spoke' ? spoke.constraints[0].degrees : NaN).toBeCloseTo(
      15,
      9,
    );
    // Left of ahead too, and across the seam behind the camera.
    expect(snapAmong(box('m', -31 * RAD, 3, 10 * RAD), [], EYE, spokes).heading).toBeCloseTo(
      1 * RAD,
      12,
    );
    expect(snapAmong(box('m', 179 * RAD, 3, 10 * RAD), [], EYE, spokes).heading).toBeCloseTo(
      1 * RAD,
      12,
    );
    // Midway between spokes, beyond the line-up angle: no spoke.
    expect(snapAmong(box('m', 7 * RAD, 3, 10 * RAD), [], EYE, spokes)).toEqual(NO_SNAP);
    // Rings: within 0.3 of the ring at 4.75 its distance goes to it; 0.45 off, it stays.
    const rings = [3, 4.75, 6.3];
    const ringed = resolveSnap(
      box('m', 7 * RAD, 4.9, 10 * RAD),
      [],
      EYE,
      { ...SETTINGS, ring: 0.3 },
      rings,
    );
    expect(ringed.distance).toBeCloseTo(-0.15, 12);
    expect(ringed.constraints).toEqual([{ kind: 'ring', distance: 4.75 }]);
    expect(
      resolveSnap(box('m', 7 * RAD, 5.2, 10 * RAD), [], EYE, { ...SETTINGS, ring: 0.3 }, rings),
    ).toEqual(NO_SNAP);
    // A ring threshold of zero snaps to no ring.
    expect(resolveSnap(box('m', 7 * RAD, 4.9, 10 * RAD), [], EYE, SETTINGS, rings)).toEqual(
      NO_SNAP,
    );
  });

  it('moves a window snapped to a ring out along its line from the camera, keeping its heading and facing', () => {
    const w = policyWorld([note('a', { heading: 20, distance: 3 })]);
    const placement = placementOf(w.ws.getState(), 'a');
    const moved = snappedTransform(placement, placement.world, EYE, {
      heading: 0,
      elevation: 0,
      distance: 1.5,
      constraints: [{ kind: 'ring', distance: 4.5 }],
    });
    expect(moved).not.toBeNull();
    const world = worldAt(placement, moved ?? placement.local);
    const centre: Vec3 = [world[12], world[13], world[14]];
    expect(Math.hypot(...centre)).toBeCloseTo(4.5, 9);
    expect(Math.atan2(centre[0], -centre[2]) / RAD).toBeCloseTo(20, 9);
    // Turned as it was: its rotation is the rotation it had.
    expect([world[0], world[2], world[8], world[10]].map((v) => Number(v.toFixed(9)))).toEqual(
      [placement.world[0], placement.world[2], placement.world[8], placement.world[10]].map((v) =>
        Number(v.toFixed(9)),
      ),
    );
  });

  it('turns a snapped window about the camera: it keeps its distance and how it faces the camera', () => {
    const w = policyWorld([note('a', { heading: 20, distance: 3 })]);
    const scene = w.ws.getState();
    const placement = placementOf(scene, 'a');
    const turned = snappedTransform(placement, placement.world, EYE, {
      heading: 5 * RAD,
      elevation: 0,
      distance: 0,
      constraints: [{ kind: 'horizon' }],
    });
    expect(turned).not.toBeNull();
    const world = worldAt(placement, turned ?? placement.local);
    const centre: Vec3 = [world[12], world[13], world[14]];
    expect(Math.hypot(...centre)).toBeCloseTo(3, 12);
    expect(Math.atan2(centre[0], -centre[2]) / RAD).toBeCloseTo(25, 9);
    // Its front still looks straight back at the camera.
    const front: Vec3 = [world[8], world[9], world[10]];
    expect(Math.atan2(-front[0], front[2]) / RAD).toBeCloseTo(25, 9);
  });
});

describe('a magnetic move (FR-125, UX-007, BR-004)', () => {
  /** A beside b, 25° apart at 3 units: b's left edge is 6° from a's right edge. */
  const scene = () =>
    policyWorld([note('a', { heading: 0, distance: 3 }), note('b', { heading: 25, distance: 3 })]);
  const headingOf = (centre: Vec3) => Math.atan2(centre[0], -centre[2]);
  /** Moves b's centre (pressed with the takeover modifier) to a heading, in degrees. */
  const moveB = (w: ReturnType<typeof scene>, to: number, release: boolean) => {
    const [x, y] = screenOf(w.ws, centreOf(w.ws, 'b'));
    const target = x + (to - 25) * (800 / 360);
    w.input.pointer('down', VIEWPORT, x, y, { modifiers: { alt: true } });
    for (let i = 1; i <= 6; i += 1) {
      w.input.pointer('move', VIEWPORT, x + ((target - x) * i) / 6, y);
    }
    if (release) {
      w.input.pointer('up', VIEWPORT, target, y, { buttons: 0 });
    }
  };
  /** The angle between a's right edge and b's left edge, against the padding at b's distance. */
  const gapOf = (w: ReturnType<typeof scene>, presented: boolean) => {
    const a = centreOf(w.ws, 'a', presented);
    const b = centreOf(w.ws, 'b', presented);
    const da = Math.hypot(...a);
    const db = Math.hypot(...b);
    return {
      gap: headingOf(b) - Math.atan2(0.5, db) - (headingOf(a) + Math.atan2(0.5, da)),
      padding: 0.04 / db,
    };
  };

  it('previews the snapped place as it moves, and commits it once on release', () => {
    const w = scene();
    expect(w.router.policyIds()).toContain(MAGNETIC_POLICY_ID);
    const before = w.ws.getState();
    const history = w.ws.history().length;
    // Moved 1.2° short of touching (0.063 units): inside the snap distance.
    moveB(w, 2 * (HALF / RAD) + 1.2, false);
    // Nothing is committed while it moves but the window's selection: taken, it is selected.
    expect(w.ws.getState().nodes).toStrictEqual(before.nodes);
    expect(w.ws.getState().selection).toEqual(['b']);
    expect(w.ws.history()).toHaveLength(history);
    const previewed = gapOf(w, true);
    expect(previewed.gap).toBeCloseTo(previewed.padding, 6);
    expect(w.policies.status().gesture).toMatchObject({
      operation: 'node.move',
      nodeId: 'b',
      snap: {
        constraints: expect.arrayContaining([
          expect.objectContaining({ kind: 'edge', side: 'left', neighbourId: 'a' }),
        ]) as unknown[],
      },
    });
    w.input.pointer('up', VIEWPORT, 0, 0, { buttons: 0 });
    expect(w.ws.history()).toHaveLength(history + 1);
    const committed = gapOf(w, false);
    expect(committed.gap).toBeCloseTo(committed.padding, 6);
    expect(w.policies.status().ended).toMatchObject({
      operation: 'node.move',
      outcome: 'committed',
    });
    // One undo puts b back exactly.
    w.ws.undo({ source: 'user' });
    expect(w.ws.getState().nodes.get('b')?.transform).toEqual(before.nodes.get('b')?.transform);
  });

  it('cancels with Escape, leaving the window where it was', () => {
    const w = scene();
    const before = w.ws.getState();
    const history = w.ws.history().length;
    moveB(w, 2 * (HALF / RAD) + 1.2, false);
    w.input.key('Escape', { viewportId: VIEWPORT });
    // Nothing changed but the selection, which is not undone.
    expect(w.ws.getState().nodes).toStrictEqual(before.nodes);
    expect(w.ws.history()).toHaveLength(history);
    expect(worldMatrix(w.ws.getPresented().nodes, 'b')).toEqual(worldMatrix(before.nodes, 'b'));
    expect(w.policies.status().ended).toMatchObject({ outcome: 'cancelled', reason: 'escape' });
  });

  it('moves without snapping once magnetic positioning is turned off', () => {
    const w = scene();
    w.policies.configure({ enabled: { snap: false } });
    expect(w.router.policyIds()).not.toContain(MAGNETIC_POLICY_ID);
    moveB(w, 2 * (HALF / RAD) + 1.2, true);
    const { gap, padding } = gapOf(w, false);
    expect(Math.abs(gap - padding)).toBeGreaterThan(0.004);
    w.policies.configure({ enabled: { snap: true } });
    expect(w.router.policyIds()).toContain(MAGNETIC_POLICY_ID);
  });
});
