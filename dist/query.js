import { aabbIntersects, aabbOfBox, IDENTITY_MAT4, mat4Decompose, mat4FromTransform, mat4Multiply, rayIntersectAabb, } from '@swf/math';
import { GeometryRegistry, RECT_GEOMETRY, resolveGeometry } from './geometry.js';
import { makeError, RejectionSignal, SwfFailure } from './errors.js';
import { checkMetadataKey } from './json.js';
import { Table } from './table.js';
/**
 * The surface's local-to-world matrix: its owner's world matrix times its own transform.
 * Undefined for an unknown surface.
 */
export function surfaceWorldMatrix(state, surfaceId) {
    const surface = state.surfaces.get(surfaceId);
    const owner = surface === undefined ? undefined : worldMatrix(state.nodes, surface.ownerNodeId);
    return surface === undefined || owner === undefined
        ? undefined
        : mat4Multiply(owner, mat4FromTransform(surface.transform));
}
/**
 * A surface's status and flags after inheriting from its owner node: it is active and visible
 * only when its owner is, and selectable only when it and its owner are.
 */
export function surfaceEffectiveState(state, surfaceId) {
    const surface = state.surfaces.get(surfaceId);
    const owner = surface === undefined ? undefined : effectiveState(state.nodes, surface.ownerNodeId);
    if (surface === undefined || owner === undefined) {
        return undefined;
    }
    const visible = owner.visible && surface.flags.visible;
    return {
        active: owner.active,
        visible,
        selectable: visible && owner.selectable && surface.flags.selectable,
    };
}
/**
 * The surface's presentation geometry placed in the world, as rendering and picking must both use
 * it, with its fidelity. Undefined for an unknown surface.
 */
export function surfaceGeometry(state, surfaceId, registry) {
    const surface = state.surfaces.get(surfaceId);
    const world = surfaceWorldMatrix(state, surfaceId);
    return surface === undefined || world === undefined
        ? undefined
        : resolveGeometry(surfaceId, surface.geometry, surface.bounds, world, registry);
}
/** Resolves only the built-in rectangle: a node frame is always a rectangle. */
const FRAME_REGISTRY = new GeometryRegistry();
/**
 * A node's frame placed in the world: its bounds rectangle in its local z = 0 plane, as picking
 * of window frames and rendering of window chrome both use it. The result's `surfaceId` field
 * holds the node's ID. Undefined for an unknown node.
 */
export function nodeFrameGeometry(state, nodeId) {
    const node = state.nodes.get(nodeId);
    const world = worldMatrix(state.nodes, nodeId);
    return node === undefined || world === undefined
        ? undefined
        : resolveGeometry(nodeId, RECT_GEOMETRY, node.bounds, world, FRAME_REGISTRY);
}
const worldCache = new WeakMap();
/**
 * The node's local-to-world matrix: the product of its ancestors' transforms and its own. Results
 * on committed (immutable) tables are cached, so the matrix returned may be shared and must not be
 * changed. Returns undefined for an unknown node, or one with an unknown ancestor.
 */
export function worldMatrix(nodes, id) {
    const cache = nodes instanceof Table ? cacheFor(nodes) : undefined;
    const cached = cache?.get(id);
    if (cached !== undefined) {
        return cached;
    }
    const node = nodes.get(id);
    if (node === undefined) {
        return undefined;
    }
    const parent = node.parentId === null ? IDENTITY_MAT4 : worldMatrix(nodes, node.parentId);
    if (parent === undefined) {
        return undefined;
    }
    const world = mat4Multiply(parent, mat4FromTransform(node.transform));
    cache?.set(id, world);
    return world;
}
/** The world matrix of the node's parent: identity for a root, undefined for an unknown parent. */
export function parentWorldMatrix(nodes, parentId) {
    return parentId === null ? IDENTITY_MAT4 : worldMatrix(nodes, parentId);
}
function cacheFor(nodes) {
    let cache = worldCache.get(nodes);
    if (cache === undefined) {
        cache = new Map();
        worldCache.set(nodes, cache);
    }
    return cache;
}
/**
 * The node's world placement as position, rotation and scale. Fails with `shear` when a rotated
 * ancestor with non-uniform scale makes the world placement inexpressible that way; the world
 * matrix is always available.
 */
