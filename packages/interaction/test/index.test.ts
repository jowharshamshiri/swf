import type { SceneCommand } from '@swf/core';
import { createWorkspace, raycastBounds } from '@swf/core';
import type { Aabb, Ray } from '@swf/math';
import { aabbIntersects, normalize, rayIntersectAabb } from '@swf/math';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { BoundingVolumeTree, nodeKey, SceneIndex } from '../src/index.js';
import { windowCommands } from './fixtures.js';

const coordinate = fc.double({ min: -50, max: 50, noNaN: true });
const box = fc
  .tuple(coordinate, coordinate, coordinate, fc.double({ min: 0, max: 5, noNaN: true }))
  .map(([x, y, z, s]): Aabb => ({ min: [x, y, z], max: [x + s, y + s / 2, z + s / 3] }));
const ray = fc
  .tuple(coordinate, coordinate, coordinate, coordinate, coordinate, coordinate)
  .filter(([, , , dx, dy, dz]) => Math.hypot(dx, dy, dz) > 1e-3)
  .map(([x, y, z, dx, dy, dz]): Ray => ({
    origin: [x, y, z],
    direction: normalize([dx, dy, dz]),
  }));

type Op = { kind: 'set'; key: number; box: Aabb } | { kind: 'delete'; key: number };
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant('set' as const), key: fc.integer({ min: 0, max: 40 }), box }),
  fc.record({ kind: fc.constant('delete' as const), key: fc.integer({ min: 0, max: 40 }) }),
);

describe('bounding-volume tree (ARCH-004)', () => {
  it('answers ray and box queries exactly as a brute-force scan, through any edits', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 120 }), ray, box, (ops, r, query) => {
        const tree = new BoundingVolumeTree<number>();
        const truth = new Map<number, Aabb>();
        for (const o of ops) {
          if (o.kind === 'set') {
            tree.set(o.key, o.box);
            truth.set(o.key, o.box);
          } else {
            expect(tree.delete(o.key)).toBe(truth.delete(o.key));
          }
        }
        expect(tree.size).toBe(truth.size);
        const sorted = (keys: number[]) => [...keys].sort((a, b) => a - b);
        expect(sorted(tree.raycast(r))).toEqual(
          sorted([...truth].filter(([, b]) => rayIntersectAabb(r, b) !== null).map(([k]) => k)),
        );
        expect(sorted(tree.query(query))).toEqual(
          sorted([...truth].filter(([, b]) => aabbIntersects(b, query)).map(([k]) => k)),
        );
      }),
      { numRuns: 300 },
    );
  });

  it('honours a maximum ray distance', () => {
    const tree = new BoundingVolumeTree<string>();
    tree.set('near', { min: [-1, -1, -3], max: [1, 1, -2] });
    tree.set('far', { min: [-1, -1, -12], max: [1, 1, -10] });
    const r: Ray = { origin: [0, 0, 0], direction: [0, 0, -1] };
    expect(tree.raycast(r).sort()).toEqual(['far', 'near']);
    expect(tree.raycast(r, 5)).toEqual(['near']);
  });

  it('stays shallow when boxes arrive in sorted order', () => {
    const tree = new BoundingVolumeTree<number>();
    for (let i = 0; i < 1024; i++) {
      tree.set(i, { min: [i, 0, 0], max: [i + 0.5, 1, 1] });
    }
    // A degenerate (list-like) tree would be 1024 deep.
    expect(tree.height()).toBeLessThanOrEqual(40);
  });

  it('rejects a non-finite box', () => {
    const tree = new BoundingVolumeTree<string>();
    expect(() => {
      tree.set('x', { min: [0, 0, 0], max: [Infinity, 1, 1] });
    }).toThrow(RangeError);
  });
});

describe('scene index', () => {
  const groups: SceneCommand[] = [
    {
      type: 'node.create',
      node: { id: 'g', kind: 'group', bounds: [1, 1, 1], transform: at([0, 0, -5]) },
    },
  ];
  const windows = windowCommands(
    Array.from({ length: 10 }, (_, i) => ({
      id: `w${String(i)}`,
      heading: i * 0.6,
      distance: 3 + i,
      ...(i < 4 ? { parentId: 'g' } : {}),
    })),
  );

  it('finds exactly what a scan of the scene finds, and re-places only what moved', () => {
    const ws = createWorkspace({ id: 'ws' });
    expect(ws.transaction([...groups, ...windows]).status).toBe('committed');
    const index = new SceneIndex();
    const geometry = (id: string) => ws.surfaceGeometry(id);
    // Everything: 11 nodes and 10 surfaces.
    expect(index.sync(ws.getState(), geometry)).toBe(21);
    expect(index.sync(ws.getState(), geometry)).toBe(0);
    for (let heading = 0; heading < 6.3; heading += 0.3) {
      const r: Ray = { origin: [0, 0, 0], direction: [Math.sin(heading), 0, -Math.cos(heading)] };
      const nodes = index
        .raycast(r)
        .filter((k) => k.startsWith('node:'))
        .map((k) => k.slice(5))
        .sort();
      expect(nodes).toEqual(
        raycastBounds(ws.getState(), r)
          .map((h) => h.nodeId)
          .sort(),
      );
    }
    // Moving one window re-places it and its surface.
    expect(ws.dispatch({ type: 'node.patch', id: 'w7', transform: at([0, 0, -20]) }).status).toBe(
      'committed',
    );
    expect(index.sync(ws.getState(), geometry)).toBe(2);
    // Moving the group re-places it, its four windows and their surfaces.
    expect(ws.dispatch({ type: 'node.patch', id: 'g', transform: at([1, 0, -5]) }).status).toBe(
      'committed',
    );
    expect(index.sync(ws.getState(), geometry)).toBe(9);
    // A deleted window leaves the index with its surface.
    expect(ws.dispatch({ type: 'node.delete', id: 'w9', mode: 'subtree' }).status).toBe(
      'committed',
    );
    expect(index.sync(ws.getState(), geometry)).toBe(0);
    expect(index.size).toBe(19);
    expect(index.raycast({ origin: [0, 0, 0], direction: [0, 0, -1] })).toContain(nodeKey('w0'));
  });
});

function at(position: [number, number, number]) {
  return { position, rotation: [0, 0, 0, 1] as const, scale: [1, 1, 1] as const };
}
