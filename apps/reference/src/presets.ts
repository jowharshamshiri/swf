import type { SceneCommand } from '@swf/core';
import { WINDOW_FRAME, layoutSurfaces } from '@swf/navigation';
import type { Random } from '@swf/math';
import { createRandom, seedIssue } from '@swf/math';

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
  /** World units out from the camera along the room's floor. */
  readonly reach: number;
  /** World units of its centre above the camera's level. */
  readonly y: number;
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
  /**
   * What the window is about, as a real application's window would show it: a category, a
   * headline figure and a line describing it. Absent for the plain demo windows of the test scenes.
   */
  readonly detail?: WindowDetail;
}

/** The host's description of a window's content, shown in it and exposed to search. */
export interface WindowDetail {
  readonly category: string;
  /** The headline figure the content shows large. */
  readonly metric: string;
  readonly description: string;
}

export const PRESET_IDS = [
  'studio',
  'research',
  'planning',
  'empty',
  'sparse',
  'dense',
  'seam',
  'composed',
] as const;
export type PresetId = (typeof PRESET_IDS)[number];

export interface Preset {
  readonly id: PresetId;
  /** Its name, as the ID of the message that says it. */
  readonly name: `preset.${PresetId}`;
  readonly defaultSeed: number;
  plan(random: Random, seed: number): PlannedWindow[];
}

/** The adapter types demo content is bound through. */
export const NOTE_ADAPTER = 'reference.note/1';
export const TILE_ADAPTER = 'reference.tile/1';

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
  place: { heading: number; reach: number; y: number; width: number; height: number },
): PlannedWindow {
  const number = String(index + 1).padStart(index + 1 >= 100 ? 3 : 2, '0');
  return {
    id: `window-${number}`,
    label: `${content === 'note' ? 'Note' : 'Tile'} ${number}`,
    content,
    bindingKey: `${preset}/${content}/${String(seed)}/${number}`,
    heading: wrapHeading(place.heading),
    reach: Math.round(place.reach * 100) / 100,
    y: Math.round(place.y * 100) / 100,
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
        reach: stepped(random, 2.6, 3.4, 100),
        y: stepped(random, -0.6, 0.9, 100),
        width: stepped(random, 1.4, 2, 100),
        height: stepped(random, 0.9, 1.3, 100),
      }),
    );
  },
};

/**
 * 250 windows (the benchmark's count) in five rows above and below the horizon, all the way
 * round and from near to far along the floor: mostly drawn tiles, every fifth a native note.
 */
const dense: Preset = {
  id: 'dense',
  name: 'preset.dense',
  defaultSeed: 1,
  plan(random, seed) {
    const rows = [-2.4, -1.2, 0, 1.2, 2.4];
    const perRing = 50;
    return rows.flatMap((row, r) =>
      Array.from({ length: perRing }, (_, k) => {
        const index = r * perRing + k;
        return windowAt(random, 'dense', seed, index, index % 5 === 0 ? 'note' : 'tile', {
          heading: k * (360 / perRing) + (r % 2) * (180 / perRing) + stepped(random, -1.5, 1.5, 10),
          // Near, middle and far: every band semantic depth draws.
          reach: stepped(random, 3.5, 12.5, 100),
          y: row + stepped(random, -0.2, 0.2, 100),
          width: stepped(random, 0.5, 0.9, 100),
          height: stepped(random, 0.32, 0.6, 100),
        });
      }),
    );
  },
};

/**
 * Windows across the seam behind the camera (one exactly on it, whatever the seed), windows
 * behind the camera on either side, one high above the seam, and one straight ahead for
 * reference.
 */
const seam: Preset = {
  id: 'seam',
  name: 'preset.seam',
  defaultSeed: 1,
  plan(random, seed) {
    const jitter = () => stepped(random, -4, 4, 10);
    const places: [ContentKind, Parameters<typeof windowAt>[5]][] = [
      ['note', { heading: 180, reach: 3, y: 0, width: 2.4, height: 1.4 }],
      ['tile', { heading: 168 + jitter(), reach: 3.04, y: -0.99, width: 1.8, height: 1 }],
      ['note', { heading: -170 + jitter(), reach: 2.82, y: 1.03, width: 1.2, height: 0.8 }],
      ['tile', { heading: 140 + jitter(), reach: 3.4, y: -0.12, width: 1.4, height: 1 }],
      ['note', { heading: -135 + jitter(), reach: 3.39, y: 0.24, width: 1.4, height: 1 }],
      ['tile', { heading: 180 + jitter(), reach: 2.2, y: 3.6, width: 1.6, height: 1 }],
      ['note', { heading: jitter(), reach: 3, y: 0, width: 1.6, height: 1 }],
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
        reach: 3.2,
        y: 0,
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
        reach: 3.2,
        y: stepped(random, -0.28, 0.28, 100),
        width: 1.4,
        height: 1,
      }),
      windowAt(random, 'composed', seed, 4, 'tile', {
        heading: 75 + stepped(random, -5, 5, 10),
        reach: 3.2,
        y: stepped(random, -0.28, 0.28, 100),
        width: 1.4,
        height: 1,
      }),
    ];
  },
};

