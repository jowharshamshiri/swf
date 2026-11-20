import type { JsonValue, ResolvedGeometry } from '@swf/core';
import type { Mat4, Vec3 } from '@swf/math';
import {
  length,
  mat4InvertAffine,
  mat4TransformDirection,
  mat4TransformPoint,
  normalize,
  sub,
} from '@swf/math';
import type { ProjectedFragment, ScreenPoint, ViewGeometry } from '@swf/presentation';
import { fragmentId } from '@swf/presentation';
import type {
  Continuity,
  ProjectedDirection,
  Projection,
  ProjectionDomain,
  ProjectionModule,
  RayResult,
  Visibility,
} from './contract.js';
import { PROJECTION_API_VERSION } from './contract.js';

const TWO_PI = 2 * Math.PI;
/** Angular slack for edges that are inclusive, in radians. */
const EPS = 1e-12;
/** Outline samples per edge of a surface. */
const SAMPLES_PER_EDGE = 16;

/**
 * Configuration of the equirectangular projection: the horizontal and vertical angles the viewport
 * covers, in degrees, centred on the camera's heading.
 */
export interface EquirectangularConfig {
  /** In (0, 360]. 360 shows the full circle with a wrapping seam. */
  readonly horizontal: number;
  /** In (0, 180]. 180 reaches both poles. */
  readonly vertical: number;
}

export const DEFAULT_EQUIRECTANGULAR_CONFIG = Object.freeze({
  horizontal: 360,
  vertical: 120,
}) satisfies EquirectangularConfig;

function configIssue(config: JsonValue): string | null {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return 'must be an object { horizontal, vertical } in degrees';
  }
  const keys = Object.keys(config);
  const unknown = keys.find((k) => k !== 'horizontal' && k !== 'vertical');
  if (unknown !== undefined) {
    return `${unknown} is not a setting (expected horizontal and vertical)`;
  }
  const record = config as Record<string, unknown>;
  const angle = (key: string, max: number) => {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max
      ? null
      : `${key} must be a number of degrees in (0, ${String(max)}] (got ${JSON.stringify(value)})`;
  };
  return angle('horizontal', 360) ?? angle('vertical', 180);
}

/**
 * The equirectangular projection: longitude across, latitude down. A direction in the camera's
 * frame has longitude `atan2(x, -z)` (positive to the right) and latitude `atan2(y, √(x² + z²))`
 * (positive up); the viewport spans the configured angles centred on the camera's heading. At
 * 360° the left and right edges meet at a seam behind the camera; at 180° vertically, the top and
 * bottom rows are the poles. Its inverse is exact everywhere in the image.
 */
export const equirectangular: ProjectionModule = Object.freeze({
  id: 'equirectangular/1',
  apiVersion: PROJECTION_API_VERSION,
  profile: Object.freeze({
    id: 'equirectangular/1',
    mapping: 'nonlinear',
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
    return new Equirectangular((c.horizontal * Math.PI) / 180, (c.vertical * Math.PI) / 180);
  },
});

interface Frame {
  readonly eye: Vec3;
  readonly toCamera: Mat4;
}

interface Angles {
  readonly longitude: number;
  readonly latitude: number;
  /** The direction is (numerically) straight up or down, so its longitude is undefined. */
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

function anglesOf(d: Vec3): Angles {
  const horizontal = Math.hypot(d[0], d[2]);
  return {
    longitude: Math.atan2(d[0], -d[2]),
    latitude: Math.atan2(d[1], horizontal),
    singular: horizontal <= 1e-12 * Math.abs(d[1]),
  };
}

/** `a` limited to [-limit, limit]. */
function clamp(a: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, a));
}

/** `a` shifted by a multiple of 2π into (-π, π]. */
function wrapPi(a: number): number {
  const r = a - TWO_PI * Math.round(a / TWO_PI);
  return r <= -Math.PI ? r + TWO_PI : r;
}

class Equirectangular implements Projection {
  readonly id = 'equirectangular/1';
  readonly #h: number;
  readonly #v: number;
  readonly #fullCircle: boolean;
  readonly #poles: boolean;

