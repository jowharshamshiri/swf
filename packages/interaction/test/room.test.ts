import { createWorkspace } from '@swf/core';
import { models } from '@swf/models';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { RoomPlace } from '../src/index.js';
import { ROOM_LIMITS, ROOM_PACE, RoomMotion, roomPlaceOf, standingInRoom } from '../src/index.js';
import { windowCommands } from './fixtures.js';

const W = 800;
const FULL_CIRCLE = 2 * Math.PI;

/** A drag of `dx`, `dy` pixels from `start` in a view `W` wide showing the whole circle. */
const drag = (start: RoomPlace, dx: number, dy: number, alongFloor = false) =>
  models.dragStep(ROOM_LIMITS, ROOM_PACE, {
    start,
    dx,
    dy,
    width: W,
    fieldOfView: FULL_CIRCLE,
    alongFloor,
  });

const inside = (p: RoomPlace) =>
  p.floor >= ROOM_LIMITS.nearest &&
  p.floor <= ROOM_LIMITS.farthest &&
  p.height >= ROOM_LIMITS.lowest &&
  p.height <= ROOM_LIMITS.highest &&
  p.heading > -Math.PI - 1e-12 &&
  p.heading <= Math.PI + 1e-12;

const place = fc.record({
  heading: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
  floor: fc.double({ min: 2, max: 13.5, noNaN: true }),
  height: fc.double({ min: -3, max: 4, noNaN: true }),
});
const pixels = fc.double({ min: -5000, max: 5000, noNaN: true });

describe('the room every window stands in (Swf.Room)', () => {
  it('brings a window dragged a whole view across, the full circle, back where it began', () => {
    const start = { heading: 0.4, floor: 5.2, height: 1.1 };
    const round = drag(start, W, 0);
    expect(round.heading).toBeCloseTo(start.heading, 12);
    expect(round.floor).toBe(start.floor);
    expect(round.height).toBe(start.height);
    // In steps across the seam, the same.
    let at = start;
    for (let i = 0; i < 16; i += 1) {
      at = drag(at, W / 16, 0);
    }
    expect(at.heading).toBeCloseTo(start.heading, 9);
  });

  it('turns a window by the motion across at the view’s angle a pixel, and keeps it inside the room', () => {
    fc.assert(
      fc.property(place, pixels, pixels, fc.boolean(), (start, dx, dy, alongFloor) => {
        const moved = drag(start, dx, dy, alongFloor);
        expect(inside(moved)).toBe(true);
        const turned = start.heading + (dx / W) * FULL_CIRCLE;
        expect(Math.cos(moved.heading - turned)).toBeCloseTo(1, 9);
      }),
    );
  });

  it('raises a window the same height for a pixel whatever its distance, and Shift moves it along the floor instead', () => {
    const near = drag({ heading: 0, floor: 2, height: 0 }, 0, -68);
    const far = drag({ heading: 0, floor: 13, height: 0 }, 0, -68);
    expect(near.height).toBeCloseTo(1, 12);
    expect(far.height).toBeCloseTo(1, 12);
    expect(near.floor).toBe(2);
    expect(far.floor).toBe(13);
    const out = drag({ heading: 0, floor: 5, height: 1 }, 0, 27, true);
    expect(out.floor).toBeCloseTo(6, 12);
    expect(out.height).toBe(1);
    // Never above the ceiling nor out past the room's edge.
    expect(drag({ heading: 0, floor: 5, height: 3.9 }, 0, -1000).height).toBe(4);
    expect(drag({ heading: 0, floor: 13, height: 0 }, 0, 1000, true).floor).toBe(13.5);
  });

  it('moves a window along the floor with the wheel, down farther, and stands a dropped window where it lands', () => {
    const start = { heading: 1, floor: 5, height: 0.5 };
    const farther = models.wheelOnFloor(ROOM_LIMITS, ROOM_PACE, start, 100);
    expect(farther.floor).toBeCloseTo(5 * Math.exp(0.12), 12);
    expect(farther.heading).toBeCloseTo(1, 12);
    expect(farther.height).toBe(0.5);
    expect(models.wheelOnFloor(ROOM_LIMITS, ROOM_PACE, start, -100000).floor).toBe(2);
    const dropped = models.floorDrop(ROOM_LIMITS, start, 3, -4);
    expect(dropped.floor).toBeCloseTo(5, 12);
    expect(dropped.heading).toBeCloseTo(Math.atan2(3, 4), 12);
    expect(dropped.height).toBe(0.5);
  });

  it('looks as high as its height over its floor distance, whatever its heading', () => {
    expect(models.elevationOf({ heading: 0, floor: 4, height: 4 })).toBeCloseTo(Math.PI / 4, 12);
    expect(models.elevationOf({ heading: 2, floor: 4, height: 4 })).toBeCloseTo(Math.PI / 4, 12);
  });

  it('reads a window’s place from the scene and stands it at a place, in its group too', () => {
    const ws = createWorkspace({ id: 'room' });
    const made = ws.transaction([
      {
        type: 'node.create',
        node: {
          id: 'g',
          kind: 'group',
          bounds: [1, 1, 1],
          transform: {
            position: [0, 0, 0],
            rotation: [0, Math.sin(0.35), 0, Math.cos(0.35)],
            scale: [1, 1, 1],
          },
        },
      },
      ...windowCommands([
        { id: 'a', heading: 0.5, distance: 5, y: 1 },
        { id: 'b', heading: -1, distance: 4, y: 0, parentId: 'g' },
      ]),
    ]);
    expect(made.status).toBe('committed');
    const eye = [0, 0, 0] as const;
    const a = roomPlaceOf(ws.getState(), 'a', eye);
    expect(a.heading).toBeCloseTo(0.5, 9);
    expect(a.height).toBeCloseTo(1, 9);
    const there = { heading: 2.5, floor: 9, height: -2 };
    for (const id of ['a', 'b']) {
      const transform = standingInRoom(ws.getState(), id, eye, there);
      if (transform === null) throw new Error('no placement');
      ws.dispatch({ type: 'node.patch', id, transform });
      const now = roomPlaceOf(ws.getState(), id, eye);
      expect(now.heading).toBeCloseTo(there.heading, 9);
      expect(now.floor).toBeCloseTo(there.floor, 9);
      expect(now.height).toBeCloseTo(there.height, 9);
    }
  });
});

