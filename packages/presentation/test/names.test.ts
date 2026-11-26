import type { SceneCommand } from '@swf/core';
import { createWorkspace } from '@swf/core';
import { models } from '@swf/models';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { NameObstacle, NameRequest, RenderFrame, ScreenRect } from '../src/index.js';
import { NAME_MARK, placeNames, windowNames } from '../src/index.js';

const VIEW = { width: 400, height: 200 };

const overlap = (a: ScreenRect, b: ScreenRect) =>
  a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

const written = (requests: readonly NameRequest[], at: ReturnType<typeof placeNames>) =>
  requests.flatMap((r, i) => {
    const p = at[i];
    return p === null || p === undefined
      ? []
      : [{ owner: r.owner, box: [p[0], p[1], r.size[0], r.size[1]] as ScreenRect }];
  });

const rect = fc.tuple(
  fc.integer({ min: -50, max: 450 }),
  fc.integer({ min: -50, max: 250 }),
  fc.integer({ min: 1, max: 120 }),
  fc.integer({ min: 1, max: 60 }),
);
const request = fc.record({
  owner: fc.constantFrom('a', 'b', 'c', 'd', 'e'),
  text: fc.string(),
  size: fc.tuple(fc.integer({ min: 1, max: 160 }), fc.integer({ min: 1, max: 30 })),
  places: fc.array(
    fc.tuple(fc.integer({ min: -80, max: 480 }), fc.integer({ min: -40, max: 240 })),
    {
      minLength: 1,
      maxLength: 5,
    },
  ),
});
const obstacle = fc.record({ owner: fc.constantFrom('a', 'b', 'c', 'd', 'e'), box: rect });

describe('placing names (Swf.Names)', () => {
  it('writes every name wholly inside the view, over no other owner’s obstacle or name', () => {
    fc.assert(
      fc.property(
        fc.array(obstacle, { maxLength: 12 }),
        fc.array(request, { maxLength: 12 }),
        (obstacles, requests) => {
          const names = written(requests, placeNames(VIEW, obstacles, requests));
          names.forEach((a, i) => {
            const [x, y, w, h] = a.box;
            expect(x >= 0 && y >= 0 && x + w <= VIEW.width && y + h <= VIEW.height).toBe(true);
            for (const b of names.slice(i + 1)) {
              if (a.owner !== b.owner) {
                expect(overlap(a.box, b.box)).toBe(false);
              }
            }
            for (const o of obstacles) {
              if (o.owner !== a.owner) {
                expect(overlap(a.box, o.box)).toBe(false);
              }
            }
          });
        },
      ),
    );
  });

  it('takes the first place offered that is free, moved inside the view as little as it must be', () => {
    const at = placeNames(
      VIEW,
      [{ owner: 'w', box: [0, 0, 100, 40] }],
      [
        // Its first place is over another window; the second runs off the right edge.
        {
          owner: 'n',
          text: 'Name',
          size: [50, 20],
          places: [
            [10, 10],
            [380, 100],
          ],
        },
        // Over its own window: allowed.
        { owner: 'w', text: 'Own', size: [30, 20], places: [[5, 5]] },
        // Larger than the view: nowhere.
        { owner: 'x', text: 'Huge', size: [500, 20], places: [[0, 0]] },
      ],
    );
    expect(at).toEqual([[350, 100], [5, 5], null]);
  });

  it('gives a name no place where every place offered is taken, and is unmoved by obstacles far from every place', () => {
    const requests: NameRequest[] = [
      { owner: 'a', text: 'A', size: [40, 20], places: [[100, 100]] },
      { owner: 'b', text: 'B', size: [40, 20], places: [[110, 105]] },
    ];
    const near: NameObstacle[] = [{ owner: 'c', box: [0, 0, 20, 20] }];
    expect(placeNames(VIEW, near, requests)).toEqual([[100, 100], null]);
    fc.assert(
      fc.property(fc.array(request, { maxLength: 8 }), (asked) => {
        const far: NameObstacle[] = [{ owner: 'z', box: [5000, 5000, 10, 10] }];
        expect(placeNames(VIEW, far, asked)).toEqual(placeNames(VIEW, [], asked));
      }),
    );
  });
});

