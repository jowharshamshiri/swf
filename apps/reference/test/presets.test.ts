import type { SceneCommand } from '@swf/core';
import { createWorkspace, worldMatrix } from '@swf/core';
import { createInteractionRouter } from '@swf/interaction';
import { mat4Decompose, mat4TransformPoint } from '@swf/math';
import { createPresentationRegistry, createViewOutput, viewGeometryOf } from '@swf/presentation';
import { createProjectionRegistry, equirectangular, projectorOf } from '@swf/projections';
import { describe, expect, it } from 'vitest';
import type { PresetId } from '../src/presets.js';
import {
  addedWindow,
  composites,
  planPreset,
  PRESET_IDS,
  plannedByKey,
  PRESETS,
  presetCommands,
} from '../src/presets.js';
import { CAMERA_ID } from '@swf/navigation';
import { MAX_SEED } from '@swf/math';

const W = 1440;
const H = 480;

/** A workspace holding a preset's windows, with a panorama viewport `v` at W×H. */
function seeded(preset: PresetId, seed: number) {
  return seededWith(preset, seed).ws;
}

/** A preset's windows seeded, with the projections registered for them. */
function seededWith(preset: PresetId, seed: number) {
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
  return { ws, projections };
}

/** The bands semantic depth shows by default, by distance along the floor: 6.7 and 9.3. */
const band = (reach: number) => (reach < 6.7 ? 'full' : reach < 9.3 ? 'compact' : 'label');

/** Degrees above the horizon a planned window looks, from its height and its reach. */
const elevationOf = (w: { readonly reach: number; readonly y: number }) =>
  (Math.atan2(w.y, w.reach) * 180) / Math.PI;

describe('demo presets (FR-131, MIG-005, AN-010)', () => {
  it('offers the studio, research, planning, sparse, dense, seam/behind-camera and composed scenes besides the empty one', () => {
    expect(PRESET_IDS).toEqual([
      'studio',
      'research',
      'planning',
      'empty',
      'sparse',
      'dense',
      'seam',
      'composed',
    ]);
    expect(planPreset('studio', 1)).toHaveLength(15);
    expect(planPreset('research', 1)).toHaveLength(10);
    expect(planPreset('planning', 1)).toHaveLength(10);
    expect(planPreset('composed', 1)).toHaveLength(5);
    expect(planPreset('empty', 1)).toEqual([]);
    expect(planPreset('sparse', 1)).toHaveLength(6);
    // The dense scene has the benchmark's window count, so modes compare at matching counts.
    expect(planPreset('dense', 1)).toHaveLength(250);
    expect(planPreset('seam', 1)).toHaveLength(7);
  });

  it('plans exactly the committed scenes, so a change in seeding is a deliberate one', async () => {
    const plans = {
      'studio@1': planPreset('studio', 1),
      'studio@42': planPreset('studio', 42),
      'research@1': planPreset('research', 1),
      'planning@1': planPreset('planning', 1),
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
        // The named scenes' windows are known by name; the generated scenes' by number.
        if (!['studio', 'research', 'planning'].includes(id)) {
          expect(Number(w.id.replace('window-', ''))).toBe(i + 1);
        }
        expect(Number(w.bindingKey.split('/').at(-1))).toBe(i + 1);
        expect(w.heading).toBeGreaterThan(-180);
        expect(w.heading).toBeLessThanOrEqual(180);
      });
    }
    // The same window number in two presets is two different pieces of content.
    expect(planPreset('sparse', 1)[0]?.bindingKey).not.toBe(planPreset('seam', 1)[0]?.bindingKey);
  });

  it('stands every window upright in the room at its planned heading, reach and height', () => {
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
        const expected = [planned.reach * Math.sin(h), planned.y, -planned.reach * Math.cos(h)];
        centre.forEach((v, i) => {
          expect(v).toBeCloseTo(expected[i] ?? NaN, 9);
        });
        // Drawn as a card, it carries no rotation of its own.
        const world = mat4Decompose(m);
        expect(world.ok && world.transform.rotation).toEqual([0, 0, 0, 1]);
      }
    }
  });
});

describe('the research and planning scenes, seeded spaces of their own', () => {
  it('stand named, described, distinguishable windows all the way round and at every depth, live near and drawn far', () => {
    for (const preset of ['research', 'planning'] as const) {
      const base = planPreset(preset, 1);
      for (const seed of [0, 1, 7, 1234, MAX_SEED]) {
        const plan = planPreset(preset, seed);
        expect(plan).toHaveLength(10);
        expect(new Set(plan.map((w) => w.label)).size).toBe(10);
        expect(new Set(plan.map((w) => w.hue)).size).toBe(10);
        for (const w of plan) {
          expect(w.detail?.category).toBeTruthy();
          expect(w.detail?.metric).toBeTruthy();
          expect(w.detail?.description).toBeTruthy();
          expect(w.bindingKey.startsWith(`${preset}/`)).toBe(true);
        }
        for (const [from, to] of [
          [-180, -90],
          [-90, 0],
          [0, 90],
          [90, 180],
        ] as const) {
          expect(plan.some((w) => w.heading >= from && w.heading <= to)).toBe(true);
        }
        expect(plan.filter((w) => Math.abs(w.heading) > 90).length).toBeGreaterThanOrEqual(4);
        // Above and below the camera's level.
        expect(plan.some((w) => w.y >= 1)).toBe(true);
        expect(plan.some((w) => w.y <= -0.9)).toBe(true);
        for (const which of ['full', 'compact', 'label']) {
          expect(plan.filter((w) => band(w.reach) === which).length).toBeGreaterThanOrEqual(2);
        }
        // As in the studio: every window shown in full is a live note; tiles are drawn.
        for (const w of plan.filter((p) => band(p.reach) === 'full')) {
          expect(w.content).toBe('note');
        }
        expect(plan.some((w) => w.content === 'tile')).toBe(true);
        // The seed moves each window a few degrees, never across a band.
        plan.forEach((w, i) => {
          const planned = base[i];
          expect(w.id).toBe(planned?.id);
          expect(band(w.reach)).toBe(band(planned?.reach ?? NaN));
          const turned = Math.abs(((w.heading - (planned?.heading ?? NaN) + 540) % 360) - 180);
          expect(turned).toBeLessThanOrEqual(6);
        });
      }
    }
  });
});

