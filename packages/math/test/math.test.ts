import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Quat, Transform3D, Vec3 } from '../src/index.js';
import {
  aabbContainsPoint,
  aabbOfBox,
  IDENTITY_MAT4,
  isUnitQuat,
  length,
  mat4ApproxEquals,
  mat4Decompose,
  mat4FromTransform,
  mat4InvertAffine,
  mat4Multiply,
  mat4TransformPoint,
  quatFromAxisAngle,
  quatLookRotation,
  quatMultiply,
  quatNormalize,
  quatRotate,
  quatSameRotation,
  ray,
  rayIntersectAabb,
  transformApproxEquals,
  transformIssue,
  transformPoint,
  vec3ApproxEquals,
} from '../src/index.js';

const coord = fc.double({ min: -1000, max: 1000, noNaN: true, noDefaultInfinity: true });
const vec = fc.tuple(coord, coord, coord) as fc.Arbitrary<Vec3>;
const positive = fc.double({ min: 0.1, max: 10, noNaN: true });
const scaleVec = fc.tuple(positive, positive, positive) as fc.Arbitrary<Vec3>;
const quat: fc.Arbitrary<Quat> = fc
  .tuple(
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
  )
  .filter(([x, y, z, w]) => Math.hypot(x, y, z, w) > 0.1)
  .map((q) => quatNormalize(q));
const transform: fc.Arbitrary<Transform3D> = fc.record({
  position: vec,
  rotation: quat,
  scale: scaleVec,
});

describe('quaternions', () => {
  it('normalizes any non-zero quaternion to unit length', () => {
    fc.assert(
      fc.property(
        fc.tuple(coord, coord, coord, coord).filter((q) => Math.hypot(...q) > 1e-3),
        (q) => isUnitQuat(quatNormalize(q), 1e-12),
      ),
    );
  });

  it('rejects normalizing a zero or non-finite quaternion', () => {
    expect(() => quatNormalize([0, 0, 0, 0])).toThrow(RangeError);
    expect(() => quatNormalize([NaN, 0, 0, 1])).toThrow(RangeError);
  });

  it('preserves vector length under rotation', () => {
    fc.assert(
      fc.property(
        quat,
        vec,
        (q, v) => Math.abs(length(quatRotate(q, v)) - length(v)) <= 1e-9 * (1 + length(v)),
      ),
    );
  });

  it('composes: rotating by a*b equals rotating by b, then a', () => {
    fc.assert(
      fc.property(quat, quat, vec, (a, b, v) =>
        vec3ApproxEquals(
          quatRotate(quatMultiply(a, b), v),
          quatRotate(a, quatRotate(b, v)),
          1e-9 * (1 + length(v)),
        ),
      ),
    );
  });

  it('turns +X to +Y by a quarter turn about +Z (right-handed)', () => {
    const q = quatFromAxisAngle([0, 0, 1], Math.PI / 2);
    expect(vec3ApproxEquals(quatRotate(q, [1, 0, 0]), [0, 1, 0])).toBe(true);
  });

  it('look rotation points local +Z along the forward direction', () => {
    fc.assert(
      fc.property(
        vec.filter((v) => Math.hypot(v[0], v[2]) > 1e-3),
        (forward) => {
          const q = quatLookRotation(forward, [0, 1, 0]);
          const z = quatRotate(q, [0, 0, 1]);
          const len = length(forward);
          return vec3ApproxEquals(z, [forward[0] / len, forward[1] / len, forward[2] / len], 1e-9);
        },
      ),
    );
    expect(() => quatLookRotation([0, 1, 0], [0, 1, 0])).toThrow(RangeError);
  });
});