export function worldTransform(nodes, id) {
    const m = worldMatrix(nodes, id);
    return m === undefined ? undefined : mat4Decompose(m);
}
/**
 * The world-aligned box enclosing the node's bounds placed in the world. Undefined for an unknown
 * node.
 */
export function worldBounds(nodes, id) {
    const node = nodes.get(id);
    const m = worldMatrix(nodes, id);
    return node === undefined || m === undefined ? undefined : aabbOfBox(m, node.bounds);
}
/**
 * The node's ancestors, nearest first; empty for a root or an unknown node. The array is new on
 * every call and the caller's. Throws an `Error` if the hierarchy contains a cycle, which
 * committed state never does: it means a defect, not an input to tolerate.
 */
export function ancestorIds(nodes, id) {
    const out = [];
    const seen = new Set([id]);
    let current = nodes.get(id)?.parentId ?? null;
    while (current !== null) {
        if (seen.has(current)) {
            throw new Error(`the hierarchy has a cycle through node "${current}"`);
        }
        seen.add(current);
        out.push(current);
        current = nodes.get(current)?.parentId ?? null;
    }
    return out;
}
/** True when `ancestorId` is `id` itself or one of its ancestors. */
export function isSelfOrAncestor(nodes, ancestorId, id) {
    return id === ancestorId || ancestorIds(nodes, id).includes(ancestorId);
}
/**
 * The node's descendants in depth-first pre-order (children in presentation order), archived ones
 * included; empty for a leaf or an unknown node. The array is new on every call and the caller's.
 * Throws an `Error` if the hierarchy contains a cycle.
 */
export function descendantIds(nodes, id) {
    const out = [];
    const seen = new Set([id]);
    const visit = (current) => {
        for (const child of nodes.get(current)?.childIds ?? []) {
            if (seen.has(child)) {
                throw new Error(`the hierarchy has a cycle through node "${child}"`);
            }
            seen.add(child);
            out.push(child);
            visit(child);
        }
    };
    visit(id);
    return out;
}
/**
 * The node's status and flags after inheriting from its ancestors: it is active only when it and
 * every ancestor are, visible only when also it and every ancestor are visible, and selectable
 * only when also visible and it and every ancestor are selectable. Undefined for an unknown node.
 * Throws an `Error` if the hierarchy contains a cycle, which committed state never does.
 */
export function effectiveState(nodes, id) {
    const node = nodes.get(id);
    if (node === undefined) {
        return undefined;
    }
    let active = node.status === 'active';
    let visible = node.flags.visible;
    let selectable = node.flags.selectable;
    for (const ancestorId of ancestorIds(nodes, id)) {
        const ancestor = nodes.get(ancestorId);
        if (ancestor === undefined) {
            break;
        }
        active &&= ancestor.status === 'active';
        visible &&= ancestor.flags.visible;
        selectable &&= ancestor.flags.selectable;
    }
    visible &&= active;
    selectable &&= visible;
    return { active, visible, selectable };
}
/**
 * Nodes whose world bounds overlap `box` (world coordinates; boxes that only touch do not
 * overlap), in the order they were added to the scene. Only effectively visible nodes count unless
 * `includeHidden` is set.
 */
export function nodesInBox(state, box, options = {}) {
    const out = [];
    for (const node of state.nodes) {
        if (!included(state, node.id, options)) {
            continue;
        }
        const bounds = worldBounds(state.nodes, node.id);
        if (bounds !== undefined && aabbIntersects(bounds, box)) {
            out.push(node.id);
        }
    }
    return out;
}
/**
 * Nodes whose world bounds the ray passes through: nearest first, then higher presentation
 * priority, then ID. This is a coarse, renderer-independent test; exact surface picking refines it.
 * Only hits in front of the ray's origin count, and only effectively visible nodes unless
 * `includeHidden` is set.
 */
