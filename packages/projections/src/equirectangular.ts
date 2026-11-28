import type { JsonValue } from '@swf/core';
import type { Mat4, Vec3 } from '@swf/math';
import {
  length,
  mat4InvertAffine,
  mat4TransformDirection,
  mat4TransformPoint,
  normalize,
} from '@swf/math';
import type { ScreenPoint, ViewGeometry } from '@swf/presentation';
import type {
  Continuity,
  ProjectedDirection,
  Projection,
  ProjectionDomain,
  ProjectionModule,
  RayResult,
} from './contract.js';
import { PROJECTION_API_VERSION } from './contract.js';

const TWO_PI = 2 * Math.PI;
/** Angular slack for edges that are inclusive, in radians of arc. */
const EPS = 1e-12;

/**
 * The angular radius of each pole band of the equirectangular projection, in radians: 2⁻²⁶, the
 * square root of a double's epsilon. A direction this close to straight up or down (in the
 * camera's frame) has a horizontal part so small that rounding through the camera's transform,
 * a few parts in 10¹⁶, changes its longitude by up to about 10⁻⁷ radians; within the band its
 * longitude is noise, and beyond it the longitude holds to that much.
 *
 * So the projection takes everything within the band for the pole, both ways: `projectDirection`
 * reports a direction whose angle from a pole is at most this as `singular`, imaged at the
 * centre of that pole's edge row; `unprojectPoint` gives a point whose row lies within this of a
 * pole the ray straight up or down, with latitude ±π/2 and its column's longitude. A view shows
 * the poles when its top and bottom rows reach their bands, that is when its vertical angle is
 * at least π − 2 × the band.
 */
export const EQUIRECTANGULAR_POLE_BAND = 2 ** -26;

/**
 * Configuration of the equirectangular projection: the horizontal and vertical angles the viewport
 * covers, in degrees, centred across on the camera's heading, and where down the image its horizon
 * lies.
 */
export interface EquirectangularConfig {
  /** In (0, 360]. 360 shows the full circle with a wrapping seam. */
  readonly horizontal: number;
  /** In (0, 180]. The angle from the image's top row to its bottom row. */
  readonly vertical: number;
  /**
   * Where the horizon lies, as a share of the image's height from its top: 0.5 in the middle; less
   * is higher, showing more below the horizon. It may lie past the image's top (below 0) or its
   * bottom (above 1), the image then wholly below or above it, so long as the image reaches no
   * further than a pole either way. Default 0.5.
   */
  readonly horizon?: number;
}

/**
 * The equirectangular module's default configuration, frozen: the full circle across and 120°
 * down, so the poles are not shown.
 */
export const DEFAULT_EQUIRECTANGULAR_CONFIG = Object.freeze({
  /** The full 360°, with a wrapping seam behind the camera. */
  horizontal: 360,
  /** 60° above and below the horizon. */
  vertical: 120,
}) satisfies EquirectangularConfig;

function configIssue(config: JsonValue): string | null {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return 'must be an object { horizontal, vertical, horizon? }, the angles in degrees';
  }
  const keys = Object.keys(config);
  const unknown = keys.find((k) => k !== 'horizontal' && k !== 'vertical' && k !== 'horizon');
  if (unknown !== undefined) {
    return `${unknown} is not a setting (expected horizontal, vertical and horizon)`;
  }
  const record = config as Record<string, unknown>;
  const angle = (key: string, max: number) => {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max
      ? null
      : `${key} must be a number of degrees in (0, ${String(max)}] (got ${JSON.stringify(value)})`;
  };
  const horizon = record['horizon'];
  const horizonIssue =
    horizon === undefined || (typeof horizon === 'number' && Number.isFinite(horizon))
      ? null
      : `horizon must be a finite share of the image's height (got ${JSON.stringify(horizon)})`;
  const vertical = record['vertical'];
  const reach =
    typeof vertical === 'number' && typeof horizon === 'number'
      ? Math.max(horizon, 1 - horizon) * vertical
      : 0;
  return (
    angle('horizontal', 360) ??
    angle('vertical', 180) ??
    horizonIssue ??
    (reach > 90
      ? `vertical and horizon reach ${String(reach)}° from the horizon, past a pole (at most 90°)`
      : null)
  );
}

