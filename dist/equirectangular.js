import { length, mat4InvertAffine, mat4TransformDirection, mat4TransformPoint, normalize, sub, } from '@swf/math';
import { fragmentId } from '@swf/presentation';
import { PROJECTION_API_VERSION } from './contract.js';
const TWO_PI = 2 * Math.PI;
/** Angular slack for edges that are inclusive, in radians of arc. */
const EPS = 1e-12;
/** Outline samples per edge of a surface. */
const SAMPLES_PER_EDGE = 16;
/**
 * The angular radius of each pole band of the equirectangular projection, in radians: 2⁻²⁶, the
 * square root of a double's epsilon. A direction this close to straight up or down (in the
 * camera's frame) has a horizontal part so small that rounding through the camera's transform,
 * a few parts in 10¹⁶, changes its longitude by up to about 10⁻⁷ radians; within the band its
 * longitude is noise, and beyond it the longitude holds to that much.
 *
 * So the projection takes everything within the band for the pole, both ways: `projectDirection`
 * reports a direction whose angle from a pole is at most this as `singular`, imaged at the
 * centre of that pole's edge row; `unprojectPoint` gives a point whose row lies within this of a
 * pole the ray straight up or down, with latitude ±π/2 and its column's longitude. A view shows
 * the poles when its top and bottom rows reach their bands, that is when its vertical angle is
 * at least π − 2 × the band.
 */
export const EQUIRECTANGULAR_POLE_BAND = 2 ** -26;
/**
 * The equirectangular module's default configuration, frozen: the full circle across and 120°
 * down, so the poles are not shown.
 */
export const DEFAULT_EQUIRECTANGULAR_CONFIG = Object.freeze({
    /** The full 360°, with a wrapping seam behind the camera. */
    horizontal: 360,
    /** 60° above and below the horizon. */
    vertical: 120,
});
function configIssue(config) {
    if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        return 'must be an object { horizontal, vertical } in degrees';
    }
    const keys = Object.keys(config);
    const unknown = keys.find((k) => k !== 'horizontal' && k !== 'vertical');
    if (unknown !== undefined) {
        return `${unknown} is not a setting (expected horizontal and vertical)`;
    }
    const record = config;
    const angle = (key, max) => {
        const value = record[key];
        return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max
            ? null
            : `${key} must be a number of degrees in (0, ${String(max)}] (got ${JSON.stringify(value)})`;
    };
    return angle('horizontal', 360) ?? angle('vertical', 180);
}
/**
 * The equirectangular projection: longitude across, latitude down. A direction in the camera's
 * frame has longitude `atan2(x, -z)` (positive to the right) and latitude `atan2(y, √(x² + z²))`
 * (positive up); the viewport spans the configured angles centred on the camera's heading. At
 * 360° the left and right edges meet at a seam behind the camera; at 180° vertically, the top and
 * bottom rows are the poles. Within {@link EQUIRECTANGULAR_POLE_BAND} of a pole, where longitude
 * is lost to rounding, a direction is the pole and a point unprojects to it. Its inverse is exact
 * everywhere in the image.
 *
 * Its configuration is an {@link EquirectangularConfig} in degrees; `configIssue` names a missing,
 * out-of-range or unknown setting, and `create` throws a RangeError for one. A surface crossing the
 * seam is placed as one fragment on each side, both carrying the whole surface's corners; the one
 * showing the surface's centre (or else the widest) is its native owner. With continuity, an
 * interaction ray's longitude follows the drag across the seam instead of jumping a full turn. A
 * surface whose outline circles a pole is one approximate fragment the full width of the image.
 * Its methods throw a RangeError for a view whose camera matrix cannot be inverted, and
 * `projectDirection` for a zero or non-finite direction.
 */