/** A window of the studio, as it is laid out before the seed's jitter. */
interface StudioWindow {
  readonly key: string;
  readonly label: string;
  readonly content: ContentKind;
  readonly heading: number;
  readonly reach: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly hue: number;
  readonly detail: WindowDetail;
}

/** The board's parts: three surfaces of one window straight ahead, to break apart and put back. */
const STUDIO_BOARD = Object.freeze({ id: 'board', label: 'Project Board' });

/**
 * The studio's windows, at the prototype room's places, distances and heights. The board stands
 * straight ahead; around it, windows in every direction, six of them behind the camera, at
 * distances along the floor in each of semantic depth's bands by default (full nearer than 6.7
 * units, a compact preview to 9.3, the label alone beyond), above and below the horizon. Each has a hue of its own, so no two look alike. The near ones are native notes,
 * which both backends present live; the drawn tiles are the far ones, shown by their labels.
 */
const STUDIO: readonly StudioWindow[] = Object.freeze([
  {
    key: 'plan',
    label: 'Plan',
    content: 'note',
    heading: 0,
    reach: 6.1,
    y: 0.4,
    width: 1.6,
    height: 1.4,
    hue: 210,
    detail: {
      category: 'Planning',
      metric: 'Week 48',
      description: 'Goals and the order to reach them',
    },
  },
  {
    key: 'timeline',
    label: 'Timeline',
    content: 'note',
    heading: 0,
    reach: 6.1,
    y: 0.4,
    width: 1.6,
    height: 1.4,
    hue: 45,
    detail: {
      category: 'Planning',
      metric: '12 events',
      description: 'Milestones across projects',
    },
  },
  {
    key: 'sources',
    label: 'Sources',
    content: 'note',
    heading: 0,
    reach: 6.1,
    y: 0.4,
    width: 1.6,
    height: 1.4,
    hue: 275,
    detail: { category: 'Research', metric: '18 sources', description: 'References and citations' },
  },
  {
    key: 'desk',
    label: 'Writing Desk',
    content: 'note',
    heading: 41,
    reach: 4.4,
    y: 2.55,
    width: 2.2,
    height: 1.5,
    hue: 30,
    detail: {
      category: 'Writing',
      metric: 'Draft 4',
      description: 'The current draft and its outline',
    },
  },
  {
    key: 'builds',
    label: 'Build Status',
    content: 'note',
    heading: 119,
    reach: 6.6,
    y: 2.0,
    width: 2.2,
    height: 1.5,
    hue: 150,
    detail: { category: 'Build', metric: '3 running', description: 'Builds of the main branch' },
  },
  {
    key: 'messages',
    label: 'Messages',
    content: 'note',
    heading: -162,
    reach: 5.3,
    y: 2.1,
    width: 2.6,
    height: 1.7,
    hue: 345,
    detail: {
      category: 'Team',
      metric: '7 unread',
      description: 'Replies and mentions from the team',
    },
  },
  {
    key: 'metrics',
    label: 'Metrics',
    content: 'note',
    heading: 61,
    reach: 5.9,
    y: -1.7,
    width: 2.6,
    height: 1.7,
    hue: 190,
    detail: { category: 'Data', metric: '86.4k', description: 'Visits this week' },
  },
  {
    key: 'calendar',
    label: 'Calendar',
    content: 'note',
    heading: -82,
    reach: 4.9,
    y: 1.3,
    width: 2.2,
    height: 1.5,
    hue: 95,
    detail: { category: 'Planning', metric: '4 today', description: 'Meetings and deadlines' },
  },
  {
    key: 'review',
    label: 'Code Review',
    content: 'note',
    heading: -113,
    reach: 8.4,
    y: 0.0,
    width: 2.6,
    height: 1.7,
    hue: 235,
    detail: { category: 'Build', metric: '12 files', description: 'Changes waiting for review' },
  },
  {
    key: 'reading',
    label: 'Reading List',
    content: 'tile',
    heading: -121,
    reach: 8.8,
    y: -1.7,
    width: 3.6,
    height: 2.2,
    hue: 15,
    detail: { category: 'Research', metric: '26 saved', description: 'Articles grouped by topic' },
  },
  {
    key: 'tasks',
    label: 'Tasks',
    content: 'note',
    heading: -21,
    reach: 6.8,
    y: 0.3,
    width: 2.4,
    height: 1.6,
    hue: 60,
    detail: { category: 'Planning', metric: '8 open', description: 'What is next, and who has it' },
  },
  {
    key: 'sketches',
    label: 'Sketches',
    content: 'tile',
    heading: -172,
    reach: 11.2,
    y: 2.5,
    width: 3.2,
    height: 2,
    hue: 300,
    detail: {
      category: 'Design',
      metric: '12 frames',
      description: 'Explorations of the new layout',
    },
  },
  {
    key: 'signals',
    label: 'Signal Monitor',
    content: 'tile',
    heading: 84,
    reach: 8.6,
    y: -2.1,
    width: 3.2,
    height: 2,
    hue: 170,
    detail: { category: 'Data', metric: '+24%', description: 'Events streaming normally' },
  },
  {
    key: 'media',
    label: 'Media Notes',
    content: 'note',
    heading: -39,
    reach: 10.8,
    y: 2.5,
    width: 3.6,
    height: 2.2,
    hue: 120,
    detail: { category: 'Research', metric: '04:28', description: 'A transcript with annotations' },
  },
  {
    key: 'archive',
    label: 'Archive',
    content: 'tile',
    heading: 155,
    reach: 11.6,
    y: -1.6,
    width: 3.8,
    height: 2.4,
    hue: 255,
    detail: {
      category: 'Research',
      metric: '1,204 items',
      description: 'Everything finished, by year',
    },
  },
]);