/**
 * The equirectangular projection: longitude across, latitude down. A direction in the camera's
 * frame has longitude `atan2(x, -z)` (positive to the right) and latitude `atan2(y, √(x² + z²))`
 * (positive up); the viewport spans the configured angles centred on the camera's heading. At
 * 360° the left and right edges meet at a seam behind the camera; at 180° vertically, the top and
 * bottom rows are the poles. Within {@link EQUIRECTANGULAR_POLE_BAND} of a pole, where longitude
 * is lost to rounding, a direction is the pole and a point unprojects to it. Its inverse is exact
 * everywhere in the image.
 *
 * Its configuration is an {@link EquirectangularConfig} in degrees; `configIssue` names a missing,
 * out-of-range or unknown setting, and `create` throws a RangeError for one. A surface crossing the
 * seam is placed as one fragment on each side, both carrying the whole surface's corners; the one
 * showing the surface's centre (or else the widest) is its native owner. With continuity, an
 * interaction ray's longitude follows the drag across the seam instead of jumping a full turn. A
 * surface whose outline circles a pole is one approximate fragment the full width of the image.
 * Its methods throw a RangeError for a view whose camera matrix cannot be inverted, and
 * `projectDirection` for a zero or non-finite direction.
 */
export const equirectangular: ProjectionModule = Object.freeze({
  id: 'equirectangular/1',
  apiVersion: PROJECTION_API_VERSION,
  profile: Object.freeze({
    id: 'equirectangular/1',
    seamWrapping: true,
    exactInverse: true,
  }),
  defaultConfig: DEFAULT_EQUIRECTANGULAR_CONFIG,
  configIssue,
  create(config: JsonValue): Projection {
    const issue = configIssue(config);
    if (issue !== null) {
      throw new RangeError(`equirectangular configuration ${issue}`);
    }
    const c = config as unknown as EquirectangularConfig;
    return new Equirectangular(
      (c.horizontal * Math.PI) / 180,
      (c.vertical * Math.PI) / 180,
      c.horizon ?? 0.5,
    );
  },
});

interface Frame {
  readonly eye: Vec3;
  readonly toCamera: Mat4;
}

interface Angles {
  readonly longitude: number;
  readonly latitude: number;
  /** The direction is within the pole band of straight up or down, so its longitude is noise. */
  readonly singular: boolean;
}

const frames = new WeakMap<ViewGeometry, Frame>();

function frameOf(view: ViewGeometry): Frame {
  let frame = frames.get(view);
  if (frame === undefined) {
    const toCamera = mat4InvertAffine(view.camera);
    if (toCamera === null) {
      throw new RangeError(`the camera of viewport "${view.viewportId}" is singular`);
    }
    frame = { eye: mat4TransformPoint(view.camera, [0, 0, 0]), toCamera };
    frames.set(view, frame);
  }
  return frame;
}

/** Whether an angle from the nearer pole, in radians, lies within that pole's band. */
function inPoleBand(colatitude: number): boolean {
  return colatitude <= EQUIRECTANGULAR_POLE_BAND;
}

function anglesOf(d: Vec3): Angles {
  const horizontal = Math.hypot(d[0], d[2]);
  return {
    longitude: Math.atan2(d[0], -d[2]),
    latitude: Math.atan2(d[1], horizontal),
    singular: inPoleBand(Math.atan2(horizontal, Math.abs(d[1]))),
  };
}

/** `a` limited to [-limit, limit]. */
function clamp(a: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, a));
}

class Equirectangular implements Projection {
  readonly id = 'equirectangular/1';
  readonly #h: number;
  readonly #v: number;
  readonly #horizon: number;
  readonly #fullCircle: boolean;
  readonly #poles: boolean;

  constructor(horizontal: number, vertical: number, horizon: number) {
    this.#h = horizontal;
    this.#v = vertical;
    this.#horizon = horizon;
    this.#fullCircle = horizontal >= TWO_PI - EPS;
    this.#poles = inPoleBand(Math.PI / 2 - Math.max(horizon, 1 - horizon) * vertical);
  }

  describeDomain(): ProjectionDomain {
    return Object.freeze({
      horizontalCoverage: this.#h,
      verticalCoverage: this.#v,
      seamWrapping: this.#fullCircle,
      fullCircle: this.#fullCircle,
      poles: this.#poles,
      orientationDependent: true,
      nonInjective: this.#fullCircle || this.#poles,
      inverse: 'exact',
      maxInverseError: 0,
    });
  }

