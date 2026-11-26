/** Fidelity levels, worst first; frozen. */
export const FIDELITY_ORDER = Object.freeze([
    'unsupported',
    'proxy',
    'approximate',
    'exact',
    'native',
]);
/** Interaction support levels, least first; frozen. */
export const INTERACTION_ORDER = Object.freeze([
    'none',
    'partial',
    'full',
]);
const RESIZE_ORDER = ['none', 'spatial', 'intrinsic'];
const SHARING_ORDER = ['single-owner', 'shared'];
/** Every attach strategy, in no rank order: none is better than another; frozen. */
export const ATTACH_STRATEGIES = Object.freeze([
    'native-dom',
    'drawable',
    'proxy-only',
]);
const STRATEGIES = ATTACH_STRATEGIES;
const BOOLEAN_FIELDS = [
    'uvAddressing',
    'transparency',
    'clipping',
    'cursorMapping',
    'safeDetach',
    'rebinding',
    'placeholder',
    'snapshotHooks',
];
const FIELDS = [
    'attachStrategy',
    'nativeInteraction',
    'transformFidelity',
    'resize',
    'viewportSharing',
    ...BOOLEAN_FIELDS,
];
function oneOf(value, allowed, name) {
    return typeof value === 'string' && allowed.includes(value)
        ? null
        : `${name} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`;
}
/**
 * Why a capability descriptor is malformed or self-contradictory, or null when it is valid.
 * Every field is required; unknown fields are rejected. The reason names the field, as
 * `capabilities.<field> ...`, or states the contradiction: native interaction or native fidelity
 * without `native-dom`; a `proxy-only` endpoint claiming better than proxy fidelity or UV
 * addressing; cursor mapping without UV addressing; rebinding without safe detachment.
 */
export function capabilitiesIssue(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return 'capabilities must be an object';
    }
    const record = value;
    for (const key of Object.keys(record)) {
        if (!FIELDS.includes(key)) {
            return `capabilities.${key} is not a known capability`;
        }
    }
    const shape = oneOf(record['attachStrategy'], STRATEGIES, 'attachStrategy') ??
        oneOf(record['nativeInteraction'], INTERACTION_ORDER, 'nativeInteraction') ??
        oneOf(record['transformFidelity'], FIDELITY_ORDER, 'transformFidelity') ??
        oneOf(record['resize'], RESIZE_ORDER, 'resize') ??
        oneOf(record['viewportSharing'], SHARING_ORDER, 'viewportSharing') ??
        BOOLEAN_FIELDS.map((key) => typeof record[key] === 'boolean' ? null : `${key} must be a boolean`).find((issue) => issue !== null) ??
        null;
    if (shape !== null) {
        return `capabilities.${shape}`;
    }
    return contradiction(value);
}
/** The rules that keep a descriptor honest: no claim that its attach strategy cannot back. */
function contradiction(c) {
    if (c.nativeInteraction !== 'none' && c.attachStrategy !== 'native-dom') {
        return 'native interaction requires the native-dom attach strategy';
    }
    if (c.transformFidelity === 'native' && c.attachStrategy !== 'native-dom') {
        return 'native transform fidelity requires the native-dom attach strategy';
    }
    if (c.attachStrategy === 'proxy-only') {
        if (c.transformFidelity !== 'proxy' && c.transformFidelity !== 'unsupported') {
            return 'a proxy-only endpoint cannot claim better than proxy fidelity';
        }
        if (c.uvAddressing) {
            return 'a proxy-only endpoint cannot offer UV addressing';
        }
    }
    if (c.cursorMapping && !c.uvAddressing) {
        return 'cursor mapping requires UV addressing';
    }
    if (c.rebinding && !c.safeDetach) {
        return 'rebinding requires safe detachment';
    }
    return null;
}
const rank = (order, value) => order.indexOf(value);
/**
 * The capabilities in `actual` that exceed `declared`, by field name, in the order of
 * {@link SurfaceCapabilities}' fields. Empty when `actual` stays within the declaration: the same
 * attach strategy, no ranked capability better than declared (`single-owner` ranks below
 * `shared`), and no boolean capability true that the declaration leaves false. Both descriptors
 * are taken to be valid. Returns a fresh array.
 */
export function exceededCapabilities(declared, actual) {
    const out = [];
    if (actual.attachStrategy !== declared.attachStrategy) {
        out.push('attachStrategy');
    }
    if (rank(INTERACTION_ORDER, actual.nativeInteraction) >
        rank(INTERACTION_ORDER, declared.nativeInteraction)) {
        out.push('nativeInteraction');
    }
    if (rank(FIDELITY_ORDER, actual.transformFidelity) >
        rank(FIDELITY_ORDER, declared.transformFidelity)) {
        out.push('transformFidelity');
    }
    if (rank(RESIZE_ORDER, actual.resize) > rank(RESIZE_ORDER, declared.resize)) {
        out.push('resize');
    }
    if (rank(SHARING_ORDER, actual.viewportSharing) > rank(SHARING_ORDER, declared.viewportSharing)) {
        out.push('viewportSharing');
    }
    for (const key of BOOLEAN_FIELDS) {
        if (actual[key] && !declared[key]) {
            out.push(key);
        }
    }
    return out;
}
/** A frozen copy of a valid descriptor, so later mutation by its author cannot change it. */
export function freezeCapabilities(c) {
    return Object.freeze({
        attachStrategy: c.attachStrategy,
        nativeInteraction: c.nativeInteraction,
        uvAddressing: c.uvAddressing,
        transformFidelity: c.transformFidelity,
        transparency: c.transparency,
        clipping: c.clipping,
        cursorMapping: c.cursorMapping,
        resize: c.resize,
        viewportSharing: c.viewportSharing,
        safeDetach: c.safeDetach,
        rebinding: c.rebinding,
        placeholder: c.placeholder,
        snapshotHooks: c.snapshotHooks,
    });
}
//# sourceMappingURL=capabilities.js.map