export const equirectangular = Object.freeze({
    id: 'equirectangular/1',
    apiVersion: PROJECTION_API_VERSION,
    profile: Object.freeze({
        id: 'equirectangular/1',
        mapping: 'nonlinear',
        seamWrapping: true,
        exactInverse: true,
    }),
    defaultConfig: DEFAULT_EQUIRECTANGULAR_CONFIG,
    configIssue,
    create(config) {
        const issue = configIssue(config);
        if (issue !== null) {
            throw new RangeError(`equirectangular configuration ${issue}`);
        }
        const c = config;
        return new Equirectangular((c.horizontal * Math.PI) / 180, (c.vertical * Math.PI) / 180);
    },
});
const frames = new WeakMap();
function frameOf(view) {
    let frame = frames.get(view);
    if (frame === undefined) {
        const toCamera = mat4InvertAffine(view.camera);
        if (toCamera === null) {
            throw new RangeError(`the camera of viewport "${view.viewportId}" is singular`);
        }
        frame = { eye: mat4TransformPoint(view.camera, [0, 0, 0]), toCamera };
        frames.set(view, frame);
    }
    return frame;
}
/** Whether an angle from the nearer pole, in radians, lies within that pole's band. */
function inPoleBand(colatitude) {
    return colatitude <= EQUIRECTANGULAR_POLE_BAND;
}
function anglesOf(d) {
    const horizontal = Math.hypot(d[0], d[2]);
    return {
        longitude: Math.atan2(d[0], -d[2]),
        latitude: Math.atan2(d[1], horizontal),
        singular: inPoleBand(Math.atan2(horizontal, Math.abs(d[1]))),
    };
}
/** `a` limited to [-limit, limit]. */
function clamp(a, limit) {
    return Math.max(-limit, Math.min(limit, a));
}
/** `a` shifted by a multiple of 2π into (-π, π]. */
function wrapPi(a) {
    const r = a - TWO_PI * Math.round(a / TWO_PI);
    return r <= -Math.PI ? r + TWO_PI : r;
}
class Equirectangular {
    id = 'equirectangular/1';
    #h;
    #v;
    #fullCircle;
    #poles;
    constructor(horizontal, vertical) {
        this.#h = horizontal;
        this.#v = vertical;
        this.#fullCircle = horizontal >= TWO_PI - EPS;
        this.#poles = inPoleBand(Math.PI / 2 - vertical / 2);
    }
    describeDomain() {
        return Object.freeze({
            horizontalCoverage: this.#h,
            verticalCoverage: this.#v,
            seamWrapping: this.#fullCircle,
            fullCircle: this.#fullCircle,
            poles: this.#poles,
            orientationDependent: true,
            nonInjective: this.#fullCircle || this.#poles,
            inverse: 'exact',
            maxInverseError: 0,
        });
    }
    projectDirection(direction, view) {
        if (!(length(direction) > 0)) {
            throw new RangeError('a projected direction must be finite and non-zero');
        }
        const d = mat4TransformDirection(frameOf(view).toCamera, direction);
        const { longitude, latitude, singular } = anglesOf(d);
        const behind = d[2] > 0;
        if (singular) {
            // A pole is the whole top or bottom row, when the view reaches it; its centre stands for it.
            return {
                images: this.#poles ? [[view.width / 2, latitude > 0 ? 0 : view.height]] : [],
                singular: true,
                behind,
            };
        }
        if (Math.abs(latitude) > this.#v / 2 + EPS) {
            return { images: [], singular: false, behind };
        }
        // Directions within the edge slack land on the edge, so every image is inside the image.
        const y = this.#y(clamp(latitude, this.#v / 2), view);
        const images = [];
        for (const k of [-1, 0, 1]) {
            const l = longitude + TWO_PI * k;
            if (this.#across(l, latitude)) {
                images.push([this.#x(clamp(l, this.#h / 2), view), y]);
            }
        }
        return { images, singular: false, behind };
    }
    unprojectPoint(x, y, view) {
        if (!Number.isFinite(x) ||
            !Number.isFinite(y) ||
            x < 0 ||
            x > view.width ||
            y < 0 ||
            y > view.height) {
            return {
                kind: 'outside',
                reason: `(${String(x)}, ${String(y)}) is outside the ${String(view.width)}×${String(view.height)} image`,
            };
        }
        const longitude = (x / view.width - 0.5) * this.#h;
        const row = (0.5 - y / view.height) * this.#v;
        // A row within a pole band is the pole itself, whatever the column.
        const pole = inPoleBand(Math.PI / 2 - Math.abs(row));
        const latitude = pole ? Math.sign(row) * (Math.PI / 2) : row;
        const cos = Math.cos(row);
        const local = pole
            ? [0, Math.sign(row), 0]
            : [cos * Math.sin(longitude), Math.sin(row), -cos * Math.cos(longitude)];
        return {
            kind: 'ray',
            ray: {
                origin: frameOf(view).eye,
                direction: normalize(mat4TransformDirection(view.camera, local)),
            },
            error: 0,
            longitude,
            latitude,
        };
    }
    interactionRay(x, y, view, continuity) {
        const result = this.unprojectPoint(x, y, view);
        if (result.kind !== 'ray' || continuity === undefined || !this.#fullCircle) {
            return result;
        }
        // Choose the branch of the longitude nearest the drag's previous one, so a drag across the
        // seam keeps moving the same way instead of jumping a full turn.
        const branch = Math.round((continuity.previousLongitude - result.longitude) / TWO_PI);
        return { ...result, longitude: result.longitude + TWO_PI * branch };
    }
    projectGeometry(geometry, view) {
        if (this.#beyond(geometry, view)) {
            return [];
        }
        const outline = this.#outline(geometry, view);
        if (outline === null) {
            return [];
        }
        const { lo, hi, latLo, latHi, centre, depth, encirclesPole, corners } = outline;
        const top = Math.min(latHi, this.#v / 2);
        const bottom = Math.max(latLo, -this.#v / 2);
        if (top < bottom) {
            return [];
        }
        const make = (ordinal, from, to, owner, exact, shape) => {
            const x0 = this.#x(from, view);
            const y0 = this.#y(top, view);
            return Object.freeze({
                id: fragmentId(view.viewportId, geometry.surfaceId, ordinal),
                surfaceId: geometry.surfaceId,
                viewportId: view.viewportId,
                ordinal,
                bounds: [x0, y0, this.#x(to, view) - x0, this.#y(bottom, view) - y0],
                corners: shape,
                depth,
                geometricFidelity: exact ? 'exact' : 'approximate',
                nativeOwner: owner,
            });
        };
        if (encirclesPole) {
            // Overhead or underfoot all around: the surface spans every longitude near the pole.
            return [make(0, -this.#h / 2, this.#h / 2, true, false, null)];
        }
        const edgeOn = hi - lo <= EPS;
        const pieces = [];
        for (const k of [-1, 0, 1]) {
            const from = Math.max(lo + TWO_PI * k, -this.#h / 2);
            const to = Math.min(hi + TWO_PI * k, this.#h / 2);
            // A piece only touching an edge of the image shows nothing, unless the surface is seen
            // edge-on (no width at all), in which case its one image is kept.
            if (to - from > EPS || (edgeOn && from <= to + EPS && pieces.length === 0)) {
                pieces.push({ k, from, to: Math.max(from, to) });
            }
        }
        if (pieces.length === 0) {
            return [];
        }
        pieces.sort((a, b) => a.from - b.from);
        const owner = ownerPiece(pieces, centre);
        // Every piece carries the whole surface's corners on its own branch (possibly beyond the
        // image), so a backend can place the surface and clip it to the piece's bounds.
        return pieces.map((p, ordinal) => {
            const point = ([l, phi]) => [
                this.#x(l + TWO_PI * p.k, view),
                this.#y(phi, view),
            ];
            const shape = [
                point(corners[0]),
                point(corners[1]),
                point(corners[2]),
                point(corners[3]),
            ];
            return make(ordinal, p.from, p.to, ordinal === owner, true, shape);
        });
    }
    clipVisibility(geometry, view) {
        const outline = this.#outline(geometry, view);
        const frame = frameOf(view);
        const centreDirection = mat4TransformDirection(frame.toCamera, sub(mat4TransformPoint(geometry.world, centreOf(geometry)), frame.eye));
        const behind = centreDirection[2] > 0;
        if (outline === null) {
            return { state: 'outside', coverage: 0, behind, crossesSeam: false };
        }
        let inside = 0;
        for (const [l, phi] of outline.samples) {
            const latitudeIn = Math.abs(phi) <= this.#v / 2 + EPS;
            const longitudeIn = outline.encirclesPole || [-1, 0, 1].some((k) => this.#across(l + TWO_PI * k, phi));
            if (latitudeIn && longitudeIn) {
                inside += 1;
            }
        }
        const coverage = inside / outline.samples.length;
        return {
            state: coverage === 1 ? 'inside' : coverage === 0 ? 'outside' : 'partial',
            coverage,
            behind,
            crossesSeam: this.#fullCircle &&
                (outline.encirclesPole || outline.lo < -Math.PI || outline.hi > Math.PI),
        };
    }
    /**
     * Whether a direction at this longitude and latitude lies within the image across, its side
     * edges (the seam, at 360°) included to within EPS of arc. Toward a pole the meridians converge,
     * so that arc is ever more longitude: rounding moves a direction near a pole by a hair of arc
     * but by far more longitude, and a direction on a side edge stays on it.
     */
    #across(longitude, latitude) {
        return Math.abs(longitude) <= this.#h / 2 + EPS / Math.cos(latitude);
    }
    #x(longitude, view) {
        return (longitude / this.#h + 0.5) * view.width;
    }
    #y(latitude, view) {
        return (0.5 - latitude / this.#v) * view.height;
    }
    /**
     * Whether a surface lies wholly beyond the image, decided from its world bounds alone (NFR-017):
     * the sphere round its bounding box, seen from the eye, covers a cap of the sky; when that cap
     * lies above or below the image, or (short of the full circle) to either side of it, no part of
     * the surface can show, and its outline need not be sampled. A cap the eye is inside, or one
     * reaching a pole, is never ruled out.
     */
    #beyond(geometry, view) {
        const { min, max } = geometry.worldBounds;
        const centre = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
        const radius = length(sub(max, min)) / 2;
        const frame = frameOf(view);
        const d = mat4TransformDirection(frame.toCamera, sub(centre, frame.eye));
        const distance = length(d);
        if (!(distance > radius)) {
            return false;
        }
        const cap = Math.asin(radius / distance);
        const { longitude, latitude } = anglesOf(d);
        if (latitude - cap > this.#v / 2 + EPS || latitude + cap < -this.#v / 2 - EPS) {
            return true;
        }
        if (this.#fullCircle || Math.abs(latitude) + cap >= Math.PI / 2) {
            return false;
        }
        // The cap's half-width in longitude at its latitude.
        const across = Math.asin(Math.min(1, Math.sin(cap) / Math.cos(latitude)));
        return Math.abs(longitude) - across > this.#h / 2 + EPS;
    }
    /**
     * The surface's outline as unwrapped angles: samples around its local bounds, followed
     * continuously in longitude, centred so their mean lies in (-π, π]. Null when the surface is
     * beyond the far distance or the camera is within the near distance of it.
     */
    #outline(geometry, view) {
        const frame = frameOf(view);
        const world = (p) => mat4TransformPoint(geometry.world, p);
        const centreWorld = world(centreOf(geometry));
        const depth = length(sub(centreWorld, frame.eye));
        if (depth < view.near || (view.far !== null && depth > view.far)) {
            return null;
        }
        const { min, max } = geometry.localBounds;
        const z = (min[2] + max[2]) / 2;
        // Top-left, top-right, bottom-right, bottom-left, each edge running to the next corner.
        const topLeft = [min[0], max[1], z];
        const topRight = [max[0], max[1], z];
        const bottomRight = [max[0], min[1], z];
        const bottomLeft = [min[0], min[1], z];
        const edges = [
            [topLeft, topRight],
            [topRight, bottomRight],
            [bottomRight, bottomLeft],
            [bottomLeft, topLeft],
        ];
        const raw = [];
        for (const [a, b] of edges) {
            for (let i = 0; i < SAMPLES_PER_EDGE; i++) {
                const t = i / SAMPLES_PER_EDGE;
                const p = world([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z]);
                const d = sub(p, frame.eye);
                if (!(length(d) > 0)) {
                    // The outline passes through the camera, which is within any near distance.
                    return null;
                }
                raw.push(anglesOf(mat4TransformDirection(frame.toCamera, d)));
            }
        }
        const unwrapped = [];
        let previous = null;
        for (const angle of raw) {
            // A pole sample has no longitude of its own; it continues the previous one.
            const l = angle.singular ? (previous ?? 0) : angle.longitude;
            const u = previous === null ? l : previous + wrapPi(l - wrapPi(previous));
            unwrapped.push(u);
            previous = u;
        }
        const first = unwrapped[0] ?? 0;
        const last = unwrapped[unwrapped.length - 1] ?? 0;
        const winding = last + wrapPi(wrapPi(first) - wrapPi(last)) - first;
        const mean = unwrapped.reduce((s, v) => s + v, 0) / unwrapped.length;
        const shift = wrapPi(mean) - mean;
        const longitudes = unwrapped.map((u) => u + shift);
        const latitudes = raw.map((a) => a.latitude);
        const centreAngles = anglesOf(mat4TransformDirection(frame.toCamera, sub(centreWorld, frame.eye)));
        const centreMean = wrapPi(mean);
        const centre = centreAngles.longitude + TWO_PI * Math.round((centreMean - centreAngles.longitude) / TWO_PI);
        const corner = (c) => [
            longitudes[c * SAMPLES_PER_EDGE] ?? 0,
            latitudes[c * SAMPLES_PER_EDGE] ?? 0,
        ];
        // An outline winding once around the camera's vertical encloses a pole: the one on its side.
        const encirclesPole = Math.abs(winding) > Math.PI;
        const north = latitudes.reduce((s, v) => s + v, 0) > 0;
        return {
            lo: Math.min(...longitudes),
            hi: Math.max(...longitudes),
            latLo: encirclesPole && !north ? -Math.PI / 2 : Math.min(...latitudes),
            latHi: encirclesPole && north ? Math.PI / 2 : Math.max(...latitudes),
            centre,
            depth,
            encirclesPole,
            samples: longitudes.map((l, i) => [l, latitudes[i] ?? 0]),
            corners: [corner(0), corner(1), corner(2), corner(3)],
        };
    }
}
/**
 * The piece that owns native interaction: the one showing the surface's centre, or failing that
 * the widest (the first of equals).
 */
function ownerPiece(pieces, centre) {
    const showing = pieces.findIndex((p) => {
        const c = centre + TWO_PI * p.k;
        return c >= p.from - EPS && c <= p.to + EPS;
    });
    if (showing >= 0) {
        return showing;
    }
    let widest = 0;
    pieces.forEach((p, i) => {
        const best = pieces[widest];
        if (best !== undefined && p.to - p.from > best.to - best.from) {
            widest = i;
        }
    });
    return widest;
}
function centreOf(geometry) {
    const { min, max } = geometry.localBounds;
    return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}
//# sourceMappingURL=equirectangular.js.map