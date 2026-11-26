import { isFiniteVec3, isPositiveVec3, isUnitQuat, quatNormalize } from '@swf/math';
import { RejectionSignal } from './errors.js';
import { describe } from './json.js';
import { FLAG_NAMES } from './model.js';
/**
 * A versioned ID: a name and a positive integer version, such as `host.video/1`. Adapter types,
 * projection kinds, renderers and compositors are named this way.
 */
export const VERSIONED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[1-9][0-9]*$/;
export function expectVersionedId(value, path) {
    if (typeof value !== 'string' || !VERSIONED_ID.test(value)) {
        throw invalid(path, `must be a versioned ID "<name>/<version>", such as "host.video/1" (got ${describe(value)})`);
    }
    return value;
}
export function expectPositive(value, path) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw invalid(path, `must be a positive finite number (got ${describe(value)})`);
    }
    return value;
}
/** A validated, frozen unit quaternion, renormalized like transform rotations. */
export function expectRotation(value, path) {
    const [x = NaN, y = NaN, z = NaN, w = NaN] = expectTuple(value, path, 4);
    if (!isUnitQuat([x, y, z, w], QUAT_TOLERANCE)) {
        throw invalid(path, `must be a finite unit quaternion [x, y, z, w] (length within ${String(QUAT_TOLERANCE)} of 1)`);
    }
    return Object.freeze(quatNormalize([x, y, z, w]));
}
/** A binding key is opaque: any non-blank string, or null for none. It is never interpreted. */
export function expectBindingKey(value, path) {
    if (value === null) {
        return null;
    }
    if (typeof value !== 'string' || value.trim() === '') {
        throw invalid(path, `must be a non-blank string or null (got ${describe(value)})`);
    }
    return value;
}
export function expectInteraction(value, path) {
    if (value !== 'content' && value !== 'none') {
        throw invalid(path, `must be "content" or "none" (got ${describe(value)})`);
    }
    return value;
}
/** Quaternions within this distance of unit length are accepted and stored normalized. */
export const QUAT_TOLERANCE = 1e-6;
export function invalid(path, message) {
    return new RejectionSignal('INVALID_INPUT', `${path} ${message}`, { path });
}
/** A plain object whose keys are all in `allowed`; an unknown key is rejected by name. */
export function expectRecord(value, path, allowed) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw invalid(path, `must be an object (got ${describe(value)})`);
    }
    for (const key of Object.keys(value)) {
        if (!allowed.includes(key)) {
            throw invalid(`${path}.${key}`, `is not a known field (expected one of ${allowed.join(', ')})`);
        }
    }
    return value;
}
export function expectId(value, path) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw invalid(path, `must be a non-blank string ID (got ${describe(value)})`);
    }
    return value;
}
export function expectIdOrNull(value, path) {
    return value === null ? null : expectId(value, path);
}
export function expectNonBlank(value, path) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw invalid(path, `must be a non-blank string (got ${describe(value)})`);
    }
    return value;
}
export function expectLabel(value, path) {
    if (value !== null && typeof value !== 'string') {
        throw invalid(path, `must be a string or null (got ${describe(value)})`);
    }
    return value;
}
export function expectIndex(value, path, max) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
        throw invalid(path, `must be an integer from 0 to ${max} (got ${String(value)})`);
    }
    return value;
}
function expectTuple(value, path, size) {
    if (!Array.isArray(value) || value.length !== size) {
        throw invalid(path, `must be an array of ${size} numbers`);
    }
    return value.map((item, i) => {
        if (typeof item !== 'number') {
            throw invalid(`${path}[${i}]`, `must be a number (got ${describe(item)})`);
        }
        return item;
    });
}
export function expectVec3(value, path) {
    const [x = NaN, y = NaN, z = NaN] = expectTuple(value, path, 3);
    const v = Object.freeze([x, y, z]);
    if (!isFiniteVec3(v)) {
        throw invalid(path, 'must contain finite numbers');
    }
    return v;
}
export function expectBounds(value, path) {
    const v = expectVec3(value, path);
    if (!isPositiveVec3(v)) {
        throw invalid(path, 'must contain positive numbers');
    }
    return v;
}
/** A validated copy of a transform with its rotation renormalized. */
export function expectTransform(value, path) {
    const record = expectRecord(value, path, ['position', 'rotation', 'scale']);
    const position = expectVec3(record['position'], `${path}.position`);
    const rotation = expectRotation(record['rotation'], `${path}.rotation`);
    const scale = expectVec3(record['scale'], `${path}.scale`);
    if (!isPositiveVec3(scale)) {
        throw invalid(`${path}.scale`, 'must contain positive numbers');
    }
    return Object.freeze({ position, rotation, scale });
}
export function expectFlags(value, path) {
    const record = expectRecord(value, path, FLAG_NAMES);
    const out = {};
    for (const [key, item] of Object.entries(record)) {
        if (key === 'presentationPriority') {
            if (typeof item !== 'number' || !Number.isFinite(item)) {
                throw invalid(`${path}.${key}`, 'must be a finite number');
            }
        }
        else if (typeof item !== 'boolean') {
            throw invalid(`${path}.${key}`, `must be a boolean (got ${describe(item)})`);
        }
        out[key] = item;
    }
    return out;
}
export function expectTags(value, path) {
    if (!Array.isArray(value)) {
        throw invalid(path, `must be an array of strings (got ${describe(value)})`);
    }
    const seen = new Set();
    for (const [i, tag] of value.entries()) {
        const text = expectNonBlank(tag, `${path}[${i}]`);
        if (seen.has(text)) {
            throw invalid(`${path}[${i}]`, `repeats the tag "${text}"`);
        }
        seen.add(text);
    }
    return Object.freeze([...seen]);
}
export function expectIdList(value, path) {
    if (!Array.isArray(value)) {
        throw invalid(path, `must be an array of IDs (got ${describe(value)})`);
    }
    const seen = new Set();
    for (const [i, item] of value.entries()) {
        const id = expectId(item, `${path}[${i}]`);
        if (seen.has(id)) {
            throw invalid(`${path}[${i}]`, `repeats the ID "${id}"`);
        }
        seen.add(id);
    }
    return Object.freeze([...seen]);
}
//# sourceMappingURL=validate.js.map