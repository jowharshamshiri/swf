import type { JsonValue } from '@swf/core';
import type { Quat, Vec3 } from '@swf/math';
import {
  cross,
  dot,
  length,
  mat4TransformDirection,
  mat4TransformPoint,
  normalize,
  quatFromAxisAngle,
  quatNormalize,
} from '@swf/math';
import { createViewOutput } from '@swf/presentation';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EQUIRECTANGULAR_POLE_BAND, equirectangular } from '../src/index.js';
import type { EquirectangularConfig } from '../src/index.js';
import type { Placement } from './fixtures.js';
import { geometryOf, H, placed, setup, W } from './fixtures.js';

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

describe('ruling out surfaces beyond a narrow view (NFR-017)', () => {
  /** A placed surface whose outline is counted each time its world placement is read. */
  const counted = (placement: Placement) => {
    const geometry = geometryOf(placement);
    let reads = 0;
    const watched = Object.create(geometry) as typeof geometry;
    Object.defineProperty(watched, 'world', {
      get: () => {
        reads += 1;
        return geometry.world;
      },
    });
    return { geometry: watched, reads: () => reads };
  };
  const narrow = { config: { horizontal: 64, vertical: 72 } };

  it('decides from its bounds alone that a surface behind, beside or above the view shows nothing', () => {
    const { projection, view } = setup(narrow);
    for (const placement of [
      { id: 'behind', heading: Math.PI, distance: 3 },
      { id: 'beside', heading: 1.2, distance: 3 },
      { id: 'above', heading: 0, distance: 3, y: 4 },
    ]) {
      const surface = counted(placement);
      expect(projection.projectGeometry(surface.geometry, view)).toEqual([]);
      expect(surface.reads()).toBe(0);
    }
    // One in view is projected from its outline, as before.
    const ahead = counted({ id: 'ahead', heading: 0.3, distance: 3 });
    expect(projection.projectGeometry(ahead.geometry, view)).toHaveLength(1);
    expect(ahead.reads()).toBeGreaterThan(0);
  });

  it('never rules out a surface any point of which the view shows, for any placement and view', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.double({ min: 0.3, max: 8, noNaN: true }),
        fc.double({ min: -6, max: 6, noNaN: true }),
        fc.double({ min: 0.05, max: 4, noNaN: true }),
        fc.double({ min: 0.05, max: 3, noNaN: true }),
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        fc.integer({ min: 5, max: 360 }),
        fc.integer({ min: 5, max: 180 }),
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        (heading, distance, y, w, h, turn, horizontal, vertical, look) => {
          const { projection, view } = setup({
            config: { horizontal, vertical },
            rotation: quatFromAxisAngle([0, 1, 0], look),
          });
          const placement = {
            id: 's',
            heading,
            distance,
            y,
            size: [w, h] as const,
            rotation: quatFromAxisAngle([0, 1, 0], turn),
          };
          const geometry = geometryOf(placement);
          if (projection.projectGeometry(geometry, view).length > 0) {
            return;
          }
          // Ruled out: no point of the surface, edges and inside, has an image in the view.
          for (let i = 0; i <= 12; i++) {
            for (let j = 0; j <= 12; j++) {
              const local: Vec3 = [w * (i / 12 - 0.5), h * (j / 12 - 0.5), 0];
              const world = mat4TransformPoint(geometry.world, local);
              if (length(world) > view.near) {
                expect(projection.projectDirection(world, view).images).toEqual([]);
              }
            }
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('surface fragments (FR-064 to FR-066)', () => {
  const project = (placement: Placement, options: Parameters<typeof setup>[0] = {}) => {
    const { projection, view } = setup(options);
    const geometry = geometryOf(placement);
    return {
      fragments: projection.projectGeometry(geometry, view),
      visibility: projection.clipVisibility(geometry, view),
    };
  };

  it('places a surface in front as one exact fragment around its direction', () => {
    const { fragments, visibility } = project({ id: 's', heading: 0, distance: 2 });
    expect(fragments).toHaveLength(1);
    const [f] = fragments;
    expect(f).toMatchObject({
      id: 'v/s/0',
      surfaceId: 's',
      ordinal: 0,
      nativeOwner: true,
      geometricFidelity: 'exact',
    });
    const width = (2 * Math.atan(0.25) * W) / (2 * Math.PI);
    expect(f?.bounds[0]).toBeCloseTo(W / 2 - width / 2, 9);
    expect(f?.bounds[2]).toBeCloseTo(width, 9);
    expect(f?.depth).toBeCloseTo(2, 12);
    expect(f?.corners?.[0][0]).toBeCloseTo(W / 2 - width / 2, 9);
    expect(f?.corners?.[1][0]).toBeCloseTo(W / 2 + width / 2, 9);
    expect(visibility).toEqual({ state: 'inside', coverage: 1, behind: false, crossesSeam: false });
  });

  it('splits a surface crossing the seam into fragments of one surface with one native owner', () => {
    const { fragments, visibility } = project({ id: 's', heading: Math.PI - 0.1, distance: 2 });
    expect(fragments.map((f) => [f.surfaceId, f.ordinal, f.nativeOwner])).toEqual([
      ['s', 0, false],
      ['s', 1, true],
    ]);
    const [left, right] = fragments;
    expect(left?.bounds[0]).toBe(0);
    expect((right?.bounds[0] ?? 0) + (right?.bounds[2] ?? 0)).toBeCloseTo(W, 9);
    // Each piece carries the whole surface's corners on its branch: the left piece's reach past
    // the left edge, the right piece's past the right edge, by the same width.
    expect(left?.corners?.[0][0]).toBeLessThan(0);
    expect(right?.corners?.[1][0]).toBeGreaterThan(W);
    expect((left?.corners?.[0][0] ?? 0) + W).toBeCloseTo(right?.corners?.[0][0] ?? NaN, 9);
    // Together the visible pieces span the surface's angular width.
    const width = (2 * Math.atan(0.25) * W) / (2 * Math.PI);
    expect((left?.bounds[2] ?? 0) + (right?.bounds[2] ?? 0)).toBeCloseTo(width, 9);
    expect(visibility).toMatchObject({ state: 'inside', behind: true, crossesSeam: true });
    const ws = placed([{ id: 's', heading: Math.PI - 0.1, distance: 2 }]);
    const output = createViewOutput(ws.getState(), 'v', fragments);
    expect(output.fragmentsOf('s')).toHaveLength(2);
    expect(fragments.every((f) => output.surfaceOf(f.id) === 's')).toBe(true);
  });

  it('keeps fragment count and total width consistent wherever the surface turns', () => {
    const angular = 2 * Math.atan(0.25);
    fc.assert(
      fc.property(fc.double({ min: -4 * Math.PI, max: 4 * Math.PI, noNaN: true }), (heading) => {
        const { fragments } = project({ id: 's', heading, distance: 2 });
        const offset = Math.abs(Math.atan2(Math.sin(heading), Math.cos(heading)));
        const crosses = offset > Math.PI - angular / 2 + 1e-9;
        const clear = offset < Math.PI - angular / 2 - 1e-9;
        if (crosses) {
          expect(fragments).toHaveLength(2);
        } else if (clear) {
          expect(fragments).toHaveLength(1);
        }
        const total = fragments.reduce((sum, f) => sum + f.bounds[2], 0);
        expect(total).toBeCloseTo((angular * W) / (2 * Math.PI), 6);
        expect(fragments.filter((f) => f.nativeOwner)).toHaveLength(1);
        expect(new Set(fragments.map((f) => f.surfaceId))).toEqual(new Set(['s']));
      }),
      { numRuns: 300 },
    );
  });

  it('gives a surface edge exactly on the seam one fragment, not an empty sliver', () => {
    // Half-width 1 at distance 1: the right edge sits at 45°; a heading of 135° puts it at 180°.
    const { fragments } = project({
      id: 's',
      heading: (3 * Math.PI) / 4,
      distance: 1,
      size: [2, 1],
    });
    expect(fragments).toHaveLength(1);
    expect(fragments[0]?.bounds[2]).toBeGreaterThan(0);
  });

  it('represents a surface behind the camera instead of dropping it', () => {
    const full = project({ id: 's', heading: Math.PI, distance: 2 });
    expect(full.fragments.length).toBeGreaterThan(0);
    expect(full.visibility.behind).toBe(true);
    const narrow = project(
      { id: 's', heading: Math.PI, distance: 2 },
      { config: { horizontal: 90, vertical: 90 } },
    );
    expect(narrow.fragments).toEqual([]);
    expect(narrow.visibility).toEqual({
      state: 'outside',
      coverage: 0,
      behind: true,
      crossesSeam: false,
    });
  });

  it('clips by distance and by latitude', () => {
    const at = { id: 's', heading: 0, distance: 5 };
    expect(project(at, { far: 4 }).fragments).toEqual([]);
    expect(project(at, { far: 4 }).visibility.state).toBe('outside');
    expect(project(at, { near: 6 }).fragments).toEqual([]);
    expect(project(at, { far: 6 }).fragments).toHaveLength(1);
    // A surface well above 60° is outside a 120° view; one straddling it is clipped to the edge.
    expect(project({ id: 's', heading: 0, distance: 1, y: 5 }).fragments).toEqual([]);
    const straddling = project({ id: 's', heading: 0, distance: 1, y: Math.tan(Math.PI / 3) });
    expect(straddling.fragments).toHaveLength(1);
    expect(straddling.fragments[0]?.bounds[1]).toBe(0);
    // Its corners reach above the image, where the bounds clip it.
    expect(straddling.fragments[0]?.corners?.[0][1]).toBeLessThan(0);
    expect(straddling.visibility.state).toBe('partial');
    const coverage = straddling.visibility.coverage;
    expect(coverage).toBeGreaterThan(0.2);
    expect(coverage).toBeLessThan(0.8);
  });

  it('spans every longitude for a surface overhead all around the camera', () => {
    const overhead: Placement = {
      id: 's',
      heading: 0,
      distance: 0,
      y: 2,
      size: [4, 4],
      rotation: quatFromAxisAngle([1, 0, 0], Math.PI / 2),
    };
    const { fragments, visibility } = project(overhead, {
      config: { horizontal: 360, vertical: 180 },
    });
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).toMatchObject({ geometricFidelity: 'approximate', nativeOwner: true });
    expect(fragments[0]?.bounds[0]).toBe(0);
    expect(fragments[0]?.bounds[2]).toBe(W);
    // From the pole (the top row) down to the outline's lowest point, its corners.
    const corner = Math.atan(Math.SQRT1_2);
    expect(fragments[0]?.bounds[1]).toBe(0);
    expect(fragments[0]?.bounds[3]).toBeCloseTo(((Math.PI / 2 - corner) / Math.PI) * H, 9);
    expect(visibility).toMatchObject({ state: 'inside', crossesSeam: true });
    // A 120° view shows it from its top row (60°) down to the corners.
    const partial = project(overhead);
    expect(partial.fragments).toHaveLength(1);
    expect(partial.fragments[0]?.bounds[1]).toBe(0);
    expect(partial.fragments[0]?.bounds[2]).toBe(W);
    expect(partial.fragments[0]?.bounds[3]).toBeCloseTo(
      ((Math.PI / 3 - corner) / ((2 * Math.PI) / 3)) * H,
      9,
    );
  });

  it('keeps fragment IDs distinct per viewport and surface', () => {
    const { projection, view } = setup();
    const g = geometryOf({ id: 's', heading: Math.PI - 0.1, distance: 2 });
    const ids = [
      ...projection.projectGeometry(g, view),
      ...projection.projectGeometry(g, { ...view, viewportId: 'w' }),
    ].map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
