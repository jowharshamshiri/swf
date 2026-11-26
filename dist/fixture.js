import { createRandom, quatFromAxisAngle } from '@swf/math';
import { cameraRotation } from '@swf/projections';
/** The standard benchmark fixture's counts (§26.1). */
export const STANDARD = Object.freeze({ windows: 250, surfaces: 300, groups: 5 });
/**
 * The stress fixture: twice the standard scene, for observing how far performance degrades
 * (NFR-008), without claiming the standard's frame rates.
 */
export const STRESS = Object.freeze({ windows: 500, surfaces: 600, groups: 5 });
/** The page a fixture is measured in, in CSS pixels: the benchmark's 1920×1080. Frozen. */
export const PAGE = Object.freeze({ width: 1920, height: 1080 });
/** The adapter type of a live element: a plain element, shareable between viewports. */
export const LIVE_ADAPTER = 'swf.bench.live/1';
/** The adapter type of drawn content, which the DOM backend shows as a proxy. */
export const DRAWN_ADAPTER = 'swf.bench.drawn/1';
/** The elevations of the rings windows stand in, in degrees above the horizon. */
const RINGS = Object.freeze([-45, -22.5, 0, 22.5, 45]);
/** How far each nested group is turned within its parent, about the vertical, in degrees. */
const GROUP_TURN = 3;
const RADIANS = Math.PI / 180;
/**
 * The fixture's two viewports, side by side on the 1920×1080 page: one looking ahead, the other
 * behind, each 64° across and 72° down (1/30° per pixel), which shows the middle three rings.
 */
const VIEWPORTS = Object.freeze([
    Object.freeze({
        id: 'ahead',
        cameraId: 'ahead-camera',
        left: 0,
        top: 0,
        width: 960,
        height: 1080,
        heading: 0,
        horizontal: 64,
        vertical: 72,
    }),
    Object.freeze({
        id: 'behind',
        cameraId: 'behind-camera',
        left: 960,
        top: 0,
        width: 960,
        height: 1080,
        heading: 180,
        horizontal: 64,
        vertical: 72,
    }),
]);
/** Why a size cannot be planned, in words, or null when it can; see {@link FixtureSize}. */
export function sizeIssue(size) {
    const whole = (n) => typeof n === 'number' && Number.isInteger(n) && n > 0;
    if (!whole(size.windows) || size.windows % RINGS.length !== 0) {
        return `windows must be a positive multiple of ${String(RINGS.length)} (got ${String(size.windows)})`;
    }
    if (!whole(size.surfaces) || size.surfaces < size.windows || size.surfaces > 2 * size.windows) {
        return `surfaces must be from windows to twice windows (got ${String(size.surfaces)})`;
    }
    if (!whole(size.groups)) {
        return `groups must be a positive whole number (got ${String(size.groups)})`;
    }
    return null;
}
/** A value from the sequence in steps of 1/`per`: exact, so the same on every engine. */
function stepped(random, min, max, per) {
    return random.integer(Math.round(min * per), Math.round(max * per)) / per;
}
/** A heading in (-180, 180], in tenths of a degree. */
function wrapHeading(degrees) {
    const tenths = Math.round(degrees * 10);
    const wrapped = (((tenths + 1800) % 3600) + 3600) % 3600;
    return ((wrapped === 0 ? 3600 : wrapped) - 1800) / 10;
}
/** The surfaces' gap inside a window, and the frame round them, in world units. */
const FRAME = Object.freeze({ side: 0.04, top: 0.08, bottom: 0.04, gap: 0.02 });
/**
 * Plans a fixture. Windows stand in five rings round the camera, evenly spaced with a little
 * jitter, alternate rings offset by half a step; every `windows / (surfaces - windows)`-th window
 * holds two surfaces side by side, the second drawn. Window `i` is in group `i mod groups`, so
 * every depth of nesting holds windows all the way round. The same size and seed give the same
 * fixture on every run and engine.
 *
 * @throws `RangeError` for a size {@link sizeIssue} refuses, or a seed `createRandom` refuses.
 */
