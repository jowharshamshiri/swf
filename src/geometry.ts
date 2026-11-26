import type { Aabb, Mat4, Vec3 } from '@swf/math';
import {
  aabbOfBox,
  mat4InvertAffine,
  mat4TransformDirection,
  mat4TransformPoint,
  normalize,
  sub,
} from '@swf/math';
import { thrownText } from './errors.js';
import type { JsonValue } from './json.js';
import { describe, describeAnswer } from './json.js';

/**
 * Describes a surface's presentation geometry, independently of what it shows. `params` is
 * JSON metadata interpreted by the provider registered for `kind`; the built-in kinds are `rect`
 * (no params) and `polygon` (`{ points: [[x, y], ...] }` in the surface's local frame).
 */
export interface GeometryDescriptor {
  /** The geometry kind: `rect`, `polygon`, or a registered `host.` or `ext.` kind. */
  readonly kind: string;
  /**
   * The kind's parameters as JSON (null when it takes none), within the workspace's
   * `maxParamsBytes` limit.
   */
  readonly params: JsonValue;
}

/** The default geometry: a `rect` filling the surface's bounds. The object is frozen. */
export const RECT_GEOMETRY: GeometryDescriptor = Object.freeze({ kind: 'rect', params: null });

/** Bounds on descriptor complexity, so a malformed or hostile descriptor cannot stall the page. */
export interface GeometryLimits {
  /** Largest UTF-8 size of a descriptor's params as JSON. Default 65536. */
  readonly maxParamsBytes: number;
  /** Most vertices a polygon may have. Default 1024. */
  readonly maxPolygonVertices: number;
}

/** The limits a workspace applies unless its options override them. The object is frozen. */
export const DEFAULT_GEOMETRY_LIMITS: GeometryLimits = Object.freeze({
  maxParamsBytes: 65_536,
  maxPolygonVertices: 1024,
});

/**
 * How faithfully a geometry's intersection and UV mapping follow what is presented: `exact` when
 * they are the presented shape, `approximate` when they stand in for it.
 */
export type GeometryFidelity = 'exact' | 'approximate';

/** A ray in a surface's local frame. Its direction need not be unit length. */
export interface LocalRay {
  /** Where the ray starts, in the surface's local frame. */
  readonly origin: Vec3;
  /** Which way it goes, in the surface's local frame; non-zero. */
  readonly direction: Vec3;
}

/** Where a local ray meets a geometry: `t` is the ray parameter, `uv` has its origin top-left. */
export interface LocalHit {
  /** The ray parameter of the hit: `origin + t * direction` is the point; at least 0. */
  readonly t: number;
  /** The hit point in the surface's local frame. */
  readonly point: Vec3;
  /**
   * Where on the surface the hit is, in UV space with its origin top-left. The built-in kinds map
   * the surface rectangle to (0, 0) top-left through (1, 1) bottom-right.
   */
  readonly uv: readonly [number, number];
}

/**
 * Interprets one geometry kind. It sees only the descriptor and the surface's bounds, never the
 * surface's content. Every method must be deterministic and free of side effects.
 */
export interface GeometryProvider {
  /**
   * `host.<name>` or `ext.<extension-id>.<name>`; `rect` and `polygon` are built in. Registering a
   * kind that is not namespaced or is taken throws {@link SwfFailure} (`INVALID_INPUT`).
   */
  readonly kind: string;
  /** Whether intersection and UV mapping follow the presented shape exactly. */
  readonly fidelity: GeometryFidelity;
  /**
   * Why `params` are invalid for a surface of `bounds`, or null when they are valid. When it
   * throws or answers anything but text or null, the params are refused with `INVALID_INPUT` (or
   * `SNAPSHOT_INVALID` on a restore), naming the provider and quoting what it threw or answered.
   */
  validate(params: JsonValue, bounds: Vec3, limits: GeometryLimits): string | null;
  /** The geometry's box in the surface's local frame. */
  localBounds(params: JsonValue, bounds: Vec3): Aabb;
  /** The front normal in the local frame, or null when it varies across the geometry. */
  normal(params: JsonValue, bounds: Vec3): Vec3 | null;
  /** The nearest hit in front of the ray origin (t >= 0), or null. */
  intersect(params: JsonValue, bounds: Vec3, ray: LocalRay): LocalHit | null;
}

/** UV of a point on the surface rectangle: (0, 0) is top-left, (1, 1) bottom-right. */
function rectUv(point: Vec3, bounds: Vec3): [number, number] {
  return [(point[0] + bounds[0] / 2) / bounds[0], (bounds[1] / 2 - point[1]) / bounds[1]];
}

