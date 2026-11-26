import { makeError, SwfFailure } from '@swf/core';
import { NO_MODIFIERS } from './intents.js';
import { INTERACTION_API_VERSION } from './policies.js';
/**
 * A synthetic input device. Register it with a router to connect it; timestamps come from `now`
 * (by default a counter, so runs are reproducible). Unregistering it from the router disconnects
 * it; it can then be registered again.
 *
 * @param options `id` is the adapter's versioned ID (default `swf.synthetic-input/1`), unique
 *   among a router's input adapters; `deviceId` the device every intent names (default
 *   `synthetic`); `now` the clock, in milliseconds, which must return non-negative finite numbers.
 */
export function createSyntheticInput(options = {}) {
    let tick = 0;
    const now = options.now ?? (() => (tick += 1));
    const deviceId = options.deviceId ?? 'synthetic';
    let dispatch = null;
    const send = (intent) => {
        if (dispatch === null) {
            throw new SwfFailure(makeError('INVALID_TRANSITION', `synthetic input "${deviceId}" is not connected`));
        }
        return dispatch(intent);
    };
    const modifiers = (partial) => ({
        ...NO_MODIFIERS,
        ...partial,
    });
    return {
        id: options.id ?? 'swf.synthetic-input/1',
        apiVersion: INTERACTION_API_VERSION,
        connect(next) {
            if (dispatch !== null) {
                throw new SwfFailure(makeError('INVALID_TRANSITION', `synthetic input "${deviceId}" is already connected`));
            }
            dispatch = next;
            return () => {
                dispatch = null;
            };
        },
        pointer(phase, viewportId, x, y, o = {}) {
            const intent = {
                kind: 'pointer',
                viewportId,
                deviceId,
                pointerId: o.pointerId ?? 1,
                pointerType: o.pointerType ?? 'virtual',
                phase,
                x,
                y,
                buttons: o.buttons ?? (phase === 'down' || phase === 'move' ? 1 : 0),
                modifiers: modifiers(o.modifiers),
                timestamp: now(),
                ...(o.pressure === undefined ? {} : { pressure: o.pressure }),
                ...(o.tilt === undefined ? {} : { tilt: o.tilt }),
                ...(o.twist === undefined ? {} : { twist: o.twist }),
            };
            return send(intent);
        },
        wheel(viewportId, x, y, deltaY, o = {}) {
            return send({
                kind: 'wheel',
                viewportId,
                deviceId,
                x,
                y,
                deltaX: o.deltaX ?? 0,
                deltaY,
                modifiers: modifiers(o.modifiers),
                timestamp: now(),
            });
        },
        key(key, o = {}) {
            return send({
                kind: 'key',
                viewportId: o.viewportId ?? null,
                deviceId,
                phase: o.phase ?? 'down',
                key,
                repeat: o.repeat ?? false,
                modifiers: modifiers(o.modifiers),
                focus: o.focus ?? 'workspace',
                timestamp: now(),
            });
        },
        command(command, args) {
            return send({ kind: 'command', command, args, deviceId, timestamp: now() });
        },
    };
}
//# sourceMappingURL=synthetic.js.map