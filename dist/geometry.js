import { aabbOfBox, mat4InvertAffine, mat4TransformDirection, mat4TransformPoint, normalize, sub, } from '@swf/math';
import { thrownText } from './errors.js';
import { describe, describeAnswer } from './json.js';
/** The default geometry: a `rect` filling the surface's bounds. The object is frozen. */
export const RECT_GEOMETRY = Object.freeze({ kind: 'rect', params: null });
/** The limits a workspace applies unless its options override them. The object is frozen. */
export const DEFAULT_GEOMETRY_LIMITS = Object.freeze({
    maxParamsBytes: 65_536,
    maxPolygonVertices: 1024,
});
/** UV of a point on the surface rectangle: (0, 0) is top-left, (1, 1) bottom-right. */
function rectUv(point, bounds) {
    return [(point[0] + bounds[0] / 2) / bounds[0], (bounds[1] / 2 - point[1]) / bounds[1]];
}
/** Where the ray crosses the local z = 0 plane in front of its origin. */
function planeHit(ray) {
    const dz = ray.direction[2];
    if (dz === 0) {
        return null;
    }
    const t = -ray.origin[2] / dz;
    if (!(t >= 0)) {
        return null;
    }
    return {
        t,
        point: [ray.origin[0] + t * ray.direction[0], ray.origin[1] + t * ray.direction[1], 0],
    };
}
const PLANAR_NORMAL = Object.freeze([0, 0, 1]);
/**
 * A planar rectangle filling the surface's width and height, facing local +Z. It takes no params
 * (null).
 */
export const rectGeometry = Object.freeze({
    kind: 'rect',
    fidelity: 'exact',
    validate: (params) => (params === null ? null : 'a rect takes no params (null)'),
    localBounds: (_params, bounds) => aabbOfBox(IDENTITY, bounds),
    normal: () => PLANAR_NORMAL,
    intersect(_params, bounds, ray) {
        const hit = planeHit(ray);
        if (hit === null) {
            return null;
        }
        const [x, y] = hit.point;
        if (Math.abs(x) > bounds[0] / 2 || Math.abs(y) > bounds[1] / 2) {
            return null;
        }
        return { t: hit.t, point: hit.point, uv: rectUv(hit.point, bounds) };
    },
});
function polygonPoints(params) {
    return params.points;
}
function polygonIssue(params, bounds, limits) {
    if (typeof params !== 'object' || params === null || Array.isArray(params)) {
        return `polygon params must be { points: [[x, y], ...] } (got ${describe(params)})`;
    }
    const keys = Object.keys(params);
    if (keys.length !== 1 || keys[0] !== 'points') {
        return 'polygon params take exactly one field, points';
    }
    const raw = params['points'];
    if (!Array.isArray(raw) || raw.length < 3) {
        return 'polygon points must be an array of at least 3 [x, y] pairs';
    }
    if (raw.length > limits.maxPolygonVertices) {
        return `polygon has ${raw.length} points, more than the limit of ${limits.maxPolygonVertices}`;
    }
    const hw = bounds[0] / 2;
    const hh = bounds[1] / 2;
    for (const [i, p] of raw.entries()) {
        if (!Array.isArray(p) ||
            p.length !== 2 ||
            typeof p[0] !== 'number' ||
            typeof p[1] !== 'number') {
            return `polygon points[${i}] must be [x, y]`;
        }
        if (Math.abs(p[0]) > hw || Math.abs(p[1]) > hh) {
            return `polygon points[${i}] lies outside the surface bounds`;
        }
    }
    const points = raw;
    if (Math.abs(signedArea(points)) <= 1e-12 * bounds[0] * bounds[1]) {
        return 'polygon has no area';
    }
    const crossing = selfIntersection(points);
    if (crossing !== null) {
        return `polygon edges ${crossing[0]} and ${crossing[1]} cross`;
    }
    return null;
}
function signedArea(points) {
    let sum = 0;
    points.forEach((p, i) => {
        const q = points[(i + 1) % points.length] ?? p;
        sum += p[0] * q[1] - q[0] * p[1];
    });
    return sum / 2;
}
function orientation(a, b, c) {
    const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return v > 0 ? 1 : v < 0 ? -1 : 0;
}
function onSegment(a, b, p) {
    return (Math.min(a[0], b[0]) <= p[0] &&
        p[0] <= Math.max(a[0], b[0]) &&
        Math.min(a[1], b[1]) <= p[1] &&
        p[1] <= Math.max(a[1], b[1]));
}
function segmentsTouch(a, b, c, d) {
    const o1 = orientation(a, b, c);
    const o2 = orientation(a, b, d);
    const o3 = orientation(c, d, a);
    const o4 = orientation(c, d, b);
    if (o1 !== o2 && o3 !== o4) {
        return true;
    }
    return ((o1 === 0 && onSegment(a, b, c)) ||
        (o2 === 0 && onSegment(a, b, d)) ||
        (o3 === 0 && onSegment(c, d, a)) ||
        (o4 === 0 && onSegment(c, d, b)));
}
/** The first pair of non-adjacent edges that touch, or null for a simple polygon. */
function selfIntersection(points) {
    const n = points.length;
    const at = (i) => points[i % n] ?? [0, 0];
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const adjacent = j === i + 1 || (i === 0 && j === n - 1);
            if (!adjacent && segmentsTouch(at(i), at(i + 1), at(j), at(j + 1))) {
                return [i, j];
            }
        }
    }
    return null;
}
/** Even-odd containment; points on an edge count as inside. */
function insidePolygon(points, x, y) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const a = points[i] ?? [0, 0];
        const b = points[j] ?? [0, 0];
        if (orientation(a, b, [x, y]) === 0 && onSegment(a, b, [x, y])) {
            return true;
        }
        if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) {
            inside = !inside;
        }
    }
    return inside;
}
/**
 * A planar polygon on the surface, facing local +Z. Its UV space is the surface rectangle, so the
 * polygon masks part of what the surface shows rather than remapping it. Its params are exactly
 * `{ points }`: at least 3 and at most `maxPolygonVertices` `[x, y]` pairs in the local z = 0
 * plane (+Y up), each within the surface's bounds, enclosing a non-zero area with no two
 * non-adjacent edges touching.
 */