describe('placing names as the model places them', () => {
  /** The model asked about every obstacle and every place, nothing left out. */
  function unpruned(
    view: { width: number; height: number },
    obstacles: readonly NameObstacle[],
    requests: readonly NameRequest[],
  ) {
    const owners = new Map<string, bigint>();
    const owner = (id: string) => {
      const known = owners.get(id);
      if (known !== undefined) return known;
      const next = BigInt(owners.size);
      owners.set(id, next);
      return next;
    };
    const places = requests.flatMap((r, i) => {
      const [w, h] = r.size;
      if (!(w > 0 && h > 0 && w <= view.width && h <= view.height)) return [];
      const seen = new Set<string>();
      return r.places.flatMap(([px, py]) => {
        const at = [
          Math.min(Math.floor(view.width - w), Math.max(0, Math.round(px))),
          Math.min(Math.floor(view.height - h), Math.max(0, Math.round(py))),
        ] as const;
        const key = at.join(',');
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ request: i, at }];
      });
    });
    const boxes = [
      ...obstacles.map((o, i) => {
        const [x, y, w, h] = o.box;
        return {
          name: BigInt(requests.length + i),
          owner: owner(o.owner),
          x: BigInt(Math.floor(x)),
          y: BigInt(Math.floor(y)),
          width: BigInt(Math.max(0, Math.ceil(x + w) - Math.floor(x))),
          height: BigInt(Math.max(0, Math.ceil(y + h) - Math.floor(y))),
          kept: true,
        };
      }),
      ...places.map(({ request, at }) => ({
        name: BigInt(request),
        owner: owner(requests[request]?.owner ?? ''),
        x: BigInt(at[0]),
        y: BigInt(at[1]),
        width: BigInt(Math.ceil(requests[request]?.size[0] ?? 0)),
        height: BigInt(Math.ceil(requests[request]?.size[1] ?? 0)),
        kept: false,
      })),
    ];
    const shown = models.labelsShown(boxes);
    const placed: ([number, number] | null)[] = requests.map(() => null);
    places.forEach(({ request, at }, i) => {
      if (shown[obstacles.length + i] === true) placed[request] = [at[0], at[1]];
    });
    return placed;
  }

  it('answers exactly as the model asked about every obstacle and every place', () => {
    const many = fc.record({
      owner: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g'),
      box: fc.tuple(
        fc.double({ min: -50, max: 450, noNaN: true }),
        fc.double({ min: -50, max: 250, noNaN: true }),
        fc.double({ min: 0, max: 140, noNaN: true }),
        fc.double({ min: 0, max: 70, noNaN: true }),
      ),
    });
    fc.assert(
      fc.property(
        fc.array(many, { maxLength: 30 }),
        fc.array(request, { maxLength: 30 }),
        (obstacles, requests) => {
          expect(placeNames(VIEW, obstacles, requests)).toEqual(
            unpruned(VIEW, obstacles, requests),
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('the names of a frame’s windows', () => {
  function frameOf(
    fragments: readonly {
      readonly node: string;
      readonly bounds: ScreenRect;
      readonly representation: 'full' | 'compact' | 'label';
    }[],
    selection: readonly string[] = [],
    focused: string | null = null,
  ): RenderFrame {
    const ws = createWorkspace({ id: 'ws' });
    const nodes = [...new Set(fragments.map((f) => f.node))];
    const commands: SceneCommand[] = nodes.flatMap((id): SceneCommand[] => [
      {
        type: 'node.create',
        node: { id, kind: 'window', bounds: [1, 1, 0.01], label: `Window ${id}` },
      },
      {
        type: 'surface.attach',
        surface: {
          id: `${id}-s`,
          ownerNodeId: id,
          bindingKey: `k-${id}`,
          adapterTypeId: 'test.view/1',
          bounds: [1, 1, 0.01],
        },
      },
    ]);
    commands.push({ type: 'selection.set', ids: [...selection] });
    if (focused !== null) {
      commands.push({ type: 'focus.set', id: focused });
    }
    const result = ws.transaction(commands);
    if (result.status !== 'committed') {
      throw new Error('fixture failed');
    }
    return {
      scene: ws.getState(),
      planned: fragments.map((f) => ({
        fragment: { surfaceId: `${f.node}-s`, bounds: f.bounds },
        representation: f.representation,
      })),
    } as unknown as RenderFrame;
  }
  const measure = (text: string) => [7 * text.length, 15] as const;

  it('offers a framed window’s name above its frame, then inside it, then below; a far one’s beside its mark', () => {
    const { names, obstacles, marks } = windowNames(
      frameOf([
        { node: 'near', bounds: [100, 80, 120, 60], representation: 'full' },
        { node: 'far', bounds: [300, 90, 20, 10], representation: 'label' },
      ]),
      measure,
    );
    const near = names.find((n) => n.owner === 'near');
    // "Window near": 77 by 15.
    expect(near?.places).toEqual([
      [100, 80 - 15 - 3],
      [100 + 120 - 77, 62],
      [104, 84],
      [100 + 120 - 77 - 4, 84],
      [100 + 60 - 38.5, 80 + 30 - 7.5],
      [100, 143],
      [143, 143],
    ]);
    expect(near?.marked).toBe(false);
    const far = names.find((n) => n.owner === 'far');
    expect(far?.marked).toBe(true);
    expect(far?.places[0]).toEqual([310 + NAME_MARK / 2 + 3, 95 - 7.5]);
    expect(marks.get('far')).toEqual([[310, 95]]);
    expect(obstacles).toEqual([
      { owner: 'near', box: [100, 80, 120, 60] },
      { owner: 'far', box: [310 - NAME_MARK / 2, 95 - NAME_MARK / 2, NAME_MARK, NAME_MARK] },
    ]);
  });

  it('weighs the selected window’s name first, the focused one’s next, then the nearer before the farther', () => {
    const fragments = ['a', 'b', 'c', 'd'].map((node, i) => ({
      node,
      bounds: [i * 50, 50, 40, 30] as ScreenRect,
      representation: 'full' as const,
    }));
    // Planned back to front: d is the nearest.
    expect(windowNames(frameOf(fragments), measure).names.map((n) => n.owner)).toEqual([
      'd',
      'c',
      'b',
      'a',
    ]);
    expect(windowNames(frameOf(fragments, ['b'], 'a'), measure).names.map((n) => n.owner)).toEqual([
      'b',
      'a',
      'd',
      'c',
    ]);
  });
});
