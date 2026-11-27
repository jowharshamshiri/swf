import { createWorkspace } from '@swf/core';
import { ROOM_LIMITS } from '@swf/interaction';
import { describe, expect, it } from 'vitest';
import { posedPatch, poseOf, wrapDegrees } from '../src/pose.js';

const RADIANS = Math.PI / 180;

/** A workspace with one upright window at a heading (degrees), a floor distance and a height. */
function placed(
  heading: number,
  distance: number,
  y = 0,
  flags: { readonly locked: boolean } = { locked: true },
) {
  const ws = createWorkspace({ id: 'pose' });
  const h = heading * RADIANS;
  const result = ws.dispatch({
    type: 'node.create',
    node: {
      id: 'w',
      kind: 'window',
      bounds: [1.6, 0.9, 0.01],
      flags,
      transform: {
        position: [distance * Math.sin(h), y, -distance * Math.cos(h)],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    },
  });
  if (result.status !== 'committed') {
    throw new Error(JSON.stringify(result));
  }
  return ws;
}

describe('a window’s pose, as the operator reads it', () => {
  it('says where it stands in the room: its heading, floor distance and height, and how high it looks', () => {
    const ahead = poseOf(placed(30, 3).getState(), 'w', [0, 0, 0]);
    expect(ahead?.heading).toBeCloseTo(30, 9);
    expect(ahead?.elevation).toBeCloseTo(0, 9);
    expect(ahead?.distance).toBeCloseTo(3, 9);
    expect(ahead?.reach).toBeCloseTo(3, 9);
    expect(ahead).toMatchObject({ width: 1.6, height: 0.9, locked: true, movable: true });
    // Left of ahead and above the horizon: its elevation derived from its height and reach.
    const left = poseOf(placed(-90, 2, 2).getState(), 'w', [0, 0, 0]);
    expect(left?.heading).toBeCloseTo(-90, 9);
    expect(left?.elevation).toBeCloseTo(45, 9);
    // How far out it stands along the floor, whatever its height; and how high it stands, apart
    // from its frame's own height.
    expect(left?.reach).toBeCloseTo(2, 9);
    expect(left?.above).toBeCloseTo(2, 9);
    expect(left?.height).toBe(0.9);
    expect(poseOf(placed(0, 3, 1).getState(), 'w', [0, 0.25, 0])?.above).toBeCloseTo(0.75, 9);
    expect(left?.distance).toBeCloseTo(Math.hypot(2, 2), 9);
    // Seen from where the camera stands, not from the world's origin.
    expect(poseOf(placed(0, 3).getState(), 'w', [0, 0, 1])?.distance).toBeCloseTo(4, 9);
    expect(poseOf(placed(0, 3).getState(), 'none', [0, 0, 0])).toBeNull();
  });

  it('brings angles into −180 to 180, with no negative zero', () => {
    expect(wrapDegrees(190)).toBe(-170);
    expect(wrapDegrees(-190)).toBe(170);
    expect(wrapDegrees(720)).toBe(0);
    expect(Object.is(wrapDegrees(-360), 0)).toBe(true);
  });
});

describe('posing a window as the inspector sets it', () => {
  /**
   * The patch that poses a window standing 30° right, 3 out along the floor and 0.5 up, and its
   * pose once applied, from the origin.
   */
  const posed = (target: Parameters<typeof posedPatch>[3]) => {
    const ws = placed(30, 3, 0.5, { locked: false });
    const patch = posedPatch(ws.getState(), 'w', [0, 0, 0], target);
    if (patch === null) {
      throw new Error('no patch');
    }
    expect(ws.dispatch(patch).status).toBe('committed');
    return { patch, pose: poseOf(ws.getState(), 'w', [0, 0, 0]) };
  };

  it('moves it round the room, out along the floor and up, each on its own, upright as it stood', () => {
    const round = posed({ heading: -120 });
    expect(round.pose?.heading).toBeCloseTo(-120, 9);
    expect(round.pose?.reach).toBeCloseTo(3, 9);
    expect(round.pose?.position[1]).toBeCloseTo(0.5, 9);
    expect(round.patch.bounds).toBeUndefined();
    expect(round.patch.transform?.rotation).toEqual([0, 0, 0, 1]);
    const out = posed({ reach: 7.5 });
    expect(out.pose?.heading).toBeCloseTo(30, 9);
    expect(out.pose?.reach).toBeCloseTo(7.5, 9);
    expect(out.pose?.position[1]).toBeCloseTo(0.5, 9);
    const up = posed({ y: -1.25 });
    expect(up.pose?.position[1]).toBeCloseTo(-1.25, 9);
    expect(up.pose?.reach).toBeCloseTo(3, 9);
    expect(up.pose?.heading).toBeCloseTo(30, 9);
  });

  it('keeps it inside the room', () => {
    const far = posed({ reach: 40, y: 10 });
    expect(far.pose?.reach).toBeCloseTo(ROOM_LIMITS.farthest, 9);
    expect(far.pose?.position[1]).toBeCloseTo(ROOM_LIMITS.highest, 9);
    expect(posed({ reach: 0.5, y: -10 }).pose).toMatchObject({
      reach: ROOM_LIMITS.nearest,
      position: [expect.any(Number), ROOM_LIMITS.lowest, expect.any(Number)],
    });
  });

  it('sizes it keeping its centre, leaving the rest as it was, and does everything at once as one change', () => {
    const sized = posed({ width: 2.5 });
    expect(sized.patch.transform).toBeUndefined();
    expect(sized.pose).toMatchObject({ width: 2.5, height: 0.9 });
    expect(sized.pose?.heading).toBeCloseTo(30, 9);
    const all = posed({ heading: 90, reach: 5, y: 1, width: 1, height: 2 });
    expect(all.pose?.heading).toBeCloseTo(90, 9);
    expect(all.pose?.reach).toBeCloseTo(5, 9);
    expect(all.pose?.position[1]).toBeCloseTo(1, 9);
    expect(all.pose).toMatchObject({ width: 1, height: 2 });
  });
});
