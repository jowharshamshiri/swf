import { createWorkspace } from '@swf/core';
import { quatFromAxisAngle } from '@swf/math';
import { describe, expect, it } from 'vitest';
import { posedPatch, poseOf, wrapDegrees } from '../src/pose.js';

const RADIANS = Math.PI / 180;

/** A workspace with one window at a heading and distance, turned `yaw` degrees to the right. */
function windowAt(
  heading: number,
  distance: number,
  yaw: number,
  y = 0,
  flags: { readonly locked: boolean; readonly rotatable: boolean } = {
    locked: true,
    rotatable: false,
  },
) {
  return placed(heading, distance, yaw, y, flags).getState();
}

function placed(
  heading: number,
  distance: number,
  yaw: number,
  y: number,
  flags: { readonly locked: boolean; readonly rotatable: boolean },
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
        rotation: quatFromAxisAngle([0, 1, 0], -yaw * RADIANS),
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
  it('says where it is round the camera and how far it is turned from facing it', () => {
    // Facing the camera squarely: turned 0.
    const facing = poseOf(windowAt(30, 3, 30), 'w', [0, 0, 0]);
    expect(facing?.heading).toBeCloseTo(30, 9);
    expect(facing?.elevation).toBeCloseTo(0, 9);
    expect(facing?.distance).toBeCloseTo(3, 9);
    expect(facing?.turned).toBeCloseTo(0, 9);
    expect(facing).toMatchObject({ width: 1.6, height: 0.9, locked: true, rotatable: false });
    // Turned 10° further right than facing the camera.
    expect(poseOf(windowAt(30, 3, 40), 'w', [0, 0, 0])?.turned).toBeCloseTo(10, 9);
    // Left of ahead and above the horizon.
    const left = poseOf(windowAt(-90, 2, -90, 2), 'w', [0, 0, 0]);
    expect(left?.heading).toBeCloseTo(-90, 9);
    expect(left?.elevation).toBeCloseTo(45, 9);
    // How far out it stands across the ground, whatever its height.
    expect(left?.reach).toBeCloseTo(2, 9);
    // Seen from where the camera stands, not from the world's origin.
    expect(poseOf(windowAt(0, 3, 0), 'w', [0, 0, 1])?.distance).toBeCloseTo(4, 9);
    expect(poseOf(windowAt(0, 3, 0), 'none', [0, 0, 0])).toBeNull();
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
   * The patch that poses a window standing 30° right, 3 out, 0.5 up and turned 10° from facing the
   * camera, and its pose once applied, from the origin.
   */
  const posed = (target: Parameters<typeof posedPatch>[3]) => {
    const ws = placed(30, 3, 40, 0.5, { locked: false, rotatable: true });
    const patch = posedPatch(ws.getState(), 'w', [0, 0, 0], target);
    if (patch === null) {
      throw new Error('no patch');
    }
    expect(ws.dispatch(patch).status).toBe('committed');
    return { patch, pose: poseOf(ws.getState(), 'w', [0, 0, 0]) };
  };

  it('moves it round the camera, out from it and up, each on its own, still facing it as it did', () => {
    const round = posed({ heading: -120 });
    expect(round.pose?.heading).toBeCloseTo(-120, 9);
    expect(round.pose?.reach).toBeCloseTo(3, 9);
    expect(round.pose?.position[1]).toBeCloseTo(0.5, 9);
    expect(round.pose?.turned).toBeCloseTo(10, 9);
    expect(round.patch.bounds).toBeUndefined();
    const out = posed({ reach: 7.5 });
    expect(out.pose?.heading).toBeCloseTo(30, 9);
    expect(out.pose?.reach).toBeCloseTo(7.5, 9);
    expect(out.pose?.turned).toBeCloseTo(10, 9);
    const up = posed({ y: -1.25 });
    expect(up.pose?.position[1]).toBeCloseTo(-1.25, 9);
    expect(up.pose?.reach).toBeCloseTo(3, 9);
    expect(up.pose?.heading).toBeCloseTo(30, 9);
  });

  it('turns it about its own centre, and sizes it keeping its centre, leaving the rest as it was', () => {
    const turned = posed({ turned: -45 });
    expect(turned.pose?.turned).toBeCloseTo(-45, 9);
    expect(turned.pose?.heading).toBeCloseTo(30, 9);
    expect(turned.pose?.reach).toBeCloseTo(3, 9);
    const sized = posed({ width: 2.5 });
    expect(sized.patch.transform).toBeUndefined();
    expect(sized.pose).toMatchObject({ width: 2.5, height: 0.9 });
    expect(sized.pose?.heading).toBeCloseTo(30, 9);
    // All at once: one change.
    const all = posed({ heading: 90, reach: 5, y: 1, turned: 0, width: 1, height: 2 });
    expect(all.pose?.heading).toBeCloseTo(90, 9);
    expect(all.pose?.reach).toBeCloseTo(5, 9);
    expect(all.pose?.position[1]).toBeCloseTo(1, 9);
    expect(all.pose?.turned).toBeCloseTo(0, 9);
    expect(all.pose).toMatchObject({ width: 1, height: 2 });
  });
});
