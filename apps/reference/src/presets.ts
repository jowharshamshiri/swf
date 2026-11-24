import type { SceneCommand } from '@swf/core';
import { cameraRotation } from '@swf/projections';
import { layoutSurfaces, WINDOW_FRAME } from './composition.js';
import type { MessageId } from './messages.js';
import type { Random } from './random.js';
import { createRandom, seedIssue } from './random.js';

/**
 * The demo scenes the reference application seeds. Each preset is a stable scenario definition:
 * from a preset and a seed it plans the same windows on every run, engine and release, so a
 * change in behaviour can be regression-tested against the same scene.
 *
 * A plan holds only values made by exact arithmetic on the seeded sequence, rounded to tenths of a
 * degree and hundredths of a world unit. The scene's transforms are computed from it.
 */

/** What a demo window shows: a native page element, or content drawn on a canvas. */
export type ContentKind = 'note' | 'tile';

export interface PlannedWindow {
  /**
   * The window's node ID; its surface is `<id>-surface`. A window composed into another has no
   * node of its own: its surface is in that window, and detaching it makes a window of this ID.
   */
  readonly id: string;
  readonly label: string;
  readonly content: ContentKind;
  /** The host's key for the window's content. */
  readonly bindingKey: string;
  /** Degrees to the right of straight ahead (-Z), in (-180, 180]. */
  readonly heading: number;
  /** Degrees above the horizon. */
  readonly elevation: number;
  /** World units from the camera. */
  readonly distance: number;
  /** World units. */
  readonly width: number;
  readonly height: number;
  /** The content's hue, in degrees. */
  readonly hue: number;
  /**
   * The window whose surfaces this one's is composed with, side by side, in plan order: placed
   * where the first of them is planned. Absent for a window of its own.
   */
  readonly composedInto?: { readonly id: string; readonly label: string };
}

export const PRESET_IDS = ['empty', 'sparse', 'dense', 'seam', 'composed'] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export interface Preset {
  readonly id: PresetId;
  readonly name: MessageId;
  readonly defaultSeed: number;
  plan(random: Random, seed: number): PlannedWindow[];
}

/** The adapter types demo content is bound through. */
export const NOTE_ADAPTER = 'reference.note/1';
export const TILE_ADAPTER = 'reference.tile/1';

/** The camera every preset is seen from. */
export const CAMERA_ID = 'camera';

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

function windowAt(
  random: Random,
  preset: PresetId,
  seed: number,
  index: number,
  content: ContentKind,
  place: { heading: number; elevation: number; distance: number; width: number; height: number },
): PlannedWindow {
  const number = String(index + 1).padStart(index + 1 >= 100 ? 3 : 2, '0');
  return {
    id: `window-${number}`,
    label: `${content === 'note' ? 'Note' : 'Tile'} ${number}`,
    content,
    bindingKey: `${preset}/${content}/${String(seed)}/${number}`,
    heading: wrapHeading(place.heading),
    elevation: Math.round(place.elevation * 10) / 10,
    distance: Math.round(place.distance * 100) / 100,
    width: Math.round(place.width * 100) / 100,
    height: Math.round(place.height * 100) / 100,
    hue: random.integer(0, 359),
  };
}

const empty: Preset = {
  id: 'empty',
  name: 'preset.empty',
  defaultSeed: 1,
  plan: () => [],
};

/** Six windows spread around the whole panorama, alternating native and drawn content. */
const sparse: Preset = {
  id: 'sparse',
  name: 'preset.sparse',
  defaultSeed: 1,
  plan(random, seed) {
    const first: ContentKind = random.next() < 0.5 ? 'note' : 'tile';
    return Array.from({ length: 6 }, (_, i) =>
      windowAt(random, 'sparse', seed, i, (i % 2 === 0) === (first === 'note') ? 'note' : 'tile', {
        heading: i * 60 + stepped(random, -15, 15, 10),
        elevation: stepped(random, -10, 15, 10),
        distance: stepped(random, 2.6, 3.4, 100),
        width: stepped(random, 1.4, 2, 100),
        height: stepped(random, 0.9, 1.3, 100),
      }),
    );
  },
};

/**
 * 250 windows (the benchmark's count) in five rings above and below the horizon, all the way
 * round: mostly drawn tiles, every fifth a native note.
 */
const dense: Preset = {
  id: 'dense',
  name: 'preset.dense',
  defaultSeed: 1,
  plan(random, seed) {
    const rings = [-40, -20, 0, 20, 40];
    const perRing = 50;
    return rings.flatMap((ring, r) =>
      Array.from({ length: perRing }, (_, k) => {
        const index = r * perRing + k;
        return windowAt(random, 'dense', seed, index, index % 5 === 0 ? 'note' : 'tile', {
          heading: k * (360 / perRing) + (r % 2) * (180 / perRing) + stepped(random, -1.5, 1.5, 10),
          elevation: ring + stepped(random, -3, 3, 10),
          distance: stepped(random, 3.5, 6, 100),
          width: stepped(random, 0.5, 0.9, 100),
          height: stepped(random, 0.32, 0.6, 100),
        });
      }),
    );
  },
};