describe('affine matrices', () => {
  it('maps points the same way as the transform', () => {
    fc.assert(
      fc.property(transform, vec, (t, p) =>
        vec3ApproxEquals(
          mat4TransformPoint(mat4FromTransform(t), p),
          transformPoint(t, p),
          1e-7 * (1 + length(p)),
        ),
      ),
    );
  });

  it('inverts: inverse(m) * m is the identity', () => {
    fc.assert(
      fc.property(transform, (t) => {
        const m = mat4FromTransform(t);
        const inverse = mat4InvertAffine(m);
        return inverse !== null && mat4ApproxEquals(mat4Multiply(inverse, m), IDENTITY_MAT4, 1e-7);
      }),
    );
  });

  it('decomposes a composed transform back to an equal transform', () => {
    fc.assert(
      fc.property(transform, (t) => {
        const result = mat4Decompose(mat4FromTransform(t));
        return result.ok && transformApproxEquals(result.transform, t, 1e-7);
      }),
    );
  });

  it('decomposes a chain of uniformly scaled transforms', () => {
    const uniform = fc.record({
      position: vec,
      rotation: quat,
      scale: positive.map((s) => [s, s, s] as const),
    });
    fc.assert(
      fc.property(uniform, uniform, (a, b) => {
        const m = mat4Multiply(mat4FromTransform(a), mat4FromTransform(b));
        const result = mat4Decompose(m);
        return result.ok && mat4ApproxEquals(mat4FromTransform(result.transform), m, 1e-6);
      }),
    );
  });

  it('reports shear when a rotated child sits under a non-uniformly scaled parent', () => {
    const parent = mat4FromTransform({
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [2, 1, 1],
    });
    const child = mat4FromTransform({
      position: [0, 0, 0],
      rotation: quatFromAxisAngle([0, 0, 1], Math.PI / 4),
      scale: [1, 1, 1],
    });
    expect(mat4Decompose(mat4Multiply(parent, child))).toEqual({ ok: false, reason: 'shear' });
  });

  it('reports reflection, singularity and non-finite input', () => {
    const mirror = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
    expect(mat4Decompose(mirror)).toEqual({ ok: false, reason: 'reflection' });
    const flat = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
    expect(mat4Decompose(flat)).toEqual({ ok: false, reason: 'singular' });
    expect(mat4InvertAffine(flat)).toBeNull();
    const broken = [NaN, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;
    expect(mat4Decompose(broken)).toEqual({ ok: false, reason: 'non-finite' });
  });
});

describe('transform validation', () => {
  it('accepts a valid transform and names the invalid field otherwise', () => {
    expect(
      transformIssue({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }),
    ).toBeNull();
    expect(
      transformIssue({ position: [Infinity, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }),
    ).toMatch(/^position/);
    expect(
      transformIssue({ position: [0, 0, 0], rotation: [0, 0, 0, 2], scale: [1, 1, 1] }),
    ).toMatch(/^rotation/);
    expect(
      transformIssue({ position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 0, 1] }),
    ).toMatch(/^scale/);
  });

  it('treats q and -q as the same rotation', () => {
    fc.assert(fc.property(quat, (q) => quatSameRotation(q, [-q[0], -q[1], -q[2], -q[3]])));
  });
});

describe('bounding boxes and rays', () => {
  it('encloses every corner of a placed box', () => {
    fc.assert(
      fc.property(transform, scaleVec, (t, size) => {
        const m = mat4FromTransform(t);
        const box = aabbOfBox(m, size);
        const slack = 1e-7 * (1 + Math.max(...box.max.map(Math.abs), ...box.min.map(Math.abs)));
        const grown = {
          min: [box.min[0] - slack, box.min[1] - slack, box.min[2] - slack] as const,
          max: [box.max[0] + slack, box.max[1] + slack, box.max[2] + slack] as const,
        };
        const half = size.map((s) => s / 2);
        for (const sx of [-1, 1]) {
          for (const sy of [-1, 1]) {
            for (const sz of [-1, 1]) {
              const corner = mat4TransformPoint(m, [
                sx * (half[0] ?? 0),
                sy * (half[1] ?? 0),
                sz * (half[2] ?? 0),
              ]);
              if (!aabbContainsPoint(grown, corner)) {
                return false;
              }
            }
          }
        }
        return true;
      }),
    );
  });

  it('hits a box the ray points at and misses one behind it', () => {
    const box = { min: [-1, -1, -6] as const, max: [1, 1, -4] as const };
    const forward = ray([0, 0, 0], [0, 0, -1]);
    expect(rayIntersectAabb(forward, box)).toEqual({ near: 4, far: 6 });
    expect(rayIntersectAabb(ray([0, 0, 0], [0, 0, 1]), box)).toBeNull();
    expect(rayIntersectAabb(ray([0, 0, -5], [1, 0, 0]), box)).toEqual({ near: 0, far: 1 });
    expect(rayIntersectAabb(ray([5, 0, 0], [0, 0, -1]), box)).toBeNull();
  });
});
