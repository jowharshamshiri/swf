import { jsonValue, SwfFailure } from '@swf/core';
/** No modifier held; frozen. */
export const NO_MODIFIERS = Object.freeze({
    shift: false,
    ctrl: false,
    alt: false,
    meta: false,
});
const POINTER_TYPES = ['mouse', 'touch', 'pen', 'virtual'];
const POINTER_PHASES = ['down', 'move', 'up', 'cancel'];
const FIELDS = {
    pointer: {
        required: [
            'kind',
            'viewportId',
            'deviceId',
            'pointerId',
            'pointerType',
            'phase',
            'x',
            'y',
            'buttons',
            'modifiers',
            'timestamp',
        ],
        optional: ['pressure', 'tilt', 'twist'],
    },
    wheel: {
        required: [
            'kind',
            'viewportId',
            'deviceId',
            'x',
            'y',
            'deltaX',
            'deltaY',
            'modifiers',
            'timestamp',
        ],
        optional: [],
    },
    key: {
        required: [
            'kind',
            'viewportId',
            'deviceId',
            'phase',
            'key',
            'repeat',
            'modifiers',
            'focus',
            'timestamp',
        ],
        optional: [],
    },
    command: { required: ['kind', 'command', 'args', 'deviceId', 'timestamp'], optional: [] },
};
const nonBlank = (v) => typeof v === 'string' && v.trim() !== '';
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
/**
 * Why a value is not a valid intent, naming the field, or null when it is valid. Intents come from
 * adapters that may be plain JavaScript, so nothing is assumed: the kind, then the required and
 * allowed fields, then each field's value are checked, and the first problem is reported.
 */
export function intentIssue(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return 'an intent must be an object';
    }
    const record = value;
    const kind = record['kind'];
    if (kind !== 'pointer' && kind !== 'wheel' && kind !== 'key' && kind !== 'command') {
        return `kind must be pointer, wheel, key or command (got ${JSON.stringify(kind)})`;
    }
    const { required, optional } = FIELDS[kind];
    const missing = required.find((k) => !(k in record));
    if (missing !== undefined) {
        return `${missing} is required`;
    }
    const unknown = Object.keys(record).find((k) => !required.includes(k) && !optional.includes(k));
    if (unknown !== undefined) {
        return `${unknown} is not a field of a ${kind} intent`;
    }
    if (!nonBlank(record['deviceId'])) {
        return 'deviceId must be a non-blank string';
    }
    if (!finite(record['timestamp']) || record['timestamp'] < 0) {
        return 'timestamp must be a non-negative finite number';
    }
    if (kind !== 'command') {
        const modifiers = modifiersIssue(record['modifiers']);
        if (modifiers !== null) {
            return modifiers;
        }
    }
    switch (kind) {
        case 'pointer':
            return pointerIssue(record);
        case 'wheel':
            if (!nonBlank(record['viewportId'])) {
                return 'viewportId must be a non-blank string';
            }
            for (const k of ['x', 'y', 'deltaX', 'deltaY']) {
                if (!finite(record[k])) {
                    return `${k} must be a finite number`;
                }
            }
            return null;
        case 'key':
            if (record['viewportId'] !== null && !nonBlank(record['viewportId'])) {
                return 'viewportId must be null or a non-blank string';
            }
            if (record['phase'] !== 'down' && record['phase'] !== 'up') {
                return 'phase must be down or up';
            }
            if (typeof record['key'] !== 'string' || record['key'] === '') {
                return 'key must be a non-empty string';
            }
            if (typeof record['repeat'] !== 'boolean') {
                return 'repeat must be a boolean';
            }
            if (record['focus'] !== 'workspace' && record['focus'] !== 'content') {
                return 'focus must be workspace or content';
            }
            return null;
        case 'command':
            if (!nonBlank(record['command'])) {
                return 'command must be a non-blank string';
            }
            try {
                jsonValue(record['args'], 'args');
            }
            catch (error) {
                if (error instanceof SwfFailure) {
                    return error.message;
                }
                throw error;
            }
            return null;
    }
}
function modifiersIssue(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return 'modifiers must be an object { shift, ctrl, alt, meta }';
    }
    const record = value;
    for (const key of Object.keys(NO_MODIFIERS)) {
        if (typeof record[key] !== 'boolean') {
            return `modifiers.${key} must be a boolean`;
        }
    }
    const extra = Object.keys(record).find((k) => !(k in NO_MODIFIERS));
    return extra === undefined ? null : `modifiers.${extra} is not a modifier`;
}
function pointerIssue(record) {
    if (!nonBlank(record['viewportId'])) {
        return 'viewportId must be a non-blank string';
    }
    const pointerId = record['pointerId'];
    if (!Number.isInteger(pointerId) || pointerId < 0) {
        return 'pointerId must be a non-negative integer';
    }
    if (!POINTER_TYPES.includes(record['pointerType'])) {
        return `pointerType must be one of ${POINTER_TYPES.join(', ')}`;
    }
    if (!POINTER_PHASES.includes(record['phase'])) {
        return `phase must be one of ${POINTER_PHASES.join(', ')}`;
    }
    if (!finite(record['x']) || !finite(record['y'])) {
        return 'x and y must be finite numbers';
    }
    const buttons = record['buttons'];
    if (!Number.isInteger(buttons) || buttons < 0) {
        return 'buttons must be a non-negative integer bit mask';
    }
    const pressure = record['pressure'];
    if (pressure !== undefined && !(finite(pressure) && pressure >= 0 && pressure <= 1)) {
        return 'pressure must be a number in [0, 1]';
    }
    const tilt = record['tilt'];
    if (tilt !== undefined) {
        const t = tilt;
        const angle = (v) => finite(v) && v >= -90 && v <= 90;
        if (typeof t !== 'object' ||
            t === null ||
            Object.keys(t).length !== 2 ||
            !angle(t['x']) ||
            !angle(t['y'])) {
            return 'tilt must be { x, y } in degrees, each in [-90, 90]';
        }
    }
    const twist = record['twist'];
    if (twist !== undefined && !(finite(twist) && twist >= 0 && twist < 360)) {
        return 'twist must be a number of degrees in [0, 360)';
    }
    return null;
}
//# sourceMappingURL=intents.js.map