/** Where the ray crosses the local z = 0 plane in front of its origin. */
function planeHit(ray: LocalRay): { t: number; point: Vec3 } | null {
  const dz = ray.direction[2];
  if (dz === 0) {
    return null;
  }
  const t = -ray.origin[2] / dz;
  if (!(t >= 0)) {
    return null;
  }
  return {
    t,
    point: [ray.origin[0] + t * ray.direction[0], ray.origin[1] + t * ray.direction[1], 0],
  };
}

const PLANAR_NORMAL: Vec3 = Object.freeze([0, 0, 1] as const);

/**
 * A planar rectangle filling the surface's width and height, facing local +Z. It takes no params
 * (null).
 */
export const rectGeometry: GeometryProvider = Object.freeze({
  kind: 'rect',
  fidelity: 'exact',
  validate: (params: JsonValue) => (params === null ? null : 'a rect takes no params (null)'),
  localBounds: (_params: JsonValue, bounds: Vec3) => aabbOfBox(IDENTITY, bounds),
  normal: () => PLANAR_NORMAL,
  intersect(_params: JsonValue, bounds: Vec3, ray: LocalRay): LocalHit | null {
    const hit = planeHit(ray);
    if (hit === null) {
      return null;
    }
    const [x, y] = hit.point;
    if (Math.abs(x) > bounds[0] / 2 || Math.abs(y) > bounds[1] / 2) {
      return null;
    }
    return { t: hit.t, point: hit.point, uv: rectUv(hit.point, bounds) };
  },
});

type Point2 = readonly [number, number];

function polygonPoints(params: JsonValue): Point2[] {
  return (params as { points: Point2[] }).points;
}

function polygonIssue(params: JsonValue, bounds: Vec3, limits: GeometryLimits): string | null {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return `polygon params must be { points: [[x, y], ...] } (got ${describe(params)})`;
  }
  const keys = Object.keys(params);
  if (keys.length !== 1 || keys[0] !== 'points') {
    return 'polygon params take exactly one field, points';
  }
  const raw: unknown = (params as Record<string, unknown>)['points'];
  if (!Array.isArray(raw) || raw.length < 3) {
    return 'polygon points must be an array of at least 3 [x, y] pairs';
  }
  if (raw.length > limits.maxPolygonVertices) {
    return `polygon has ${raw.length} points, more than the limit of ${limits.maxPolygonVertices}`;
  }
  const hw = bounds[0] / 2;
  const hh = bounds[1] / 2;
  for (const [i, p] of raw.entries()) {
    if (
      !Array.isArray(p) ||
      p.length !== 2 ||
      typeof p[0] !== 'number' ||
      typeof p[1] !== 'number'
    ) {
      return `polygon points[${i}] must be [x, y]`;
    }
    if (Math.abs(p[0]) > hw || Math.abs(p[1]) > hh) {
      return `polygon points[${i}] lies outside the surface bounds`;
    }
  }
  const points = raw as Point2[];
  if (Math.abs(signedArea(points)) <= 1e-12 * bounds[0] * bounds[1]) {
    return 'polygon has no area';
  }
  const crossing = selfIntersection(points);
  if (crossing !== null) {
    return `polygon edges ${crossing[0]} and ${crossing[1]} cross`;
  }
  return null;
}

function signedArea(points: readonly Point2[]): number {
  let sum = 0;
  points.forEach((p, i) => {
    const q = points[(i + 1) % points.length] ?? p;
    sum += p[0] * q[1] - q[0] * p[1];
  });
  return sum / 2;
}

function orientation(a: Point2, b: Point2, c: Point2): number {
  const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

function onSegment(a: Point2, b: Point2, p: Point2): boolean {
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  );
}

function segmentsTouch(a: Point2, b: Point2, c: Point2, d: Point2): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) {
    return true;
  }
  return (
    (o1 === 0 && onSegment(a, b, c)) ||
    (o2 === 0 && onSegment(a, b, d)) ||
    (o3 === 0 && onSegment(c, d, a)) ||
    (o4 === 0 && onSegment(c, d, b))
  );
}

/** The first pair of non-adjacent edges that touch, or null for a simple polygon. */
function selfIntersection(points: readonly Point2[]): [number, number] | null {
  const n = points.length;
  const at = (i: number): Point2 => points[i % n] ?? [0, 0];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (!adjacent && segmentsTouch(at(i), at(i + 1), at(j), at(j + 1))) {
        return [i, j];
      }
    }
  }
  return null;
}

