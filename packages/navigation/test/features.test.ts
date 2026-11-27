import { describe, expect, it } from 'vitest';
import {
  ALL_ENABLED,
  DEFAULT_FEATURES,
  FEATURE_IDS,
  FeatureError,
  updateFeatures,
} from '../src/features.js';

/** The field a patch is refused for, or null when it is taken. */
function refusal(patch: unknown): string | null {
  try {
    updateFeatures(DEFAULT_FEATURES, patch);
    return null;
  } catch (error) {
    if (error instanceof FeatureError) {
      return error.field;
    }
    throw error;
  }
}

describe('feature settings (FR-130, UX-010, §29, CFG-001)', () => {
  it('turns all eight modules on in the combined defaults, with the specification’s snap distance', () => {
    expect(FEATURE_IDS).toEqual([
      'focus',
      'orbit',
      'map',
      'cursor',
      'snap',
      'depth',
      'composition',
      'persistence',
    ]);
    expect(DEFAULT_FEATURES.enabled).toEqual(ALL_ENABLED);
    expect(Object.values(ALL_ENABLED)).toEqual(FEATURE_IDS.map(() => true));
    expect(DEFAULT_FEATURES.snap.linear).toBe(0.08);
    expect(DEFAULT_FEATURES.depth.full).toBeLessThan(DEFAULT_FEATURES.depth.compact);
  });

  it('changes only what a patch names, each policy on its own', () => {
    const off = updateFeatures(DEFAULT_FEATURES, { enabled: { snap: false } });
    expect(off.enabled).toEqual({ ...ALL_ENABLED, snap: false });
    // Each module on its own: turning any one off leaves the other seven on.
    for (const id of FEATURE_IDS) {
      const one = updateFeatures(DEFAULT_FEATURES, { enabled: { [id]: false } });
      expect(FEATURE_IDS.filter((other) => !one.enabled[other])).toEqual([id]);
    }
    expect(off.snap).toBe(DEFAULT_FEATURES.snap);
    expect(off.depth).toBe(DEFAULT_FEATURES.depth);
    const banded = updateFeatures(off, { depth: { compact: 9 } });
    expect(banded.depth).toEqual({ full: DEFAULT_FEATURES.depth.full, compact: 9 });
    expect(banded.enabled).toBe(off.enabled);
    // A patch that changes nothing gives back the very same settings.
    expect(updateFeatures(banded, { enabled: { snap: false } })).toBe(banded);
    // Resetting is patching with the defaults.
    expect(updateFeatures(banded, DEFAULT_FEATURES)).toEqual(DEFAULT_FEATURES);
  });

  it('refuses an invalid setting by its field and keeps the settings as they were', () => {
    expect(refusal({ enabled: { zoom: true } })).toBe('enabled.zoom');
    expect(refusal({ enabled: { orbit: 'yes' } })).toBe('enabled.orbit');
    expect(refusal({ snap: { linear: -0.01 } })).toBe('snap.linear');
    expect(refusal({ snap: { padding: Number.NaN } })).toBe('snap.padding');
    expect(refusal({ snap: { angular: 16 } })).toBe('snap.angular');
    expect(refusal({ depth: { full: 0 } })).toBe('depth.full');
    expect(refusal({ depth: { compact: 3 } })).toBe('depth.compact');
    // Past where the compact band ends.
    expect(refusal({ depth: { full: 9.5 } })).toBe('depth.full');
    expect(refusal({ speed: 1 })).toBe('features.speed');
    expect(refusal('on')).toBe('features');
    // Zero is a valid snap distance: nothing snaps by edges.
    expect(refusal({ snap: { linear: 0 } })).toBeNull();
    expect(DEFAULT_FEATURES.snap.linear).toBe(0.08);
  });
});
