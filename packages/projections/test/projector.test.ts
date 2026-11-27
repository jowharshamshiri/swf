import type { SceneCommand } from '@swf/core';
import { createWorkspace } from '@swf/core';
import { quatFromAxisAngle } from '@swf/math';
import type { RepresentationPolicy } from '@swf/presentation';
import { cardScale, COMPACT_CARD, createViewOutput, LABEL_CARD } from '@swf/presentation';
import { describe, expect, it } from 'vitest';
import { equirectangular, projectorOf } from '../src/index.js';
import type { Placement } from './fixtures.js';
import { H, placed, setup, W } from './fixtures.js';

const projector = projectorOf(equirectangular);
const project = (
  placements: readonly Placement[],
  options: Parameters<typeof setup>[0] = {},
  representation: RepresentationPolicy | null = null,
) => {
  const ws = placed(placements);
  const { view } = setup(options);
  const fragments = projector.project(
    ws.getState(),
    view,
    (id) => ws.surfaceGeometry(id),
    representation,
  );
  // What it gives is a view output the presenter accepts.
  createViewOutput(ws.getState(), 'v', fragments);
  return { fragments, view, ws };
};

describe('cards at the windows’ projected centres', () => {
  it('draws a window as a flat, upright card centred where its centre projects, its own size', () => {
    const { fragments } = project([{ id: 'a', heading: 0.5, distance: 5, y: 1, size: [2, 1] }]);
    expect(fragments).toHaveLength(1);
    const [f] = fragments;
    // Centred on the image of its centre: 0.5 radians right, 1 up at 5 out.
    const x = W / 2 + (0.5 / (2 * Math.PI)) * W;
    const y = H / 2 - (Math.atan2(1, 5) / ((120 * Math.PI) / 180)) * H;
    // Every window shown in full: scaled by its distance along the floor and the field of view.
    const scale = cardScale('full', 5, 360, false);
    expect(f?.scale).toBeCloseTo(scale, 12);
    const [cx, cy, cw, ch] = f?.card ?? [];
    expect(cw).toBeCloseTo(2 * 80 * scale, 9);
    expect(ch).toBeCloseTo(1 * 80 * scale, 9);
    expect((cx ?? 0) + (cw ?? 0) / 2).toBeCloseTo(x, 9);
    expect((cy ?? 0) + (ch ?? 0) / 2).toBeCloseTo(y, 9);
    expect(f?.bounds).toEqual(f?.card);
    expect(f).toMatchObject({
      representation: 'full',
      geometricFidelity: 'exact',
      nativeOwner: true,
      ordinal: 0,
    });
    expect(f?.depth).toBeCloseTo(Math.hypot(5, 1), 12);
  });

  it('lays a window’s surfaces on its card where they lie on the window, across and up', () => {
    const ws = createWorkspace({ id: 'ws' });
    const surface = (id: string, x: number): SceneCommand => ({
      type: 'surface.attach',
      surface: {
        id,
        ownerNodeId: 'w',
        bindingKey: `key-${id}`,
        adapterTypeId: 'host.view/1',
        bounds: [1, 0.5, 0.01],
        transform: { position: [x, 0.25, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
    });
    ws.transaction([
      {
        type: 'node.create',
        node: {
          id: 'w',
          kind: 'window',
          bounds: [2, 1, 0.01],
          transform: { position: [0, 0, -4], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
      },
      surface('left', -0.5),
      surface('right', 0.5),
    ]);
    const { view } = setup();
    const fragments = projector.project(ws.getState(), view, (id) => ws.surfaceGeometry(id), null);
    const of = (id: string) => fragments.find((f) => f.surfaceId === id);
    const card = of('left')?.card ?? [0, 0, 0, 0];
    const unit = card[2] / 2;
    // Each half of the card's width, in its upper half.
    expect(of('left')?.bounds[0]).toBeCloseTo(card[0], 9);
    expect(of('right')?.bounds[0]).toBeCloseTo(card[0] + unit, 9);
    expect(of('left')?.bounds[1]).toBeCloseTo(card[1], 9);
    expect(of('right')?.bounds[2]).toBeCloseTo(unit, 9);
    expect(of('right')?.bounds[3]).toBeCloseTo(unit / 2, 9);
    expect(of('right')?.card).toEqual(card);
  });

  it('draws a card across the seam at both edges, its widest part the native owner', () => {
    const { fragments } = project([
      { id: 'a', heading: Math.PI - 0.02, distance: 3, size: [2, 1] },
    ]);
    expect(fragments.map((f) => f.ordinal)).toEqual([0, 1]);
    const [own, copy] = fragments;
    expect(own?.nativeOwner).toBe(true);
    expect(copy?.nativeOwner).toBe(false);
    // The same card, a whole view apart: one reaching past the right edge, one past the left.
    expect(Math.abs((own?.card[0] ?? 0) - (copy?.card[0] ?? 0))).toBeCloseTo(W, 9);
    const inside = (b: readonly number[]) =>
      Math.min(W, (b[0] ?? 0) + (b[2] ?? 0)) - Math.max(0, b[0] ?? 0);
    expect(inside(own?.bounds ?? [])).toBeGreaterThan(inside(copy?.bounds ?? []));
  });

  it('shows the part of a card whose centre is past a narrow view’s edge, and nothing of one wholly out', () => {
    const narrow = { config: { horizontal: 90, vertical: 60 } };
    // 46° right in a 90° view: the centre a little past the right edge, the card reaching in.
    const { fragments } = project(
      [
        { id: 'edge', heading: (46 * Math.PI) / 180, distance: 2, size: [2, 1] },
        { id: 'behind', heading: Math.PI, distance: 3 },
      ],
      narrow,
    );
    expect(fragments.map((f) => f.surfaceId)).toEqual(['edge']);
    const [x, , w] = fragments[0]?.bounds ?? [];
    expect((x ?? 0) + (w ?? 0) / 2).toBeGreaterThan(W);
    expect(x).toBeLessThan(W);
  });

  it('places a window or surface that carries a rotation of its own approximately, so a host is told', () => {
    const { fragments } = project([
      { id: 'upright', heading: -0.5, distance: 4 },
      { id: 'turned', heading: 0.5, distance: 4, rotation: quatFromAxisAngle([0, 1, 0], 0.3) },
    ]);
    const fidelity = Object.fromEntries(fragments.map((f) => [f.surfaceId, f.geometricFidelity]));
    expect(fidelity).toEqual({ upright: 'exact', turned: 'approximate' });
  });

  it('sizes each card as the representation policy shows its window, asked once per surface', () => {
    const asked: string[] = [];
    const policy: RepresentationPolicy = {
      id: 'test.depth/1',
      representationOf({ surfaceId }) {
        asked.push(surfaceId);
        return surfaceId === 'near' ? 'full' : surfaceId === 'mid' ? 'compact' : 'label';
      },
    };
    const { fragments } = project(
      [
        { id: 'near', heading: -1, distance: 4, size: [2, 1] },
        { id: 'mid', heading: 0, distance: 8, size: [2, 1] },
        { id: 'far', heading: 1, distance: 12, size: [2, 1] },
      ],
      {},
      policy,
    );
    expect(asked).toEqual(['near', 'mid', 'far']);
    const of = (id: string) => fragments.find((f) => f.surfaceId === id);
    expect(of('near')?.card[2]).toBeCloseTo(2 * 80 * cardScale('full', 4, 360, true), 9);
    expect(of('mid')?.card[2]).toBeCloseTo(2 * 80 * 0.9 * COMPACT_CARD.width, 9);
    expect(of('far')?.card[2]).toBeCloseTo(LABEL_CARD.width, 9);
    expect(of('mid')?.representation).toBe('compact');
  });

  it('takes the card scale a policy gives, and refuses one that is no scale', () => {
    const focus: RepresentationPolicy = {
      id: 'test.focus/1',
      representationOf: () => 'full',
      scaleOf: ({ surfaceId }, natural) => (surfaceId === 'a' ? 2 : natural),
    };
    const { fragments } = project(
      [
        { id: 'a', heading: 0, distance: 6, size: [2, 1] },
        { id: 'b', heading: 1, distance: 6, size: [2, 1] },
      ],
      {},
      focus,
    );
    expect(fragments.find((f) => f.surfaceId === 'a')?.scale).toBe(2);
    expect(fragments.find((f) => f.surfaceId === 'b')?.scale).toBeCloseTo(
      cardScale('full', 6, 360, true),
      12,
    );
    const broken: RepresentationPolicy = { ...focus, scaleOf: () => Number.NaN };
    expect(() => project([{ id: 'a', heading: 0, distance: 6 }], {}, broken)).toThrow(
      /gave card scale null for surface "a"/,
    );
  });

  it('leaves out a window nearer than the view’s near distance or beyond its far one', () => {
    const { fragments } = project(
      [
        { id: 'near', heading: 0, distance: 0.5 },
        { id: 'mid', heading: 0.4, distance: 3 },
        { id: 'far', heading: -0.4, distance: 9 },
      ],
      { near: 1, far: 5 },
    );
    expect(fragments.map((f) => f.surfaceId)).toEqual(['mid']);
  });
});
