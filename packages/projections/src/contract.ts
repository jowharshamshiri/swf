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

/** The world ray for a screen point, or why there is none. */
export type RayResult =
  | {
      readonly kind: 'ray';
      readonly ray: Ray;
      /** Bound on the angle between this ray and the true one, in radians; 0 when exact. */
      readonly error: number;
      /** Angle right of the camera's heading, in radians (unwrapped when continuity is given). */
      readonly longitude: number;
      /** Angle above the camera's horizon, in radians. */
      readonly latitude: number;
    }
  /** The point lies outside the image. */
  | { readonly kind: 'outside'; readonly reason: string }
  /** The point lies inside the image where the projection has no valid inverse. */
  | { readonly kind: 'unpickable'; readonly reason: string };

/** How much of a surface a viewport shows. */
export interface Visibility {
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
  readonly previousLongitude: number;
}

/**
 * A projection for one configuration. It maps between world directions and viewport pixels and
 * places surface geometry as fragments; it reads the view and the geometry only, and keeps no
 * state of its own.
 */
export interface Projection {
  readonly id: string;
  describeDomain(): ProjectionDomain;
  /** Where a world direction (from the camera) appears. */
  projectDirection(direction: Vec3, view: ViewGeometry): ProjectedDirection;
  /** The world ray through a viewport point. */
  unprojectPoint(x: number, y: number, view: ViewGeometry): RayResult;
  /**
   * The visible fragments of a surface: none, one, or several (a surface crossing a seam), each
   * referring to the surface. Exactly one of them, if any, is the native owner.
   */
  projectGeometry(geometry: ResolvedGeometry, view: ViewGeometry): ProjectedFragment[];
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
  readonly apiVersion: number;
  readonly profile: ProjectionProfile;
  /** A configuration the module accepts, used to validate it on registration. */
  readonly defaultConfig: JsonValue;
  create(config: JsonValue): Projection;
}
