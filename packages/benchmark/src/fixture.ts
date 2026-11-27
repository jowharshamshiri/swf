import type { SceneCommand } from '@swf/core';
import type { Random } from '@swf/math';
import { createRandom, quatFromAxisAngle } from '@swf/math';
import { cameraRotation } from '@swf/projections';

/**
 * The performance benchmark's fixtures (§26.1): seeded, stable scenes for comparing browsers,
 * releases and modes at matching entity counts (AN-010). From a size and a seed a fixture plans the
 * same scene on every run and engine: every value comes from exact arithmetic on the seeded
 * sequence, rounded to tenths of a degree and hundredths of a world unit.
 *
 * The standard fixture holds 250 windows with 300 surfaces among them in five nested groups, seen
 * through two viewports that each show 30 to 50 surfaces wherever their cameras turn. Its content
 * is lightweight: the host's surfaces are plain elements or proxies, so frames measure the
 * framework, not content.
 */

/** How large a fixture is; {@link sizeIssue} says whether one can be planned. */
export interface FixtureSize {
  /** Windows in the scene: a positive multiple of 5, one share for each of the five rings. */
  readonly windows: number;
  /** Surfaces among the windows: from `windows` to twice `windows`. */
  readonly surfaces: number;
  /** Nested groups the windows are spread among: a positive whole number. */
  readonly groups: number;
}

/** The standard benchmark fixture's counts (§26.1). */
export const STANDARD: FixtureSize = Object.freeze({ windows: 250, surfaces: 300, groups: 5 });

/**
 * The stress fixture: twice the standard scene, for observing how far performance degrades
 * (NFR-008), without claiming the standard's frame rates.
 */
export const STRESS: FixtureSize = Object.freeze({ windows: 500, surfaces: 600, groups: 5 });

/** The page a fixture is measured in, in CSS pixels: the benchmark's 1920×1080. Frozen. */
export const PAGE: {
  /** The page's width, in CSS pixels. */
  readonly width: number;
  /** The page's height, in CSS pixels. */
  readonly height: number;
} = Object.freeze({ width: 1920, height: 1080 });

/** The adapter type of a live element: a plain element, shareable between viewports. */
export const LIVE_ADAPTER = 'swf.bench.live/1';
/** The adapter type of drawn content, which the DOM backend shows as a proxy. */
export const DRAWN_ADAPTER = 'swf.bench.drawn/1';

/**
 * The heights of the rows windows stand in round the room, in world units above the camera's
 * level: the middle three in view, the outer two above and below it.
 */
const ROWS = Object.freeze([-2.8, -1.4, 0, 1.4, 2.8]);

/** How far each nested group is turned within its parent, about the vertical, in degrees. */
const GROUP_TURN = 3;

const RADIANS = Math.PI / 180;

/** A viewport of a fixture, as the scene holds it, beside its neighbour on the page. Frozen. */
export interface FixtureViewport {
  /** The viewport's ID in the scene: `ahead` or `behind`. */
  readonly id: string;
  /** The ID of the camera it looks through. */
  readonly cameraId: string;
  /** Where its left edge stands on the page, in CSS pixels. */
  readonly left: number;
  /** Where its top edge stands on the page, in CSS pixels. */
  readonly top: number;
  /** Its width, in CSS pixels. */
  readonly width: number;
  /** Its height, in CSS pixels. */
  readonly height: number;
  /** Degrees to the right of straight ahead (-Z) its camera starts turned. */
  readonly heading: number;
  /** The equirectangular angle it shows across, in degrees: the same degrees per pixel each way. */
  readonly horizontal: number;
  /** The equirectangular angle it shows down, in degrees. */
  readonly vertical: number;
}

/** A surface of a planned window. Frozen. */
export interface FixtureSurface {
  /** The surface's ID: its window's, with `-a` or `-b`. */
  readonly id: string;
  /** {@link LIVE_ADAPTER} for a window's first surface, {@link DRAWN_ADAPTER} for its second. */
  readonly adapterTypeId: string;
  /** `bench/<seed>/<window number>/<a or b>`: unique within the fixture. */
  readonly bindingKey: string;
  /** Its centre in the window's frame, across, in world units. */
  readonly x: number;
  /** Its width, in world units. */
  readonly width: number;
  /** Its height, in world units. */
  readonly height: number;
}

/** A planned window, in the world. Frozen. */
export interface FixtureWindow {
  /** `window-<number>`, numbered from 1 and padded to the digits of the window count. */
  readonly id: string;
  /** `Window <number>`. */
  readonly label: string;
  /** The nested group it is in, `group-1` (outermost) to `group-<groups>`. */
  readonly groupId: string;
  /** Degrees to the right of straight ahead, in (-180, 180], as seen in the world. */
  readonly heading: number;
  /** World units out from the camera along the floor. */
  readonly reach: number;
  /** World units of its centre above the camera's level. */
  readonly y: number;
  /** Its width, in world units: 0.5 to 0.9. */
  readonly width: number;
  /** Its height, in world units: 0.32 to 0.5. */
  readonly height: number;
  /** Its one or two surfaces, side by side. */
  readonly surfaces: readonly FixtureSurface[];
}