export function raycastBounds(state, r, options = {}) {
    const hits = [];
    for (const node of state.nodes) {
        if (!included(state, node.id, options)) {
            continue;
        }
        const bounds = worldBounds(state.nodes, node.id);
        const span = bounds === undefined ? null : rayIntersectAabb(r, bounds);
        if (span !== null) {
            hits.push({
                nodeId: node.id,
                distance: span.near,
                priority: node.flags.presentationPriority,
            });
        }
    }
    hits.sort((a, b) => a.distance - b.distance ||
        b.priority - a.priority ||
        (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
    return hits.map(({ nodeId, distance }) => ({ nodeId, distance }));
}
function included(state, id, options) {
    return options.includeHidden === true || effectiveState(state.nodes, id)?.visible === true;
}
/**
 * Nodes matching descriptive metadata only, in scene order. Surface content is never consulted,
 * nor any metadata the query does not expose. Throws {@link SwfFailure} (`INVALID_INPUT`) for a
 * metadata key that is not namespaced, and (`UNKNOWN_ENTITY`) for a `within` node that does not
 * exist.
 */
export function findNodes(state, query) {
    const keys = query.metadataKeys ?? [];
    keys.forEach((key, i) => {
        try {
            checkMetadataKey(key, `query.metadataKeys[${String(i)}]`);
        }
        catch (error) {
            if (error instanceof RejectionSignal) {
                throw new SwfFailure(makeError(error.code, error.message, error.path === undefined ? {} : { path: error.path }));
            }
            throw error;
        }
    });
    if (query.within !== undefined && !state.nodes.has(query.within)) {
        throw new SwfFailure(makeError('UNKNOWN_ENTITY', `query.within names no node "${query.within}"`, {
            workspaceId: state.workspaceId,
            entityId: query.within,
            path: 'query.within',
        }));
    }
    const needle = query.text === undefined ? null : fold(query.text);
    const out = [];
    for (const node of state.nodes) {
        const effective = effectiveState(state.nodes, node.id);
        if (query.includeArchived !== true && effective?.active !== true) {
            continue;
        }
        if (query.kinds !== undefined && !query.kinds.includes(node.kind)) {
            continue;
        }
        if (query.tags !== undefined && !query.tags.every((tag) => node.tags.includes(tag))) {
            continue;
        }
        if (query.visible !== undefined && effective?.visible !== query.visible) {
            continue;
        }
        if (query.locked !== undefined && node.flags.locked !== query.locked) {
            continue;
        }
        if (query.within !== undefined && !ancestorIds(state.nodes, node.id).includes(query.within)) {
            continue;
        }
        if (needle !== null && !matchesText(state, node, needle, keys, query.groupPath === true)) {
            continue;
        }
        out.push(node.id);
    }
    return out;
}
/**
 * The folded text of a node's own descriptive fields, kept per record: records are immutable, so a
 * folded entry stays right for as long as its record is current and goes with it.
 */
const foldedOwn = new WeakMap();
const foldedMetadata = new WeakMap();
function ownText(node) {
    let text = foldedOwn.get(node);
    if (text === undefined) {
        text = Object.freeze([node.id, ...node.tags, ...(node.label === null ? [] : [node.label])].map(fold));
        foldedOwn.set(node, text);
    }
    return text;
}
function metadataText(node, key) {
    let byKey = foldedMetadata.get(node);
    if (byKey === undefined) {
        byKey = new Map();
        foldedMetadata.set(node, byKey);
    }
    let text = byKey.get(key);
    if (text === undefined) {
        const value = Object.hasOwn(node.metadata, key) ? node.metadata[key] : undefined;
        text =
            typeof value === 'string'
                ? fold(value)
                : typeof value === 'number'
                    ? fold(String(value))
                    : null;
        byKey.set(key, text);
    }
    return text;
}
function matchesText(state, node, needle, keys, groupPath) {
    if (ownText(node).some((text) => text.includes(needle))) {
        return true;
    }
    if (keys.some((key) => metadataText(node, key)?.includes(needle) === true)) {
        return true;
    }
    if (!groupPath) {
        return false;
    }
    return ancestorIds(state.nodes, node.id).some((id) => {
        const ancestor = state.nodes.get(id);
        return (ancestor !== undefined &&
            [ancestor.id, ...(ancestor.label === null ? [] : [ancestor.label])].some((text) => fold(text).includes(needle)));
    });
}
/**
 * Unicode compatibility normalisation (NFKC) plus locale-independent lower-casing: how
 * {@link findNodes} compares text.
 */
export function fold(text) {
    return text.normalize('NFKC').toLowerCase();
}
//# sourceMappingURL=query.js.map