/** The studio's windows that are parts of the board, by key. */
const STUDIO_BOARD_PARTS: readonly string[] = Object.freeze(['plan', 'timeline', 'sources']);

/**
 * Named windows planned from their layout: the seed turns each window a few degrees and raises or
 * lowers it a little, never across a depth band, and the parts of a board (by key) stay together,
 * composed into it.
 */
function planNamed(
  preset: PresetId,
  windows: readonly StudioWindow[],
  board: {
    readonly window: { readonly id: string; readonly label: string };
    readonly parts: readonly string[];
  } | null,
  random: Random,
  seed: number,
): PlannedWindow[] {
  return windows.map((spec, i): PlannedWindow => {
    const part = board?.parts.includes(spec.key) === true;
    const jitter = part ? 0 : stepped(random, -3, 3, 10);
    const lift = part ? 0 : stepped(random, -0.15, 0.15, 100);
    const number = String(i + 1).padStart(2, '0');
    return {
      id: spec.key,
      label: spec.label,
      content: spec.content,
      bindingKey: `${preset}/${spec.content}/${String(seed)}/${number}`,
      heading: wrapHeading(spec.heading + jitter),
      reach: spec.reach,
      y: Math.round((spec.y + lift) * 100) / 100,
      width: spec.width,
      height: spec.height,
      hue: spec.hue,
      detail: spec.detail,
      ...(board !== null && part ? { composedInto: board.window } : {}),
    };
  });
}

/**
 * The default scene: a studio of named windows all the way round the camera and at every depth,
 * each looking like what it is, with a board of three surfaces straight ahead to break apart. The
 * seed moves each window a few degrees, never across a depth band; the board's parts stay together.
 */
const studio: Preset = {
  id: 'studio',
  name: 'preset.studio',
  defaultSeed: 1,
  plan: (random, seed) =>
    planNamed('studio', STUDIO, { window: STUDIO_BOARD, parts: STUDIO_BOARD_PARTS }, random, seed),
};

/** A window of a named scene: where it stands, how large, its hue and what it is about. */
const named = (
  key: string,
  label: string,
  content: ContentKind,
  [heading, reach, y]: readonly [number, number, number],
  [width, height]: readonly [number, number],
  hue: number,
  detail: WindowDetail,
): StudioWindow =>
  Object.freeze({ key, label, content, heading, reach, y, width, height, hue, detail });

