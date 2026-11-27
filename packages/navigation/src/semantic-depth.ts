import type { Id, SceneState } from '@swf/core';
import { worldMatrix } from '@swf/core';
import { eyeOf } from '@swf/interaction';
import type { Mat4, Vec3 } from '@swf/math';
import type * as Lean from '@swf/models';
import { models } from '@swf/models';
import type {
  Representation,
  RepresentationContext,
  RepresentationPolicy,
  ViewGeometry,
} from '@swf/presentation';
import { cardScale } from '@swf/presentation';
import type { DepthBands } from './features.js';
import type { FocusOptions } from './focus.js';
import { focusFrame } from './focus.js';

/**
 * Semantic depth: each window is represented by how far it is from the camera, in bands. Nearer
 * than the full band it shows its content; within the compact band, a compact preview stands for
 * it; beyond, its label alone. The representation is the viewport's choice of presentation: the
 * window's content stays bound, attached and running whatever band it is in, and nothing of the
 * window's record changes. The bands are decided by the Lean model `Swf.AppDepth`
 * (models/Swf/AppDepth.lean), where it is proved that farther never shows more; this module
 * measures the distances and asks it once per frame for every window.
 */

export const SEMANTIC_DEPTH_ID = 'swf.navigation.semantic-depth/1';

/** The representation for a distance from the camera along the floor, by the bands. */
export function representationAt(distance: number, bands: DepthBands): Representation {
  const [representation] = answer(bands, [distance], null);
  if (representation === undefined) {
    throw new Error('semantic depth answered no representation for one distance');
  }
  return representation;
}

/** How far a window's centre is from the eye of a view along the floor, in world units. */
export function distanceFrom(scene: SceneState, nodeId: Id, view: ViewGeometry): number {
  const world = worldMatrix(scene.nodes, nodeId);
  if (world === undefined) {
    throw new Error(`no node "${nodeId}" in the scene`);
  }
  return distanceOf(world, eyeOf(view));
}

/** How semantic depth draws: the bands it chooses a window's representation by. */
export interface SemanticDepthOptions {
  /** The distances that bound each representation. */
  readonly bands: DepthBands;
  /**
   * The mode in which the focused window is presented in full whatever its distance: focus shows
   * one window readably, which a label would defeat.
   */
  readonly focusModeId: string;
  /** How focus shows its window: the card of the focused window, in focus, is scaled to it. */
  readonly focus: FocusOptions;
}

/** The window a view in focus shows, or null when the view is not in focus. */
function focusedIn(scene: SceneState, view: ViewGeometry, focusModeId: string): Id | null {
  return scene.viewports.get(view.viewportId)?.mode === focusModeId ? scene.focusedId : null;
}

/** The scale focus gives the card of the window it shows, as `focusFrame` frames it. */
function focusScale(scene: SceneState, view: ViewGeometry, nodeId: Id, focus: FocusOptions) {
  return focusFrame(scene, nodeId, eyeOf(view), view, focus).scale;
}

/**
 * Focus's representation policy for a view that shows every window in full (semantic depth off):
 * every surface is shown in full, the focused window's card, in focus, scaled to read, and every
 * other card by the card rules' geometric scale (by its distance and the view's field of view).
 */
export function focusCards(options: {
  readonly focusModeId: string;
  readonly focus: FocusOptions;
}): RepresentationPolicy {
  return Object.freeze({
    id: FOCUS_CARDS_ID,
    representationOf: (): Representation => 'full',
    scaleOf({ scene, view, nodeId }: RepresentationContext): number {
      if (focusedIn(scene, view, options.focusModeId) === nodeId) {
        return focusScale(scene, view, nodeId, options.focus);
      }
      const world = worldMatrix(scene.nodes, nodeId);
      const config = view.projectionConfig as Readonly<Record<string, unknown>> | null;
      const horizontal = config?.['horizontal'];
      if (world === undefined || typeof horizontal !== 'number') {
        throw new Error(`window "${nodeId}" has no card to scale in viewport "${view.viewportId}"`);
      }
      return cardScale('full', distanceOf(world, eyeOf(view)), horizontal, false);
    },
  });
}

