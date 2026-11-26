import type { ProjectionModule } from './contract.js';
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
export declare const EQUIRECTANGULAR_POLE_BAND: number;
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
/**
 * The equirectangular module's default configuration, frozen: the full circle across and 120°
 * down, so the poles are not shown.
 */
export declare const DEFAULT_EQUIRECTANGULAR_CONFIG: Readonly<{
    /** The full 360°, with a wrapping seam behind the camera. */
    horizontal: 360;
    /** 60° above and below the horizon. */
    vertical: 120;
}>;
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
export declare const equirectangular: ProjectionModule;
//# sourceMappingURL=equirectangular.d.ts.map