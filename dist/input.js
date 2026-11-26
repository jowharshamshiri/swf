import { makeError, SwfFailure } from '@swf/core';
import { INTERACTION_API_VERSION } from '@swf/interaction';
import { DOM_ATTRIBUTES } from './renderer.js';
/** CSS pixels one wheel "line" scrolls when the platform reports lines. */
const LINE_PX = 16;
/**
 * Connects a view's DOM to the interaction router. It listens on the view's root in the capture
 * phase and offers every pointer, wheel and key event as an intent. When the framework consumes
 * one, the event stops there (so content does not act on it too) and a pressed pointer is
 * captured on the root until its gesture ends. When it does not, the event is left untouched and
 * the browser delivers it to the content as the genuine event it is: nothing is synthesized or
 * re-dispatched, and content in a cross-origin frame receives its input from the browser alone.
 *
 * Wheel deltas are given in CSS pixels: a line is 16 px and a page the root's height. Keys
 * pressed inside a live slot are offered with focus `content`, others with focus `workspace`.
 * Pen and touch pointers carry pressure (clamped to 0 to 1), tilt and twist.
 *
 * The adapter connects to one router at a time: `connect` adds its listeners to the root and
 * subscribes to `events`, and the function it returns removes and unsubscribes them again. A
 * second `connect` before that throws {@link SwfFailure} (`INVALID_TRANSITION`).
 */
export function createDomInput(options) {
    const { root, viewportId } = options;
    const id = options.id ?? 'swf.dom-input/1';
    let connected = false;
    return Object.freeze({
        id,
        apiVersion: INTERACTION_API_VERSION,
        connect(dispatch) {
            if (connected) {
                throw new SwfFailure(makeError('INVALID_TRANSITION', `DOM input "${id}" is already connected`));
            }
            connected = true;
            const deviceOf = (e) => (e.pointerType === '' ? 'pointer' : e.pointerType);
            const position = (e) => {
                const box = root.getBoundingClientRect();
                return { x: e.clientX - box.left, y: e.clientY - box.top };
            };
            const settle = (event, result) => {
                if (result.consumed) {
                    event.preventDefault();
                    event.stopPropagation();
                }
            };
            const pointer = (phase) => (event) => {
                const e = event;
                const { x, y } = position(e);
                const result = dispatch({
                    kind: 'pointer',
                    viewportId,
                    deviceId: deviceOf(e),
                    pointerId: e.pointerId,
                    pointerType: pointerTypeOf(e.pointerType),
                    phase,
                    x,
                    y,
                    buttons: e.buttons,
                    modifiers: modifiersOf(e),
                    timestamp: e.timeStamp,
                    ...penDetails(e),
                });
                // A press the framework takes is captured on the root: the release then targets the root,
                // so the click that follows lands there too and never reaches the content.
                if (phase === 'down' && result.consumed && !root.hasPointerCapture(e.pointerId)) {
                    root.setPointerCapture(e.pointerId);
                }
                settle(event, result);
            };
            const lost = (event) => {
                const e = event;
                const { x, y } = position(e);
                dispatch({
                    kind: 'pointer',
                    viewportId,
                    deviceId: deviceOf(e),
                    pointerId: e.pointerId,
                    pointerType: pointerTypeOf(e.pointerType),
                    phase: 'cancel',
                    x,
                    y,
                    buttons: 0,
                    modifiers: modifiersOf(e),
                    timestamp: e.timeStamp,
                });
            };
            const wheel = (event) => {
                const e = event;
                const { x, y } = position(e);
                const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? root.getBoundingClientRect().height : 1;
                settle(event, dispatch({
                    kind: 'wheel',
                    viewportId,
                    deviceId: 'wheel',
                    x,
                    y,
                    deltaX: e.deltaX * unit,
                    deltaY: e.deltaY * unit,
                    modifiers: modifiersOf(e),
                    timestamp: e.timeStamp,
                }));
            };
            const key = (phase) => (event) => {
                const e = event;
                const target = e.target;
                const inContent = target instanceof Element && target.closest(`[${DOM_ATTRIBUTES.slot}]`) !== null;
                settle(event, dispatch({
                    kind: 'key',
                    viewportId,
                    deviceId: 'keyboard',
                    phase,
                    key: e.key,
                    repeat: e.repeat,
                    modifiers: modifiersOf(e),
                    focus: inContent ? 'content' : 'workspace',
                    timestamp: e.timeStamp,
                }));
            };
            const listeners = [
                ['pointerdown', pointer('down')],
                ['pointermove', pointer('move')],
                ['pointerup', pointer('up')],
                ['pointercancel', pointer('cancel')],
                ['lostpointercapture', lost],
                ['wheel', wheel],
                ['keydown', key('down')],
                ['keyup', key('up')],
            ];
            for (const [type, listener] of listeners) {
                root.addEventListener(type, listener, { capture: true, passive: false });
            }
            const unsubscribe = options.events((event) => {
                if (event.type === 'capture.released' &&
                    event.viewportId === viewportId &&
                    root.hasPointerCapture(event.pointerId)) {
                    root.releasePointerCapture(event.pointerId);
                }
            });
            return () => {
                for (const [type, listener] of listeners) {
                    root.removeEventListener(type, listener, { capture: true });
                }
                unsubscribe();
                connected = false;
            };
        },
    });
}
/**
 * The platform's pointer type. A type the platform does not name (an empty or custom one) is
 * reported as `virtual`: a pointer the framework cannot classify as mouse, pen or touch.
 */
function pointerTypeOf(type) {
    return type === 'mouse' || type === 'pen' || type === 'touch' ? type : 'virtual';
}
function modifiersOf(e) {
    return { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey };
}
/** Pressure, tilt and twist, for the devices that measure them (pens and touch). */
function penDetails(e) {
    if (e.pointerType !== 'pen' && e.pointerType !== 'touch') {
        return {};
    }
    return {
        pressure: Math.min(1, Math.max(0, e.pressure)),
        tilt: { x: e.tiltX, y: e.tiltY },
        twist: e.twist % 360,
    };
}
//# sourceMappingURL=input.js.map