/** The ID of {@link focusCards}. */
export const FOCUS_CARDS_ID = 'swf.navigation.focus-cards/1';

/**
 * Semantic depth as the viewport's representation policy. A frame consults it for every fragment
 * with the same scene and view: the first consultation measures every node of the scene and asks
 * the model once for all their bands, and the rest of the frame reads that answer, kept for as
 * long as that scene and view are.
 */
export function semanticDepth(options: SemanticDepthOptions): RepresentationPolicy {
  const { bands, focusModeId, focus } = options;
  const frames = new WeakMap<SceneState, WeakMap<ViewGeometry, ReadonlyMap<Id, Representation>>>();
  const frameOf = (scene: SceneState, view: ViewGeometry): ReadonlyMap<Id, Representation> => {
    let byView = frames.get(scene);
    if (byView === undefined) {
      byView = new WeakMap();
      frames.set(scene, byView);
    }
    let frame = byView.get(view);
    if (frame === undefined) {
      frame = representationsOf(scene, view, bands, focusModeId);
      byView.set(view, frame);
    }
    return frame;
  };
  return Object.freeze({
    id: SEMANTIC_DEPTH_ID,
    representationOf({ scene, view, nodeId }: RepresentationContext): Representation {
      const representation = frameOf(scene, view).get(nodeId);
      if (representation === undefined) {
        throw new Error(`no node "${nodeId}" in the scene`);
      }
      return representation;
    },
    scaleOf({ scene, view, nodeId }: RepresentationContext, natural: number): number {
      return focusedIn(scene, view, focusModeId) === nodeId
        ? focusScale(scene, view, nodeId, focus)
        : natural;
    },
  });
}

/** Every placed node of a scene, by ID, as a view represents it. */
function representationsOf(
  scene: SceneState,
  view: ViewGeometry,
  bands: DepthBands,
  focusModeId: string,
): ReadonlyMap<Id, Representation> {
  const eye = eyeOf(view);
  const ids: Id[] = [];
  const distances: number[] = [];
  for (const id of scene.nodes.ids()) {
    const world = worldMatrix(scene.nodes, id);
    if (world !== undefined) {
      ids.push(id);
      distances.push(distanceOf(world, eye));
    }
  }
  const focusing = scene.viewports.get(view.viewportId)?.mode === focusModeId;
  const focused = focusing && scene.focusedId !== null ? ids.indexOf(scene.focusedId) : -1;
  const representations = answer(bands, distances, focused === -1 ? null : BigInt(focused));
  return new Map(
    ids.map((id, i) => {
      const representation = representations[i];
      if (representation === undefined) {
        throw new Error(`semantic depth answered no representation for node "${id}"`);
      }
      return [id, representation];
    }),
  );
}

/** The model's representations for distances, by the bands; the focused one's place, if any. */
function answer(
  bands: DepthBands,
  distances: readonly number[],
  focused: bigint | null,
): readonly Representation[] {
  const query: Lean.DepthQuery = { bands, distances: [...distances], focused };
  const answered = models.depthBands(query);
  switch (answered.kind) {
    case 'invalidBands':
      throw new RangeError(
        `semantic depth's bands end at numbers (got full ${String(bands.full)}, compact ${String(bands.compact)})`,
      );
    case 'invalidDistance':
      throw new RangeError(
        `a distance from the camera is finite and not negative (got ${String(distances[Number(answered.index)])})`,
      );
    case 'bands':
      return answered.representations.map((band) => band.kind);
  }
}

/** How far a window's centre stands from the eye along the room's floor, whatever its height. */
function distanceOf(world: Mat4, [x, , z]: Vec3): number {
  return Math.hypot(world[12] - x, world[14] - z);
}
