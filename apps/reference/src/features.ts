/**
 * The reference application's optional policies, each turned on or off on its own, and the
 * parameters of those that have any. Every policy is a module of its own that reads only these
 * settings and the framework's public contracts; none depends on another, so any one can be off
 * while the rest stay on. Turning a policy off removes its hooks and its controls and never
 * changes the scene's data or its layout.
 */

/** The policies, by stable ID. */
export const FEATURE_IDS = ['orbit', 'depth', 'snap', 'cursor'] as const;
export type FeatureId = (typeof FEATURE_IDS)[number];

/** Magnetic positioning: how near counts as touching, and the gap it keeps between windows. */
export interface SnapSettings {
  /** World units within which an edge snaps to a neighbour's (§29's snap distance). */
  readonly linear: number;
  /** Degrees within which a window's centre lines up with a neighbour's, or the horizon. */
  readonly angular: number;
  /** World units of gap kept between snapped edges; windows closer than it are pushed apart. */
  readonly padding: number;
}

/**
 * Semantic depth's bands, in world units from the camera: a window nearer than `full` shows its
 * content, one nearer than `compact` a compact preview, and one farther its label alone.
 */
export interface DepthBands {
  readonly full: number;
  readonly compact: number;
}

export interface FeatureSettings {
  readonly enabled: Readonly<Record<FeatureId, boolean>>;
  readonly snap: SnapSettings;
  readonly depth: DepthBands;
}

/** The combined configuration: every policy on, with the specification's defaults. */
export const DEFAULT_FEATURES: FeatureSettings = Object.freeze({
  enabled: Object.freeze({ orbit: true, depth: true, snap: true, cursor: true }),
  snap: Object.freeze({ linear: 0.08, angular: 2, padding: 0.04 }),
  depth: Object.freeze({ full: 4, compact: 5.5 }),
});

/** A change to the settings: only what it names changes. */
export interface FeaturePatch {
  readonly enabled?: Partial<Record<FeatureId, boolean>>;
  readonly snap?: Partial<SnapSettings>;
  readonly depth?: Partial<DepthBands>;
}

/** A setting the application cannot use, by its field. */
export class FeatureError extends Error {
  constructor(
    readonly field: string,
    readonly reason: string,
  ) {
    super(`${field}: ${reason}`);
    this.name = 'FeatureError';
  }
}

/** The largest angular snap threshold: beyond it everything would snap to everything. */
export const MAX_ANGULAR_SNAP = 15;

/**
 * The settings with a patch applied, validated as a whole. Throws {@link FeatureError} naming the
 * first field at fault; the current settings are never changed.
 */
export function updateFeatures(current: FeatureSettings, patch: unknown): FeatureSettings {
  const p = record(patch, 'features');
  known(p, ['enabled', 'snap', 'depth'], 'features');
  let enabled = current.enabled;
  if (p['enabled'] !== undefined) {
    const e = record(p['enabled'], 'enabled');
    known(e, FEATURE_IDS, 'enabled');
    const next: Record<FeatureId, boolean> = { ...current.enabled };
    for (const id of FEATURE_IDS) {
      const value = e[id];
      if (value === undefined) {
        continue;
      }
      if (typeof value !== 'boolean') {
        throw new FeatureError(`enabled.${id}`, 'must be true or false');
      }
      next[id] = value;
    }
    enabled = Object.freeze(next);
  }
  let snap = current.snap;
  if (p['snap'] !== undefined) {
    const s = record(p['snap'], 'snap');
    known(s, ['linear', 'angular', 'padding'], 'snap');
    snap = Object.freeze({
      linear:
        s['linear'] === undefined ? current.snap.linear : nonNegative(s['linear'], 'snap.linear'),
      angular:
        s['angular'] === undefined
          ? current.snap.angular
          : nonNegative(s['angular'], 'snap.angular'),
      padding:
        s['padding'] === undefined
          ? current.snap.padding
          : nonNegative(s['padding'], 'snap.padding'),
    });
    if (snap.angular > MAX_ANGULAR_SNAP) {
      throw new FeatureError('snap.angular', `must be at most ${String(MAX_ANGULAR_SNAP)} degrees`);
    }
  }
  let depth = current.depth;
  if (p['depth'] !== undefined) {
    const d = record(p['depth'], 'depth');
    known(d, ['full', 'compact'], 'depth');
    depth = Object.freeze({
      full: d['full'] === undefined ? current.depth.full : positive(d['full'], 'depth.full'),
      compact:
        d['compact'] === undefined
          ? current.depth.compact
          : positive(d['compact'], 'depth.compact'),
    });
    if (!(depth.compact > depth.full)) {
      throw new FeatureError(
        d['compact'] === undefined ? 'depth.full' : 'depth.compact',
        `the compact band must end farther than the full one (full ${String(depth.full)}, compact ${String(depth.compact)})`,
      );
    }
  }
  const next = Object.freeze({
    enabled: same(enabled, current.enabled) ? current.enabled : enabled,
    snap: same(snap, current.snap) ? current.snap : snap,
    depth: same(depth, current.depth) ? current.depth : depth,
  });
  return next.enabled === current.enabled &&
    next.snap === current.snap &&
    next.depth === current.depth
    ? current
    : next;
}

/** Whether two flat settings records hold the same values. */
function same<T extends object>(a: T, b: T): boolean {
  return (Object.keys(a) as (keyof T)[]).every((key) => Object.is(a[key], b[key]));
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new FeatureError(field, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function known(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  if (extra !== undefined) {
    throw new FeatureError(
      `${field}.${extra}`,
      `is not a setting; the settings are ${keys.join(', ')}`,
    );
  }
}

function nonNegative(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new FeatureError(field, 'must be a finite number, zero or more');
  }
  return value;
}

function positive(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new FeatureError(field, 'must be a finite number above zero');
  }
  return value;
}
