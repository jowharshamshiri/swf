import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Quad2 } from '../src/index.js';
import { applyHomography, isConvexQuad, offsetQuad, rectQuad, rectToQuad } from '../src/index.js';

/** A rectangle w×h turned by `angle` about the view axis, seen in perspective at `depth`. */
function perspectiveQuad(w: number, h: number, yaw: number, pitch: number, depth: number): Quad2 {
  const project = (x: number, y: number): readonly [number, number] => {
    // Turn about y (yaw) then x (pitch), push back by depth, project with focal length 500.
    const x1 = x * Math.cos(yaw);
    const z1 = -x * Math.sin(yaw);
    const y2 = y * Math.cos(pitch) - z1 * Math.sin(pitch);
    const z2 = y * Math.sin(pitch) + z1 * Math.cos(pitch) + depth;
    return [400 + (500 * x1) / z2, 300 - (500 * y2) / z2];
  };
  return [
    project(-w / 2, h / 2),
    project(w / 2, h / 2),
    project(w / 2, -h / 2),
    project(-w / 2, -h / 2),
  ];
}

describe('rect-to-quad homography', () => {
  it('puts each corner of the box exactly on the quad, for any perspective view of a rectangle', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.1, max: 4, noNaN: true }),
        fc.double({ min: 0.1, max: 4, noNaN: true }),
        fc.double({ min: -1.2, max: 1.2, noNaN: true }),
        fc.double({ min: -1.2, max: 1.2, noNaN: true }),
        fc.double({ min: 3, max: 20, noNaN: true }),
        fc.integer({ min: 10, max: 2000 }),
        fc.integer({ min: 10, max: 2000 }),
        (w, h, yaw, pitch, depth, width, height) => {
          const quad = perspectiveQuad(w, h, yaw, pitch, depth);
          const m = rectToQuad(width, height, quad);
          expect(m).not.toBeNull();
          if (m === null) {
            return;
          }
          const box: [number, number][] = [
            [0, 0],
            [width, 0],
            [width, height],
            [0, height],
          ];
          box.forEach(([x, y], i) => {
            const [px, py] = applyHomography(m, x, y);
            expect(Math.hypot(px - (quad[i]?.[0] ?? NaN), py - (quad[i]?.[1] ?? NaN))).toBeLessThan(
              1e-6,
            );
          });
          // The box's centre goes to where the quad's diagonals cross, as a plane in perspective
          // requires (an affine fill would put it at the corners' average instead).
          const [cx, cy] = applyHomography(m, width / 2, height / 2);
          const [a, , c] = quad;
          const [, b, , d] = quad;
          const cross = intersect(a, c, b, d);
          expect(Math.hypot(cx - cross[0], cy - cross[1])).toBeLessThan(1e-6);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('is plain scaling and translation for an axis-aligned rectangle', () => {
    expect(rectToQuad(200, 100, rectQuad([10, 20, 400, 50]))).toEqual([
      2, 0, 10, 0, 0.5, 20, 0, 0, 1,
    ]);
  });

  it('refuses quads no rectangle in front of the viewer projects to', () => {
    const bowtie: Quad2 = [
      [0, 0],
      [100, 100],
      [100, 0],
      [0, 100],
    ];
    const line: Quad2 = [
      [0, 0],
      [50, 0],
      [100, 0],
      [100, 10],
    ];
    const concave: Quad2 = [
      [0, 0],
      [100, 0],
      [30, 30],
      [0, 100],
    ];
    for (const quad of [bowtie, line, concave]) {
      expect(isConvexQuad(quad)).toBe(false);
      expect(rectToQuad(100, 100, quad)).toBeNull();
    }
    expect(rectToQuad(0, 100, rectQuad([0, 0, 10, 10]))).toBeNull();
    expect(
      rectToQuad(10, 10, [
        [0, 0],
        [NaN, 0],
        [10, 10],
        [0, 10],
      ]),
    ).toBeNull();
  });

  it('moves a quad into a box’s own frame', () => {
    expect(offsetQuad(rectQuad([10, 20, 5, 5]), 10, 20)).toEqual(rectQuad([0, 0, 5, 5]));
  });
});

function intersect(
  a: readonly [number, number],
  c: readonly [number, number],
  b: readonly [number, number],
  d: readonly [number, number],
): [number, number] {
  const den = (a[0] - c[0]) * (b[1] - d[1]) - (a[1] - c[1]) * (b[0] - d[0]);
  const t = ((a[0] - b[0]) * (b[1] - d[1]) - (a[1] - b[1]) * (b[0] - d[0])) / den;
  return [a[0] + t * (c[0] - a[0]), a[1] + t * (c[1] - a[1])];
}