/** Even-odd containment; points on an edge count as inside. */
function insidePolygon(points: readonly Point2[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i] ?? [0, 0];
    const b = points[j] ?? [0, 0];
    if (orientation(a, b, [x, y]) === 0 && onSegment(a, b, [x, y])) {
      return true;
    }
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * A planar polygon on the surface, facing local +Z. Its UV space is the surface rectangle, so the
 * polygon masks part of what the surface shows rather than remapping it. Its params are exactly
 * `{ points }`: at least 3 and at most `maxPolygonVertices` `[x, y]` pairs in the local z = 0
 * plane (+Y up), each within the surface's bounds, enclosing a non-zero area with no two
 * non-adjacent edges touching.
 */
export const polygonGeometry: GeometryProvider = Object.freeze({
  kind: 'polygon',
  fidelity: 'exact',
  validate: polygonIssue,
  localBounds(params: JsonValue, bounds: Vec3): Aabb {
    const points = polygonPoints(params);
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    return {
      min: [Math.min(...xs), Math.min(...ys), -bounds[2] / 2],
      max: [Math.max(...xs), Math.max(...ys), bounds[2] / 2],
    };
  },
  normal: () => PLANAR_NORMAL,
  intersect(params: JsonValue, bounds: Vec3, ray: LocalRay): LocalHit | null {
    const hit = planeHit(ray);
    if (hit === null || !insidePolygon(polygonPoints(params), hit.point[0], hit.point[1])) {
      return null;
    }
    return { t: hit.t, point: hit.point, uv: rectUv(hit.point, bounds) };
  },
});

const IDENTITY: Mat4 = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const);

const BUILT_IN = new Map<string, GeometryProvider>([
  ['rect', rectGeometry],
  ['polygon', polygonGeometry],
]);

const CUSTOM_KIND = /^(?:host\.\S+|ext\.[A-Za-z0-9_-]+\.\S+)$/;

/** The geometry kinds a workspace knows: the built-ins plus those the host registers. */
export class GeometryRegistry {
  readonly #providers = new Map<string, GeometryProvider>(BUILT_IN);

  get(kind: string): GeometryProvider | undefined {
    return this.#providers.get(kind);
  }

  /**
   * Adds a provider; throws a TypeError naming the problem when its kind is not namespaced, is
   * taken, or the provider is malformed. The returned function removes it (safe to call twice).
   */
  register(provider: GeometryProvider): () => void {
    const p: unknown = provider;
    if (typeof p !== 'object' || p === null) {
      throw new TypeError(`geometry provider must be an object (got ${describe(p)})`);
    }
    const kind = (p as { kind?: unknown }).kind;
    if (typeof kind !== 'string' || !CUSTOM_KIND.test(kind)) {
      throw new TypeError(
        `geometry kind ${JSON.stringify(kind)} must be namespaced as "host.<name>" or "ext.<extension-id>.<name>"`,
      );
    }
    if (this.#providers.has(kind)) {
      throw new TypeError(`geometry kind "${kind}" is already registered`);
    }
    for (const method of ['validate', 'localBounds', 'normal', 'intersect'] as const) {
      if (typeof (p as Record<string, unknown>)[method] !== 'function') {
        throw new TypeError(`geometry provider "${kind}" must implement ${method}()`);
      }
    }
    const fidelity = (p as { fidelity?: unknown }).fidelity;
    if (fidelity !== 'exact' && fidelity !== 'approximate') {
      throw new TypeError(`geometry provider "${kind}" fidelity must be "exact" or "approximate"`);
    }
    this.#providers.set(kind, provider);
    return () => {
      if (this.#providers.get(kind) === provider) {
        this.#providers.delete(kind);
      }
    };
  }
}

/** A surface's presentation geometry placed in the world, as rendering and picking must use it. */
export interface ResolvedGeometry {
  /** The surface placed (for a node frame, the node). */
  readonly surfaceId: string;
  /** The descriptor's kind, even when no provider is registered for it. */
  readonly kind: string;
  /**
   * False when no provider is registered for the kind: the geometry then falls back to the
   * surface rectangle and its fidelity is `approximate`, never claimed exact.
   */
  readonly supported: boolean;
  /** The provider's fidelity, or `approximate` when the kind is unsupported. */
  readonly fidelity: GeometryFidelity;
  /** Surface-local to world matrix: the owner's world matrix times the surface's transform. */
  readonly world: Mat4;
  /** The geometry's box in the surface's local frame. */
  readonly localBounds: Aabb;
  /** The world-aligned box enclosing `localBounds` placed in the world. */
  readonly worldBounds: Aabb;
  /** The front normal in world space, or null when it varies across the geometry. */
  readonly normal: Vec3 | null;
  /** The nearest hit of a world ray (unit direction) in front of its origin, or null. */
  intersect(ray: { readonly origin: Vec3; readonly direction: Vec3 }): WorldHit | null;
}