export function planFixture(size, seed) {
    const issue = sizeIssue(size);
    if (issue !== null) {
        throw new RangeError(issue);
    }
    const random = createRandom(seed);
    const perRing = size.windows / RINGS.length;
    const pairs = size.surfaces - size.windows;
    const groupIds = Array.from({ length: size.groups }, (_, g) => `group-${String(g + 1)}`);
    const digits = String(size.windows).length;
    const windows = RINGS.flatMap((ring, r) => Array.from({ length: perRing }, (_, k) => {
        const index = r * perRing + k;
        const number = String(index + 1).padStart(digits, '0');
        const id = `window-${number}`;
        const width = stepped(random, 0.5, 0.9, 100);
        const height = stepped(random, 0.32, 0.5, 100);
        const paired = pairs > 0 &&
            Math.floor(((index + 1) * pairs) / size.windows) >
                Math.floor((index * pairs) / size.windows);
        const inner = (w) => Math.round(w * 100) / 100;
        const surfaceHeight = inner(height - FRAME.top - FRAME.bottom);
        const full = inner(width - 2 * FRAME.side);
        const half = inner((full - FRAME.gap) / 2);
        const surfaces = paired
            ? [
                {
                    id: `${id}-a`,
                    adapterTypeId: LIVE_ADAPTER,
                    bindingKey: `bench/${String(seed)}/${number}/a`,
                    x: -(half + FRAME.gap) / 2,
                    width: half,
                    height: surfaceHeight,
                },
                {
                    id: `${id}-b`,
                    adapterTypeId: DRAWN_ADAPTER,
                    bindingKey: `bench/${String(seed)}/${number}/b`,
                    x: (half + FRAME.gap) / 2,
                    width: half,
                    height: surfaceHeight,
                },
            ]
            : [
                {
                    id: `${id}-a`,
                    adapterTypeId: LIVE_ADAPTER,
                    bindingKey: `bench/${String(seed)}/${number}/a`,
                    x: 0,
                    width: full,
                    height: surfaceHeight,
                },
            ];
        return Object.freeze({
            id,
            label: `Window ${number}`,
            groupId: groupIds[index % size.groups] ?? 'group-1',
            heading: wrapHeading(k * (360 / perRing) + (r % 2) * (180 / perRing) + stepped(random, -1, 1, 10)),
            elevation: Math.round((ring + stepped(random, -2, 2, 10)) * 10) / 10,
            distance: stepped(random, 3.5, 6, 100),
            width,
            height,
            surfaces: Object.freeze(surfaces.map((s) => Object.freeze(s))),
        });
    }));
    return Object.freeze({
        size,
        seed,
        groupIds: Object.freeze(groupIds),
        windows: Object.freeze(windows),
        viewports: VIEWPORTS,
        commands: Object.freeze(fixtureCommands(groupIds, windows)),
    });
}
/** How far a group is turned in the world: each nested group turns `GROUP_TURN` more. */
function groupTurn(groupIndex) {
    return (groupIndex + 1) * GROUP_TURN;
}
function fixtureCommands(groupIds, windows) {
    const reach = windows.reduce((most, w) => Math.max(most, w.distance + w.width), 1);
    const groups = groupIds.map((id, g) => ({
        type: 'node.create',
        node: {
            id,
            kind: 'group',
            label: `Group ${String(g + 1)}`,
            ...(g === 0 ? {} : { parentId: groupIds[g - 1] ?? null }),
            bounds: [2 * reach, 2 * reach, 2 * reach],
            transform: {
                position: [0, 0, 0],
                rotation: quatFromAxisAngle([0, 1, 0], -GROUP_TURN * RADIANS),
                scale: [1, 1, 1],
            },
        },
    }));
    const cameras = VIEWPORTS.flatMap((v) => [
        {
            type: 'camera.create',
            camera: { id: v.cameraId, rotation: cameraRotation(v.heading * RADIANS, 0) },
        },
        {
            type: 'viewport.create',
            viewport: {
                id: v.id,
                cameraId: v.cameraId,
                projection: {
                    id: 'equirectangular/1',
                    config: { horizontal: v.horizontal, vertical: v.vertical },
                },
                size: { width: v.width, height: v.height, devicePixelRatio: 1 },
            },
        },
    ]);
    const placed = windows.flatMap((w) => {
        const g = groupIds.indexOf(w.groupId);
        // The window's place in its group: its world heading less the group's own turn.
        const h = (w.heading - groupTurn(g)) * RADIANS;
        const e = w.elevation * RADIANS;
        const d = w.distance;
        return [
            {
                type: 'node.create',
                node: {
                    id: w.id,
                    kind: 'window',
                    parentId: w.groupId,
                    label: w.label,
                    bounds: [w.width, w.height, 0.01],
                    transform: {
                        position: [
                            d * Math.cos(e) * Math.sin(h),
                            d * Math.sin(e),
                            -d * Math.cos(e) * Math.cos(h),
                        ],
                        // It faces the camera: its front (+Z) looks back along the camera's line to it.
                        rotation: cameraRotation(h, e),
                        scale: [1, 1, 1],
                    },
                },
            },
            ...w.surfaces.map((s) => ({
                type: 'surface.attach',
                surface: {
                    id: s.id,
                    ownerNodeId: w.id,
                    bindingKey: s.bindingKey,
                    adapterTypeId: s.adapterTypeId,
                    label: w.surfaces.length === 1 ? w.label : `${w.label} ${s.id.slice(-1)}`,
                    bounds: [s.width, s.height, 0.01],
                    transform: {
                        position: [s.x, (FRAME.bottom - FRAME.top) / 2, 0],
                        rotation: [0, 0, 0, 1],
                        scale: [1, 1, 1],
                    },
                },
            })),
        ];
    });
    return [...groups, ...placed, ...cameras];
}
//# sourceMappingURL=fixture.js.map