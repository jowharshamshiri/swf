import { worldMatrix } from '@swf/core';
import type { RoomPlace } from '@swf/interaction';
import { ROOM_LIMITS } from '@swf/interaction';
import { CARD_PIXELS_PER_UNIT, cardScale } from '@swf/presentation';
import { describe, expect, it } from 'vitest';
import type { SnapBox, SnapSettings } from '@swf/navigation';
import {
  cardMeasureOf,
  DEFAULT_FEATURES,
  MAGNETIC_POLICY_ID,
  NO_SNAP,
  resolveSnap,
  SNAP_SPACING,
  snappedPlace,
  spacedPlace,
} from '@swf/navigation';
import { centreOf, note, policyWorld, screenOf, VIEWPORT } from './policy-world.js';

const RAD = Math.PI / 180;
const SETTINGS: SnapSettings = { linear: 0.08, angular: 2, padding: 0.04, spoke: 0, ring: 0 };

/** The snap among neighbours alone: no rings, as `SETTINGS` sets no spokes. */
const snapAmong = (moving: SnapBox, neighbours: readonly SnapBox[], settings: SnapSettings) =>
  resolveSnap(moving, neighbours, settings, []);

/** Half the angle a card spans across: as a 1-unit-wide window's would at 3 units. */
const HALF = Math.atan2(0.5, 3);

/**
 * A window standing at a heading (radians) and a distance along the floor, at the height that
 * makes it look `elevation` (radians) above the horizon, its card spanning `half` either way.
 */
function box(
  id: string,
  heading: number,
  floor: number,
  elevation = 0,
  half: readonly [number, number] = [HALF, Math.atan2(0.3, 3)],
): SnapBox {
  return {
    id,
    label: id.toUpperCase(),
    place: { heading, floor, height: floor * Math.tan(elevation) },
    halfWidth: half[0],
    halfHeight: half[1],
  };
}