export const polygonGeometry = Object.freeze({
    kind: 'polygon',
    fidelity: 'exact',
    validate: polygonIssue,
    localBounds(params, bounds) {
        const points = polygonPoints(params);
        const xs = points.map((p) => p[0]);
        const ys = points.map((p) => p[1]);
        return {
            min: [Math.min(...xs), Math.min(...ys), -bounds[2] / 2],
            max: [Math.max(...xs), Math.max(...ys), bounds[2] / 2],
        };
    },
    normal: () => PLANAR_NORMAL,
    intersect(params, bounds, ray) {
        const hit = planeHit(ray);
        if (hit === null || !insidePolygon(polygonPoints(params), hit.point[0], hit.point[1])) {
            return null;
        }
        return { t: hit.t, point: hit.point, uv: rectUv(hit.point, bounds) };
    },
});
const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const BUILT_IN = new Map([
    ['rect', rectGeometry],
    ['polygon', polygonGeometry],
]);
const CUSTOM_KIND = /^(?:host\.\S+|ext\.[A-Za-z0-9_-]+\.\S+)$/;
/** The geometry kinds a workspace knows: the built-ins plus those the host registers. */
export class GeometryRegistry {
    #providers = new Map(BUILT_IN);
    get(kind) {
        return this.#providers.get(kind);
    }
    /**
     * Adds a provider; throws a TypeError naming the problem when its kind is not namespaced, is
     * taken, or the provider is malformed. The returned function removes it (safe to call twice).
     */
    register(provider) {
        const p = provider;
        if (typeof p !== 'object' || p === null) {
            throw new TypeError(`geometry provider must be an object (got ${describe(p)})`);
        }
        const kind = p.kind;
        if (typeof kind !== 'string' || !CUSTOM_KIND.test(kind)) {
            throw new TypeError(`geometry kind ${JSON.stringify(kind)} must be namespaced as "host.<name>" or "ext.<extension-id>.<name>"`);
        }
        if (this.#providers.has(kind)) {
            throw new TypeError(`geometry kind "${kind}" is already registered`);
        }
        for (const method of ['validate', 'localBounds', 'normal', 'intersect']) {
            if (typeof p[method] !== 'function') {
                throw new TypeError(`geometry provider "${kind}" must implement ${method}()`);
            }
        }
        const fidelity = p.fidelity;
        if (fidelity !== 'exact' && fidelity !== 'approximate') {
            throw new TypeError(`geometry provider "${kind}" fidelity must be "exact" or "approximate"`);
        }
        this.#providers.set(kind, provider);
        return () => {
            if (this.#providers.get(kind) === provider) {
                this.#providers.delete(kind);
            }
        };
    }
}
/**
 * What is wrong with `params` for a surface of `bounds`, or null when they are valid: params over
 * the `maxParamsBytes` limit, or what `provider.validate` finds. A validate that throws or answers
 * anything but text or null is reported as the issue, naming the provider. Transactions and
 * restore both hold geometry to this one check.
 */
