import type { Id, JsonValue, SceneState } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type { Mat4 } from '@swf/math';
import { mat4FromTransform } from '@swf/math';
import type { Representation } from './representation.js';
import { REPRESENTATIONS } from './representation.js';

/**
 * [x, y, width, height] in viewport CSS pixels, from the top-left corner with y down; width and
 * height are never negative.
 */
export type ScreenRect = readonly [number, number, number, number];
/** [x, y] in viewport CSS pixels, from the top-left corner with y down. */
export type ScreenPoint = readonly [number, number];

/**
 * The view a viewport shows: its size, pixel density, camera placement and depth range, and its
 * projection with that projection's configuration.
 */
export interface ViewGeometry {
  /** The viewport shown; a non-blank string. */
  readonly viewportId: Id;
  /** Width in CSS pixels, positive and finite. */
  readonly width: number;
  /** Height in CSS pixels, positive and finite. */
  readonly height: number;
  /** Device pixels per CSS pixel, positive and finite. */
  readonly devicePixelRatio: number;
  /**
   * The camera's local-to-world placement (rotation and position, no scale), as 16 finite numbers.
   * The world is right-handed with +Y up, and the camera looks along its local -Z.
   */
  readonly camera: Mat4;
  /** Nearest distance shown, positive. */
  readonly near: number;
  /** Farthest distance shown, or null for no limit. */
  readonly far: number | null;
  /** The projection's versioned ID. */
  readonly projectionId: string;
  /** The projection's configuration, as the viewport's projection setting holds it. */
  readonly projectionConfig: JsonValue;
}

/**
 * A surface as one viewport shows it: on its window's card, a flat, upright rectangle drawn at the
 * window's projected centre, sized by the window's own size and its distance (the card rules,
 * `CARD_PIXELS_PER_UNIT`). A surface may show as several fragments (a card across a panorama
 * seam is drawn at both edges); all of them refer to the same Surface ID, which stays the single
 * target for focus, selection and undo.
 */
export interface ProjectedFragment {
  /** The presentation fragment ID, derived by {@link fragmentId}. */
  readonly id: string;
  /** The one surface the fragment shows; input aimed at any fragment goes to it. */
  readonly surfaceId: Id;
  /** The viewport the fragment is in. */
  readonly viewportId: Id;
  /** The fragment's number among its surface's fragments in this viewport, from 0. */
  readonly ordinal: number;
  /**
   * Where the surface is drawn on its window's card: finite and never negative in size, possibly
   * reaching past the viewport's edges, which clip it.
   */
  readonly bounds: ScreenRect;
  /** The window's whole card on this fragment's branch: what its frame and name stand by. */
  readonly card: ScreenRect;
  /**
   * The card's scale: CSS pixels drawn for each CSS pixel the surface measures at
   * `CARD_PIXELS_PER_UNIT`; finite and above zero.
   */
  readonly scale: number;
  /**
   * How the viewport's representation policy chose to show the surface: `full` unless one chose
   * less. A card's size follows it.
   */
  readonly representation: Representation;
  /** Distance from the camera; larger is farther. */
  readonly depth: number;
  /**
   * Whether the card shows the surface as the scene places it: `exact`, or `approximate` when its
   * window or the surface itself carries a rotation of its own, which a card (drawn upright,
   * facing the camera) does not show.
   */
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
  /** The viewport the fragments are in. */
  readonly viewportId: Id;
  /** The revision of the scene the fragments were validated against. */
  readonly sceneRevision: number;
  /** Every fragment, back to front; the array and each fragment are frozen. */
  readonly fragments: readonly ProjectedFragment[];
  /** The surface a fragment shows, by the fragment's ID; undefined for an ID not in the output. */
  surfaceOf(fragmentId: string): Id | undefined;
  /** A surface's fragments, back to front; frozen, and empty for a surface with none here. */
  fragmentsOf(surfaceId: Id): readonly ProjectedFragment[];
}

/**
 * The presentation fragment ID of a surface's `ordinal`th fragment in a viewport: the three parts
 * joined by `/`, each URI-encoded, so IDs containing separators can never collide. It checks
 * nothing; {@link createViewOutput} refuses a fragment whose ID is not the one derived here.
 */
export function fragmentId(viewportId: Id, surfaceId: Id, ordinal: number): string {
  return `${encodeURIComponent(viewportId)}/${encodeURIComponent(surfaceId)}/${String(ordinal)}`;
}

/**
 * Validates fragments and orders them deterministically: back to front by depth, then by the
 * presentation priority of the surface and its owner (lower first), then by scene order (the
 * owner's place in the hierarchy and the surface's slot), then by ordinal and fragment ID. The
 * result depends only on the scene revision and the fragments themselves, never on the order they
 * were supplied in. Throws {@link SwfFailure} (`INVALID_INPUT`) naming the first problem: a
 * fragment of another viewport or of a surface not in the scene, an ID not derived by
 * {@link fragmentId}, a repeated ID, ordinals of a surface not running 0, 1, 2…, more than one
 * native owner per surface, or bounds, corners or depth that are not finite. The output is
 * frozen and holds a frozen shallow copy of each fragment; the array given is not changed.
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
  if (!f.card.every(Number.isFinite) || f.card[2] < 0 || f.card[3] < 0) {
    return `fragment "${f.id}" has an invalid card`;
  }
  if (!(Number.isFinite(f.scale) && f.scale > 0)) {
    return `fragment "${f.id}" has scale ${String(f.scale)}, not a finite number above zero`;
  }
  if (!(REPRESENTATIONS as readonly unknown[]).includes(f.representation)) {
    return `fragment "${f.id}" has representation ${JSON.stringify(f.representation)}, not one of ${REPRESENTATIONS.join(', ')}`;
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

/**
 * Why a view geometry is invalid, or null when it is valid: the first problem, naming the field
 * (`viewportId`, `width`, `height`, `devicePixelRatio`, `camera`, `near` or `far`). It never
 * throws, and does not check the projection's ID or configuration.
 */
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

/**
 * The view a viewport shows in a scene: its size, its camera's placement and depth range, and its
 * projection setting. Throws {@link SwfFailure} (`UNKNOWN_ENTITY`) when the viewport, or its
 * camera, is not in the scene. The view is a new frozen value built from the scene's records; its
 * camera matrix has no scale.
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