describe('magnetic positioning, resolved (FR-125)', () => {
  it('snaps an edge to a neighbour’s within the snap distance, leaving the padding between them', () => {
    // The moving window's right edge is 0.06 units (inside 0.08) short of the neighbour's left.
    const gap = 0.06 / 3;
    const snap = snapAmong(box('m', 0, 3), [box('n', 2 * HALF + gap, 3)], SETTINGS);
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
    const snap = snapAmong(box('m', 0, 3), [box('n', -(2 * HALF - overlap), 3)], SETTINGS);
    // Its left edge goes to the neighbour's right edge plus the padding.
    expect(snap.heading).toBeCloseTo(overlap + 0.04 / 3, 12);
    expect(snap.constraints[0]).toMatchObject({ kind: 'edge', side: 'left', neighbourId: 'n' });
  });

  it('leaves alone what lies beyond the thresholds, and windows that lie behind', () => {
    const far = snapAmong(
      box('m', 0, 3, 10 * RAD),
      [box('n', 2 * HALF + 0.2 / 3, 3, 30 * RAD)],
      SETTINGS,
    );
    expect(far).toEqual(NO_SNAP);
    // Edge to edge, but twice as far out along the floor: behind it, not beside it.
    const behind = snapAmong(box('m', 0, 3, 10 * RAD), [box('n', 2 * HALF, 6, 10 * RAD)], SETTINGS);
    expect(behind).toEqual(NO_SNAP);
    // A snap distance of zero snaps no edges.
    const none = snapAmong(box('m', 0, 3, 10 * RAD), [box('n', 2 * HALF + 0.01, 3, 20 * RAD)], {
      ...SETTINGS,
      linear: 0,
    });
    expect(none.constraints.filter((c) => c.kind === 'edge')).toEqual([]);
  });

  it('lines a centre up with a neighbour’s, and with the horizon, within the angle', () => {
    // Above the neighbour, 1.5° to its right: the columns line up.
    const column = snapAmong(box('m', 1.5 * RAD, 3, 40 * RAD), [box('n', 0, 3, 0)], SETTINGS);
    expect(column.heading).toBeCloseTo(-1.5 * RAD, 12);
    expect(column.elevation).toBe(0);
    expect(column.constraints).toEqual([
      { kind: 'align', axis: 'heading', neighbourId: 'n', neighbourLabel: 'N' },
    ]);
    const level = snapAmong(box('m', 0, 3, 1.5 * RAD), [], SETTINGS);
    expect(level.elevation).toBeCloseTo(-1.5 * RAD, 12);
    expect(level.constraints).toEqual([{ kind: 'horizon' }]);
    expect(snapAmong(box('m', 0, 3, 2.5 * RAD), [], SETTINGS)).toEqual(NO_SNAP);
  });

  it('takes the nearest snap on each axis, edges before line-ups at the same distance', () => {
    const near = box('near', 2 * HALF + 0.01 / 3, 3);
    const nearer = box('nearer', -(2 * HALF + 0.005 / 3), 3);
    const snap = snapAmong(box('m', 0, 3), [near, nearer], { ...SETTINGS, padding: 0 });
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
    const spoke = snapAmong(box('m', 14 * RAD, 3, 10 * RAD), [], spokes);
    expect(spoke.heading).toBeCloseTo(1 * RAD, 12);
    expect(spoke.constraints).toHaveLength(1);
    expect(spoke.constraints[0]).toMatchObject({ kind: 'spoke' });
    expect(spoke.constraints[0]?.kind === 'spoke' ? spoke.constraints[0].degrees : NaN).toBeCloseTo(
      15,
      9,
    );
    // Left of ahead too, and across the seam behind the camera.
    expect(snapAmong(box('m', -31 * RAD, 3, 10 * RAD), [], spokes).heading).toBeCloseTo(
      1 * RAD,
      12,
    );
    expect(snapAmong(box('m', 179 * RAD, 3, 10 * RAD), [], spokes).heading).toBeCloseTo(
      1 * RAD,
      12,
    );
    // Midway between spokes, beyond the line-up angle: no spoke.
    expect(snapAmong(box('m', 7 * RAD, 3, 10 * RAD), [], spokes)).toEqual(NO_SNAP);
    // Rings: within 0.3 of the ring at 4.75 its distance along the floor goes to it; 0.45 off, it
    // stays.
    const rings = [3, 4.75, 6.3];
    const ringed = resolveSnap(
      box('m', 7 * RAD, 4.9, 10 * RAD),
      [],
      { ...SETTINGS, ring: 0.3 },
      rings,
    );
    expect(ringed.distance).toBeCloseTo(-0.15, 12);
    expect(ringed.constraints).toEqual([{ kind: 'ring', distance: 4.75 }]);
    expect(
      resolveSnap(box('m', 7 * RAD, 5.2, 10 * RAD), [], { ...SETTINGS, ring: 0.3 }, rings),
    ).toEqual(NO_SNAP);
    // A ring threshold of zero snaps to no ring.
    expect(resolveSnap(box('m', 7 * RAD, 4.9, 10 * RAD), [], SETTINGS, rings)).toEqual(NO_SNAP);
  });

  it('moves a window snapped to a ring out along the floor, keeping its heading and how high it looks', () => {
    const place: RoomPlace = { heading: 20 * RAD, floor: 3, height: 0.6 };
    const moved = snappedPlace(place, {
      heading: 0,
      elevation: 0,
      distance: 1.5,
      constraints: [{ kind: 'ring', distance: 4.5 }],
    });
    expect(moved.heading).toBeCloseTo(20 * RAD, 12);
    expect(moved.floor).toBeCloseTo(4.5, 12);
    expect(moved.height / moved.floor).toBeCloseTo(0.6 / 3, 12);
  });

  it('turns a snapped window round the camera and onto the horizon, keeping its distance, inside the room', () => {
    const place: RoomPlace = { heading: 20 * RAD, floor: 3, height: 0.05 };
    const turned = snappedPlace(place, {
      heading: 5 * RAD,
      elevation: -Math.atan2(0.05, 3),
      distance: 0,
      constraints: [{ kind: 'horizon' }],
    });
    expect(turned.heading).toBeCloseTo(25 * RAD, 12);
    expect(turned.floor).toBeCloseTo(3, 12);
    expect(turned.height).toBeCloseTo(0, 12);
    // A ring past the room's far wall stands it at the wall.
    const out = snappedPlace(
      { heading: 0, floor: 13, height: 0 },
      { heading: 0, elevation: 0, distance: 2, constraints: [{ kind: 'ring', distance: 15 }] },
    );
    expect(out.floor).toBe(ROOM_LIMITS.farthest);
  });
});