export function geometryParamsIssue(provider, params, bounds, limits) {
    const size = jsonByteLength(params);
    if (size > limits.maxParamsBytes) {
        return `their JSON is ${size} bytes, more than the maxParamsBytes limit of ${limits.maxParamsBytes}`;
    }
    let issue;
    try {
        issue = provider.validate(params, bounds, limits);
    }
    catch (error) {
        return `geometry provider "${provider.kind}": its validate threw: ${thrownText(error)}`;
    }
    if (issue === null || typeof issue === 'string') {
        return issue;
    }
    return `geometry provider "${provider.kind}": its validate returned ${describeAnswer(issue)}, not text or null`;
}
/** Places a descriptor in the world through `world`, the surface-local to world matrix. */
export function resolveGeometry(surfaceId, descriptor, bounds, world, registry) {
    const provider = registry.get(descriptor.kind);
    const effective = provider ?? rectGeometry;
    const params = provider === undefined ? null : descriptor.params;
    const inverse = mat4InvertAffine(world);
    if (inverse === null) {
        throw new Error(`surface "${surfaceId}" has a singular world placement`);
    }
    const localBounds = effective.localBounds(params, bounds);
    const localNormal = effective.normal(params, bounds);
    // Normals transform by the inverse transpose of the linear part.
    const normal = localNormal === null
        ? null
        : normalize([
            inverse[0] * localNormal[0] + inverse[1] * localNormal[1] + inverse[2] * localNormal[2],
            inverse[4] * localNormal[0] + inverse[5] * localNormal[1] + inverse[6] * localNormal[2],
            inverse[8] * localNormal[0] + inverse[9] * localNormal[1] + inverse[10] * localNormal[2],
        ]);
    const centre = [
        (localBounds.min[0] + localBounds.max[0]) / 2,
        (localBounds.min[1] + localBounds.max[1]) / 2,
        (localBounds.min[2] + localBounds.max[2]) / 2,
    ];
    const size = sub(localBounds.max, localBounds.min);
    const boxWorld = [
        world[0], world[1], world[2], world[3],
        world[4], world[5], world[6], world[7],
        world[8], world[9], world[10], world[11],
        ...mat4TransformPoint(world, centre), 1,
    ]; // prettier-ignore
    return Object.freeze({
        surfaceId,
        kind: descriptor.kind,
        supported: provider !== undefined,
        fidelity: provider === undefined ? 'approximate' : provider.fidelity,
        world,
        localBounds,
        worldBounds: aabbOfBox(boxWorld, size),
        normal,
        intersect(ray) {
            const local = {
                origin: mat4TransformPoint(inverse, ray.origin),
                direction: mat4TransformDirection(inverse, ray.direction),
            };
            const hit = effective.intersect(params, bounds, local);
            if (hit === null) {
                return null;
            }
            // An affine map keeps the ray parameter, so with a unit world direction t is the distance.
            return {
                distance: hit.t,
                point: mat4TransformPoint(world, hit.point),
                localPoint: hit.point,
                uv: hit.uv,
            };
        },
    });
}
/** The size of a JSON value's text in UTF-8 bytes. */
export function jsonByteLength(value) {
    const text = JSON.stringify(value);
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) {
            bytes += 1;
        }
        else if (code < 0x800) {
            bytes += 2;
        }
        else if (code >= 0xd800 && code <= 0xdbff) {
            bytes += 4;
            i += 1;
        }
        else {
            bytes += 3;
        }
    }
    return bytes;
}
//# sourceMappingURL=geometry.js.map