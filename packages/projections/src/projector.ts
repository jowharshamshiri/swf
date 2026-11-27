import type { Id, ResolvedGeometry, SceneState } from '@swf/core';
import { effectiveState, makeError, SwfFailure, worldMatrix } from '@swf/core';
import type { Mat4, Quat } from '@swf/math';
import type {
  ProjectedFragment,
  Representation,
  RepresentationPolicy,
  ScreenRect,
  ViewGeometry,
  ViewProjector,
} from '@swf/presentation';
import {
  cardScale,
  cardScaleFor,
  fragmentId,
  representationFor,
  viewGeometryIssue,
  windowCard,
} from '@swf/presentation';
import type { Projection, ProjectionModule } from './contract.js';

/**
 * Looks up a surface's geometry as placed in the scene being projected (a workspace's
 * `presentedGeometry`, say); undefined when there is none. It is only read, never retained past
 * the call it is given to.
 */
export type GeometryOf = (surfaceId: Id) => ResolvedGeometry | undefined;

/**
 * The configured projection a view uses, from the module the view names. Throws
 * {@link SwfFailure} (`INVALID_INPUT`, naming the viewport) when the view is malformed, names
 * another projection, or carries a configuration the module rejects. The projection is created
 * afresh on each call and holds no resources.
 */
export function projectionFor(module: ProjectionModule, view: ViewGeometry): Projection {
  const fail = (message: string): never => {
    throw new SwfFailure(
      makeError('INVALID_INPUT', `viewport "${view.viewportId}": ${message}`, {
        entityId: view.viewportId,
      }),
    );
  };
  const issue = viewGeometryIssue(view);
  if (issue !== null) {
    fail(issue);
  }
  if (view.projectionId !== module.id) {
    fail(`it uses projection "${view.projectionId}", not "${module.id}"`);
  }
  const configIssue = module.configIssue(view.projectionConfig);
  if (configIssue !== null) {
    fail(`projection "${module.id}" configuration ${configIssue}`);
  }
  return module.create(view.projectionConfig);
}

/** How far a rotation may be from none and still count as none. */
const UPRIGHT = 1e-9;

/** Whether a rotation turns nothing. */
function upright(q: Quat): boolean {
  return Math.abs(q[0]) <= UPRIGHT && Math.abs(q[1]) <= UPRIGHT && Math.abs(q[2]) <= UPRIGHT;
}

/** The length of a world matrix's column `i` (0 across, 1 up): the world scale along that axis. */
function axisScale(m: Mat4, i: 0 | 1): number {
  const o = 4 * i;
  return Math.hypot(m[o] ?? 0, m[o + 1] ?? 0, m[o + 2] ?? 0);
}

/**
 * Stage 4 for a projection module: every shown surface on its window's card. A window's card is a
 * flat, upright rectangle centred where the projection places the window's centre, its own size at
 * `CARD_PIXELS_PER_UNIT` times the card's scale (`cardScale`, by its representation and its
 * distance along the floor); its surfaces lie on it where they lie on the window, across and up.
 * Short of the full circle, a card whose centre is past the view's edge still shows the part of it
 * inside; at the full circle, a card across the seam is drawn at both edges, its widest part the
 * native owner. A card drawn upright and facing the camera shows no rotation, and draws a surface
 * as its rectangle: a window or surface carrying a rotation of its own, or a surface of another
 * shape than `rect`, is placed `approximate`, so a host is told. A surface the scene
 * shows but that has no resolved geometry is an inconsistency, reported as {@link SwfFailure}
 * (`INVALID_INPUT`); so is a view {@link projectionFor} refuses. The projector returned is frozen
 * and stateless, with the module's profile.
 */
