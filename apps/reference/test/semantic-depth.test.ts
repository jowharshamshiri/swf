import { representationFor, viewGeometryOf } from '@swf/presentation';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEATURES,
  FOCUS_ID,
  distanceFrom,
  representationAt,
  semanticDepth,
} from '@swf/navigation';
import { planPreset } from '../src/presets.js';
import { FOCUS, policyWorld, VIEWPORT } from './policy-world.js';

const BANDS = { full: 4, compact: 5.5 };

describe('semantic depth (FR-122, ARCH-025)', () => {
  it('maps distance bands to full, compact and label-only representations', () => {
    expect(representationAt(0, BANDS)).toBe('full');
    expect(representationAt(3.99, BANDS)).toBe('full');
    // A band's end belongs to the next band.
    expect(representationAt(4, BANDS)).toBe('compact');
    expect(representationAt(5.49, BANDS)).toBe('compact');
    expect(representationAt(5.5, BANDS)).toBe('label');
    expect(representationAt(500, BANDS)).toBe('label');
    expect(() => representationAt(-1, BANDS)).toThrow(RangeError);
    expect(() => representationAt(Number.NaN, BANDS)).toThrow(RangeError);
  });

  it('represents each window of a scene by its distance from the camera along the floor, reading only the scene', () => {
    const w = policyWorld('dense');
    const state = w.ws.getState();
    const view = viewGeometryOf(state, VIEWPORT);
    const policy = semanticDepth({
      bands: DEFAULT_FEATURES.depth,
      focusModeId: FOCUS_ID,
      focus: FOCUS,
    });
    const counts = { full: 0, compact: 0, label: 0 };
    for (const planned of planPreset('dense', 1)) {
      const chosen = representationFor(policy, {
        scene: state,
        view,
        surfaceId: `${planned.id}-surface`,
        nodeId: planned.id,
      });
      // The planned reach is the window's distance from the camera along the floor, and its band
      // decides, whatever its height.
      const distance = distanceFrom(state, planned.id, view);
      expect(distance).toBeCloseTo(planned.reach, 9);
      expect(chosen).toBe(representationAt(distance, DEFAULT_FEATURES.depth));
      counts[chosen] += 1;
    }
    // The dense scene spans every band.
    expect(counts.full).toBeGreaterThan(0);
    expect(counts.compact).toBeGreaterThan(0);
    expect(counts.label).toBeGreaterThan(0);
    // Representing changed nothing in the scene.
    expect(w.ws.getState()).toBe(state);
  });

  it('follows a window as it moves nearer, and turns with the workspace without changing band', () => {
    const w = policyWorld('dense');
    const policy = semanticDepth({ bands: BANDS, focusModeId: FOCUS_ID, focus: FOCUS });
    const represent = (nodeId: string) => {
      const scene = w.ws.getState();
      return representationFor(policy, {
        scene,
        view: viewGeometryOf(scene, VIEWPORT),
        surfaceId: `${nodeId}-surface`,
        nodeId,
      });
    };
    const far = planPreset('dense', 1).find((p) => p.reach >= 5.5);
    if (far === undefined) {
      throw new Error('the dense scene has no far window');
    }
    expect(represent(far.id)).toBe('label');
    // Turned round the camera with the workspace: as far as before.
    w.policies.turnWorkspace(90);
    expect(represent(far.id)).toBe('label');
    // Brought nearer along the floor, and raised high: 3 out, so shown in full, though 4.2 away.
    const node = w.ws.getState().nodes.get(far.id);
    const [x, , z] = node?.transform.position ?? [0, 0, 0];
    const k = 3 / Math.hypot(x, z);
    w.ws.transaction(
      [
        {
          type: 'node.patch',
          id: far.id,
          transform: {
            ...(node?.transform ?? { rotation: [0, 0, 0, 1], scale: [1, 1, 1] }),
            position: [x * k, 3, z * k],
          },
        },
      ],
      { source: 'user' },
    );
    expect(represent(far.id)).toBe('full');
  });

  it('shows the window focus presents in full, whatever its distance', () => {
    const w = policyWorld('dense');
    const policy = semanticDepth({ bands: BANDS, focusModeId: FOCUS_ID, focus: FOCUS });
    const far = planPreset('dense', 1).find((p) => p.reach >= 5.5);
    if (far === undefined) {
      throw new Error('the dense scene has no far window');
    }
    w.ws.transaction([
      { type: 'focus.set', id: far.id },
      { type: 'viewport.patch', id: VIEWPORT, mode: FOCUS_ID },
    ]);
    const scene = w.ws.getState();
    const view = viewGeometryOf(scene, VIEWPORT);
    const context = { scene, view, surfaceId: `${far.id}-surface`, nodeId: far.id };
    expect(representationFor(policy, context)).toBe('full');
    // Focused but in the panorama, it is represented by its distance like any other.
    w.ws.transaction([{ type: 'viewport.patch', id: VIEWPORT, mode: 'panorama' }]);
    const panorama = w.ws.getState();
    expect(
      representationFor(policy, {
        ...context,
        scene: panorama,
        view: viewGeometryOf(panorama, VIEWPORT),
      }),
    ).toBe('label');
  });
});