describe('the studio, the default scene', () => {
  it('stands named, distinguishable windows all the way round the camera and at every depth', () => {
    for (const seed of [0, 1, 7, 1234, MAX_SEED]) {
      const made = composites(planPreset('studio', seed));
      expect(made).toHaveLength(13);
      const places = made.map((w) => w.place);
      // Every name and colour its own, every window described.
      expect(new Set(made.map((w) => w.label)).size).toBe(13);
      expect(new Set(places.map((p) => p.hue)).size).toBe(13);
      for (const part of planPreset('studio', seed)) {
        expect(part.detail?.category).toBeTruthy();
        expect(part.detail?.metric).toBeTruthy();
        expect(part.detail?.description).toBeTruthy();
      }
      // All the way round: each quarter of the circle holds windows, and eight are behind.
      for (const [from, to] of [
        [-180, -90],
        [-90, 0],
        [0, 90],
        [90, 180],
      ] as const) {
        expect(places.some((p) => p.heading >= from && p.heading <= to)).toBe(true);
      }
      expect(places.filter((p) => Math.abs(p.heading) > 90)).toHaveLength(6);
      // High and low round the room.
      expect(places.some((p) => elevationOf(p) > 20)).toBe(true);
      expect(places.some((p) => p.y <= -1.9)).toBe(true);
      // Each depth band holds several windows.
      for (const which of ['full', 'compact', 'label']) {
        expect(places.filter((p) => band(p.reach) === which).length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('holds one board of three surfaces straight ahead, to break apart and put back', () => {
    const board = composites(planPreset('studio', 1)).find((w) => w.parts.length > 1);
    expect(board?.id).toBe('board');
    expect(board?.label).toBe('Project Board');
    expect(board?.parts.map((p) => p.label)).toEqual(['Plan', 'Timeline', 'Sources']);
    expect(board?.place.heading).toBe(0);
    expect(composites(planPreset('studio', 1)).filter((w) => w.parts.length > 1)).toHaveLength(1);
  });

  it('keeps each window in its depth band and near its place whatever the seed', () => {
    const base = planPreset('studio', 1);
    for (const seed of [0, 7, 1234, MAX_SEED]) {
      planPreset('studio', seed).forEach((w, i) => {
        const planned = base[i];
        expect(w.id).toBe(planned?.id);
        expect(band(w.reach)).toBe(band(planned?.reach ?? NaN));
        const turned = Math.abs(((w.heading - (planned?.heading ?? NaN) + 540) % 360) - 180);
        expect(turned).toBeLessThanOrEqual(6);
      });
    }
  });

  it('shows every window shown in full live in both backends: tiles are drawn', () => {
    const plan = planPreset('studio', 1);
    for (const w of plan.filter((p) => band(p.reach) === 'full')) {
      expect(w.content).toBe('note');
    }
    expect(plan.some((w) => w.content === 'tile')).toBe(true);
  });
});

describe('windows added from the controls', () => {
  it('are blank notes the host knows by key alone, each in a hue of its own', () => {
    const first = addedWindow(1);
    expect(first).toMatchObject({
      bindingKey: 'added/note/1',
      content: 'note',
      label: 'New window 1',
    });
    expect(first.detail).toBeUndefined();
    expect(plannedByKey('added/note/1')).toEqual(first);
    expect(plannedByKey('added/note/12')?.label).toBe('New window 12');
    const hues = Array.from({ length: 8 }, (_, i) => addedWindow(i + 1).hue);
    expect(new Set(hues).size).toBe(8);
    for (const key of ['added/note/0', 'added/note/01', 'added/tile/1', 'added/note/x']) {
      expect(plannedByKey(key), key).toBeNull();
    }
    expect(() => addedWindow(0)).toThrow('numbered from 1');
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
      expect(plan.some((w) => elevationOf(w) > 45)).toBe(true);
    }
  });

  it('shows a seam-crossing window on both edges of the panorama, and picks it as one surface there', () => {
    const { ws, projections } = seededWith('seam', 1);
    const state = ws.getState();
    const view = viewGeometryOf(state, 'v');
    const geometry = (id: string) => ws.surfaceGeometry(id);
    const fragments = createViewOutput(
      state,
      'v',
      projectorOf(equirectangular).project(state, view, geometry, null),
    ).fragments.filter((f) => f.surfaceId === 'window-01-surface');
    // Its card is drawn at both edges: one copy reaching in from the left, one from the right.
    expect(fragments).toHaveLength(2);
    const lefts = fragments.map((f) => f.bounds[0]).sort((a, b) => a - b);
    expect(lefts[0]).toBeLessThan(0);
    expect(lefts[1]).toBeLessThan(W);
    expect((lefts[1] ?? 0) + (fragments[1]?.bounds[2] ?? 0)).toBeGreaterThan(W);

    const router = createInteractionRouter({ workspace: ws, projections });
    for (const x of [3, 20, W - 20, W - 3]) {
      const pick = router.pick('v', x, H / 2);
      expect(pick.kind).toBe('hit');
      if (pick.kind === 'hit') {
        expect(pick.target.surfaceId).toBe('window-01-surface');
      }
    }
    router.dispose();
  });
});
