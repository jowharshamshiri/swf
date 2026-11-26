import { ancestorIds, effectiveState, nodeFrameGeometry, surfaceEffectiveState, worldMatrix, } from '@swf/core';
import { models } from '@swf/models';
/** Each hit region as the arbitration model names it. */
const HIT_REGIONS = Object.freeze({
    'resize-handle': 'resizeHandle',
    content: 'content',
    chrome: 'chrome',
});
/**
 * Picks at a viewport point: the projection's inverse gives the world ray, the index the entries
 * it may reach, and exact geometry the hits. Hits are kept only for entities that are visible,
 * take pointer input and lie within the camera's depth range, then ordered by presentation
 * priority, occlusion and depth. A surface split by a seam is one entity in the world, so it is
 * picked as one Surface ID wherever its fragments are. Where the projection has no inverse the
 * point is reported unpickable, never guessed.
 *
 * @param x Horizontal position in the viewport's CSS pixels, from its left edge.
 * @param y Vertical position in the viewport's CSS pixels, from its top edge.
 * @param continuity The previous longitude of a drag in progress, so a ray across a panorama's
 *   seam is unwrapped rather than jumping.
 * @throws Error when `context.index` was not brought up to date with `context.scene`.
 * @throws RangeError when `options.depthTolerance` is not finite and at least zero, or a hit's
 *   distance or presentation priority is not finite: the arbitration model orders only finite
 *   numbers.
 */
export function pick(context, x, y, continuity) {
    const { scene, view, projection, options } = context;
    if (context.index.state !== scene) {
        throw new Error('the scene index is not up to date with the scene being picked');
    }
    const result = projection.interactionRay(x, y, view, continuity);
    if (result.kind !== 'ray') {
        return result;
    }
    const info = {
        ray: result.ray,
        longitude: result.longitude,
        latitude: result.latitude,
        confidence: result.error === 0 ? 'exact' : 'approximate',
        error: result.error,
    };
    const far = view.far ?? Infinity;
    // The angle one CSS pixel spans across the viewport, for sizing handles in the world.
    const pixelAngle = projection.describeDomain().horizontalCoverage / view.width;
    const raw = [];
    for (const key of context.index.raycast(result.ray, far)) {
        const separator = key.indexOf(':');
        const id = key.slice(separator + 1);
        const hit = key.startsWith('surface:')
            ? surfaceHit(context, id, result.ray)
            : nodeHit(scene, id, result.ray, options.handlePx * pixelAngle);
        if (hit !== null && hit.distance >= view.near && hit.distance <= far) {
            raw.push(hit);
        }
    }
    // The arbitration model (`Swf.Arbitration`) merges the hits (a window's frame counts inside it
    // only where no surface of its own covers it, except along its resize band), marks the occluded
    // ones and orders them. It refuses a number it cannot order: a depth tolerance that is not finite
    // and at least zero, or a hit whose distance or priority is not finite.
    const outcome = models.pickOrder(raw.map((hit) => ({
        node: hit.nodeId,
        surface: hit.surfaceId,
        region: { kind: HIT_REGIONS[hit.region] },
        distance: hit.distance,
        priority: hit.priority,
        occluding: options.occlusion({ nodeId: hit.nodeId, surfaceId: hit.surfaceId }) === 'occluding',
    })), options.depthTolerance);
    if (outcome.kind === 'invalidTolerance') {
        throw new RangeError(`the depth tolerance is finite and at least zero (got ${String(options.depthTolerance)})`);
    }
    if (outcome.kind === 'invalidHit') {
        const hit = raw[Number(outcome.hit)];
        if (hit === undefined) {
            throw new Error(`the arbitration model refused hit ${String(outcome.hit)}, which is not given`);
        }
        const value = outcome.field === 'distance' ? hit.distance : hit.priority;
        const on = hit.surfaceId === null ? `node "${hit.nodeId}"` : `surface "${hit.surfaceId}"`;
        throw new RangeError(`the ${outcome.field} of the hit on ${on} is not finite (got ${String(value)})`);
    }
    const decided = outcome.pick;
    const candidates = decided.order.map((index, k) => {
        const hit = raw[Number(index)];
        const occluded = decided.occluded[k];
        if (hit === undefined || occluded === undefined) {
            throw new Error(`the arbitration model ordered hit ${String(index)}, which is not given`);
        }
        return { ...hit, occluded };
    });
    const target = candidates[0];
    if (target === undefined) {
        return {
            ...info,
            kind: 'background',
            region: options.modal === null ? 'background' : 'modal-overlay',
        };
    }
    const ambiguous = decided.ambiguous;
    const excluded = options.modal !== null && !options.modal.has(target.nodeId);
    return {
        ...info,
        kind: 'hit',
        target,
        region: excluded ? 'modal-overlay' : target.region,
        candidates,
        ambiguous,
        actions: target.proxy ? ['focus', 'activate'] : [],
    };
}
/** A hit on a surface that takes pointer input, or null. */
function surfaceHit(ctx, surfaceId, ray) {
    const surface = ctx.scene.surfaces.get(surfaceId);
    const state = surfaceEffectiveState(ctx.scene, surfaceId);
    if (surface === undefined ||
        state?.visible !== true ||
        !surface.flags.pointerEnabled ||
        !takesPointer(ctx.scene, surface.ownerNodeId)) {
        return null;
    }
    const g = ctx.geometry(surfaceId);
    const hit = g?.intersect(ray) ?? null;
    if (hit === null) {
        return null;
    }
    const owner = ctx.scene.nodes.get(surface.ownerNodeId);
    const proxy = ctx.options.presentation(surfaceId, ctx.view.viewportId) === 'proxy';
    return {
        nodeId: surface.ownerNodeId,
        surfaceId,
        region: surface.interaction === 'content' ? 'content' : 'chrome',
        edge: null,
        distance: hit.distance,
        worldPoint: hit.point,
        localPoint: hit.localPoint,
        uv: hit.uv,
        priority: (owner?.flags.presentationPriority ?? 0) + surface.flags.presentationPriority,
        proxy,
    };
}
/** The node and all its ancestors are active, visible and take pointer input. */
function takesPointer(scene, nodeId) {
    if (effectiveState(scene.nodes, nodeId)?.visible !== true) {
        return false;
    }
    return [nodeId, ...ancestorIds(scene.nodes, nodeId)].every((id) => scene.nodes.get(id)?.flags.pointerEnabled === true);
}
/**
 * A hit on a node's frame: its bounds rectangle in its local z = 0 plane, with a resize band of
 * `bandAngle` radians (as seen from the ray origin) along its edges.
 */
