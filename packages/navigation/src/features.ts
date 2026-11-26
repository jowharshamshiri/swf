import type * as Lean from '@swf/models';
import { models, toJson } from '@swf/models';

/**
 * Navigation's eight capabilities (DLV-007, AC-015), each turned on or off on
 * its own, and the parameters of those that have any. Every module reads only these settings and
 * the framework's public contracts; none depends on another, so any one can be off while the rest
 * stay on. Turning a module off removes its hooks and its controls and never changes the scene's
 * data, its layout or what is saved.
 * - `focus`: focus and context, the Focus view mode;
 * - `orbit`: workspace orbit;
 * - `map`: the spatial map, the Map view mode;
 * - `cursor`: the wrapped cursor;
 * - `snap`: magnetic positioning;
 * - `depth`: semantic depth;
 * - `composition`: detaching, moving and merging surfaces and regrouping windows;
 * - `persistence`: saving the workspace as it changes, named workspaces, import and export.
 */

/** The modules, by stable ID, in the order the specification lists them. */
export const FEATURE_IDS = [
  'focus',
  'orbit',
  'map',
  'cursor',
  'snap',
  'depth',
  'composition',
  'persistence',
] as const;
/** A capability, by its ID. */
export type FeatureId = (typeof FEATURE_IDS)[number];

/** Magnetic positioning: how near counts as touching, and the gap it keeps between windows. */
export interface SnapSettings {
  /** World units within which an edge snaps to a neighbour's (§29's snap distance). */
  readonly linear: number;
  /** Degrees within which a window's centre lines up with a neighbour's, or the horizon. */
  readonly angular: number;
  /** World units of gap kept between snapped edges; windows closer than it are pushed apart. */
  readonly padding: number;
  /**
   * Degrees between the spokes round the camera a window's heading snaps to, within the angular
   * threshold: 0 for none, at most 90.
   */
  readonly spoke: number;
  /**
   * World units within which a window's distance from the camera snaps to a ring ({@link ringsOf}):
   * 0 for none.
   */
  readonly ring: number;
}

/**
 * Semantic depth's bands, in world units from the camera: a window nearer than `full` shows its
 * content, one nearer than `compact` a compact preview, and one farther its label alone.
 */
export interface DepthBands {
  /** World units from the camera within which a window shows its content. */
  readonly full: number;
  /** World units within which it shows a compact preview; more than `full`. */
  readonly compact: number;
}

/** The capabilities' settings: which is on, and the parameters of snapping and semantic depth. */
export interface FeatureSettings {
  /** Whether each capability is on. */
  readonly enabled: Readonly<Record<FeatureId, boolean>>;
  /** Magnetic snapping's parameters. */
  readonly snap: SnapSettings;
  /** Semantic depth's bands. */
  readonly depth: DepthBands;
}

/** Every module on: the combined preset. */
export const ALL_ENABLED: Readonly<Record<FeatureId, boolean>> = Object.freeze(
  Object.fromEntries(FEATURE_IDS.map((id) => [id, true])) as Record<FeatureId, boolean>,
);

/** The defaults: the combined preset (every module on), with the specification's parameters. */
export const DEFAULT_FEATURES: FeatureSettings = Object.freeze({
  enabled: ALL_ENABLED,
  snap: Object.freeze({ linear: 0.08, angular: 2, padding: 0.04, spoke: 15, ring: 0.3 }),
  depth: Object.freeze({ full: 4, compact: 5.5 }),
});

/**
 * The rings round the camera, nearest first, in world units: one within each band semantic depth
 * draws by (near enough to show whole, compact, a label alone). Windows are arranged on them, and
 * magnetic positioning snaps a window's distance to them.
 */
export function ringsOf(depth: DepthBands): readonly [number, number, number] {
  return [depth.full * 0.75, (depth.full + depth.compact) / 2, depth.compact * 1.15];
}

/** A change to the settings: only what it names changes. */
export interface FeaturePatch {
  /** The capabilities turned on or off. */
  readonly enabled?: Partial<Record<FeatureId, boolean>>;
  /** Snapping's parameters changed. */
  readonly snap?: Partial<SnapSettings>;
  /** Semantic depth's bands changed. */
  readonly depth?: Partial<DepthBands>;
}

/** A setting navigation cannot use, by its field. */
export class FeatureError extends Error {
  constructor(
    /** The setting at fault. */
    readonly field: string,
    /** Why it cannot be used. */
    readonly reason: string,
  ) {
    super(`${field}: ${reason}`);
    this.name = 'FeatureError';
  }
}

/**
 * The settings with a patch applied, validated as a whole by the Lean model `Swf.AppFeatures`
 * (models/Swf/AppFeatures.lean), where it is proved that valid settings stay valid and that a
 * patch is applied whole or not at all. Throws {@link FeatureError} naming the first field at
 * fault; the current settings are never changed. A part the patch leaves as it was is the very
 * same object, and a patch that changes nothing gives back `current` itself.
 */
export function updateFeatures(current: FeatureSettings, patch: unknown): FeatureSettings {
  const update = models.featuresUpdate(
    { enabled: current.enabled, snap: current.snap, depth: current.depth },
    toJson(patch, 'features'),
  );
  if (update.kind === 'refused') {
    throw new FeatureError(update.field, reasonOf(update.fault));
  }
  if (update.enabled === null && update.snap === null && update.depth === null) {
    return current;
  }
  return Object.freeze({
    enabled: update.enabled === null ? current.enabled : Object.freeze({ ...update.enabled }),
    snap: update.snap === null ? current.snap : Object.freeze({ ...update.snap }),
    depth: update.depth === null ? current.depth : Object.freeze({ ...update.depth }),
  });
}

/** What is wrong with a refused field, as the operator is told it. */
function reasonOf(fault: Lean.FeatureFault): string {
  switch (fault.kind) {
    case 'notObject':
      return 'must be an object';
    case 'unknown':
      return `is not a setting; the settings are ${fault.settings.join(', ')}`;
    case 'notBoolean':
      return 'must be true or false';
    case 'notNonNegative':
      return 'must be a finite number, zero or more';
    case 'notPositive':
      return 'must be a finite number above zero';
    case 'tooWide':
      return `must be at most ${String(fault.max)} degrees`;
    case 'bandsOutOfOrder':
      return `the compact band must end farther than the full one (full ${String(fault.full)}, compact ${String(fault.compact)})`;
  }
}
