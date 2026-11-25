import type { JsonValue, ProjectionKind, ResolvedGeometry } from '@swf/core';
import type { Ray, Vec3 } from '@swf/math';
import type {
  ProjectedFragment,
  ProjectionProfile,
  ScreenPoint,
  ViewGeometry,
} from '@swf/presentation';

/** The version of the projection contract this package defines. */
export const PROJECTION_API_VERSION = 1;

/**
 * What a projection covers and how its mapping behaves, for a given configuration. Angles are in
 * radians.
 */
export interface ProjectionDomain {
  /** Horizontal angle covered, in (0, 2π]. */
  readonly horizontalCoverage: number;
  /** Vertical angle covered, in (0, π]. */
  readonly verticalCoverage: number;
  /** The left and right edges meet, so content crossing them wraps around. */
  readonly seamWrapping: boolean;
  /** The full 360° around the camera is shown. */
  readonly fullCircle: boolean;
  /** Straight up and straight down are shown (each as a whole edge row of the image). */
  readonly poles: boolean;
  /** The image depends on the camera's orientation, not only its position. */
  readonly orientationDependent: boolean;
  /** Some directions have several images on screen (a seam, or a pole row). */
  readonly nonInjective: boolean;
  /** Whether screen points map back to exact rays, or to approximations within `maxInverseError`. */
  readonly inverse: 'exact' | 'approximate';
  /** The largest angle between an inverse ray and the true one, in radians; 0 when exact. */
  readonly maxInverseError: number;
}

/** Where a world direction appears on screen. */
export interface ProjectedDirection {
  /**
   * Every image of the direction, in viewport CSS pixels; empty when it is outside the covered
   * angles. A direction on a seam has two images.
   */
  readonly images: readonly ScreenPoint[];
  /**
   * The direction is a pole: it maps to a whole edge row of the image, and `images` holds that
   * row's centre.
   */
  readonly singular: boolean;
  /** The direction points behind the camera. */
  readonly behind: boolean;
}

/**
 * The world ray for a screen point, or why there is none. A point that has no ray is reported,
 * never guessed: callers decide what an `outside` or `unpickable` point means for them.
 */
export type RayResult =
  | {
      /** The point has a ray. */
      readonly kind: 'ray';
      /** In world space, from the camera's position, with a unit direction. */
      readonly ray: Ray;
      /** Bound on the angle between this ray and the true one, in radians; 0 when exact. */
      readonly error: number;
      /** Angle right of the camera's heading, in radians (unwrapped when continuity is given). */
      readonly longitude: number;
      /** Angle above the camera's horizon, in radians. */
      readonly latitude: number;
    }
  /** The point lies outside the image. */
  | {
      /** The point is outside the view, or not a finite number. */
      readonly kind: 'outside';
      /** Why, in words for diagnostics, naming the point and the image size. */
      readonly reason: string;
    }
  /** The point lies inside the image where the projection has no valid inverse. */
  | {
      /** The point is inside the view, where the projection has no inverse to give. */
      readonly kind: 'unpickable';
      /** Why, in words for diagnostics. */
      readonly reason: string;
    };

/** How much of a surface a viewport shows. */
export interface Visibility {
  /**
   * `inside` when the whole outline is in the image (`coverage` 1), `outside` when none of it is
   * (`coverage` 0), `partial` otherwise.
   */
  readonly state: 'inside' | 'partial' | 'outside';
  /** Share of the surface's outline inside the image, 0 to 1. */
  readonly coverage: number;
  /** The surface's centre is behind the camera. */
  readonly behind: boolean;
  /** The surface crosses the image's wrapping seam. */
  readonly crossesSeam: boolean;
}

/** Continuity for interaction: the previous longitude of a drag in progress, unwrapped. */
export interface Continuity {
  /**
   * The longitude the drag's previous ray reported, in radians, as {@link RayResult} gives it:
   * already unwrapped, so it may lie outside (-π, π].
   */
  readonly previousLongitude: number;
}

/**
 * A projection for one configuration. It maps between world directions and viewport pixels and
 * places surface geometry as fragments; it reads the view and the geometry only, and keeps no
 * state of its own. Screen coordinates are viewport CSS pixels with (0, 0) at the top-left corner,
 * x to the right and y down; world directions are in the right-handed, +Y-up world, and the
 * camera looks along its local -Z. Every method expects a view that passes `viewGeometryIssue`
 * and uses this projection's ID and configuration, as {@link projectionFor} checks.
 */
export interface Projection {
  /** The versioned ID of the module that created it; registration refuses any other. */
  readonly id: string;
  /**
   * What this configuration covers and how its mapping behaves. Registration checks it against
   * the module's profile (seam wrapping, exact inverse) and refuses a contradiction.
   */
  describeDomain(): ProjectionDomain;
  /** Where a world direction (from the camera, any non-zero length) appears. */
  projectDirection(direction: Vec3, view: ViewGeometry): ProjectedDirection;
  /**
   * The world ray through a viewport point, or `outside` for a point beyond the image or not
   * finite. Its longitude is never unwrapped; {@link Projection.interactionRay} unwraps it for a
   * drag.
   */
  unprojectPoint(x: number, y: number, view: ViewGeometry): RayResult;
  /**
   * The visible fragments of a surface: none, one, or several (a surface crossing a seam), each
   * referring to the surface. Exactly one of them, if any, is the native owner.
   */
  projectGeometry(geometry: ResolvedGeometry, view: ViewGeometry): ProjectedFragment[];
  /** How much of a surface the view shows, as the share of its outline inside the image. */
  clipVisibility(geometry: ResolvedGeometry, view: ViewGeometry): Visibility;
  /**
   * The world ray for a pointer at a viewport point. With `continuity`, the longitude is unwrapped
   * to the branch nearest the drag's previous longitude, so angles stay continuous across a seam.
   */
  interactionRay(x: number, y: number, view: ViewGeometry, continuity?: Continuity): RayResult;
}

/**
 * A projection kind as a module: what the scene needs to accept viewports that use it (its ID and
 * a configuration check), what negotiation needs (its profile), and a factory for configured
 * projections.
 */
export interface ProjectionModule extends ProjectionKind {
  /**
   * The contract version it implements; registration refuses any but
   * {@link PROJECTION_API_VERSION} with `UNSUPPORTED_CAPABILITY`.
   */
  readonly apiVersion: number;
  /** What negotiation knows of it; its `id` must be the module's own. */
  readonly profile: ProjectionProfile;
  /** A configuration the module accepts, used to validate it on registration. */
  readonly defaultConfig: JsonValue;
  /**
   * A projection for `config`. It throws for a configuration `configIssue` rejects; a projection
   * holds no resources, so there is nothing to release.
   */
  create(config: JsonValue): Projection;
}