/** A planned fixture: what it holds, and the commands that make it. Deeply frozen. */
export interface Fixture {
  /** The size it was planned at, as given. */
  readonly size: FixtureSize;
  /** The seed it was planned from. */
  readonly seed: number;
  /** `group-1` (outermost) to `group-<groups>`, each nested in the one before. */
  readonly groupIds: readonly string[];
  /** Every window, row by row from the lowest. */
  readonly windows: readonly FixtureWindow[];
  /** The two viewports, `ahead` and `behind`, side by side on the {@link PAGE}. */
  readonly viewports: readonly FixtureViewport[];
  /** The commands that make the whole scene in an empty workspace, as one transaction. */
  readonly commands: readonly SceneCommand[];
}

/**
 * The fixture's two viewports, side by side on the 1920×1080 page: one looking ahead, the other
 * behind, each 64° across and 72° down (1/15° per pixel), which shows the middle three rows.
 */
const VIEWPORTS: readonly FixtureViewport[] = Object.freeze([
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
export function sizeIssue(size: FixtureSize): string | null {
  const whole = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n > 0;
  if (!whole(size.windows) || size.windows % ROWS.length !== 0) {
    return `windows must be a positive multiple of ${String(ROWS.length)} (got ${String(size.windows)})`;
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
function stepped(random: Random, min: number, max: number, per: number): number {
  return random.integer(Math.round(min * per), Math.round(max * per)) / per;
}

/** A heading in (-180, 180], in tenths of a degree. */
function wrapHeading(degrees: number): number {
  const tenths = Math.round(degrees * 10);
  const wrapped = (((tenths + 1800) % 3600) + 3600) % 3600;
  return ((wrapped === 0 ? 3600 : wrapped) - 1800) / 10;
}

/**
 * The surfaces' gap inside a window, and the frame round them, in world units: a title band deep
 * enough to be pressed clear of the resize band along a card's top edge.
 */
const FRAME = Object.freeze({ side: 0.04, top: 0.16, bottom: 0.04, gap: 0.02 });

/**
 * Plans a fixture. Windows stand upright in five rows round the room, 2.5 to 3.2 units out along
 * the floor, evenly spaced with a little jitter, alternate rows offset by half a step; every `windows / (surfaces - windows)`-th window
 * holds two surfaces side by side, the second drawn. Window `i` is in group `i mod groups`, so
 * every depth of nesting holds windows all the way round. The same size and seed give the same
 * fixture on every run and engine.
 *
 * @throws `RangeError` for a size {@link sizeIssue} refuses, or a seed `createRandom` refuses.
 */
export function planFixture(size: FixtureSize, seed: number): Fixture {
  const issue = sizeIssue(size);
  if (issue !== null) {
    throw new RangeError(issue);
  }
  const random = createRandom(seed);
  const perRow = size.windows / ROWS.length;
  const pairs = size.surfaces - size.windows;
  const groupIds = Array.from({ length: size.groups }, (_, g) => `group-${String(g + 1)}`);
  const digits = String(size.windows).length;
  const windows = ROWS.flatMap((row, r) =>
    Array.from({ length: perRow }, (_, k): FixtureWindow => {
      const index = r * perRow + k;
      const number = String(index + 1).padStart(digits, '0');
      const id = `window-${number}`;
      const width = stepped(random, 0.5, 0.9, 100);
      const height = stepped(random, 0.32, 0.5, 100);
      const paired =
        pairs > 0 &&
        Math.floor(((index + 1) * pairs) / size.windows) >
          Math.floor((index * pairs) / size.windows);
      const inner = (w: number) => Math.round(w * 100) / 100;
      const surfaceHeight = inner(height - FRAME.top - FRAME.bottom);
      const full = inner(width - 2 * FRAME.side);
      const half = inner((full - FRAME.gap) / 2);
      const surfaces: FixtureSurface[] = paired
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
        heading: wrapHeading(
          k * (360 / perRow) + (r % 2) * (180 / perRow) + stepped(random, -1, 1, 10),
        ),
        reach: stepped(random, 2.5, 3.2, 100),
        y: Math.round((row + stepped(random, -0.1, 0.1, 100)) * 100) / 100,
        width,
        height,
        surfaces: Object.freeze(surfaces.map((s) => Object.freeze(s))),
      });
    }),
  );
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
function groupTurn(groupIndex: number): number {
  return (groupIndex + 1) * GROUP_TURN;
}

function fixtureCommands(
  groupIds: readonly string[],
  windows: readonly FixtureWindow[],
): SceneCommand[] {
  const reach = windows.reduce((most, w) => Math.max(most, Math.hypot(w.reach, w.y) + w.width), 1);
  const groups = groupIds.map((id, g): SceneCommand => ({
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
  const cameras = VIEWPORTS.flatMap((v): SceneCommand[] => [
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
  const placed = windows.flatMap((w): SceneCommand[] => {
    const g = groupIds.indexOf(w.groupId);
    // The window's place in its group: its world heading less the group's own turn.
    const h = (w.heading - groupTurn(g)) * RADIANS;
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
            position: [w.reach * Math.sin(h), w.y, -w.reach * Math.cos(h)],
            // Upright, carrying no rotation of its own: drawn as a card at its place.
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
      },
      ...w.surfaces.map((s): SceneCommand => ({
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