/** Where a world ray meets a placed geometry. */
export interface WorldHit {
  /**
   * Distance along the world ray: the ray parameter, a distance in world units when the ray's
   * direction is unit length.
   */
  readonly distance: number;
  /** The hit point in world coordinates. */
  readonly point: Vec3;
  /** The hit point in the surface's local frame. */
  readonly localPoint: Vec3;
  /** The hit's UV coordinates, as the geometry's provider maps them (origin top-left). */
  readonly uv: readonly [number, number];
}

/**
 * What is wrong with `params` for a surface of `bounds`, or null when they are valid: params over
 * the `maxParamsBytes` limit, or what `provider.validate` finds. A validate that throws or answers
 * anything but text or null is reported as the issue, naming the provider. Transactions and
 * restore both hold geometry to this one check.
 */
export function geometryParamsIssue(
  provider: GeometryProvider,
  params: JsonValue,
  bounds: Vec3,
  limits: GeometryLimits,
): string | null {
  const size = jsonByteLength(params);
  if (size > limits.maxParamsBytes) {
    return `their JSON is ${size} bytes, more than the maxParamsBytes limit of ${limits.maxParamsBytes}`;
  }
  let issue: unknown;
  try {
    issue = provider.validate(params, bounds, limits);
  } catch (error) {
    return `geometry provider "${provider.kind}": its validate threw: ${thrownText(error)}`;
  }
  if (issue === null || typeof issue === 'string') {
    return issue;
  }
  return `geometry provider "${provider.kind}": its validate returned ${describeAnswer(issue)}, not text or null`;
}

/** Places a descriptor in the world through `world`, the surface-local to world matrix. */
export function resolveGeometry(
  surfaceId: string,
  descriptor: GeometryDescriptor,
  bounds: Vec3,
  world: Mat4,
  registry: GeometryRegistry,
): ResolvedGeometry {
  const provider = registry.get(descriptor.kind);
  const effective = provider ?? rectGeometry;
  const params = provider === undefined ? null : descriptor.params;
  const inverse = mat4InvertAffine(world);
  if (inverse === null) {
    throw new Error(`surface "${surfaceId}" has a singular world placement`);
  }
  const localBounds = effective.localBounds(params, bounds);
  const localNormal = effective.normal(params, bounds);
  // Normals transform by the inverse transpose of the linear part.
  const normal =
    localNormal === null
      ? null
      : normalize([
          inverse[0] * localNormal[0] + inverse[1] * localNormal[1] + inverse[2] * localNormal[2],
          inverse[4] * localNormal[0] + inverse[5] * localNormal[1] + inverse[6] * localNormal[2],
          inverse[8] * localNormal[0] + inverse[9] * localNormal[1] + inverse[10] * localNormal[2],
        ]);
  const centre: Vec3 = [
    (localBounds.min[0] + localBounds.max[0]) / 2,
    (localBounds.min[1] + localBounds.max[1]) / 2,
    (localBounds.min[2] + localBounds.max[2]) / 2,
  ];
  const size: Vec3 = sub(localBounds.max, localBounds.min);
  const boxWorld: Mat4 = [
    world[0], world[1], world[2], world[3],
    world[4], world[5], world[6], world[7],
    world[8], world[9], world[10], world[11],
    ...mat4TransformPoint(world, centre), 1,
  ]; // prettier-ignore
  return Object.freeze({
    surfaceId,
    kind: descriptor.kind,
    supported: provider !== undefined,
    fidelity: provider === undefined ? 'approximate' : provider.fidelity,
    world,
    localBounds,
    worldBounds: aabbOfBox(boxWorld, size),
    normal,
    intersect(ray: { readonly origin: Vec3; readonly direction: Vec3 }): WorldHit | null {
      const local: LocalRay = {
        origin: mat4TransformPoint(inverse, ray.origin),
        direction: mat4TransformDirection(inverse, ray.direction),
      };
      const hit = effective.intersect(params, bounds, local);
      if (hit === null) {
        return null;
      }
      // An affine map keeps the ray parameter, so with a unit world direction t is the distance.
      return {
        distance: hit.t,
        point: mat4TransformPoint(world, hit.point),
        localPoint: hit.point,
        uv: hit.uv,
      };
    },
  });
}

/** The size of a JSON value's text in UTF-8 bytes. */
export function jsonByteLength(value: JsonValue): number {
  const text = JSON.stringify(value);
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}
