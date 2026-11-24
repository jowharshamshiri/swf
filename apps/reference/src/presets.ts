import type { SceneCommand } from '@swf/core';
import { cameraRotation } from '@swf/projections';
import type { MessageId } from './messages.js';
import type { Random } from './random.js';
import { createRandom } from './random.js';

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
  /** The window's node ID; its surface is `<id>-surface`. */
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
}

export const PRESET_IDS = ['empty', 'sparse', 'dense', 'seam'] as const;
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

/** Window frames are this much larger than their surfaces: room for the title above. */
const FRAME = { side: 0.08, top: 0.2, bottom: 0.08 } as const;

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

export const PRESETS: Readonly<Record<PresetId, Preset>> = Object.freeze({
  empty,
  sparse,
  dense,
  seam,
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

/** The commands that create a planned window and its surface, facing the camera at the origin. */
export function windowCommands(window: PlannedWindow): SceneCommand[] {
  const h = window.heading * RADIANS;
  const e = window.elevation * RADIANS;
  const d = window.distance;
  return [
    {
      type: 'node.create',
      node: {
        id: window.id,
        kind: 'window',
        label: window.label,
        tags: [window.content],
        metadata: { [COLOUR_KEY]: colourName(window.hue) },
        bounds: [window.width, window.height, 0.01],
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
    {
      type: 'surface.attach',
      surface: {
        id: `${window.id}-surface`,
        ownerNodeId: window.id,
        bindingKey: window.bindingKey,
        adapterTypeId: window.content === 'note' ? NOTE_ADAPTER : TILE_ADAPTER,
        label: window.label,
        bounds: [window.width - 2 * FRAME.side, window.height - FRAME.top - FRAME.bottom, 0.01],
        transform: {
          position: [0, (FRAME.bottom - FRAME.top) / 2, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
      },
    },
  ];
}
