import type { JsonValue } from '@swf/core';
import type { Quat, Vec3 } from '@swf/math';
import { cross, dot, length, mat4TransformDirection, normalize, quatNormalize } from '@swf/math';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EQUIRECTANGULAR_POLE_BAND, equirectangular } from '../src/index.js';
import type { EquirectangularConfig } from '../src/index.js';
import { H, setup, W } from './fixtures.js';

const rotation = fc
  .tuple(
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
  )
  .filter((q) => Math.hypot(...q) > 0.1)
  .map((q): Quat => quatNormalize(q));

/** Slack for rounding at the very edge of a pole band, in radians. */
const BAND_EDGE = 1e-14;

/**
 * A share of the image's height: anywhere, or within a hair of the top or bottom edge, where the
 * pole bands of a view reaching the poles lie (a band is about 5e-9 of a 180° image's height).
 */
const row = fc.oneof(
  fc.double({ min: 0, max: 1, noNaN: true }),
  fc.double({ min: 0, max: 2e-8, noNaN: true }),
  fc.double({ min: 0, max: 2e-8, noNaN: true }).map((d) => 1 - d),
);

/** A camera-local direction from longitude (right of -Z) and latitude (up). */
function local(longitude: number, latitude: number): Vec3 {
  const c = Math.cos(latitude);
  return [c * Math.sin(longitude), Math.sin(latitude), -c * Math.cos(longitude)];
}

/** The angle between two directions, accurate near zero (unlike acos of their dot product). */
const angleBetween = (a: Vec3, b: Vec3) =>
  Math.atan2(length(cross(normalize(a), normalize(b))), dot(normalize(a), normalize(b)));

describe('equirectangular configuration', () => {
  it('defaults to 360° across and 120° up and down, adjustable to 180°', () => {
    expect(equirectangular.defaultConfig).toEqual({ horizontal: 360, vertical: 120 });
    const domain = equirectangular.create(equirectangular.defaultConfig).describeDomain();
    expect(domain).toMatchObject({ fullCircle: true, seamWrapping: true, poles: false });
    expect(domain.horizontalCoverage).toBeCloseTo(2 * Math.PI, 15);
    expect(domain.verticalCoverage).toBeCloseTo((2 * Math.PI) / 3, 15);
    const poles = equirectangular.create({ horizontal: 360, vertical: 180 }).describeDomain();
    expect(poles).toMatchObject({ poles: true, nonInjective: true });
    // A view whose top and bottom rows reach into the pole bands shows the poles; one short of
    // them does not.
    const band = (EQUIRECTANGULAR_POLE_BAND * 180) / Math.PI;
    for (const [vertical, reaches] of [
      [180, true],
      [180 - band, true],
      [180 - 1.9 * band, true],
      [180 - 2.1 * band, false],
    ] as const) {
      expect(equirectangular.create({ horizontal: 360, vertical }).describeDomain().poles).toBe(
        reaches,
      );
    }
    expect(equirectangular.create({ horizontal: 90, vertical: 60 }).describeDomain()).toMatchObject(
      { fullCircle: false, seamWrapping: false, poles: false, nonInjective: false },
    );
  });

  it('accepts exactly the angles in range, naming the setting at fault', () => {
    const issue = (config: JsonValue) => equirectangular.configIssue(config);
    expect(issue({ horizontal: 360, vertical: 180 })).toBeNull();
    expect(issue({ horizontal: 0.5, vertical: 0.5 })).toBeNull();
    expect(issue({ horizontal: 360.0001, vertical: 120 })).toMatch(/^horizontal/);
    expect(issue({ horizontal: 0, vertical: 120 })).toMatch(/^horizontal/);
    expect(issue({ horizontal: 360, vertical: 180.5 })).toMatch(/^vertical/);
    expect(issue({ horizontal: 360 })).toMatch(/^vertical/);
    expect(issue({ horizontal: 360, vertical: 120, fov: 3 })).toMatch(/^fov is not a setting/);
    expect(issue(null)).not.toBeNull();
    expect(issue([360, 120])).not.toBeNull();
    expect(() => equirectangular.create({ horizontal: 400, vertical: 120 })).toThrow(RangeError);
  });
});