describe('spacing a window dropped on a spoke', () => {
  const spokes = { ...SETTINGS, spoke: 15 };
  /** A window on the floor at a heading (degrees) and a distance, as snapping sees it. */
  const at = (id: string, degrees: number, floor: number) => box(id, degrees * RAD, floor);

  it('moves a window snapped onto a spoke where another stands to the nearest clear spoke, left first', () => {
    expect(SNAP_SPACING).toBe(1.8);
    // 14° out at 3 units snaps to the spoke at 15°; a neighbour stands 0.3 from that place.
    const moving = at('m', 14, 3);
    const snap = resolveSnap(moving, [], spokes, []);
    const spokeOf = (constraints: readonly { kind: string; degrees?: number }[]) =>
      constraints.find((c) => c.kind === 'spoke')?.degrees ?? NaN;
    expect(spokeOf(snap.constraints)).toBeCloseTo(15, 9);
    const crowd = at('n', 15, 3.3);
    const spaced = spacedPlace(snappedPlace(moving.place, snap), snap, [crowd], spokes);
    // Tried in turn: 0° and 30° (0.88 from the neighbour along the floor), -15° and 45° (1.66),
    // all nearer than 1.8; three spokes left, at -30°, is the first clear.
    expect((spaced.place.heading * 180) / Math.PI).toBeCloseTo(-30, 9);
    expect(spaced.place.floor).toBeCloseTo(3, 12);
    expect(spokeOf(spaced.snap.constraints)).toBeCloseTo(-30, 9);
    expect(spaced.snap.heading).toBeCloseTo(-44 * RAD, 12);
  });

  it('leaves a window clear of the others, or one not on a spoke, where its snap put it', () => {
    const moving = at('m', 14, 3);
    const snap = resolveSnap(moving, [], spokes, []);
    const snapped = snappedPlace(moving.place, snap);
    const clear = spacedPlace(snapped, snap, [at('far', 90, 3)], spokes);
    expect(clear.place).toBe(snapped);
    expect(clear.snap).toBe(snap);
    // Off every spoke (no spokes at all): a crowded place is left as it is.
    const free = spacedPlace(moving.place, NO_SNAP, [at('n', 14, 3.2)], SETTINGS);
    expect(free).toEqual({ place: moving.place, snap: NO_SNAP });
  });

  it('keeps the snapped place where no tried spoke is clear', () => {
    const moving = at('m', 14, 3);
    const snap = resolveSnap(moving, [], spokes, []);
    // A ring of windows all the way round, every 15°: nowhere is clear.
    const ring = Array.from({ length: 24 }, (_, i) => at(`r${String(i)}`, i * 15, 3));
    const snapped = snappedPlace(moving.place, snap);
    expect(spacedPlace(snapped, snap, ring, spokes).place).toBe(snapped);
  });
});