  projectDirection(direction: Vec3, view: ViewGeometry): ProjectedDirection {
    if (!(length(direction) > 0)) {
      throw new RangeError('a projected direction must be finite and non-zero');
    }
    const d = mat4TransformDirection(frameOf(view).toCamera, direction);
    const { longitude, latitude, singular } = anglesOf(d);
    const behind = d[2] > 0;
    if (singular) {
      // A pole is the whole top or bottom row, when the view reaches it; its centre stands for it.
      const reaches =
        latitude > 0 ? this.#top >= Math.PI / 2 - EPS : this.#bottom <= EPS - Math.PI / 2;
      return {
        images: this.#poles && reaches ? [[view.width / 2, latitude > 0 ? 0 : view.height]] : [],
        singular: true,
        behind,
      };
    }
    if (latitude > this.#top + EPS || latitude < this.#bottom - EPS) {
      return { images: [], singular: false, behind };
    }
    // Directions within the edge slack land on the edge, so every image is inside the image.
    const y = this.#y(Math.min(this.#top, Math.max(this.#bottom, latitude)), view);
    const images: ScreenPoint[] = [];
    for (const k of [-1, 0, 1]) {
      const l = longitude + TWO_PI * k;
      if (this.#across(l, latitude)) {
        images.push([this.#x(clamp(l, this.#h / 2), view), y]);
      }
    }
    return { images, singular: false, behind };
  }

  placeDirection(direction: Vec3, view: ViewGeometry): ScreenPoint {
    if (!(length(direction) > 0)) {
      throw new RangeError('a placed direction must be finite and non-zero');
    }
    const { longitude, latitude } = anglesOf(
      mat4TransformDirection(frameOf(view).toCamera, direction),
    );
    return [this.#x(longitude, view), this.#y(latitude, view)];
  }

  unprojectPoint(x: number, y: number, view: ViewGeometry): RayResult {
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      x > view.width ||
      y < 0 ||
      y > view.height
    ) {
      return {
        kind: 'outside',
        reason: `(${String(x)}, ${String(y)}) is outside the ${String(view.width)}×${String(view.height)} image`,
      };
    }
    const longitude = (x / view.width - 0.5) * this.#h;
    const row = (this.#horizon - y / view.height) * this.#v;
    // A row within a pole band is the pole itself, whatever the column.
    const pole = inPoleBand(Math.PI / 2 - Math.abs(row));
    const latitude = pole ? Math.sign(row) * (Math.PI / 2) : row;
    const cos = Math.cos(row);
    const local: Vec3 = pole
      ? [0, Math.sign(row), 0]
      : [cos * Math.sin(longitude), Math.sin(row), -cos * Math.cos(longitude)];
    return {
      kind: 'ray',
      ray: {
        origin: frameOf(view).eye,
        direction: normalize(mat4TransformDirection(view.camera, local)),
      },
      error: 0,
      longitude,
      latitude,
    };
  }

  interactionRay(x: number, y: number, view: ViewGeometry, continuity?: Continuity): RayResult {
    const result = this.unprojectPoint(x, y, view);
    if (result.kind !== 'ray' || continuity === undefined || !this.#fullCircle) {
      return result;
    }
    // Choose the branch of the longitude nearest the drag's previous one, so a drag across the
    // seam keeps moving the same way instead of jumping a full turn.
    const branch = Math.round((continuity.previousLongitude - result.longitude) / TWO_PI);
    return { ...result, longitude: result.longitude + TWO_PI * branch };
  }

  #across(longitude: number, latitude: number): boolean {
    return Math.abs(longitude) <= this.#h / 2 + EPS / Math.cos(latitude);
  }

  #x(longitude: number, view: ViewGeometry): number {
    return (longitude / this.#h + 0.5) * view.width;
  }

  #y(latitude: number, view: ViewGeometry): number {
    return (this.#horizon - latitude / this.#v) * view.height;
  }

  /** The highest latitude the image shows, in radians. */
  get #top(): number {
    return this.#horizon * this.#v;
  }

  /** The lowest latitude the image shows, in radians (negative below the horizon). */
  get #bottom(): number {
    return (this.#horizon - 1) * this.#v;
  }
}
