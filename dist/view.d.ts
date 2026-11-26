import type { Quat } from '@swf/math';
/**
 * A camera rotation from a heading (radians to the right of the -Z axis, about +Y) and a pitch
 * (radians above the horizon). A camera looks along its local -Z with +Y up. Any finite angles are
 * accepted, beyond a turn or past straight up included; the rotation is a new value.
 *
 * @throws RangeError when either angle is not finite.
 */
export declare function cameraRotation(heading: number, pitch: number): Quat;
/**
 * The heading and pitch a camera rotation looks along, as {@link cameraRotation} defines them;
 * heading is in (-π, π] and pitch in [-π/2, π/2]. Looking straight up or down, the heading is that
 * of the camera's up vector, so it stays defined.
 */
export declare function headingPitchOf(rotation: Quat): {
    /** Radians to the right of the -Z axis, about +Y. */
    heading: number;
    /** Radians above the horizon. */
    pitch: number;
};
//# sourceMappingURL=view.d.ts.map