/**
 * Windows across the seam behind the camera (one exactly on it, whatever the seed), windows
 * behind the camera on either side, one near the pole above the seam, and one straight ahead for
 * reference.
 */
const seam: Preset = {
  id: 'seam',
  name: 'preset.seam',
  defaultSeed: 1,
  plan(random, seed) {
    const jitter = () => stepped(random, -4, 4, 10);
    const places: [ContentKind, Parameters<typeof windowAt>[5]][] = [
      ['note', { heading: 180, elevation: 0, distance: 3, width: 2.4, height: 1.4 }],
      ['tile', { heading: 168 + jitter(), elevation: -18, distance: 3.2, width: 1.8, height: 1 }],
      ['note', { heading: -170 + jitter(), elevation: 20, distance: 3, width: 1.2, height: 0.8 }],
      ['tile', { heading: 140 + jitter(), elevation: -2, distance: 3.4, width: 1.4, height: 1 }],
      ['note', { heading: -135 + jitter(), elevation: 4, distance: 3.4, width: 1.4, height: 1 }],
      ['tile', { heading: 180 + jitter(), elevation: 58, distance: 3.2, width: 1.6, height: 1 }],
      ['note', { heading: jitter(), elevation: 0, distance: 3, width: 1.6, height: 1 }],
    ];
    return places.map(([content, place], i) => windowAt(random, 'seam', seed, i, content, place));
  },
};

/**
 * A board composed of three surfaces the host supplied (two notes and a tile, side by side in one
 * window) straight ahead, and two windows of their own to either side to move surfaces into:
 * the scene of multi-surface composition (FR-126, §33.2 scenario 4).
 */
const composed: Preset = {
  id: 'composed',
  name: 'preset.composed',
  defaultSeed: 1,
  plan(random, seed) {
    const board = { id: 'board', label: 'Board' };
    const part = (content: ContentKind, i: number): PlannedWindow => ({
      ...windowAt(random, 'composed', seed, i, content, {
        heading: 0,
        elevation: 0,
        distance: 3.2,
        width: stepped(random, 1.1, 1.4, 100),
        height: stepped(random, 0.8, 1, 100),
      }),
      composedInto: board,
    });
    return [
      part('note', 0),
      part('tile', 1),
      part('note', 2),
      windowAt(random, 'composed', seed, 3, 'note', {
        heading: -75 + stepped(random, -5, 5, 10),
        elevation: stepped(random, -5, 5, 10),
        distance: 3.2,
        width: 1.4,
        height: 1,
      }),
      windowAt(random, 'composed', seed, 4, 'tile', {
        heading: 75 + stepped(random, -5, 5, 10),
        elevation: stepped(random, -5, 5, 10),
        distance: 3.2,
        width: 1.4,
        height: 1,
      }),
    ];
  },
};

export const PRESETS: Readonly<Record<PresetId, Preset>> = Object.freeze({
  empty,
  sparse,
  dense,
  seam,
  composed,
});

export function presetIssue(value: unknown): string | null {
  return typeof value === 'string' && (PRESET_IDS as readonly string[]).includes(value)
    ? null
    : `a preset must be one of ${PRESET_IDS.join(', ')}`;
}

/** The windows a preset plans from a seed: the same every time. */
export function planPreset(id: PresetId, seed: number): readonly PlannedWindow[] {
  return Object.freeze(PRESETS[id].plan(createRandom(seed), seed));
}

const RADIANS = Math.PI / 180;

/**
 * The descriptive metadata the demo host exposes to search: each window's colour, by name. It is
 * the host's description of its content, as a real host would describe a document by its project
 * or owner; search reads it only because it is exposed, never the content itself.
 */
export const COLOUR_KEY = 'host.reference.colour';
export const SEARCHABLE_METADATA: readonly string[] = Object.freeze([COLOUR_KEY]);

const COLOURS = [
  'Red',
  'Orange',
  'Yellow',
  'Lime',
  'Green',
  'Mint',
  'Cyan',
  'Azure',
  'Blue',
  'Violet',
  'Magenta',
  'Rose',
] as const;

/** A hue's name: twelve names, each for thirty degrees centred on its own hue. */
export function colourName(hue: number): string {
  const index = Math.round((((hue % 360) + 360) % 360) / 30) % COLOURS.length;
  const name = COLOURS[index];
  if (name === undefined) {
    throw new RangeError(`hue ${String(hue)} has no colour name`);
  }
  return name;
}

/**
 * The group every preset's windows are in: the whole workspace around the camera, designated as
 * the group workspace orbit turns. It stands at the camera's place, unturned, so a window's place
 * in it is its place in the world until the workspace is turned.
 */
export const WORKSPACE_GROUP_ID = 'workspace';

/** A planned window with every window composed into it: the parts its surfaces show. */
export interface PlannedComposite {
  readonly id: string;
  readonly label: string;
  /** Where the window stands: as its first part is planned. */
  readonly place: PlannedWindow;
  readonly parts: readonly PlannedWindow[];
}

