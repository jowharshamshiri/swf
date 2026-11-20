import type { Quad2 } from '@swf/math';
import { applyHomography, rectQuad, rectToQuad } from '@swf/math';
import { describe, expect, it } from 'vitest';
import { applyMatrix, cssMatrixOf, cssTransform, quadMatrix } from '../src/index.js';

describe('CSS placement', () => {
  it('applies the same projective map as the plane homography it is made from', () => {
    const quad: Quad2 = [
      [110, 105],
      [290, 120],
      [270, 230],
      [95, 190],
    ];
    const h = rectToQuad(640, 320, quad);
    const m = quadMatrix(640, 320, quad);
    if (h === null || m === null) {
      throw new Error('expected a map');
    }
    for (const [x, y] of [
      [0, 0],
      [640, 0],
      [640, 320],
      [0, 320],
      [123, 45],
      [320, 160],
    ] as const) {
      const [ax, ay] = applyMatrix(m, x, y);
      const [bx, by] = applyHomography(h, x, y);
      expect(Math.hypot(ax - bx, ay - by)).toBeLessThan(1e-9);
    }
    expect(cssMatrixOf(h)).toEqual(m);
  });

  it('writes a matrix as a CSS transform, and refuses quads no rectangle maps to', () => {
    const m = quadMatrix(200, 100, rectQuad([10, 20, 400, 50]));
    expect(m).toEqual([2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1]);
    expect(m === null ? null : cssTransform(m)).toBe(
      'matrix3d(2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1)',
    );
    expect(
      quadMatrix(100, 100, [
        [0, 0],
        [100, 100],
        [100, 0],
        [0, 100],
      ]),
    ).toBeNull();
  });
});
