import { createWorkspace } from '@swf/core';
import { quatFromAxisAngle } from '@swf/math';
import { describe, expect, it } from 'vitest';
import { poseOf, wrapDegrees } from '../src/pose.js';

const RADIANS = Math.PI / 180;

/** A workspace with one window at a heading and distance, turned `yaw` degrees to the right. */
function windowAt(heading: number, distance: number, yaw: number, y = 0) {
  const ws = createWorkspace({ id: 'pose' });
  const h = heading * RADIANS;
  const result = ws.dispatch({
    type: 'node.create',
    node: {
      id: 'w',
      kind: 'window',
      bounds: [1.6, 0.9, 0.01],
      flags: { locked: true, rotatable: false },
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
  return ws.getState();
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