function nodeHit(scene, nodeId, ray, bandAngle) {
    const node = scene.nodes.get(nodeId);
    const world = worldMatrix(scene.nodes, nodeId);
    if (node === undefined || world === undefined || !takesPointer(scene, nodeId)) {
        return null;
    }
    // The frame is the same rectangle window chrome is drawn from.
    const hit = nodeFrameGeometry(scene, nodeId)?.intersect(ray) ?? null;
    if (hit === null) {
        return null;
    }
    const [w, h] = node.bounds;
    const local = hit.localPoint;
    const worldPoint = hit.point;
    const distance = hit.distance;
    const edge = edgeAt(local, w, h, distance * bandAngle, world);
    return {
        nodeId,
        surfaceId: null,
        region: edge === null || !node.flags.resizable ? 'chrome' : 'resize-handle',
        edge: node.flags.resizable ? edge : null,
        distance,
        worldPoint,
        localPoint: local,
        uv: null,
        priority: node.flags.presentationPriority,
        proxy: false,
    };
}
/** The edge or corner whose band contains the local point, or null for the interior. */
function edgeAt(local, w, h, band, world) {
    // The band is a world width; in local units it shrinks with the node's scale, and it never
    // takes more than a quarter of the window, so small windows keep their middle.
    const scaleX = Math.hypot(world[0], world[1], world[2]);
    const scaleY = Math.hypot(world[4], world[5], world[6]);
    const bx = Math.min(band / scaleX, w / 4);
    const by = Math.min(band / scaleY, h / 4);
    const vertical = local[1] >= h / 2 - by ? 'n' : local[1] <= -h / 2 + by ? 's' : '';
    const horizontal = local[0] >= w / 2 - bx ? 'e' : local[0] <= -w / 2 + bx ? 'w' : '';
    const edge = `${vertical}${horizontal}`;
    return edge === '' ? null : edge;
}
//# sourceMappingURL=pick.js.map