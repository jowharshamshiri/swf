import { VERSIONED_ID } from '@swf/core';
import { ATTACH_STRATEGIES, FIDELITY_ORDER } from '@swf/surfaces';
const STRATEGIES = ATTACH_STRATEGIES;
const FIDELITIES = FIDELITY_ORDER;
/** Every {@link LayerCategory}, in the order the type lists them. */
export const LAYER_CATEGORIES = [
    'content-native',
    'content-raster',
    'proxy',
    'placeholder',
    'chrome',
    'overlay',
];
const CLIPS = ['none', 'rect', 'path'];
const TRANSFORMS = ['translate', 'affine-2d', 'perspective-3d', 'mesh'];
const LAYERINGS = ['dom', 'raster', 'dom-and-raster'];
export const clipRank = (c) => CLIPS.indexOf(c);
export const transformRank = (t) => TRANSFORMS.indexOf(t);
export const fidelityRank = (f) => FIDELITIES.indexOf(f);
function fields(value, allowed, what) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return `${what} must be an object`;
    }
    const unknownKey = Object.keys(value).find((k) => !allowed.includes(k));
    return unknownKey === undefined
        ? value
        : `${what}.${unknownKey} is not a known capability`;
}
function oneOf(record, key, allowed, what) {
    const value = record[key];
    return typeof value === 'string' && allowed.includes(value)
        ? null
        : `${what}.${key} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`;
}
function bools(record, keys, what) {
    const bad = keys.find((k) => typeof record[k] !== 'boolean');
    return bad === undefined ? null : `${what}.${bad} must be a boolean`;
}
/**
 * Why a renderer's capabilities are malformed or self-contradictory, or null when valid: the
 * first problem, in words naming the field (`renderer capabilities.<field>`). It accepts any value
 * and never throws; an unknown field is a problem too. Registration refuses capabilities it
 * faults.
 */
export function rendererCapabilitiesIssue(value) {
    const what = 'renderer capabilities';
    const record = fields(value, [
        'handleKinds',
        'transformMode',
        'clipping',
        'hitMapping',
        'layering',
        'resourceOwnership',
        'recovery',
    ], what);
    if (typeof record === 'string') {
        return record;
    }
    const shape = oneOf(record, 'transformMode', TRANSFORMS, what) ??
        oneOf(record, 'clipping', CLIPS, what) ??
        oneOf(record, 'layering', LAYERINGS, what) ??
        oneOf(record, 'resourceOwnership', ['renderer', 'host'], what) ??
        oneOf(record, 'recovery', ['restore', 'rebuild', 'none'], what) ??
        bools(record, ['hitMapping'], what);
    if (shape !== null) {
        return shape;
    }
    const kinds = record['handleKinds'];
    if (typeof kinds !== 'object' || kinds === null || Array.isArray(kinds)) {
        return `${what}.handleKinds must map handle kinds to fidelity`;
    }
    const entries = Object.entries(kinds);
    if (entries.length === 0) {
        return `${what}.handleKinds must name at least one handle kind`;
    }
    for (const [kind, fidelity] of entries) {
        if (!STRATEGIES.includes(kind)) {
            return `${what}.handleKinds.${kind} is not a handle kind (${STRATEGIES.join(', ')})`;
        }
        if (typeof fidelity !== 'string' || !FIDELITIES.includes(fidelity)) {
            return `${what}.handleKinds.${kind} must be a fidelity (${FIDELITIES.join(', ')})`;
        }
    }
    const c = value;
    if (c.handleKinds['native-dom'] !== undefined && c.layering === 'raster') {
        return `${what}: native-dom handles need a DOM layer, but layering is raster`;
    }
    if (c.handleKinds.drawable !== undefined && c.layering === 'dom') {
        return `${what}: drawable handles need a raster layer, but layering is dom`;
    }
    if (c.handleKinds['native-dom'] === 'exact' && c.transformMode !== 'mesh') {
        return `${what}: native-dom content cannot be exact without mesh warping`;
    }
    if (c.handleKinds.drawable === 'native' || c.handleKinds['proxy-only'] === 'native') {
        return `${what}: only native-dom content can have native fidelity`;
    }
    const proxy = c.handleKinds['proxy-only'];
    if (proxy !== undefined && proxy !== 'proxy' && proxy !== 'unsupported') {
        return `${what}: proxy-only handles cannot be presented better than as proxies`;
    }
    return null;
}
/**
 * Why a compositor's capabilities are malformed or self-contradictory, or null when valid: the
 * first problem, in words naming the field (`compositor capabilities.<field>`). It accepts any
 * value and never throws; an unknown field is a problem too. Registration refuses capabilities it
 * faults.
 */
export function compositorCapabilitiesIssue(value) {
    const what = 'compositor capabilities';
    const record = fields(value, [
        'layerCategories',
        'ordering',
        'masking',
        'transparency',
        'clipping',
        'overlays',
        'interpolation',
        'directNative',
        'multiViewport',
        'occlusion',
    ], what);
    if (typeof record === 'string') {
        return record;
    }
    const shape = oneOf(record, 'ordering', ['explicit', 'dom-order'], what) ??
        oneOf(record, 'clipping', CLIPS, what) ??
        oneOf(record, 'occlusion', ['depth', 'layer-order'], what) ??
        bools(record, ['masking', 'transparency', 'overlays', 'interpolation', 'directNative', 'multiViewport'], what);
    if (shape !== null) {
        return shape;
    }
    const categories = record['layerCategories'];
    if (!Array.isArray(categories)) {
        return `${what}.layerCategories must be an array`;
    }
    const seen = new Set();
    for (const category of categories) {
        if (typeof category !== 'string' ||
            !LAYER_CATEGORIES.includes(category)) {
            return `${what}.layerCategories has ${JSON.stringify(category)}, not a layer category`;
        }
        if (seen.has(category)) {
            return `${what}.layerCategories repeats ${category}`;
        }
        seen.add(category);
    }
    // Every compositor must be able to show an honest placeholder and keep chrome apart.
    for (const required of ['placeholder', 'chrome']) {
        if (!seen.has(required)) {
            return `${what}.layerCategories must include ${required}`;
        }
    }
    const c = value;
    if (seen.has('content-native') !== c.directNative) {
        return `${what}: a content-native layer and direct native presentation go together`;
    }
    if (seen.has('overlay') !== c.overlays) {
        return `${what}: an overlay layer and overlay support go together`;
    }
    return null;
}
/**
 * Why a projection profile is malformed, or null when valid: the first problem, in words naming
 * the field (`projection profile.<field>`). It accepts any value and never throws; an unknown
 * field is a problem too.
 */
export function projectionProfileIssue(value) {
    const what = 'projection profile';
    const record = fields(value, ['id', 'mapping', 'seamWrapping', 'exactInverse'], what);
    if (typeof record === 'string') {
        return record;
    }
    if (typeof record['id'] !== 'string' || !VERSIONED_ID.test(record['id'])) {
        return `${what}.id must be a versioned ID "<name>/<version>" (got ${JSON.stringify(record['id'])})`;
    }
    return (oneOf(record, 'mapping', ['affine', 'nonlinear'], what) ??
        bools(record, ['seamWrapping', 'exactInverse'], what));
}
export function isVersionedId(value) {
    return typeof value === 'string' && VERSIONED_ID.test(value);
}
//# sourceMappingURL=capabilities.js.map