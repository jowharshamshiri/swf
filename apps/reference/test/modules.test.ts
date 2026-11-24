import { describe, expect, it } from 'vitest';
import { FEATURE_IDS } from '../src/features.js';
import { FOCUS_ID } from '../src/focus.js';
import { MAP, PANORAMA } from '../src/modes.js';
import { plannedByKey, planPreset } from '../src/presets.js';
import { policyWorld } from './policy-world.js';

/** Every node's place and every surface's binding: what turning a module off must not change. */
const layoutOf = (world: ReturnType<typeof policyWorld>) =>
  JSON.stringify(world.ws.serialize().nodes) + JSON.stringify(world.ws.serialize().surfaces);

describe('the eight modules, each on its own (FR-130, UX-010, AC-015, §33.2 scenario 5)', () => {
  it('registers the Focus and Map modes only while their features are on, in their places', () => {
    const world = policyWorld('sparse');
    const ids = () => world.modes.list().map((m) => m.id);
    expect(ids()).toEqual([PANORAMA.id, FOCUS_ID, MAP.id]);
    world.policies.configure({ enabled: { focus: false } });
    expect(ids()).toEqual([PANORAMA.id, MAP.id]);
    world.policies.configure({ enabled: { map: false } });
    expect(ids()).toEqual([PANORAMA.id]);
    // Back on, each comes back to its own place.
    world.policies.configure({ enabled: { map: true } });
    world.policies.configure({ enabled: { focus: true } });
    expect(ids()).toEqual([PANORAMA.id, FOCUS_ID, MAP.id]);
  });

  it('leaves a mode being shown for the view it came from when its feature is turned off', () => {
    const world = policyWorld('sparse');
    const camera = () => JSON.stringify(world.ws.getState().cameras.get('camera')?.rotation);
    const before = camera();
    expect(world.modes.switchTo(FOCUS_ID, { target: 'window-02' }).status).toBe('committed');
    expect(camera()).not.toBe(before);
    world.policies.configure({ enabled: { focus: false } });
    expect(world.modes.current()).toBe(PANORAMA.id);
    expect(camera()).toBe(before);
    // Focus entered from the map goes back to the map.
    world.policies.configure({ enabled: { focus: true } });
    world.modes.switchTo(MAP.id);
    world.modes.switchTo(FOCUS_ID, { target: 'window-03' });
    world.policies.configure({ enabled: { focus: false } });
    expect(world.modes.current()).toBe(MAP.id);
    expect(camera()).toBe(before);
    world.policies.configure({ enabled: { map: false } });
    expect(world.modes.current()).toBe(PANORAMA.id);
  });

  it('turns any one module off and on without touching the layout or the others', () => {
    const world = policyWorld('dense');
    const layout = layoutOf(world);
    for (const id of FEATURE_IDS) {
      world.policies.configure({ enabled: { [id]: false } });
      const enabled = world.policies.status().features.enabled;
      expect(FEATURE_IDS.filter((other) => !enabled[other])).toEqual([id]);
      expect(layoutOf(world), id).toBe(layout);
      world.policies.configure({ enabled: { [id]: true } });
    }
    expect(layoutOf(world)).toBe(layout);
  });

  it('keeps no state shared between two applications: each has its own modules', () => {
    const a = policyWorld('sparse');
    const b = policyWorld('sparse');
    a.policies.configure({ enabled: { focus: false, snap: false }, snap: { linear: 0.2 } });
    expect(b.policies.status().features.enabled.focus).toBe(true);
    expect(b.policies.status().features.snap.linear).toBe(0.08);
    expect(b.modes.list().map((m) => m.id)).toContain(FOCUS_ID);
    expect(a.modes.list().map((m) => m.id)).not.toContain(FOCUS_ID);
  });
});

describe('the demo host’s content, found by key', () => {
  it('finds the window any preset plans from its key alone, and nothing for another key', () => {
    for (const planned of [...planPreset('sparse', 42), ...planPreset('composed', 1)]) {
      expect(plannedByKey(planned.bindingKey)).toEqual(planned);
    }
    for (const key of ['sparse/note/1/99', 'nope/note/1/01', 'sparse/tile/x/01', 'test/a', '']) {
      expect(plannedByKey(key)).toBeNull();
    }
  });
});
