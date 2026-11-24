import type { SceneCommand } from '@swf/core';
import { createWorkspace, worldMatrix } from '@swf/core';
import { dot, mat4TransformDirection, mat4TransformPoint, normalize, scale } from '@swf/math';
import { createPresentationRegistry, createViewOutput, viewGeometryOf } from '@swf/presentation';
import {
  createProjectionRegistry,
  equirectangular,
  pickAt,
  projectionFor,
  projectorOf,
} from '@swf/projections';
import { describe, expect, it } from 'vitest';
import type { PresetId } from '../src/presets.js';
import {
  CAMERA_ID,
  composites,
  planPreset,
  PRESET_IDS,
  PRESETS,
  presetCommands,
} from '../src/presets.js';
import { MAX_SEED } from '@swf/math';

const W = 1440;
const H = 480;

/** A workspace holding a preset's windows, with a panorama viewport `v` at W×H. */
function seeded(preset: PresetId, seed: number) {
  const ws = createWorkspace({ id: 'test', now: () => 0 });
  const presentation = createPresentationRegistry();
  const projections = createProjectionRegistry({
    kinds: ws.mutator(),
    projectors: presentation.registrar(),
  });
  projections.register(equirectangular);
  const commands: SceneCommand[] = [
    { type: 'camera.create', camera: { id: CAMERA_ID } },
    {
      type: 'viewport.create',
      viewport: {
        id: 'v',
        cameraId: CAMERA_ID,
        projection: { id: 'equirectangular/1', config: { horizontal: 360, vertical: 120 } },
        size: { width: W, height: H, devicePixelRatio: 1 },
      },
    },
    ...presetCommands(planPreset(preset, seed)),
  ];
  const result = ws.transaction(commands);
  if (result.status !== 'committed') {
    throw new Error(`could not seed ${preset}@${String(seed)}: ${JSON.stringify(result)}`);
  }
  return ws;
}

describe('demo presets (FR-131, MIG-005, AN-010)', () => {
  it('offers sparse, dense, seam/behind-camera and composed scenes besides the empty one', () => {
    expect(PRESET_IDS).toEqual(['empty', 'sparse', 'dense', 'seam', 'composed']);
    expect(planPreset('composed', 1)).toHaveLength(5);
    expect(planPreset('empty', 1)).toEqual([]);
    expect(planPreset('sparse', 1)).toHaveLength(6);
    // The dense scene has the benchmark's window count, so modes compare at matching counts.
    expect(planPreset('dense', 1)).toHaveLength(250);
    expect(planPreset('seam', 1)).toHaveLength(7);
  });

  it('plans exactly the committed scenes, so a change in seeding is a deliberate one', async () => {
    const plans = {
      'empty@1': planPreset('empty', 1),
      'sparse@1': planPreset('sparse', 1),
      'sparse@42': planPreset('sparse', 42),
      'dense@1': planPreset('dense', 1),
      'seam@1': planPreset('seam', 1),
      'seam@7': planPreset('seam', 7),
      'composed@1': planPreset('composed', 1),
    };
    await expect(`${JSON.stringify(plans, null, 2)}\n`).toMatchFileSnapshot(
      './fixtures/preset-plans.json',
    );
  });

  it('plans the same windows for the same seed and different ones for another', () => {
    for (const id of PRESET_IDS) {
      const seed = PRESETS[id].defaultSeed;
      expect(planPreset(id, seed)).toEqual(planPreset(id, seed));
      if (id !== 'empty') {
        expect(planPreset(id, seed + 1)).not.toEqual(planPreset(id, seed));
      }
    }
  });

  it('builds the same layout from the same plan in any workspace', () => {
    for (const id of PRESET_IDS) {
      const a = seeded(id, 5).serialize();
      const b = seeded(id, 5).serialize();
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    }
  });

  it('gives every window and binding key its own identity, numbered in order', () => {
    for (const id of PRESET_IDS) {
      const plan = planPreset(id, 3);
      expect(new Set(plan.map((w) => w.id)).size).toBe(plan.length);
      expect(new Set(plan.map((w) => w.bindingKey)).size).toBe(plan.length);
      plan.forEach((w, i) => {
        expect(Number(w.id.replace('window-', ''))).toBe(i + 1);
        expect(w.heading).toBeGreaterThan(-180);
        expect(w.heading).toBeLessThanOrEqual(180);
      });
    }
    // The same window number in two presets is two different pieces of content.
    expect(planPreset('sparse', 1)[0]?.bindingKey).not.toBe(planPreset('seam', 1)[0]?.bindingKey);
  });

  it('places every window facing the camera at its planned direction and distance', () => {
    for (const id of PRESET_IDS) {
      const ws = seeded(id, 9);
      // A composed window stands where its first part is planned.
      for (const { id: windowId, place: planned } of composites(planPreset(id, 9))) {
        const m = worldMatrix(ws.getState().nodes, windowId);
        if (m === undefined) {
          throw new Error(`no ${windowId}`);
        }
        const centre = mat4TransformPoint(m, [0, 0, 0]);
        const h = (planned.heading * Math.PI) / 180;
        const e = (planned.elevation * Math.PI) / 180;
        const expected = scale(
          [Math.cos(e) * Math.sin(h), Math.sin(e), -Math.cos(e) * Math.cos(h)],
          planned.distance,
        );
        centre.forEach((v, i) => {
          expect(v).toBeCloseTo(expected[i] ?? NaN, 9);
        });
        // The window's front (+Z) points back at the camera.
        const front = normalize(mat4TransformDirection(m, [0, 0, 1]));
        expect(dot(front, normalize(scale(centre, -1)))).toBeCloseTo(1, 9);
      }
    }
  });
});

describe('the seam and behind-camera scene (UX-002, WF-03)', () => {
  it('always has a window centred exactly on the seam, and windows behind the camera on both sides', () => {
    for (const seed of [0, 1, 7, 1234, MAX_SEED]) {
      const plan = planPreset('seam', seed);
      expect(plan[0]?.heading).toBe(180);
      const behind = plan.filter((w) => Math.abs(w.heading) > 90);
      expect(behind.some((w) => w.heading > 0)).toBe(true);
      expect(behind.some((w) => w.heading < 0)).toBe(true);
      expect(behind.length).toBeGreaterThanOrEqual(5);
      expect(plan.some((w) => w.elevation > 45)).toBe(true);
    }
  });

  it('shows a seam-crossing window on both edges of the panorama, and picks it as one surface there', () => {
    const ws = seeded('seam', 1);
    const state = ws.getState();
    const view = viewGeometryOf(state, 'v');
    const geometry = (id: string) => ws.surfaceGeometry(id);
    const fragments = createViewOutput(
      state,
      'v',
      projectorOf(equirectangular).project(state, view, geometry),
    ).fragments.filter((f) => f.surfaceId === 'window-01-surface');
    expect(fragments).toHaveLength(2);
    const lefts = fragments.map((f) => f.bounds[0]).sort((a, b) => a - b);
    expect(lefts[0]).toBeLessThan(1);
    expect((lefts[1] ?? 0) + (fragments[1]?.bounds[2] ?? 0)).toBeGreaterThan(W / 2);

    const projection = projectionFor(equirectangular, view);
    for (const x of [3, 20, W - 20, W - 3]) {
      const pick = pickAt(projection, state, view, x, H / 2, geometry);
      expect(pick.kind).toBe('hits');
      if (pick.kind === 'hits') {
        expect(pick.candidates[0]?.surfaceId).toBe('window-01-surface');
      }
    }
  });
});
