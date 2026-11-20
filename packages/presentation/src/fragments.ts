import type { Id, JsonValue, SceneState } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type { Mat4 } from '@swf/math';

/** [x, y, width, height] in viewport CSS pixels. */
export type ScreenRect = readonly [number, number, number, number];
export type ScreenPoint = readonly [number, number];

/**
 * The view a viewport shows: its size, pixel density, camera placement and depth range, and its
 * projection with that projection's configuration.
 */
export interface ViewGeometry {
  readonly viewportId: Id;
  /** Width and height in CSS pixels, both positive. */
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
  /** The camera's local-to-world placement (rotation and position, no scale). */
  readonly camera: Mat4;
  /** Nearest distance shown, positive. */
  readonly near: number;
  /** Farthest distance shown, or null for no limit. */
  readonly far: number | null;
  /** The projection's versioned ID. */
  readonly projectionId: string;
  readonly projectionConfig: JsonValue;
}

/**
 * One visible piece of a surface in one viewport. A surface may show as several fragments (for
 * example on both sides of a panorama seam); all of them refer to the same Surface ID, which stays
 * the single target for focus, selection and undo.
 */
export interface ProjectedFragment {
  /** The presentation fragment ID, derived by {@link fragmentId}. */
  readonly id: string;
  readonly surfaceId: Id;
  readonly viewportId: Id;
  /** The fragment's number among its surface's fragments in this viewport, from 0. */
  readonly ordinal: number;
  readonly bounds: ScreenRect;
  /**
   * The projected corners of the whole surface on this fragment's branch (top-left, top-right,
   * bottom-right, bottom-left), possibly beyond the viewport, or null when the projection cannot
   * give them; `bounds` is the visible part.
   */
  readonly corners: readonly [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint] | null;
  /** Distance from the camera; larger is farther. */
  readonly depth: number;
  /** Whether the fragment's placement follows the projection exactly or approximates it. */
  readonly geometricFidelity: 'exact' | 'approximate';
  /**
   * The fragment that owns native interaction for its surface. At most one fragment per surface
   * and viewport owns it; the others are presentation proxies routing to the same surface.
   */
  readonly nativeOwner: boolean;
}

/**
 * A viewport's projected fragments for one scene revision, in presentation order (back to front),
 * with the mapping from each fragment to its one surface.
 */
export interface ViewOutput {
  readonly viewportId: Id;
  readonly sceneRevision: number;
  readonly fragments: readonly ProjectedFragment[];
  surfaceOf(fragmentId: string): Id | undefined;
  fragmentsOf(surfaceId: Id): readonly ProjectedFragment[];
}

/**
 * The presentation fragment ID of a surface's `ordinal`th fragment in a viewport. Each part is
 * encoded, so IDs containing separators can never collide.
 */
export function fragmentId(viewportId: Id, surfaceId: Id, ordinal: number): string {
  return `${encodeURIComponent(viewportId)}/${encodeURIComponent(surfaceId)}/${String(ordinal)}`;
}

/**
 * Validates fragments and orders them deterministically: back to front by depth, then by the
 * surface's owner presentation priority, then by scene order (the owner's place in the hierarchy
 * and the surface's slot), then by fragment ID. The result depends only on the scene revision and
 * the fragments themselves, never on the order they were supplied in. Throws {@link SwfFailure}
 * (`INVALID_INPUT`) naming the first problem.
 */
export function createViewOutput(
  scene: SceneState,
  viewportId: Id,
  fragments: readonly ProjectedFragment[],
): ViewOutput {
  const fail = (message: string, entityId?: Id): never => {
    throw new SwfFailure(
      makeError('INVALID_INPUT', `view output for viewport "${viewportId}": ${message}`, {
        workspaceId: scene.workspaceId,
        ...(entityId === undefined ? {} : { entityId }),
      }),
    );
  };
  const byId = new Map<string, ProjectedFragment>();
  const bySurface = new Map<Id, ProjectedFragment[]>();
  for (const fragment of fragments) {
    const issue = fragmentIssue(fragment, viewportId);
    if (issue !== null) {
      fail(issue, fragment.surfaceId);
    }
    if (!scene.surfaces.has(fragment.surfaceId)) {
      fail(
        `fragment "${fragment.id}" refers to unknown surface "${fragment.surfaceId}"`,
        fragment.surfaceId,
      );
    }
    if (byId.has(fragment.id)) {
      fail(`fragment "${fragment.id}" appears twice`, fragment.surfaceId);
    }
    byId.set(fragment.id, Object.freeze({ ...fragment }));
    const list = bySurface.get(fragment.surfaceId) ?? [];
    list.push(fragment);
    bySurface.set(fragment.surfaceId, list);
  }
  for (const [surfaceId, list] of bySurface) {
    const ordinals = list.map((f) => f.ordinal).sort((a, b) => a - b);
    if (ordinals.some((ordinal, i) => ordinal !== i)) {
      fail(
        `surface "${surfaceId}" has fragment ordinals ${ordinals.join(', ')}, not 0 to ${String(list.length - 1)}`,
        surfaceId,
      );
    }
    if (list.filter((f) => f.nativeOwner).length > 1) {
      fail(`surface "${surfaceId}" has more than one native-owner fragment`, surfaceId);
    }
  }
  const rank = sceneRanks(scene);
  const ordered = [...byId.values()].sort((a, b) => compareFragments(scene, rank, a, b));
  const frozen = Object.freeze(ordered);
  const grouped = new Map<Id, readonly ProjectedFragment[]>(
    [...bySurface.keys()].map((surfaceId) => [
      surfaceId,
      Object.freeze(frozen.filter((f) => f.surfaceId === surfaceId)),
    ]),
  );
  return Object.freeze({
    viewportId,
    sceneRevision: scene.revision,
    fragments: frozen,
    surfaceOf: (id: string) => byId.get(id)?.surfaceId,
    fragmentsOf: (surfaceId: Id) => grouped.get(surfaceId) ?? EMPTY,
  });
}

