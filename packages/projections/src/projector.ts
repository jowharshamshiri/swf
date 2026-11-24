import type { Id, ResolvedGeometry, SceneState } from '@swf/core';
import { effectiveState, makeError, SwfFailure } from '@swf/core';
import type { Ray, Vec3 } from '@swf/math';
import type {
  PreviousProjection,
  ProjectedFragment,
  ViewGeometry,
  ViewProjector,
} from '@swf/presentation';
import { viewGeometryIssue } from '@swf/presentation';
import type { Continuity, Projection, ProjectionModule } from './contract.js';

type GeometryOf = (surfaceId: Id) => ResolvedGeometry | undefined;

/**
 * The configured projection a view uses, from the module the view names. Throws
 * {@link SwfFailure} (`INVALID_INPUT`) when the view is malformed, names another projection, or
 * carries a configuration the module rejects.
 */
export function projectionFor(module: ProjectionModule, view: ViewGeometry): Projection {
  const fail = (message: string): never => {
    throw new SwfFailure(
      makeError('INVALID_INPUT', `view of viewport "${view.viewportId}": ${message}`, {
        entityId: view.viewportId,
      }),
    );
  };
  const issue = viewGeometryIssue(view);
  if (issue !== null) {
    fail(issue);
  }
  if (view.projectionId !== module.id) {
    fail(`uses projection "${view.projectionId}", not "${module.id}"`);
  }
  const configIssue = module.configIssue(view.projectionConfig);
  if (configIssue !== null) {
    fail(`projection configuration ${configIssue}`);
  }
  return module.create(view.projectionConfig);
}

/**
 * Stage 4 for a projection module: the fragments of every visible surface of the scene, as the
 * view's configured projection places them. A surface the scene shows but that has no resolved
 * geometry is an inconsistency, reported as {@link SwfFailure} (`INVALID_INPUT`).
 */
export function projectorOf(module: ProjectionModule): ViewProjector {
  return Object.freeze({
    profile: module.profile,
    project(
      scene: SceneState,
      view: ViewGeometry,
      geometry: GeometryOf,
      previous?: PreviousProjection,
    ): ProjectedFragment[] {
      const projection = projectionFor(module, view);
      const kept = previous === undefined ? null : keptFragments(previous);
      const fragments: ProjectedFragment[] = [];
      for (const surfaceId of shownSurfaces(scene, 'visible')) {
        const same =
          kept !== null && previous !== undefined && samePlacement(scene, previous.scene, surfaceId)
            ? kept.get(surfaceId)
            : undefined;
        fragments.push(
          ...(same ?? projection.projectGeometry(resolved(scene, geometry, surfaceId), view)),
        );
      }
      return fragments;
    },
  });
}

/**
 * The fragments of each surface the previous projection showed, by surface: a surface it showed
 * with none (wholly out of view) has an empty list, so it is known and kept too.
 */
function keptFragments(previous: PreviousProjection): Map<Id, ProjectedFragment[]> {
  const kept = new Map<Id, ProjectedFragment[]>();
  for (const surfaceId of shownSurfaces(previous.scene, 'visible')) {
    kept.set(surfaceId, []);
  }
  for (const fragment of previous.fragments) {
    kept.get(fragment.surfaceId)?.push(fragment);
  }
  return kept;
}

/**
 * Whether a surface stands exactly where it stood: its record and those of its owner and every
 * ancestor are the same objects (records are immutable, so the same object means unchanged), and
 * its placement and visibility depend on nothing else.
 */
function samePlacement(scene: SceneState, before: SceneState, surfaceId: Id): boolean {
  const surface = scene.surfaces.get(surfaceId);
  if (surface === undefined || before.surfaces.get(surfaceId) !== surface) {
    return false;
  }
  for (let id: Id | null = surface.ownerNodeId; id !== null;) {
    const node = scene.nodes.get(id);
    if (node === undefined || before.nodes.get(id) !== node) {
      return false;
    }
    id = node.parentId;
  }
  return true;
}

/** A surface a pointer ray hits. */
export interface PickCandidate {
  readonly surfaceId: Id;
  /** Distance from the camera along the ray. */
  readonly distance: number;
  readonly point: Vec3;
  readonly uv: readonly [number, number];
}

/** What lies under a viewport point. */
export type Pick =
  | {
      readonly kind: 'hits';
      readonly ray: Ray;
      /** Bound on the ray's angular error, in radians. */
      readonly error: number;
      readonly longitude: number;
      readonly latitude: number;
      /** Every selectable surface the ray hits, nearest first (then by Surface ID). */
      readonly candidates: readonly PickCandidate[];
    }
  | { readonly kind: 'outside'; readonly reason: string }
  | { readonly kind: 'unpickable'; readonly reason: string };

/**
 * The selectable surfaces under a viewport point, as ordered candidates along the projection's
 * interaction ray. Where the projection has no inverse the point is reported unpickable rather than
 * guessed; with `continuity`, the longitude is unwrapped to stay continuous during a drag.
 */
export function pickAt(
  projection: Projection,
  scene: SceneState,
  view: ViewGeometry,
  x: number,
  y: number,
  geometry: GeometryOf,
  continuity?: Continuity,
): Pick {
  const result = projection.interactionRay(x, y, view, continuity);
  if (result.kind !== 'ray') {
    return result;
  }
  const candidates: PickCandidate[] = [];
  for (const surfaceId of shownSurfaces(scene, 'selectable')) {
    const hit = resolved(scene, geometry, surfaceId).intersect(result.ray);
    if (
      hit !== null &&
      (view.far === null || hit.distance <= view.far) &&
      hit.distance >= view.near
    ) {
      candidates.push({ surfaceId, distance: hit.distance, point: hit.point, uv: hit.uv });
    }
  }
  candidates.sort(
    (a, b) =>
      a.distance - b.distance ||
      (a.surfaceId < b.surfaceId ? -1 : a.surfaceId > b.surfaceId ? 1 : 0),
  );
  return {
    kind: 'hits',
    ray: result.ray,
    error: result.error,
    longitude: result.longitude,
    latitude: result.latitude,
    candidates,
  };
}

/** The surfaces whose owner is effectively visible (or selectable) and that are themselves so. */
function* shownSurfaces(scene: SceneState, need: 'visible' | 'selectable'): Generator<Id> {
  for (const surface of scene.surfaces.values()) {
    const owner = effectiveState(scene.nodes, surface.ownerNodeId);
    if (owner?.[need] === true && surface.flags[need]) {
      yield surface.id;
    }
  }
}

function resolved(scene: SceneState, geometry: GeometryOf, surfaceId: Id): ResolvedGeometry {
  const g = geometry(surfaceId);
  if (g === undefined) {
    throw new SwfFailure(
      makeError('INVALID_INPUT', `surface "${surfaceId}" has no resolved geometry`, {
        workspaceId: scene.workspaceId,
        entityId: surfaceId,
      }),
    );
  }
  return g;
}
