import { makeError, SwfFailure, worldMatrix } from '@swf/core';
import { add, dot, IDENTITY_MAT4, length, mat4Decompose, mat4InvertAffine, mat4TransformDirection, mat4TransformPoint, normalize, quatFromAxisAngle, quatInvert, quatMultiply, quatNormalize, quatRotate, scale, sub, } from '@swf/math';
/** Every drag mode, the default first; frozen. */
export const DRAG_MODES = Object.freeze([
    'camera-plane',
    'world-plane',
    'angular-shell',
]);
/**
 * Fixes a drag of the point `anchor`, seen from `eye`, in `mode`. `worldPlaneNormal` is used only
 * for `world-plane` and need not be unit length. The returned frame is fresh and unfrozen and
 * keeps `eye` and `anchor` as given.
 *
 * @throws RangeError when `anchor` is at `eye`, or when a `world-plane` normal is zero or not
 *   finite.
 */
export function dragFrame(mode, eye, anchor, worldPlaneNormal, minDistance) {
    const offset = sub(anchor, eye);
    const radius = length(offset);
    if (!(radius > 0)) {
        throw new RangeError('a drag cannot start at the camera position');
    }
    return {
        mode,
        eye,
        anchor,
        normal: mode === 'world-plane' ? normalize(worldPlaneNormal) : scale(offset, 1 / radius),
        radius,
        minDistance,
    };
}
/**
 * Where the grabbed point goes for a pointer ray, with `depth` added along the line from the
 * camera; null when the ray cannot reach the drag's surface (it runs parallel to the plane or away
 * from it), in which case the drag holds its last position instead of jumping.
 */
export function dragAnchor(frame, ray, depth) {
    let point;
    if (frame.mode === 'angular-shell') {
        point = add(frame.eye, scale(normalize(ray.direction), frame.radius));
    }
    else {
        const denominator = dot(ray.direction, frame.normal);
        if (Math.abs(denominator) < 1e-9) {
            return null;
        }
        const t = dot(sub(frame.anchor, ray.origin), frame.normal) / denominator;
        if (!(t > 0)) {
            return null;
        }
        point = add(ray.origin, scale(ray.direction, t));
    }
    return depth === 0 ? point : withDepth(frame.eye, point, depth, frame.minDistance);
}
/**
 * `point` moved by `depth` along the line from `eye` (positive away from it), never nearer than
 * `minDistance`. A point at `eye` is returned as it is.
 */
export function withDepth(eye, point, depth, minDistance) {
    const offset = sub(point, eye);
    const distance = length(offset);
    if (!(distance > 0)) {
        return point;
    }
    const target = Math.max(minDistance, distance + depth);
    return add(eye, scale(offset, target / distance));
}
/** The node's placement in `scene`; throws {@link SwfFailure} (`UNKNOWN_ENTITY`) if absent. */
export function placementOf(scene, nodeId) {
    const node = scene.nodes.get(nodeId);
    const world = worldMatrix(scene.nodes, nodeId);
    const parentWorld = node === undefined || node.parentId === null
        ? IDENTITY_MAT4
        : worldMatrix(scene.nodes, node.parentId);
    if (node === undefined || world === undefined || parentWorld === undefined) {
        throw new SwfFailure(makeError('UNKNOWN_ENTITY', `no node "${nodeId}" in this workspace`, { entityId: nodeId }));
    }
    return { local: node.transform, parentWorld, world };
}
/** The node's world origin: the translation of its world matrix. */
export function worldOrigin(placement) {
    return [placement.world[12], placement.world[13], placement.world[14]];
}
/** The local transform that moves the node by `delta` in the world; null if the parent is singular. */
export function translatedBy(placement, delta) {
    const toParent = mat4InvertAffine(placement.parentWorld);
    if (toParent === null) {
        return null;
    }
    // Only the parent's linear part acts on a displacement.
    const local = mat4TransformDirection(toParent, delta);
    return { ...placement.local, position: add(placement.local.position, local) };
}
/**
 * The local transform that turns the node by `yaw` radians about the world vertical through
 * `pivot`; positive turns to the right (clockwise seen from above). Null when the parent's
 * placement cannot be decomposed or inverted.
 */
export function turnedAbout(placement, pivot, yaw) {
    const toParent = mat4InvertAffine(placement.parentWorld);
    const parent = mat4Decompose(placement.parentWorld);
    if (toParent === null || !parent.ok) {
        return null;
    }
    const q = quatFromAxisAngle([0, 1, 0], -yaw);
    const position = add(pivot, quatRotate(q, sub(worldOrigin(placement), pivot)));
    const p = parent.transform.rotation;
    // World rotation W = P·L turns to Q·W, so the local one becomes P⁻¹·Q·P·L.
    const rotation = quatNormalize(quatMultiply(quatMultiply(quatInvert(p), q), quatMultiply(p, placement.local.rotation)));
    return { ...placement.local, position: mat4TransformPoint(toParent, position), rotation };
}
/**
 * The node's local transform after its grabbed point moved from the frame's anchor to `anchor`.
 * Planar modes translate it; the angular shell also turns it about the vertical through the
 * grabbed point by the change in heading, so it keeps facing the camera the same way. Null when
 * the parent's placement cannot be inverted.
 */
export function movedTransform(placement, frame, anchor) {
    const delta = sub(anchor, frame.anchor);
    if (frame.mode !== 'angular-shell') {
        return translatedBy(placement, delta);
    }
    const turn = headingOf(sub(anchor, frame.eye)) - headingOf(sub(frame.anchor, frame.eye));
    const turned = turnedAbout(placement, frame.anchor, turn);
    return turned === null ? null : translatedBy({ ...placement, local: turned }, delta);
}
/**
 * The heading of `direction`: radians right of -Z about +Y, in [-π, π]; 0 for a vertical
 * direction.
 */
export function headingOf(direction) {
    return Math.hypot(direction[0], direction[2]) === 0 ? 0 : Math.atan2(direction[0], -direction[2]);
}
//# sourceMappingURL=drag.js.map