describe('a pointer’s motion of a window round the room', () => {
  const at = (x: number, y: number, shift = false) => ({ x, y, modifiers: { shift } });
  const start: RoomPlace = { heading: 0, floor: 5, height: 0 };

  it('starts afresh when Shift changes, from where the pointer was last, losing no motion', () => {
    const motion = new RoomMotion(start, at(100, 100));
    const raised = motion.moved(at(100, 66), W, FULL_CIRCLE);
    expect(raised.height).toBeCloseTo(0.5, 12);
    motion.accept(raised);
    // Shift pressed at the next position: the 27 px since then move it along the floor.
    const out = motion.moved(at(100, 93, true), W, FULL_CIRCLE);
    expect(out).toMatchObject({ height: raised.height });
    expect(out.floor).toBeCloseTo(6, 12);
  });

  it('carries on from where the wheel put the window, counting no motion twice', () => {
    const motion = new RoomMotion(start, at(0, 0));
    motion.accept(motion.moved(at(100, 0), W, FULL_CIRCLE));
    const wheeled = motion.wheeled(100);
    expect(wheeled.floor).toBeCloseTo(5 * Math.exp(0.12), 12);
    motion.accept(wheeled);
    motion.restart();
    const on = motion.moved(at(150, 0), W, FULL_CIRCLE);
    expect(on.heading).toBeCloseTo((150 / W) * FULL_CIRCLE, 12);
    expect(on.floor).toBeCloseTo(wheeled.floor, 12);
  });

  it('leaves the window where it stood when a proposed place is refused', () => {
    const motion = new RoomMotion(start, at(0, 0));
    motion.moved(at(0, -68), W, FULL_CIRCLE);
    expect(motion.place).toBe(start);
    // The wheel turns from where it stands, not from the place refused.
    expect(motion.wheeled(0)).toEqual(start);
  });
});