/**
 * The windows a plan makes, in plan order: each window of its own, and each composed window
 * once, where its first part comes, holding all its parts.
 */
export function composites(windows: readonly PlannedWindow[]): PlannedComposite[] {
  const out: PlannedComposite[] = [];
  const byId = new Map<string, { parts: PlannedWindow[] }>();
  for (const window of windows) {
    const into = window.composedInto;
    if (into === undefined) {
      out.push({ id: window.id, label: window.label, place: window, parts: [window] });
      continue;
    }
    const known = byId.get(into.id);
    if (known !== undefined) {
      known.parts.push(window);
      continue;
    }
    const parts = [window];
    byId.set(into.id, { parts });
    out.push({ id: into.id, label: into.label, place: window, parts });
  }
  return out;
}

/** A planned surface's size: its window's planned size less the frame. */
const surfaceSize = (window: PlannedWindow): readonly [number, number] => [
  window.width - 2 * WINDOW_FRAME.side,
  window.height - WINDOW_FRAME.top - WINDOW_FRAME.bottom,
];

/**
 * The commands that seed a scene with planned windows: the workspace group, the windows in it
 * (each composed window holding its parts' surfaces side by side), and the group designated as
 * the orbit root.
 */
export function presetCommands(windows: readonly PlannedWindow[]): SceneCommand[] {
  const made = composites(windows);
  // The group's box holds every window wherever it is turned: a cube round the camera.
  const reach = made.reduce((most, w) => {
    const [width, height] = layoutSurfaces(w.parts.map(surfaceSize)).bounds;
    return Math.max(most, w.place.distance + Math.hypot(width, height) / 2);
  }, 1);
  return [
    {
      type: 'node.create',
      node: {
        id: WORKSPACE_GROUP_ID,
        kind: 'group',
        label: 'Workspace',
        bounds: [2 * reach, 2 * reach, 2 * reach],
      },
    },
    ...made.flatMap((window) => windowCommands(window, WORKSPACE_GROUP_ID)),
    { type: 'orbitRoot.set', nodeId: WORKSPACE_GROUP_ID },
  ];
}

/**
 * The commands that create a planned window and its surfaces in a group standing unturned at the
 * camera's place, facing the camera at the origin. Its tags say what kinds of content it shows;
 * its colour is its first part's.
 */
export function windowCommands(window: PlannedComposite, parentId: string): SceneCommand[] {
  const { place, parts } = window;
  const h = place.heading * RADIANS;
  const e = place.elevation * RADIANS;
  const d = place.distance;
  const layout = layoutSurfaces(parts.map(surfaceSize));
  return [
    {
      type: 'node.create',
      node: {
        id: window.id,
        kind: 'window',
        parentId,
        label: window.label,
        tags: [...new Set(parts.map((p) => p.content))],
        metadata: { [COLOUR_KEY]: colourName(place.hue) },
        bounds: layout.bounds,
        transform: {
          position: [
            d * Math.cos(e) * Math.sin(h),
            d * Math.sin(e),
            -d * Math.cos(e) * Math.cos(h),
          ],
          // A window faces the camera: its front (+Z) looks back along the camera's line to it.
          rotation: cameraRotation(h, e),
          scale: [1, 1, 1],
        },
      },
    },
    ...parts.map((part, i): SceneCommand => {
      const [width, height] = surfaceSize(part);
      return {
        type: 'surface.attach',
        surface: {
          id: `${part.id}-surface`,
          ownerNodeId: window.id,
          bindingKey: part.bindingKey,
          adapterTypeId: adapterOf(part.content),
          label: part.label,
          bounds: [width, height, 0.01],
          transform: {
            position: layout.offsets[i] ?? [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
      };
    }),
  ];
}

/** The adapter type a kind of content is bound through. */
export function adapterOf(content: ContentKind): string {
  return content === 'note' ? NOTE_ADAPTER : TILE_ADAPTER;
}

/** The kind of content an adapter type binds, or null for another adapter's. */
export function contentOf(adapterTypeId: string): ContentKind | null {
  return adapterTypeId === NOTE_ADAPTER ? 'note' : adapterTypeId === TILE_ADAPTER ? 'tile' : null;
}

/**
 * The planned window a binding key names (`<preset>/<content>/<seed>/<number>`), planned again
 * from its preset and seed with `plan` (which may remember plans), or null when the key names no
 * window any preset plans. The host knows its content by key alone, so a layout restored in
 * another session finds it.
 */
export function plannedByKey(
  key: string,
  plan: (preset: PresetId, seed: number) => readonly PlannedWindow[] = planPreset,
): PlannedWindow | null {
  const match = /^([a-z]+)\/(note|tile)\/(\d+)\/(\d+)$/.exec(key);
  if (match === null) {
    return null;
  }
  const [, preset = '', , seedText = ''] = match;
  const seed = Number(seedText);
  if (presetIssue(preset) !== null || seedIssue(seed) !== null) {
    return null;
  }
  return plan(preset as PresetId, seed).find((w) => w.bindingKey === key) ?? null;
}
