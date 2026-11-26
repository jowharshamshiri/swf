import { makeError, SwfFailure } from '@swf/core';
import { mat4FromTransform } from '@swf/math';
/**
 * The presentation fragment ID of a surface's `ordinal`th fragment in a viewport: the three parts
 * joined by `/`, each URI-encoded, so IDs containing separators can never collide. It checks
 * nothing; {@link createViewOutput} refuses a fragment whose ID is not the one derived here.
 */
export function fragmentId(viewportId, surfaceId, ordinal) {
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
export function createViewOutput(scene, viewportId, fragments) {
    const fail = (message, entityId) => {
        throw new SwfFailure(makeError('INVALID_INPUT', `view output for viewport "${viewportId}": ${message}`, {
            workspaceId: scene.workspaceId,
            ...(entityId === undefined ? {} : { entityId }),
        }));
    };
    const byId = new Map();
    const bySurface = new Map();
    for (const fragment of fragments) {
        const issue = fragmentIssue(fragment, viewportId);
        if (issue !== null) {
            fail(issue, fragment.surfaceId);
        }
        if (!scene.surfaces.has(fragment.surfaceId)) {
            fail(`fragment "${fragment.id}" refers to unknown surface "${fragment.surfaceId}"`, fragment.surfaceId);
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
            fail(`surface "${surfaceId}" has fragment ordinals ${ordinals.join(', ')}, not 0 to ${String(list.length - 1)}`, surfaceId);
        }
        if (list.filter((f) => f.nativeOwner).length > 1) {
            fail(`surface "${surfaceId}" has more than one native-owner fragment`, surfaceId);
        }
    }
    const rank = sceneRanks(scene);
    const ordered = [...byId.values()].sort((a, b) => compareFragments(scene, rank, a, b));
    const frozen = Object.freeze(ordered);
    const grouped = new Map([...bySurface.keys()].map((surfaceId) => [
        surfaceId,
        Object.freeze(frozen.filter((f) => f.surfaceId === surfaceId)),
    ]));
    return Object.freeze({
        viewportId,
        sceneRevision: scene.revision,
        fragments: frozen,
        surfaceOf: (id) => byId.get(id)?.surfaceId,
        fragmentsOf: (surfaceId) => grouped.get(surfaceId) ?? EMPTY,
    });
}
const EMPTY = Object.freeze([]);
function fragmentIssue(f, viewportId) {
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
    if (f.corners !== null &&
        !f.corners.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
        return `fragment "${f.id}" has non-finite corners`;
    }
    if (!Number.isFinite(f.depth)) {
        return `fragment "${f.id}" has a non-finite depth`;
    }
    return null;
}
/** Each surface's place in scene order: owners in depth-first order, then slots within an owner. */
function sceneRanks(scene) {
    const ranks = new Map();
    let next = 0;
    const visit = (nodeId) => {
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
function compareFragments(scene, rank, a, b) {
    const priority = (f) => {
        const surface = scene.surfaces.get(f.surfaceId);
        const owner = surface === undefined ? undefined : scene.nodes.get(surface.ownerNodeId);
        return (owner?.flags.presentationPriority ?? 0) + (surface?.flags.presentationPriority ?? 0);
    };
    return (b.depth - a.depth ||
        priority(a) - priority(b) ||
        (rank.get(a.surfaceId) ?? 0) - (rank.get(b.surfaceId) ?? 0) ||
        a.ordinal - b.ordinal ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/**
 * Why a view geometry is invalid, or null when it is valid: the first problem, naming the field
 * (`viewportId`, `width`, `height`, `devicePixelRatio`, `camera`, `near` or `far`). It never
 * throws, and does not check the projection's ID or configuration.
 */
export function viewGeometryIssue(view) {
    if (typeof view.viewportId !== 'string' || view.viewportId.trim() === '') {
        return 'viewportId must be a non-blank string';
    }
    if (!(view.width > 0 &&
        view.height > 0 &&
        Number.isFinite(view.width) &&
        Number.isFinite(view.height))) {
        return 'width and height must be positive finite numbers';
    }
    if (!(view.devicePixelRatio > 0 && Number.isFinite(view.devicePixelRatio))) {
        return 'devicePixelRatio must be a positive finite number';
    }
    // Callers may be plain JavaScript, so the matrix's length is checked, not assumed.
    const camera = view.camera;
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
export function viewGeometryOf(scene, viewportId) {
    const unknown = (message, entityId) => {
        throw new SwfFailure(makeError('UNKNOWN_ENTITY', message, { workspaceId: scene.workspaceId, entityId }));
    };
    const viewport = scene.viewports.get(viewportId) ?? unknown(`no viewport "${viewportId}"`, viewportId);
    const camera = scene.cameras.get(viewport.cameraId) ??
        unknown(`viewport "${viewportId}" refers to missing camera "${viewport.cameraId}"`, viewport.cameraId);
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
//# sourceMappingURL=fragments.js.map