/**
 * A researcher's desk: the question straight ahead, reading and fieldwork to either side, data
 * and the lab's log further round, writing and the archive far off, every depth band filled.
 */
const RESEARCH: readonly StudioWindow[] = Object.freeze([
  named('question', 'Research Question', 'note', [0, 5.2, 1.1], [2.2, 1.5], 205, {
    category: 'Research',
    metric: '3 hypotheses',
    description: 'What the study sets out to answer',
  }),
  named('papers', 'Papers', 'note', [-76, 5.3, 1.4], [2.4, 1.6], 20, {
    category: 'Reading',
    metric: '42 papers',
    description: 'Read, skimmed and still to read',
  }),
  named('fieldnotes', 'Field Notes', 'note', [61, 5.9, -1.7], [2.2, 1.5], 85, {
    category: 'Fieldwork',
    metric: '17 entries',
    description: 'Observations from the last site visit',
  }),
  named('datasets', 'Datasets', 'note', [-145, 4.1, -1.0], [2.6, 1.7], 175, {
    category: 'Data',
    metric: '6 sets',
    description: 'Sources, licences and versions',
  }),
  named('experiments', 'Experiment Log', 'note', [152, 6.4, -1.7], [2.6, 1.7], 130, {
    category: 'Lab',
    metric: 'Run 14',
    description: 'Each run, its settings and outcome',
  }),
  named('interviews', 'Interviews', 'note', [28, 8.0, 2.25], [2.2, 1.5], 330, {
    category: 'Fieldwork',
    metric: '9 transcripts',
    description: 'Conversations, coded by theme',
  }),
  named('survey', 'Survey Results', 'tile', [-172, 11.2, 2.5], [3.2, 2], 265, {
    category: 'Data',
    metric: '412 replies',
    description: 'Answers by question and group',
  }),
  named('citations', 'Citations', 'note', [-50, 9.8, -0.3], [3.4, 2.2], 50, {
    category: 'Writing',
    metric: '128 references',
    description: 'The bibliography, checked',
  }),
  named('draft', 'Paper Draft', 'note', [-113, 8.4, 0.0], [3, 1.9], 290, {
    category: 'Writing',
    metric: '6,200 words',
    description: 'The draft, section by section',
  }),
  named('labarchive', 'Lab Archive', 'tile', [106, 10.5, 2.5], [3.8, 2.4], 240, {
    category: 'Archive',
    metric: '3 years',
    description: 'Earlier studies and their data',
  }),
]);

/**
 * A planner's room: the roadmap straight ahead, the work to either side, milestones, risks and
 * money further round, capacity and decisions behind, the quarter's goals and its retrospective
 * far off, every depth band filled.
 */
const PLANNING: readonly StudioWindow[] = Object.freeze([
  named('roadmap', 'Roadmap', 'note', [3, 4.4, 1.0], [2.6, 1.6], 215, {
    category: 'Planning',
    metric: 'Q1–Q4',
    description: 'Where the year is going',
  }),
  named('backlog', 'Backlog', 'note', [-85, 5.6, 0.6], [2.2, 1.5], 40, {
    category: 'Work',
    metric: '58 items',
    description: 'Everything not yet scheduled',
  }),
  named('sprint', 'Sprint Board', 'note', [67, 4.6, -1.6], [2.4, 1.6], 145, {
    category: 'Work',
    metric: 'Sprint 31',
    description: 'This fortnight’s work by state',
  }),
  named('milestones', 'Milestones', 'note', [-154, 4.8, -0.5], [2.6, 1.7], 90, {
    category: 'Planning',
    metric: '5 due',
    description: 'Dates the plan commits to',
  }),
  named('risks', 'Risks', 'note', [137, 6.2, -0.9], [2.6, 1.7], 0, {
    category: 'Review',
    metric: '7 open',
    description: 'What could slip, and the plan if it does',
  }),
  named('budget', 'Budget', 'note', [34, 7.8, 1.55], [2.2, 1.5], 120, {
    category: 'Finance',
    metric: '72% spent',
    description: 'Spending against the plan',
  }),
  named('capacity', 'Team Capacity', 'tile', [-124, 10, 1.4], [3.2, 2], 280, {
    category: 'People',
    metric: '34 days free',
    description: 'Who is free, and when',
  }),
  named('decisions', 'Decisions', 'tile', [95, 9.9, 2.2], [3.4, 2.2], 190, {
    category: 'Review',
    metric: '23 logged',
    description: 'What was decided, by whom and why',
  }),
  named('goals', 'Quarter Goals', 'note', [-50, 7.9, -0.7], [3, 1.9], 320, {
    category: 'Planning',
    metric: '4 goals',
    description: 'Outcomes the quarter is measured by',
  }),
  named('retro', 'Retrospective', 'note', [174, 8.3, 1.3], [3.8, 2.4], 260, {
    category: 'Review',
    metric: '12 notes',
    description: 'What went well, and what to change',
  }),
]);

