import { mat4InvertAffine, mat4TransformDirection, mat4TransformPoint, sub } from '@swf/math';
import { cameraRotation, headingPitchOf } from '@swf/projections';
import { eyeOf } from './commands.js';
import { dragAnchor, dragFrame, movedTransform, placementOf, translatedBy, turnedAbout, withDepth, } from './drag.js';
/**
 * The version of the policy and input adapter contract this package defines. A policy or input
 * adapter states it as its `apiVersion`; any other value is refused at registration with
 * `UNSUPPORTED_CAPABILITY`.
 */
export const INTERACTION_API_VERSION = 1;
const reasonOf = (error) => error.code === 'CONSTRAINT_REJECTED' || error.code === 'LOCKED'
    ? 'constraint-rejected'
    : 'commit-rejected';
/** Ends a previewing gesture: commits its last accepted proposal, or reports why not. */
function commitLast(session, last) {
    if (last === null) {
        return { outcome: 'unchanged' };
    }
    const result = session.commit(last);
    return result.status === 'committed'
        ? { outcome: 'committed', transactionId: result.transactionId }
        : { outcome: 'cancelled', reason: reasonOf(result.error), error: result.error };
}
/** The target a press on a window may move or resize, if its flags allow. */
function movableTarget(context, flag) {
    if (context.pick.kind !== 'hit') {
        return null;
    }
    const target = context.pick.target;
    const node = context.scene.nodes.get(target.nodeId);
    return node !== undefined && node.flags[flag] && !node.flags.locked ? target : null;
}
/** A press on chrome, or on content when content is not live input here. */
function grabsWindow(context) {
    return (context.region === 'chrome' ||
        (context.region === 'content' &&
            (context.takeover || (context.pick.kind === 'hit' && context.pick.target.proxy))));
}
/** Moves a window with one pointer, previewing on every move and committing once. */
class MoveGesture {
    #session;
    #nodeId;
    #placement;
    #frame;
    #depth = 0;
    #pointer = null;
    #last = null;
    constructor(session, target) {
        this.#session = session;
        this.#nodeId = target.nodeId;
        this.#placement = placementOf(session.scene(), target.nodeId);
        const s = session.settings;
        this.#frame = dragFrame(s.dragMode, eyeOf(session.view()), target.worldPoint, s.worldPlaneNormal, s.minDistance);
    }
    update(pointers) {
        const pointer = pointers[0];
        if (pointer === undefined) {
            return;
        }
        this.#pointer = pointer;
        const ray = this.#session.ray(pointer);
        if (ray.kind !== 'ray') {
            // Outside the image or where it has no inverse: hold the last position, keep the capture.
            return;
        }
        const anchor = dragAnchor(this.#frame, ray.ray, this.#depth);
        if (anchor !== null) {
            this.#propose(anchor);
        }
    }
    wheel(intent) {
        this.#depth -= intent.deltaY * this.#session.settings.wheelDepthPerPixel;
        if (this.#pointer === null) {
            this.#propose(withDepth(this.#frame.eye, this.#frame.anchor, this.#depth, this.#frame.minDistance));
        }
        else {
            this.update([this.#pointer]);
        }
        return true;
    }
    finish() {
        return commitLast(this.#session, this.#last);
    }
    cancel() {
        // Everything this gesture changed is in its preview.
    }
    #propose(anchor) {
        const transform = movedTransform(this.#placement, this.#frame, anchor);
        if (transform === null) {
            return;
        }
        const commands = [{ type: 'node.patch', id: this.#nodeId, transform }];
        // A rejected proposal (a constraint said no) leaves the last valid one in place.
        if (this.#session.preview(commands).status === 'previewed') {
            this.#last = commands;
        }
    }
}
/**
 * Drags a window's frame or a non-live surface (or its content during a takeover) to move the
 * window, as the `dragMode` setting maps the pointer, with the wheel adding depth. One pointer, a
 * draggable node that is not locked; previews on every move and commits once (`node.move`).
 * `swf.window-move/1`, priority 100.
 */
export const windowMovePolicy = Object.freeze({
    id: 'swf.window-move/1',
    apiVersion: INTERACTION_API_VERSION,
    priority: 100,
    operations: Object.freeze(['node.move']),
    claim(context) {
        const target = context.pointers.length === 1 ? movableTarget(context, 'draggable') : null;
        if (target === null || !grabsWindow(context)) {
            return null;
        }
        return {
            kind: 'drag',
            pointers: 1,
            operation: 'node.move',
            nodeId: target.nodeId,
            begin: (session) => new MoveGesture(session, target),
        };
    },
});
/** Resizes a window from an edge or corner, keeping the opposite side in place. */
class ResizeGesture {
    #session;
    #nodeId;
    #edge;
    #placement;
    #start;
    #bounds;
    #last = null;
    constructor(session, target, edge) {
        this.#session = session;
        this.#nodeId = target.nodeId;
        this.#edge = edge;
        const scene = session.scene();
        this.#placement = placementOf(scene, target.nodeId);
        this.#start = target.localPoint;
        const node = scene.nodes.get(target.nodeId);
        if (node === undefined) {
            throw new Error(`node "${target.nodeId}" vanished before its resize began`);
        }
        this.#bounds = node.bounds;
    }
    update(pointers) {
        const pointer = pointers[0];
        const ray = pointer === undefined ? null : this.#session.ray(pointer);
        const toLocal = mat4InvertAffine(this.#placement.world);
        if (ray?.kind !== 'ray' || toLocal === null) {
            return;
        }
        // Where the ray meets the window's own plane, in its local frame.
        const origin = mat4TransformPoint(toLocal, ray.ray.origin);
        const direction = mat4TransformDirection(toLocal, ray.ray.direction);
        if (direction[2] === 0) {
            return;
        }
        const t = -origin[2] / direction[2];
        if (!(t > 0)) {
            return;
        }
        const dx = origin[0] + t * direction[0] - this.#start[0];
        const dy = origin[1] + t * direction[1] - this.#start[1];
        const min = this.#session.settings.minSize;
        const [w, h, d] = this.#bounds;
        const east = this.#edge.includes('e') ? 1 : this.#edge.includes('w') ? -1 : 0;
        const north = this.#edge.includes('n') ? 1 : this.#edge.includes('s') ? -1 : 0;
        const width = east === 0 ? w : Math.max(min, w + east * dx);
        const height = north === 0 ? h : Math.max(min, h + north * dy);
        // The centre moves half the growth towards the dragged side.
        const shiftLocal = [(east * (width - w)) / 2, (north * (height - h)) / 2, 0];
        const shift = mat4TransformDirection(this.#placement.world, shiftLocal);
        const transform = translatedBy(this.#placement, shift);
        if (transform === null) {
            return;
        }
        const commands = [
            { type: 'node.patch', id: this.#nodeId, bounds: [width, height, d], transform },
        ];
        if (this.#session.preview(commands).status === 'previewed') {
            this.#last = commands;
        }
    }
    finish() {
        return commitLast(this.#session, this.#last);
    }
    cancel() {
        // Everything this gesture changed is in its preview.
    }
}
/**
 * Drags a resize handle to resize a window, keeping the opposite edge in place and no side
 * smaller than `minSize`. One pointer, a resizable node that is not locked; previews on every move
 * and commits once (`node.resize`). `swf.window-resize/1`, priority 110.
 */
export const windowResizePolicy = Object.freeze({
    id: 'swf.window-resize/1',
    apiVersion: INTERACTION_API_VERSION,
    priority: 110,
    operations: Object.freeze(['node.resize']),
    claim(context) {
        const target = context.pointers.length === 1 && context.region === 'resize-handle'
            ? movableTarget(context, 'resizable')
            : null;
        const edge = target?.edge ?? null;
        if (target === null || edge === null) {
            return null;
        }
        return {
            kind: 'drag',
            pointers: 1,
            operation: 'node.resize',
            nodeId: target.nodeId,
            begin: (session) => new ResizeGesture(session, target, edge),
        };
    },
});
/**
 * Turns the view by dragging the background: the camera in camera navigation (view state,
 * applied as it goes), or the orbit root in orbit navigation (previewed, committed once). The
 * grabbed direction stays under the pointer: angles are read in the view as it was at the press.
 */
class TurnGesture {
    #session;
    #target;
    #view;
    #projection;
    #down;
    #cameraId;
    #rotation;
    #orbit;
    #previous;
    #last = null;
    constructor(session, target, down) {
        this.#session = session;
        this.#target = target;
        this.#view = session.view();
        this.#projection = session.projection();
        const at = this.#projection.interactionRay(down.x, down.y, this.#view);
        this.#down = at.kind === 'ray' ? { longitude: at.longitude, latitude: at.latitude } : null;
        this.#previous = this.#down?.longitude ?? 0;
        const scene = session.scene();
        const viewport = scene.viewports.get(session.viewportId);
        const camera = viewport === undefined ? undefined : scene.cameras.get(viewport.cameraId);
        if (camera === undefined) {
            throw new Error(`viewport "${session.viewportId}" has no camera`);
        }
        this.#cameraId = camera.id;
        this.#rotation = camera.rotation;
        const rootId = scene.orbitRootId;
        this.#orbit =
            target === 'orbit' && rootId !== null
                ? { rootId, placement: placementOf(scene, rootId) }
                : null;
    }
    update(pointers) {
        const pointer = pointers[0];
        if (pointer === undefined || this.#down === null) {
            return;
        }
        const at = this.#projection.interactionRay(pointer.x, pointer.y, this.#view, {
            previousLongitude: this.#previous,
        });
        if (at.kind !== 'ray') {
            return;
        }
        this.#previous = at.longitude;
        const dLongitude = at.longitude - this.#down.longitude;
        const dLatitude = at.latitude - this.#down.latitude;
        if (this.#target === 'camera') {
            const { heading, pitch } = headingPitchOf(this.#rotation);
            const nextPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch - dLatitude));
            this.#session.transact([
                {
                    type: 'camera.patch',
                    id: this.#cameraId,
                    rotation: cameraRotation(heading - dLongitude, nextPitch),
                },
            ]);
            return;
        }
        if (this.#orbit === null) {
            return;
        }
        const transform = turnedAbout(this.#orbit.placement, eyeOf(this.#view), dLongitude);
        if (transform === null) {
            return;
        }
        const commands = [{ type: 'node.patch', id: this.#orbit.rootId, transform }];
        if (this.#session.preview(commands).status === 'previewed') {
            this.#last = commands;
        }
    }
    finish() {
        return this.#target === 'camera'
            ? { outcome: 'committed', transactionId: null }
            : commitLast(this.#session, this.#last);
    }
    cancel() {
        if (this.#target === 'camera') {
            // The camera turned as the drag went; turn it back.
            this.#session.apply([{ type: 'camera.patch', id: this.#cameraId, rotation: this.#rotation }]);
        }
    }
}
/**
 * Dragging the background turns the view as the viewport's navigation setting says: never by a
 * guess from where the pointer is. In `camera` navigation the camera turns as the drag goes (view
 * state, not undoable; cancelling turns it back); in `orbit` navigation the orbit root turns in a
 * preview and commits once. One pointer on the background. `swf.background-navigation/1`,
 * priority 10.
 */
export const backgroundNavigationPolicy = Object.freeze({
    id: 'swf.background-navigation/1',
    apiVersion: INTERACTION_API_VERSION,
    priority: 10,
    operations: Object.freeze(['camera.turn', 'orbit.turn']),
    claim(context) {
        const down = context.pointers[0];
        const viewport = context.scene.viewports.get(context.viewportId);
        if (context.region !== 'background' || context.pointers.length !== 1 || down === undefined) {
            return null;
        }
        if (viewport === undefined) {
            return null;
        }
        const target = viewport.navigation;
        if (target === 'orbit' && context.scene.orbitRootId === null) {
            return null;
        }
        return {
            kind: 'drag',
            pointers: 1,
            operation: target === 'camera' ? 'camera.turn' : 'orbit.turn',
            nodeId: target === 'orbit' ? context.scene.orbitRootId : null,
            begin: (session) => new TurnGesture(session, target, down),
        };
    },
});
/**
 * A tap selects the window it lands on (and focuses it when its surface is only a proxy here, as
 * the eligible activation); a tap on the background clears the selection. A tap on live content
 * stays native and is not claimed. One pointer; commits at once on release.
 * `swf.tap-select/1`, priority 0.
 */
export const tapSelectPolicy = Object.freeze({
    id: 'swf.tap-select/1',
    apiVersion: INTERACTION_API_VERSION,
    priority: 0,
    operations: Object.freeze(['selection.set', 'focus.set']),
    claim(context) {
        if (context.pointers.length !== 1) {
            return null;
        }
        if (context.region === 'background') {
            return tap(null, [{ type: 'selection.set', ids: [] }]);
        }
        if (context.pick.kind !== 'hit' ||
            !(grabsWindow(context) || context.region === 'resize-handle')) {
            return null;
        }
        const target = context.pick.target;
        const commands = [{ type: 'selection.set', ids: [target.nodeId] }];
        if (target.proxy) {
            commands.push({ type: 'focus.set', id: target.nodeId });
        }
        return tap(target.nodeId, commands);
    },
});
function tap(nodeId, commands) {
    return {
        kind: 'tap',
        pointers: 1,
        operation: 'selection.set',
        nodeId,
        begin: (session) => ({
            update: () => undefined,
            finish() {
                const result = session.transact(commands);
                return result.status === 'committed'
                    ? { outcome: 'committed', transactionId: result.transactionId }
                    : { outcome: 'cancelled', reason: reasonOf(result.error), error: result.error };
            },
            cancel: () => undefined,
        }),
    };
}
/** Two pointers on a window: spreading them brings it nearer, pinching sends it away. */
class PinchDepthGesture {
    #session;
    #nodeId;
    #placement;
    #eye;
    #anchor;
    #spread;
    #last = null;
    constructor(session, target, pointers) {
        this.#session = session;
        this.#nodeId = target.nodeId;
        this.#placement = placementOf(session.scene(), target.nodeId);
        this.#eye = eyeOf(session.view());
        this.#anchor = target.worldPoint;
        this.#spread = spreadOf(pointers);
    }
    update(pointers) {
        const spread = spreadOf(pointers);
        if (!(spread >= 1) || !(this.#spread >= 1)) {
            return;
        }
        const radius = Math.hypot(...sub(this.#anchor, this.#eye));
        const depth = radius * (this.#spread / spread) - radius;
        const anchor = withDepth(this.#eye, this.#anchor, depth, this.#session.settings.minDistance);
        const transform = translatedBy(this.#placement, sub(anchor, this.#anchor));
        if (transform === null) {
            return;
        }
        const commands = [{ type: 'node.patch', id: this.#nodeId, transform }];
        if (this.#session.preview(commands).status === 'previewed') {
            this.#last = commands;
        }
    }
    finish() {
        return commitLast(this.#session, this.#last);
    }
    cancel() {
        // Everything this gesture changed is in its preview.
    }
}
function spreadOf(pointers) {
    const [a, b] = pointers;
    return a === undefined || b === undefined ? 0 : Math.hypot(a.x - b.x, a.y - b.y);
}
/**
 * Two pointers pressed on one window adjust its depth: spreading them brings it nearer, pinching
 * sends it away, never nearer the camera than `minDistance`. A draggable node that is not locked;
 * previews and commits once (`node.move`). `swf.pinch-depth/1`, priority 200.
 */
export const pinchDepthPolicy = Object.freeze({
    id: 'swf.pinch-depth/1',
    apiVersion: INTERACTION_API_VERSION,
    priority: 200,
    operations: Object.freeze(['node.move']),
    claim(context) {
        const target = context.pointers.length === 2 ? movableTarget(context, 'draggable') : null;
        if (target === null || !(grabsWindow(context) || context.region === 'resize-handle')) {
            return null;
        }
        const pointers = context.pointers;
        return {
            kind: 'drag',
            pointers: 2,
            operation: 'node.move',
            nodeId: target.nodeId,
            begin: (session) => new PinchDepthGesture(session, target, pointers),
        };
    },
});
/** The policies a router starts with, unless its options name others; frozen. */
export const BUILT_IN_POLICIES = Object.freeze([
    windowMovePolicy,
    windowResizePolicy,
    backgroundNavigationPolicy,
    tapSelectPolicy,
    pinchDepthPolicy,
]);
//# sourceMappingURL=policies.js.map