describe('equirectangular mapping (QA-002)', () => {
  it('maps the reference directions to their documented places', () => {
    const { projection, view } = setup();
    const at = (longitudeDeg: number, latitudeDeg = 0) =>
      projection.projectDirection(
        local((longitudeDeg * Math.PI) / 180, (latitudeDeg * Math.PI) / 180),
        view,
      );
    const near = (images: readonly (readonly [number, number])[], expected: [number, number][]) => {
      expect(images).toHaveLength(expected.length);
      images.forEach(([x, y], i) => {
        expect(x).toBeCloseTo(expected[i]?.[0] ?? NaN, 9);
        expect(y).toBeCloseTo(expected[i]?.[1] ?? NaN, 9);
      });
    };
    near(at(0).images, [[W / 2, H / 2]]);
    near(at(90).images, [[(3 * W) / 4, H / 2]]);
    near(at(-90).images, [[W / 4, H / 2]]);
    near(at(0, 60).images, [[W / 2, 0]]);
    near(at(0, -60).images, [[W / 2, H]]);
    expect(at(0, 61).images).toEqual([]);
    // 180° is the seam: one direction, two images, on the left and right edges.
    const seam = at(180);
    near(seam.images, [
      [0, H / 2],
      [W, H / 2],
    ]);
    expect(seam.behind).toBe(true);
    expect(at(0).behind).toBe(false);
  });

  it('shows a narrower view only within its angles, edges included', () => {
    const { projection, view } = setup({ config: { horizontal: 180, vertical: 90 } });
    expect(projection.projectDirection(local(Math.PI / 2, 0), view).images).toEqual([[W, H / 2]]);
    expect(projection.projectDirection(local(-Math.PI / 2, 0), view).images).toEqual([[0, H / 2]]);
    const behind = projection.projectDirection(local(Math.PI, 0), view);
    expect(behind).toEqual({ images: [], singular: false, behind: true });
  });

  it('round-trips every image point to a ray and back, for any camera and size', () => {
    // A point 3e-13 of the height below the top edge of a 180° view: its ray's longitude is lost
    // to rounding through the camera, so it must be the pole.
    const nearPole: [Quat, number, number, number, number, EquirectangularConfig] = [
      [0.9998934104654372, 0.014600263963241733, 0, 0],
      1,
      1,
      0,
      3.1832869673564806e-13,
      { horizontal: 360, vertical: 180 },
    ];
    // A point on the seam just beyond the bottom pole band: rounding moves its ray by a hair of arc
    // but by 1e-12 of longitude, and it must keep its images on both edges.
    const onSeamNearPole: [Quat, number, number, number, number, EquirectangularConfig] = [
      [0, 0, 0.00006103515727318154, -0.9999999981373549],
      1,
      1,
      0,
      0.999999992500363,
      { horizontal: 360, vertical: 180 },
    ];
    fc.assert(
      fc.property(
        rotation,
        fc.integer({ min: 1, max: 4000 }),
        fc.integer({ min: 1, max: 4000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        row,
        fc.constantFrom<EquirectangularConfig>(
          { horizontal: 360, vertical: 120 },
          { horizontal: 360, vertical: 180 },
          { horizontal: 120, vertical: 90 },
          { horizontal: 120, vertical: 180 },
        ),
        (r, width, height, u, v, config) => {
          const { projection, view } = setup({ rotation: r, width, height, config });
          const x = u * width;
          const y = v * height;
          const result = projection.unprojectPoint(x, y, view);
          if (result.kind !== 'ray') {
            return false;
          }
          expect(result.error).toBe(0);
          const horizontal = (config.horizontal * Math.PI) / 180;
          const vertical = (config.vertical * Math.PI) / 180;
          // The point's angle from the nearer pole, from its row alone.
          const colatitude = Math.PI / 2 - Math.abs(0.5 - y / height) * vertical;
          const projected = projection.projectDirection(result.ray.direction, view);
          if (colatitude < EQUIRECTANGULAR_POLE_BAND - BAND_EDGE) {
            // Within a pole band the point is the pole, whatever its column: its ray is straight
            // up or down, its longitude its column's, and the pole's one image its row's centre.
            const north = y < height / 2;
            const pole = mat4TransformDirection(view.camera, [0, north ? 1 : -1, 0]);
            expect(angleBetween(result.ray.direction, pole)).toBeLessThan(1e-12);
            expect(result.latitude).toBe(north ? Math.PI / 2 : -Math.PI / 2);
            expect(result.longitude).toBeCloseTo((u - 0.5) * horizontal, 12);
            expect(projected.singular).toBe(true);
            expect(projected.images).toEqual([[width / 2, north ? 0 : height]]);
            return true;
          }
          if (projected.singular) {
            // Rounding may take a point on the very edge of a band for the pole, and no other.
            expect(colatitude).toBeLessThan(EQUIRECTANGULAR_POLE_BAND + BAND_EDGE);
            return true;
          }
          const tolerance = 1e-7 * Math.max(width, height);
          return projected.images.some(([px, py]) => Math.hypot(px - x, py - y) <= tolerance);
        },
      ),
      { numRuns: 500, examples: [nearPole, onSeamNearPole] },
    );
  });

  it('takes every direction within a pole band for the pole, and round-trips every other', () => {
    fc.assert(
      fc.property(
        rotation,
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.oneof(
          fc.double({ min: 0, max: 3 * EQUIRECTANGULAR_POLE_BAND, noNaN: true }),
          fc.double({ min: 0, max: Math.PI / 2, noNaN: true }),
        ),
        fc.boolean(),
        (r, longitude, colatitude, north) => {
          const { projection, view } = setup({
            rotation: r,
            config: { horizontal: 360, vertical: 180 },
          });
          const latitude = (north ? 1 : -1) * (Math.PI / 2 - colatitude);
          const direction = mat4TransformDirection(view.camera, local(longitude, latitude));
          const projected = projection.projectDirection(direction, view);
          if (colatitude < EQUIRECTANGULAR_POLE_BAND - BAND_EDGE) {
            // The pole's image is its row's centre, and that point is the pole: the direction
            // comes back to within the band.
            expect(projected.singular).toBe(true);
            expect(projected.images).toEqual([[W / 2, north ? 0 : H]]);
            const back = projection.unprojectPoint(W / 2, north ? 0 : H, view);
            expect(back.kind === 'ray' && angleBetween(back.ray.direction, direction)).toBeLessThan(
              EQUIRECTANGULAR_POLE_BAND,
            );
            return;
          }
          if (projected.singular) {
            expect(colatitude).toBeLessThan(EQUIRECTANGULAR_POLE_BAND + BAND_EDGE);
            return;
          }
          expect(projected.images.length).toBeGreaterThanOrEqual(1);
          for (const [x, y] of projected.images) {
            const back = projection.unprojectPoint(x, y, view);
            expect(back.kind === 'ray' && angleBetween(back.ray.direction, direction)).toBeLessThan(
              1e-9,
            );
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('round-trips every covered direction to each of its images and back', () => {
    fc.assert(
      fc.property(
        rotation,
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.double({ min: -Math.PI / 3, max: Math.PI / 3, noNaN: true }),
        (r, longitude, latitude) => {
          const { projection, view } = setup({ rotation: r });
          const direction = mat4TransformDirection(view.camera, local(longitude, latitude));
          const { images } = projection.projectDirection(direction, view);
          expect(images.length).toBeGreaterThanOrEqual(1);
          for (const [x, y] of images) {
            const back = projection.unprojectPoint(x, y, view);
            expect(back.kind).toBe('ray');
            if (back.kind === 'ray') {
              expect(angleBetween(back.ray.direction, direction)).toBeLessThan(1e-9);
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('maps both seam edges to the same direction, exactly behind the camera', () => {
    fc.assert(
      fc.property(rotation, fc.double({ min: 0, max: 1, noNaN: true }), (r, v) => {
        const { projection, view } = setup({ rotation: r });
        const left = projection.unprojectPoint(0, v * H, view);
        const right = projection.unprojectPoint(W, v * H, view);
        if (left.kind !== 'ray' || right.kind !== 'ray') {
          return false;
        }
        expect(angleBetween(left.ray.direction, right.ray.direction)).toBeLessThan(1e-12);
        expect(left.longitude).toBeCloseTo(-Math.PI, 15);
        expect(right.longitude).toBeCloseTo(Math.PI, 15);
        return true;
      }),
    );
  });

  it('maps a pole to its whole edge row when the view reaches it, and hides it otherwise', () => {
    const up: Vec3 = [0, 1, 0];
    const full = setup({ config: { horizontal: 360, vertical: 180 } });
    expect(full.projection.projectDirection(up, full.view)).toEqual({
      images: [[W / 2, 0]],
      singular: true,
      behind: false,
    });
    expect(full.projection.projectDirection([0, -1, 0], full.view).images).toEqual([[W / 2, H]]);
    for (const x of [0, W / 3, W]) {
      const ray = full.projection.unprojectPoint(x, 0, full.view);
      expect(ray.kind === 'ray' && angleBetween(ray.ray.direction, up)).toBeLessThan(1e-12);
    }
    const partial = setup();
    expect(partial.projection.projectDirection(up, partial.view)).toMatchObject({
      images: [],
      singular: true,
    });
  });

  it('scales every image with the viewport on resize, without changing the directions', () => {
    fc.assert(
      fc.property(
        rotation,
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.integer({ min: 1, max: 4000 }),
        fc.integer({ min: 1, max: 4000 }),
        (r, longitude, latitude, width, height) => {
          const a = setup({ rotation: r });
          const b = setup({ rotation: r, width, height });
          const direction = mat4TransformDirection(a.view.camera, local(longitude, latitude));
          const before = a.projection.projectDirection(direction, a.view).images;
          const after = b.projection.projectDirection(direction, b.view).images;
          expect(after).toHaveLength(before.length);
          after.forEach(([x, y], i) => {
            const [x0, y0] = before[i] ?? [NaN, NaN];
            expect(Math.abs(x - (x0 * width) / W)).toBeLessThan(1e-7 * width);
            expect(Math.abs(y - (y0 * height) / H)).toBeLessThan(1e-7 * height);
          });
        },
      ),
    );
  });

  it('reports points outside the image as outside, never as a ray', () => {
    const { projection, view } = setup();
    for (const [x, y] of [
      [-0.001, 10],
      [W + 0.001, 10],
      [10, -1],
      [10, H + 1],
      [NaN, 1],
      [1, Infinity],
    ] as const) {
      expect(projection.unprojectPoint(x, y, view).kind).toBe('outside');
      expect(projection.interactionRay(x, y, view, { previousLongitude: 0 }).kind).toBe('outside');
    }
  });

  it('rejects a zero direction and a singular camera', () => {
    const { projection, view } = setup();
    expect(() => projection.projectDirection([0, 0, 0], view)).toThrow(RangeError);
    const flat = { ...view, camera: view.camera.map((v, i) => (i === 0 ? 0 : v)) as never };
    expect(() => projection.unprojectPoint(1, 1, flat)).toThrow(/singular/);
  });
});

describe('seam-continuous interaction (FR-070, FR-071)', () => {
  it('unwraps the longitude to the branch nearest the drag, for any previous longitude', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -50, max: 50, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (previous, u) => {
          const { projection, view } = setup();
          const raw = projection.unprojectPoint(u * W, H / 2, view);
          const result = projection.interactionRay(u * W, H / 2, view, {
            previousLongitude: previous,
          });
          if (raw.kind !== 'ray' || result.kind !== 'ray') {
            return false;
          }
          const turns = (result.longitude - raw.longitude) / (2 * Math.PI);
          expect(Math.abs(turns - Math.round(turns))).toBeLessThan(1e-9);
          expect(Math.abs(result.longitude - previous)).toBeLessThanOrEqual(Math.PI + 1e-9);
          expect(result.ray).toEqual(raw.ray);
          return true;
        },
      ),
    );
  });

  it('keeps a drag across the seam moving the same way instead of jumping a turn', () => {
    const { projection, view } = setup();
    const xs = [W - 30, W - 20, W - 10, W, 10, 20, 30];
    let previous = 0.9 * Math.PI;
    const longitudes: number[] = [];
    for (const x of xs) {
      const result = projection.interactionRay(x, H / 2, view, { previousLongitude: previous });
      if (result.kind !== 'ray') {
        throw new Error('expected a ray');
      }
      longitudes.push(result.longitude);
      previous = result.longitude;
    }
    for (let i = 1; i < longitudes.length; i++) {
      const step = (longitudes[i] ?? NaN) - (longitudes[i - 1] ?? NaN);
      expect(step).toBeGreaterThanOrEqual(0);
      expect(step).toBeLessThan(0.1);
    }
    expect(longitudes.at(-1)).toBeGreaterThan(Math.PI);
  });

  it('leaves the longitude as it is where the view has no seam', () => {
    const { projection, view } = setup({ config: { horizontal: 180, vertical: 90 } });
    const result = projection.interactionRay(W / 2, H / 2, view, { previousLongitude: 7 });
    expect(result.kind === 'ray' && result.longitude).toBe(0);
  });
});

describe('the horizon and places past the edges', () => {
  it('puts the horizon where the configuration says, and the image spans the vertical angle from it', () => {
    const { projection, view } = setup({
      config: { horizontal: 360, vertical: 130, horizon: 0.49 },
    });
    const level = projection.projectDirection([0, 0, -1], view).images[0];
    expect(level?.[1]).toBeCloseTo(0.49 * H, 9);
    // 63.7° up is the top row, 66.3° down the bottom.
    const top = (0.49 * 130 * Math.PI) / 180;
    expect(projection.projectDirection(local(0, top - 1e-9), view).images[0]?.[1]).toBeCloseTo(
      0,
      6,
    );
    const bottom = (0.51 * 130 * Math.PI) / 180;
    expect(projection.projectDirection(local(0, -bottom + 1e-9), view).images[0]?.[1]).toBeCloseTo(
      H,
      6,
    );
    expect(projection.projectDirection(local(0, top + 0.01), view).images).toEqual([]);
    // And back: the horizon's row looks level.
    const ray = projection.unprojectPoint(W / 2, 0.49 * H, view);
    expect(ray.kind === 'ray' ? ray.latitude : NaN).toBeCloseTo(0, 12);
  });

  it('refuses a horizon that is no number, or one that reaches past a pole', () => {
    expect(
      equirectangular.configIssue({ horizontal: 360, vertical: 120, horizon: Number.NaN }),
    ).toMatch(/horizon must be a finite share of the image's height/);
    expect(equirectangular.configIssue({ horizontal: 360, vertical: 180, horizon: 0.2 })).toMatch(
      /past a pole/,
    );
    // Below the image's bottom, so far the image's top reaches past the pole above.
    expect(equirectangular.configIssue({ horizontal: 360, vertical: 120, horizon: 1.2 })).toMatch(
      /past a pole/,
    );
    expect(
      equirectangular.configIssue({ horizontal: 360, vertical: 130, horizon: 0.49 }),
    ).toBeNull();
  });

  it('shows an image wholly above the horizon when the horizon lies below its bottom', () => {
    // 40° down, the horizon one and a half heights from the top: 20° to 60° above it.
    const { projection, view } = setup({ config: { horizontal: 360, vertical: 40, horizon: 1.5 } });
    const at = (degrees: number) =>
      projection.projectDirection(local(0, (degrees * Math.PI) / 180), view).images[0]?.[1];
    expect(at(40)).toBeCloseTo(H / 2, 6);
    expect(at(60 - 1e-6)).toBeCloseTo(0, 3);
    expect(at(20 + 1e-6)).toBeCloseTo(H, 3);
    expect(projection.projectDirection(local(0, (10 * Math.PI) / 180), view).images).toEqual([]);
    const ray = projection.unprojectPoint(W / 2, H / 2, view);
    expect(ray.kind === 'ray' ? (ray.latitude * 180) / Math.PI : NaN).toBeCloseTo(40, 9);
  });

  it('places a direction past the view’s edge just past it, on the branch nearest the centre', () => {
    const { projection, view } = setup({ config: { horizontal: 90, vertical: 60 } });
    // 50° right in a 90° view: 5° past the right edge, an eighteenth of the width beyond it.
    const [x, y] = projection.placeDirection(local((50 * Math.PI) / 180, 0), view);
    expect(x).toBeCloseTo(W + W / 18, 9);
    expect(y).toBeCloseTo(H / 2, 9);
    expect(projection.projectDirection(local((50 * Math.PI) / 180, 0), view).images).toEqual([]);
    // Behind the camera, nearest the centre the long way round is never taken.
    const [behind] = projection.placeDirection(local((179 * Math.PI) / 180, 0), view);
    expect(behind).toBeCloseTo(W / 2 + (179 / 90) * W, 6);
    expect(() => projection.placeDirection([0, 0, 0], view)).toThrow(RangeError);
  });
});