  constructor(horizontal: number, vertical: number) {
    this.#h = horizontal;
    this.#v = vertical;
    this.#fullCircle = horizontal >= TWO_PI - EPS;
    this.#poles = vertical >= Math.PI - EPS;
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
    if (Math.abs(latitude) > this.#v / 2 + EPS) {
      return { images: [], singular, behind };
    }
    if (singular) {
      // A pole is the whole top or bottom row; its centre stands for it.
      return {
        images: [[view.width / 2, latitude > 0 ? 0 : view.height]],
        singular: true,
        behind,
      };
    }
    // Directions within the edge slack land on the edge, so every image is inside the image.
    const y = this.#y(clamp(latitude, this.#v / 2), view);
    const images: ScreenPoint[] = [];
    for (const k of [-1, 0, 1]) {
      const l = longitude + TWO_PI * k;
      if (Math.abs(l) <= this.#h / 2 + EPS) {
        images.push([this.#x(clamp(l, this.#h / 2), view), y]);
      }
    }
    return { images, singular: false, behind };
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
    const latitude = (0.5 - y / view.height) * this.#v;
    const cos = Math.cos(latitude);
    const local: Vec3 = [cos * Math.sin(longitude), Math.sin(latitude), -cos * Math.cos(longitude)];
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

  projectGeometry(geometry: ResolvedGeometry, view: ViewGeometry): ProjectedFragment[] {
    const outline = this.#outline(geometry, view);
    if (outline === null) {
      return [];
    }
    const { lo, hi, latLo, latHi, centre, depth, encirclesPole, corners } = outline;
    const top = Math.min(latHi, this.#v / 2);
    const bottom = Math.max(latLo, -this.#v / 2);
    if (top < bottom) {
      return [];
    }
    const make = (
      ordinal: number,
      from: number,
      to: number,
      owner: boolean,
      exact: boolean,
      shape: ProjectedFragment['corners'],
    ): ProjectedFragment => {
      const x0 = this.#x(from, view);
      const y0 = this.#y(top, view);
      return Object.freeze({
        id: fragmentId(view.viewportId, geometry.surfaceId, ordinal),
        surfaceId: geometry.surfaceId,
        viewportId: view.viewportId,
        ordinal,
        bounds: [x0, y0, this.#x(to, view) - x0, this.#y(bottom, view) - y0] as const,
        corners: shape,
        depth,
        geometricFidelity: exact ? 'exact' : 'approximate',
        nativeOwner: owner,
      });
    };
    if (encirclesPole) {
      // Overhead or underfoot all around: the surface spans every longitude near the pole.
      return [make(0, -this.#h / 2, this.#h / 2, true, false, null)];
    }
    const edgeOn = hi - lo <= EPS;
    const pieces: Piece[] = [];
    for (const k of [-1, 0, 1]) {
      const from = Math.max(lo + TWO_PI * k, -this.#h / 2);
      const to = Math.min(hi + TWO_PI * k, this.#h / 2);
      // A piece only touching an edge of the image shows nothing, unless the surface is seen
      // edge-on (no width at all), in which case its one image is kept.
      if (to - from > EPS || (edgeOn && from <= to + EPS && pieces.length === 0)) {
        pieces.push({ k, from, to: Math.max(from, to) });
      }
    }
    if (pieces.length === 0) {
      return [];
    }
    pieces.sort((a, b) => a.from - b.from);
    const owner = ownerPiece(pieces, centre);
    const unclippedLatitude = latHi <= this.#v / 2 && latLo >= -this.#v / 2;
    return pieces.map((p, ordinal) => {
      const whole =
        unclippedLatitude &&
        Math.abs(p.from - (lo + TWO_PI * p.k)) <= EPS &&
        Math.abs(p.to - (hi + TWO_PI * p.k)) <= EPS;
      const point = ([l, phi]: readonly [number, number]): ScreenPoint => [
        this.#x(l + TWO_PI * p.k, view),
        this.#y(phi, view),
      ];
      const shape: ProjectedFragment['corners'] = whole
        ? [point(corners[0]), point(corners[1]), point(corners[2]), point(corners[3])]
        : null;
      return make(ordinal, p.from, p.to, ordinal === owner, true, shape);
    });
  }

  clipVisibility(geometry: ResolvedGeometry, view: ViewGeometry): Visibility {
    const outline = this.#outline(geometry, view);
    const frame = frameOf(view);
    const centreDirection = mat4TransformDirection(
      frame.toCamera,
      sub(mat4TransformPoint(geometry.world, centreOf(geometry)), frame.eye),
    );
    const behind = centreDirection[2] > 0;
    if (outline === null) {
      return { state: 'outside', coverage: 0, behind, crossesSeam: false };
    }
    let inside = 0;
    for (const [l, phi] of outline.samples) {
      const latitudeIn = Math.abs(phi) <= this.#v / 2 + EPS;
      const longitudeIn =
        outline.encirclesPole ||
        [-1, 0, 1].some((k) => Math.abs(l + TWO_PI * k) <= this.#h / 2 + EPS);
      if (latitudeIn && longitudeIn) {
        inside += 1;
      }
    }
    const coverage = inside / outline.samples.length;
    return {
      state: coverage === 1 ? 'inside' : coverage === 0 ? 'outside' : 'partial',
      coverage,
      behind,
      crossesSeam:
        this.#fullCircle &&
        (outline.encirclesPole || outline.lo < -Math.PI || outline.hi > Math.PI),
    };
  }

  #x(longitude: number, view: ViewGeometry): number {
    return (longitude / this.#h + 0.5) * view.width;
  }

  #y(latitude: number, view: ViewGeometry): number {
    return (0.5 - latitude / this.#v) * view.height;
  }

  /**
   * The surface's outline as unwrapped angles: samples around its local bounds, followed
   * continuously in longitude, centred so their mean lies in (-π, π]. Null when the surface is
   * beyond the far distance or the camera is within the near distance of it.
   */
  #outline(geometry: ResolvedGeometry, view: ViewGeometry) {
    const frame = frameOf(view);
    const world = (p: Vec3) => mat4TransformPoint(geometry.world, p);
    const centreWorld = world(centreOf(geometry));
    const depth = length(sub(centreWorld, frame.eye));
    if (depth < view.near || (view.far !== null && depth > view.far)) {
      return null;
    }
    const { min, max } = geometry.localBounds;
    const z = (min[2] + max[2]) / 2;
    // Top-left, top-right, bottom-right, bottom-left, each edge running to the next corner.
    const topLeft: Vec3 = [min[0], max[1], z];
    const topRight: Vec3 = [max[0], max[1], z];
    const bottomRight: Vec3 = [max[0], min[1], z];
    const bottomLeft: Vec3 = [min[0], min[1], z];
    const edges = [
      [topLeft, topRight],
      [topRight, bottomRight],
      [bottomRight, bottomLeft],
      [bottomLeft, topLeft],
    ] as const;
    const raw: Angles[] = [];
    for (const [a, b] of edges) {
      for (let i = 0; i < SAMPLES_PER_EDGE; i++) {
        const t = i / SAMPLES_PER_EDGE;
        const p = world([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z]);
        const d = sub(p, frame.eye);
        if (!(length(d) > 0)) {
          // The outline passes through the camera, which is within any near distance.
          return null;
        }
        raw.push(anglesOf(mat4TransformDirection(frame.toCamera, d)));
      }
    }
    const unwrapped: number[] = [];
    let previous: number | null = null;
    for (const angle of raw) {
      // A pole sample has no longitude of its own; it continues the previous one.
      const l = angle.singular ? (previous ?? 0) : angle.longitude;
      const u: number = previous === null ? l : previous + wrapPi(l - wrapPi(previous));
      unwrapped.push(u);
      previous = u;
    }
    const first = unwrapped[0] ?? 0;
    const last = unwrapped[unwrapped.length - 1] ?? 0;
    const winding = last + wrapPi(wrapPi(first) - wrapPi(last)) - first;
    const mean = unwrapped.reduce((s, v) => s + v, 0) / unwrapped.length;
    const shift = wrapPi(mean) - mean;
    const longitudes = unwrapped.map((u) => u + shift);
    const latitudes = raw.map((a) => a.latitude);
    const centreAngles = anglesOf(
      mat4TransformDirection(frame.toCamera, sub(centreWorld, frame.eye)),
    );
    const centreMean = wrapPi(mean);
    const centre =
      centreAngles.longitude + TWO_PI * Math.round((centreMean - centreAngles.longitude) / TWO_PI);
    const corner = (c: number): readonly [number, number] => [
      longitudes[c * SAMPLES_PER_EDGE] ?? 0,
      latitudes[c * SAMPLES_PER_EDGE] ?? 0,
    ];
    // An outline winding once around the camera's vertical encloses a pole: the one on its side.
    const encirclesPole = Math.abs(winding) > Math.PI;
    const north = latitudes.reduce((s, v) => s + v, 0) > 0;
    return {
      lo: Math.min(...longitudes),
      hi: Math.max(...longitudes),
      latLo: encirclesPole && !north ? -Math.PI / 2 : Math.min(...latitudes),
      latHi: encirclesPole && north ? Math.PI / 2 : Math.max(...latitudes),
      centre,
      depth,
      encirclesPole,
      samples: longitudes.map((l, i) => [l, latitudes[i] ?? 0] as const),
      corners: [corner(0), corner(1), corner(2), corner(3)] as const,
    };
  }
}

/** One horizontal piece of a surface's image, on the branch `k` turns from the centred one. */
interface Piece {
  readonly k: number;
  readonly from: number;
  readonly to: number;
}

/**
 * The piece that owns native interaction: the one showing the surface's centre, or failing that
 * the widest (the first of equals).
 */
function ownerPiece(pieces: readonly Piece[], centre: number): number {
  const showing = pieces.findIndex((p) => {
    const c = centre + TWO_PI * p.k;
    return c >= p.from - EPS && c <= p.to + EPS;
  });
  if (showing >= 0) {
    return showing;
  }
  let widest = 0;
  pieces.forEach((p, i) => {
    const best = pieces[widest];
    if (best !== undefined && p.to - p.from > best.to - best.from) {
      widest = i;
    }
  });
  return widest;
}

function centreOf(geometry: ResolvedGeometry): Vec3 {
  const { min, max } = geometry.localBounds;
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}
