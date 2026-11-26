import { quatFromAxisAngle, quatMultiply, quatRotate } from '@swf/math';
/**
 * A camera rotation from a heading (radians to the right of the -Z axis, about +Y) and a pitch
 * (radians above the horizon). A camera looks along its local -Z with +Y up. Any finite angles are
 * accepted, beyond a turn or past straight up included; the rotation is a new value.
 *
 * @throws RangeError when either angle is not finite.
 */
export function cameraRotation(heading, pitch) {
    if (!Number.isFinite(heading) || !Number.isFinite(pitch)) {
        throw new RangeError(`heading and pitch must be finite (got ${String(heading)}, ${String(pitch)})`);
    }
    return quatMultiply(quatFromAxisAngle([0, 1, 0], -heading), quatFromAxisAngle([1, 0, 0], pitch));
}
/**
 * The heading and pitch a camera rotation looks along, as {@link cameraRotation} defines them;
 * heading is in (-π, π] and pitch in [-π/2, π/2]. Looking straight up or down, the heading is that
 * of the camera's up vector, so it stays defined.
 */
export function headingPitchOf(rotation) {
    const forward = quatRotate(rotation, [0, 0, -1]);
    const pitch = Math.asin(Math.max(-1, Math.min(1, forward[1])));
    const horizontal = Math.hypot(forward[0], forward[2]);
    if (horizontal > 1e-9) {
        return { heading: Math.atan2(forward[0], -forward[2]), pitch };
    }
    // Straight up, the camera's up vector points along its heading; straight down, against it.
    const up = quatRotate(rotation, [0, 1, 0]);
    const sign = forward[1] > 0 ? -1 : 1;
    return { heading: Math.atan2(sign * up[0], -sign * up[2]), pitch };
}
//# sourceMappingURL=view.js.map