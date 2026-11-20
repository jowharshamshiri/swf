import type { Id, SceneState } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type { Quat } from '@swf/math';
import { mat4FromTransform, quatFromAxisAngle, quatMultiply, quatRotate } from '@swf/math';
import type { ViewGeometry } from '@swf/presentation';

/**
 * The view a viewport shows in a scene: its size, its camera's placement and depth range, and its
 * projection setting. Throws {@link SwfFailure} (`UNKNOWN_ENTITY`) when the viewport, or its
 * camera, is not in the scene.
 */
export function viewGeometryOf(scene: SceneState, viewportId: Id): ViewGeometry {
  const unknown = (message: string, entityId: Id): never => {
    throw new SwfFailure(
      makeError('UNKNOWN_ENTITY', message, { workspaceId: scene.workspaceId, entityId }),
    );
  };
  const viewport =
    scene.viewports.get(viewportId) ?? unknown(`no viewport "${viewportId}"`, viewportId);
  const camera =
    scene.cameras.get(viewport.cameraId) ??
    unknown(
      `viewport "${viewportId}" refers to missing camera "${viewport.cameraId}"`,
      viewport.cameraId,
    );
  return Object.freeze({
    viewportId,
    width: viewport.size.width,
    height: viewport.size.height,
    devicePixelRatio: viewport.size.devicePixelRatio,
    camera: mat4FromTransform({
      position: camera.position,
      rotation: camera.rotation,
      scale: [1, 1, 1],
    }),
    near: camera.near,
    far: camera.far,
    projectionId: viewport.projection.id,
    projectionConfig: viewport.projection.config,
  });
}

/**
 * A camera rotation from a heading (radians to the right of the -Z axis, about +Y) and a pitch
 * (radians above the horizon). A camera looks along its local -Z with +Y up.
 */
export function cameraRotation(heading: number, pitch: number): Quat {
  if (!Number.isFinite(heading) || !Number.isFinite(pitch)) {
    throw new RangeError(
      `heading and pitch must be finite (got ${String(heading)}, ${String(pitch)})`,
    );
  }
  return quatMultiply(quatFromAxisAngle([0, 1, 0], -heading), quatFromAxisAngle([1, 0, 0], pitch));
}

/**
 * The heading and pitch a camera rotation looks along, as {@link cameraRotation} defines them;
 * heading is in (-π, π] and pitch in [-π/2, π/2]. Looking straight up or down, the heading is that
 * of the camera's up vector, so it stays defined.
 */
export function headingPitchOf(rotation: Quat): { heading: number; pitch: number } {
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
