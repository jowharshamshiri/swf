import { effectiveState, makeError, SwfFailure } from '@swf/core';
import { viewGeometryIssue } from '@swf/presentation';
/**
 * The configured projection a view uses, from the module the view names. Throws
 * {@link SwfFailure} (`INVALID_INPUT`, naming the viewport) when the view is malformed, names
 * another projection, or carries a configuration the module rejects. The projection is created
 * afresh on each call and holds no resources.
 */
export function projectionFor(module, view) {
    const fail = (message) => {
        throw new SwfFailure(makeError('INVALID_INPUT', `view of viewport "${view.viewportId}": ${message}`, {
            entityId: view.viewportId,
        }));
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
 * geometry is an inconsistency, reported as {@link SwfFailure} (`INVALID_INPUT`); so is a view
 * {@link projectionFor} refuses. Given a previous projection, the fragments of each surface whose
 * own record and every ancestor's are unchanged are kept as they were. The projector returned is
 * frozen and stateless, with the module's profile.
 */
export function projectorOf(module) {
    return Object.freeze({
        profile: module.profile,
        project(scene, view, geometry, previous) {
            const projection = projectionFor(module, view);
            const kept = previous === undefined ? null : keptFragments(previous);
            const fragments = [];
            for (const surfaceId of shownSurfaces(scene, 'visible')) {
                const same = kept !== null && previous !== undefined && samePlacement(scene, previous.scene, surfaceId)
                    ? kept.get(surfaceId)
                    : undefined;
                fragments.push(...(same ?? projection.projectGeometry(resolved(scene, geometry, surfaceId), view)));
            }
            return fragments;
        },
    });
}
/**
 * The fragments of each surface the previous projection showed, by surface: a surface it showed
 * with none (wholly out of view) has an empty list, so it is known and kept too.
 */
function keptFragments(previous) {
    const kept = new Map();
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
function samePlacement(scene, before, surfaceId) {
    const surface = scene.surfaces.get(surfaceId);
    if (surface === undefined || before.surfaces.get(surfaceId) !== surface) {
        return false;
    }
    for (let id = surface.ownerNodeId; id !== null;) {
        const node = scene.nodes.get(id);
        if (node === undefined || before.nodes.get(id) !== node) {
            return false;
        }
        id = node.parentId;
    }
    return true;
}
/**
 * The selectable surfaces under a viewport point, as ordered candidates along the projection's
 * interaction ray. Where the projection has no inverse the point is reported unpickable rather than
 * guessed; with `continuity`, the longitude is unwrapped to stay continuous during a drag. A
 * surface counts when it and its owner are effectively selectable, and its hit lies within the
 * view's `near` and `far` distances.
 *
 * @param projection - The projection configured for `view`, from {@link projectionFor}.
 * @param scene - The scene whose surfaces are picked (a workspace's presented scene, so open
 *   previews count).
 * @param x - Viewport CSS pixels from the left edge.
 * @param y - Viewport CSS pixels from the top edge.
 * @param geometry - Each surface's geometry as placed in `scene`.
 * @throws An {@link SwfFailure} (`INVALID_INPUT`) when a selectable surface has no geometry.
 * @example
 * ```ts
 * const view = viewGeometryOf(workspace.getPresented(), 'main');
 * const pick = pickAt(projectionFor(equirectangular, view), workspace.getPresented(), view,
 *   event.offsetX, event.offsetY, (id) => workspace.presentedGeometry(id));
 * const target = pick.kind === 'hits' ? pick.candidates[0]?.surfaceId : undefined;
 * ```
 */
export function pickAt(projection, scene, view, x, y, geometry, continuity) {
    const result = projection.interactionRay(x, y, view, continuity);
    if (result.kind !== 'ray') {
        return result;
    }
    const candidates = [];
    for (const surfaceId of shownSurfaces(scene, 'selectable')) {
        const hit = resolved(scene, geometry, surfaceId).intersect(result.ray);
        if (hit !== null &&
            (view.far === null || hit.distance <= view.far) &&
            hit.distance >= view.near) {
            candidates.push({ surfaceId, distance: hit.distance, point: hit.point, uv: hit.uv });
        }
    }
    candidates.sort((a, b) => a.distance - b.distance ||
        (a.surfaceId < b.surfaceId ? -1 : a.surfaceId > b.surfaceId ? 1 : 0));
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
function* shownSurfaces(scene, need) {
    for (const surface of scene.surfaces.values()) {
        const owner = effectiveState(scene.nodes, surface.ownerNodeId);
        if (owner?.[need] === true && surface.flags[need]) {
            yield surface.id;
        }
    }
}
function resolved(scene, geometry, surfaceId) {
    const g = geometry(surfaceId);
    if (g === undefined) {
        throw new SwfFailure(makeError('INVALID_INPUT', `surface "${surfaceId}" has no resolved geometry`, {
            workspaceId: scene.workspaceId,
            entityId: surfaceId,
        }));
    }
    return g;
}
//# sourceMappingURL=projector.js.map