export function projectorOf(module: ProjectionModule): ViewProjector {
  return Object.freeze({
    profile: module.profile,
    project(
      scene: SceneState,
      view: ViewGeometry,
      geometry: GeometryOf,
      representation: RepresentationPolicy | null,
    ): ProjectedFragment[] {
      const projection = projectionFor(module, view);
      const domain = projection.describeDomain();
      const fieldOfView = (domain.horizontalCoverage * 180) / Math.PI;
      const eye = [view.camera[12], view.camera[13], view.camera[14]] as const;
      const fragments: ProjectedFragment[] = [];
      for (const surfaceId of shownSurfaces(scene)) {
        const surface = scene.surfaces.get(surfaceId);
        const node = surface === undefined ? undefined : scene.nodes.get(surface.ownerNodeId);
        const world =
          surface === undefined ? undefined : worldMatrix(scene.nodes, surface.ownerNodeId);
        if (surface === undefined || node === undefined || world === undefined) {
          continue;
        }
        const placed = resolved(scene, geometry, surfaceId);
        const direction = [world[12] - eye[0], world[13] - eye[1], world[14] - eye[2]] as const;
        const depth = Math.hypot(...direction);
        if (!(depth > 0) || depth < view.near || (view.far !== null && depth > view.far)) {
          continue;
        }
        const context = { scene, view, surfaceId, nodeId: node.id };
        const shown: Representation =
          representation === null ? 'full' : representationFor(representation, context);
        const floor = Math.hypot(direction[0], direction[2]);
        const semantic = representation !== null;
        const natural = cardScale(shown, floor, fieldOfView, semantic);
        const card = windowCard({
          bounds: [node.bounds[0], node.bounds[1]],
          worldScale: [axisScale(world, 0), axisScale(world, 1)],
          floor,
          representation: shown,
          fieldOfView,
          semantic,
          scale: representation === null ? natural : cardScaleFor(representation, context, natural),
        });
        const { scale } = card;
        const [cx, cy] = projection.placeDirection(direction, view);
        // The window's own units to the card's pixels, across and up.
        const [toX, toY] = card.perUnit;
        const cardWidth = card.width;
        const cardHeight = card.height;
        const [sx, sy] = surface.transform.position;
        const surfaceWidth = surface.bounds[0] * surface.transform.scale[0] * toX;
        const surfaceHeight = surface.bounds[1] * surface.transform.scale[1] * toY;
        const fidelity =
          upright(node.transform.rotation) &&
          upright(surface.transform.rotation) &&
          placed.kind === 'rect' &&
          placed.fidelity === 'exact'
            ? 'exact'
            : 'approximate';
        // Each place the card is drawn at: its own, and across the seam at the full circle.
        const centres = domain.seamWrapping ? [cx, cx - view.width, cx + view.width] : [cx];
        const copies = centres
          .map((x) => {
            const card: ScreenRect = [
              x - cardWidth / 2,
              cy - cardHeight / 2,
              cardWidth,
              cardHeight,
            ];
            const bounds: ScreenRect = [
              x + sx * toX - surfaceWidth / 2,
              cy - sy * toY - surfaceHeight / 2,
              surfaceWidth,
              surfaceHeight,
            ];
            return { card, bounds, shown: visibleArea(bounds, view) };
          })
          .filter((c) => c.shown > 0)
          // The widest part first: it is the native owner.
          .sort((a, b) => b.shown - a.shown);
        copies.forEach((c, ordinal) => {
          fragments.push({
            id: fragmentId(view.viewportId, surfaceId, ordinal),
            surfaceId,
            viewportId: view.viewportId,
            ordinal,
            bounds: c.bounds,
            card: c.card,
            scale,
            representation: shown,
            depth,
            geometricFidelity: fidelity,
            nativeOwner: ordinal === 0,
          });
        });
      }
      return fragments;
    },
  });
}

/** The area of a rect inside the view. */
function visibleArea(rect: ScreenRect, view: ViewGeometry): number {
  const w = Math.min(view.width, rect[0] + rect[2]) - Math.max(0, rect[0]);
  const h = Math.min(view.height, rect[1] + rect[3]) - Math.max(0, rect[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

/** The surfaces whose owner is effectively visible and that are themselves so. */
function* shownSurfaces(scene: SceneState): Generator<Id> {
  for (const surface of scene.surfaces.values()) {
    const owner = effectiveState(scene.nodes, surface.ownerNodeId);
    if (owner?.visible === true && surface.flags.visible) {
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