describe('a magnetic move (FR-125, UX-007, BR-004)', () => {
  /** a and b side by side 3 out along the floor, b 40° to the right. */
  const scene = () =>
    policyWorld([note('a', { heading: 0, reach: 3 }), note('b', { heading: 40, reach: 3 })]);
  const headingOf = (centre: readonly number[]) => Math.atan2(centre[0] ?? 0, -(centre[2] ?? 0));
  /** Half the angle a window's card spans across, as the panorama draws it at 3 out. */
  const halfOf = (w: ReturnType<typeof scene>) => {
    const measure = cardMeasureOf(w.ws.getState(), VIEWPORT, DEFAULT_FEATURES.depth);
    // A 1-unit card shown in full: its scale times 80 pixels, of the view's width for 360°.
    const scale = cardScale('full', 3, measure.horizontal, true);
    return ((CARD_PIXELS_PER_UNIT * scale) / measure.width) * Math.PI;
  };
  /** Moves b's centre (pressed with the takeover modifier) to a heading, in degrees. */
  const moveB = (w: ReturnType<typeof scene>, to: number, release: boolean) => {
    const [x, y] = screenOf(w.ws, centreOf(w.ws, 'b'));
    const target = x + (to - 40) * (800 / 360);
    w.input.pointer('down', VIEWPORT, x, y, { modifiers: { alt: true } });
    for (let i = 1; i <= 6; i += 1) {
      w.input.pointer('move', VIEWPORT, x + ((target - x) * i) / 6, y);
    }
    if (release) {
      w.input.pointer('up', VIEWPORT, target, y, { buttons: 0 });
    }
  };
  /** The angle between a's card's right edge and b's left edge, against the padding at 3 out. */
  const gapOf = (w: ReturnType<typeof scene>, presented: boolean) => {
    const half = halfOf(w);
    const a = centreOf(w.ws, 'a', presented);
    const b = centreOf(w.ws, 'b', presented);
    return {
      gap: headingOf(b) - half - (headingOf(a) + half),
      padding: 0.04 / Math.hypot(b[0], b[2]),
    };
  };
  /** Where b is moved: 1.2° short of touching a, inside the snap distance (0.08 at 3 out). */
  const nearA = (w: ReturnType<typeof scene>) => (2 * halfOf(w)) / RAD + 1.2;

  it('previews the snapped place as it moves, and commits it once on release', () => {
    const w = scene();
    expect(w.router.policyIds()).toContain(MAGNETIC_POLICY_ID);
    const before = w.ws.getState();
    const history = w.ws.history().length;
    moveB(w, nearA(w), false);
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

  it('moves a window dropped on a spoke beside another on to a clear spoke when let go, not while it moves', () => {
    const w = policyWorld([
      // 17°: off the 15° spoke by more than the 2° line-up angle, so b snaps to the spoke, not
      // to a's heading.
      note('a', { heading: 17, reach: 3.3 }),
      note('b', { heading: 60, reach: 3 }),
    ]);
    const headingOf = (centre: readonly number[]) =>
      (Math.atan2(centre[0] ?? 0, -(centre[2] ?? 0)) * 180) / Math.PI;
    const [x, y] = screenOf(w.ws, centreOf(w.ws, 'b'));
    const target = x + (14 - 60) * (800 / 360);
    w.input.pointer('down', VIEWPORT, x, y, { modifiers: { alt: true } });
    for (let i = 1; i <= 6; i += 1) {
      w.input.pointer('move', VIEWPORT, x + ((target - x) * i) / 6, y);
    }
    // While it moves it is shown snapped to the spoke at 15°, beside a, under the pointer.
    expect(headingOf(centreOf(w.ws, 'b', true))).toBeCloseTo(15, 6);
    w.input.pointer('up', VIEWPORT, target, y, { buttons: 0 });
    // Let go, it goes on to the first spoke clear of a along the floor: -30°.
    expect(headingOf(centreOf(w.ws, 'b'))).toBeCloseTo(-30, 6);
    expect(w.policies.status().ended).toMatchObject({ outcome: 'committed', nodeId: 'b' });
  });

  it('cancels with Escape, leaving the window where it was', () => {
    const w = scene();
    const before = w.ws.getState();
    const history = w.ws.history().length;
    moveB(w, nearA(w), false);
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
    moveB(w, nearA(w), true);
    const { gap, padding } = gapOf(w, false);
    expect(Math.abs(gap - padding)).toBeGreaterThan(0.004);
    w.policies.configure({ enabled: { snap: true } });
    expect(w.router.policyIds()).toContain(MAGNETIC_POLICY_ID);
  });
});
