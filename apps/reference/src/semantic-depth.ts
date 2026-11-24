import type { Id, SceneState } from '@swf/core';
import { worldMatrix } from '@swf/core';
import { eyeOf } from '@swf/interaction';
import type {
  Representation,
  RepresentationContext,
  RepresentationPolicy,
  ViewGeometry,
} from '@swf/presentation';
import type { DepthBands } from './features.js';

/**
 * Semantic depth: each window is represented by how far it is from the camera, in bands. Nearer
 * than the full band it shows its content; within the compact band, a compact preview stands for
 * it; beyond, its label alone. The representation is the viewport's choice of presentation: the
 * window's content stays bound, attached and running whatever band it is in, and nothing of the
 * window's record changes.
 */

export const SEMANTIC_DEPTH_ID = 'reference.semantic-depth/1';

/** The representation for a distance from the camera, by the bands. */
export function representationAt(distance: number, bands: DepthBands): Representation {
  if (!Number.isFinite(distance) || distance < 0) {
    throw new RangeError(
      `a distance from the camera is finite and not negative (got ${String(distance)})`,
    );
  }
  return distance < bands.full ? 'full' : distance < bands.compact ? 'compact' : 'label';
}

/** How far a window's centre is from the eye of a view, in world units. */
export function distanceFrom(scene: SceneState, nodeId: Id, view: ViewGeometry): number {
  const world = worldMatrix(scene.nodes, nodeId);
  if (world === undefined) {
    throw new Error(`no node "${nodeId}" in the scene`);
  }
  const [x, y, z] = eyeOf(view);
  return Math.hypot(world[12] - x, world[13] - y, world[14] - z);
}

export interface SemanticDepthOptions {
  readonly bands: DepthBands;
  /**
   * The mode in which the focused window is presented in full whatever its distance: focus shows
   * one window readably, which a label would defeat.
   */
  readonly focusModeId: string;
}

/** Semantic depth as the viewport's representation policy. */
export function semanticDepth(options: SemanticDepthOptions): RepresentationPolicy {
  const { bands, focusModeId } = options;
  return Object.freeze({
    id: SEMANTIC_DEPTH_ID,
    representationOf({ scene, view, nodeId }: RepresentationContext): Representation {
      const focused =
        scene.focusedId === nodeId && scene.viewports.get(view.viewportId)?.mode === focusModeId;
      return focused ? 'full' : representationAt(distanceFrom(scene, nodeId, view), bands);
    },
  });
}