const EMPTY: readonly ProjectedFragment[] = Object.freeze([]);

function fragmentIssue(f: ProjectedFragment, viewportId: Id): string | null {
  if (f.viewportId !== viewportId) {
    return `fragment "${f.id}" belongs to viewport "${f.viewportId}"`;
  }
  if (!Number.isInteger(f.ordinal) || f.ordinal < 0) {
    return `fragment "${f.id}" has ordinal ${String(f.ordinal)}, not a non-negative integer`;
  }
  if (f.id !== fragmentId(f.viewportId, f.surfaceId, f.ordinal)) {
    return `fragment "${f.id}" is not the ID derived from its viewport, surface and ordinal`;
  }
  if (!f.bounds.every(Number.isFinite) || f.bounds[2] < 0 || f.bounds[3] < 0) {
    return `fragment "${f.id}" has invalid bounds`;
  }
  if (
    f.corners !== null &&
    !f.corners.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
  ) {
    return `fragment "${f.id}" has non-finite corners`;
  }
  if (!Number.isFinite(f.depth)) {
    return `fragment "${f.id}" has a non-finite depth`;
  }
  return null;
}

/** Each surface's place in scene order: owners in depth-first order, then slots within an owner. */
function sceneRanks(scene: SceneState): Map<Id, number> {
  const ranks = new Map<Id, number>();
  let next = 0;
  const visit = (nodeId: Id): void => {
    const node = scene.nodes.get(nodeId);
    if (node === undefined) {
      return;
    }
    for (const surfaceId of node.surfaceIds) {
      ranks.set(surfaceId, next++);
    }
    for (const child of node.childIds) {
      visit(child);
    }
  };
  for (const root of scene.rootIds) {
    visit(root);
  }
  return ranks;
}

function compareFragments(
  scene: SceneState,
  rank: ReadonlyMap<Id, number>,
  a: ProjectedFragment,
  b: ProjectedFragment,
): number {
  const priority = (f: ProjectedFragment) => {
    const surface = scene.surfaces.get(f.surfaceId);
    const owner = surface === undefined ? undefined : scene.nodes.get(surface.ownerNodeId);
    return (owner?.flags.presentationPriority ?? 0) + (surface?.flags.presentationPriority ?? 0);
  };
  return (
    b.depth - a.depth ||
    priority(a) - priority(b) ||
    (rank.get(a.surfaceId) ?? 0) - (rank.get(b.surfaceId) ?? 0) ||
    a.ordinal - b.ordinal ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** Why a view geometry is invalid, or null when it is valid. */
export function viewGeometryIssue(view: ViewGeometry): string | null {
  if (typeof view.viewportId !== 'string' || view.viewportId.trim() === '') {
    return 'viewportId must be a non-blank string';
  }
  if (!(
    view.width > 0 &&
    view.height > 0 &&
    Number.isFinite(view.width) &&
    Number.isFinite(view.height)
  )) {
    return 'width and height must be positive finite numbers';
  }
  if (!(view.devicePixelRatio > 0 && Number.isFinite(view.devicePixelRatio))) {
    return 'devicePixelRatio must be a positive finite number';
  }
  // Callers may be plain JavaScript, so the matrix's length is checked, not assumed.
  const camera: readonly unknown[] = view.camera;
  if (camera.length !== 16 || !camera.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return 'camera must be a finite 4x4 matrix';
  }
  if (!(view.near > 0 && Number.isFinite(view.near))) {
    return 'near must be a positive finite number';
  }
  if (view.far !== null && !(view.far > view.near && Number.isFinite(view.far))) {
    return 'far must be null or a finite number greater than near';
  }
  return null;
}