/** The research space's scene: named windows round a research question. */
const research: Preset = {
  id: 'research',
  name: 'preset.research',
  defaultSeed: 1,
  plan: (random, seed) => planNamed('research', RESEARCH, null, random, seed),
};

/** The planning space's scene: named windows round a roadmap. */
const planning: Preset = {
  id: 'planning',
  name: 'preset.planning',
  defaultSeed: 1,
  plan: (random, seed) => planNamed('planning', PLANNING, null, random, seed),
};

export const PRESETS: Readonly<Record<PresetId, Preset>> = Object.freeze({
  studio,
  research,
  planning,
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
 * The descriptive metadata the demo host exposes to search: each window's colour, by name, and
 * the category of what it shows where the host describes it. It is the host's description of its
 * content, as a real host would describe a document by its project or owner; search reads it only
 * because it is exposed, never the content itself.
 */
export const COLOUR_KEY = 'host.reference.colour';
export const CATEGORY_KEY = 'host.reference.category';
/**
 * The metadata key a window made from another window's surface keeps that window's ID under: the
 * window it is a part of.
 */
export const PART_OF_KEY = 'host.reference.partOf';
export const SEARCHABLE_METADATA: readonly string[] = Object.freeze([COLOUR_KEY, CATEGORY_KEY]);

/** A window's category ({@link CATEGORY_KEY}), or null for one without. */
export function categoryOf(node: {
  readonly metadata: Readonly<Record<string, unknown>>;
}): string | null {
  const category = node.metadata[CATEGORY_KEY];
  return typeof category === 'string' ? category : null;
}

/** A window's colour's name ({@link COLOUR_KEY}), or null for one without. */
export function colourOf(node: {
  readonly metadata: Readonly<Record<string, unknown>>;
}): string | null {
  const colour = node.metadata[COLOUR_KEY];
  return typeof colour === 'string' ? colour : null;
}

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
    return Math.max(most, Math.hypot(w.place.reach, w.place.y) + Math.hypot(width, height) / 2);
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
 * camera's place: upright, at its place in the room round the camera at the origin. Its tags say what kinds of content it shows;
 * its colour is its first part's.
 */
export function windowCommands(window: PlannedComposite, parentId: string): SceneCommand[] {
  const { place, parts } = window;
  const h = place.heading * RADIANS;
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
        metadata: {
          [COLOUR_KEY]: colourName(place.hue),
          ...(place.detail === undefined ? {} : { [CATEGORY_KEY]: place.detail.category }),
        },
        bounds: layout.bounds,
        transform: {
          // In the room: its heading round the camera, its reach along the floor, its height.
          position: [place.reach * Math.sin(h), place.y, -place.reach * Math.cos(h)],
          // Upright, with no turn of its own: a card always faces the camera.
          rotation: [0, 0, 0, 1],
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

/** What the binding keys of windows added from the controls start with. */
export const ADDED_KEY = 'added/note/';

/** How far out along the floor a window added from the controls stands, in world units. */
export const ADDED_REACH = 4.4;

/**
 * The content of the `number`th window added from the controls (key `added/note/<number>`): a blank
 * native note to type in, in a hue of its own. Where it stands is the scene's, not the key's: its
 * plan stands it straight ahead.
 */
export function addedWindow(number: number): PlannedWindow {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new RangeError(`an added window is numbered from 1 (got ${String(number)})`);
  }
  return Object.freeze({
    id: `new-window-${String(number)}`,
    label: `New window ${String(number)}`,
    content: 'note',
    bindingKey: `${ADDED_KEY}${String(number)}`,
    heading: 0,
    reach: ADDED_REACH,
    y: 0,
    width: 2.2,
    height: 1.5,
    // Golden-angle steps: each new window's hue far from the last ones'.
    hue: (number * 137) % 360,
  });
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
  const added = /^added\/note\/([1-9]\d*)$/.exec(key);
  if (added !== null) {
    const number = Number(added[1]);
    return Number.isSafeInteger(number) ? addedWindow(number) : null;
  }
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
