import type { JsonValue, Workspace } from '@swf/core';
import { createOperationTrace } from '@swf/diagnostics';
import { createMemoryStore } from '@swf/persistence';
import { viewGeometryOf } from '@swf/presentation';
import { describe, expect, it } from 'vitest';
import type { PresetId } from '../src/presets.js';
import type { FeatureSettings } from '@swf/navigation';
import {
  CAMERA_ID,
  DEFAULT_FEATURES,
  FOCUS_ID,
  MAP,
  MarkerDrag,
  OVERVIEW,
  PANORAMA,
  detachSurface,
  distanceFrom,
  focusContext,
  mergeWindow,
  moveSurface,
  placedAt,
  representationAt,
  updateFeatures,
} from '@swf/navigation';
import { createWorkspaces } from '../src/workspaces.js';
import type { PolicyWorld } from './policy-world.js';
import { drag, pointOn, policyWorld, screenOf, VIEWPORT, W } from './policy-world.js';

/**
 * Golden scenes and scripted interaction traces (QA-012): each of the four view modes and each of
 * the eight behaviour modules works a seeded scene through a fixed script, and what it did (the
 * workspace's operation trace) and where it left the scene (its canonical snapshot) must match the
 * committed fixture exactly, to 1e-9 (NFR-012). A change in behaviour shows as a changed fixture,
 * to be reviewed and committed deliberately (`vitest -u`).
 */

/** Numbers to nine decimals, so the fixtures read the same on every engine. */
function rounded(value: JsonValue): JsonValue {
  if (typeof value === 'number') {
    return Math.round(value * 1e9) / 1e9 + 0;
  }
  if (Array.isArray(value)) {
    return value.map(rounded);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rounded(v)]));
  }
  return value;
}

/** A seeded scene with the reference policies, on a clock that stands still, traced. */
function scripted(scene: PresetId, features: FeatureSettings = DEFAULT_FEATURES) {
  const world = policyWorld(scene, features, { now: () => 0 });
  world.modes.register(OVERVIEW);
  const trace = createOperationTrace({ workspace: world.ws });
  return { world, trace };
}

/**
 * What a script did and where it left the scene, as the fixture holds it; with `scene: false` the
 * scene is left out, for a script that changes none and holds a scene other fixtures already do.
 */
function record(
  world: PolicyWorld,
  trace: ReturnType<typeof createOperationTrace>,
  extra: Record<string, JsonValue | undefined> = {},
  options: { readonly scene: boolean } = { scene: true },
) {
  const operations = JSON.parse(trace.serialize()) as JsonValue;
  const scene = options.scene ? { scene: world.ws.serialize() as unknown as JsonValue } : {};
  const fixture: JsonValue = { operations, ...scene, ...extra };
  return `${JSON.stringify(rounded(fixture), null, 2)}\n`;
}

/**
 * Moves a window as the takeover modifier does: pressed at its centre with Alt (so its content
 * gives the press to the framework), dragged by (dx, dy) in steps, and released.
 */
function takeAndMove(world: PolicyWorld, id: string, dx: number, dy: number): void {
  const [x, y] = screenOf(world.ws, pointOn(world.ws, id, [0, 0, 0]));
  world.input.pointer('down', VIEWPORT, x, y, { modifiers: { alt: true } });
  for (let i = 1; i <= 8; i += 1) {
    world.input.pointer('move', VIEWPORT, x + (dx * i) / 8, y + (dy * i) / 8, {
      modifiers: { alt: true },
    });
  }
  world.input.pointer('up', VIEWPORT, x + dx, y + dy, { buttons: 0 });
}

const golden = (name: string) => `./fixtures/golden/${name}.json`;

const camera = (ws: Workspace) => ws.getState().cameras.get(CAMERA_ID)?.rotation;

describe('golden scenes and scripted traces: the four view modes (QA-012)', () => {
  it('panorama: a window dragged by its frame, and the camera turned by the background', async () => {
    const { world, trace } = scripted('sparse');
    const bounds = world.ws.getState().nodes.get('window-02')?.bounds;
    takeAndMove(world, 'window-02', 60, 20);
    // Moved, not resized.
    expect(world.ws.getState().nodes.get('window-02')?.bounds).toEqual(bounds);
    drag(world.input, [10, 10], [130, 10]);
    expect(world.ws.history()).toHaveLength(1 + 1);
    await expect(record(world, trace)).toMatchFileSnapshot(golden('mode-panorama'));
  });

  it('focus: one window shown readably, then its right neighbour, then the panorama back', async () => {
    const { world, trace } = scripted('sparse');
    const before = camera(world.ws);
    expect(world.modes.switchTo(FOCUS_ID, { target: 'window-03' }).status).toBe('committed');
    const eye = world.ws.getState().cameras.get(CAMERA_ID)?.position ?? [0, 0, 0];
    const next = focusContext(world.ws.getState(), 'window-03', eye).right[0]?.id ?? '';
    expect(world.modes.switchTo(FOCUS_ID, { target: next }).status).toBe('committed');
    world.modes.back({ source: 'user' });
    expect(world.modes.current()).toBe(PANORAMA.id);
    expect(camera(world.ws)).toEqual(before);
    await expect(record(world, trace, { neighbour: next })).toMatchFileSnapshot(
      golden('mode-focus'),
    );
  });

  it('map: a window carried behind the camera on the ground, then raised', async () => {
    const { world, trace } = scripted('seam');
    expect(world.modes.switchTo(MAP.id).status).toBe('committed');
    const m = world.ws.getState().nodes.get('window-07')?.transform.position ?? [0, 0, 0];
    const marker = new MarkerDrag(world.ws, VIEWPORT, 'window-07', [m[0] + 0.1, m[2]]);
    expect(marker.moveTo(m[0] + 1.1, m[2] + 2)).toBe(true);
    expect(marker.commit()?.status).toBe('committed');
    const raised = placedAt(world.ws.getState(), 'window-07', [0, 0, 0], { y: 1.25 });
    if (raised === null) {
      throw new Error('window-07 cannot be placed');
    }
    world.ws.dispatch(
      { type: 'node.patch', id: 'window-07', transform: raised },
      { source: 'user' },
    );
    world.modes.back({ source: 'user' });
    await expect(record(world, trace)).toMatchFileSnapshot(golden('mode-map'));
  });

  it('overview: a tile selected and opened in focus, then back to the overview and the panorama', async () => {
    const { world, trace } = scripted('sparse');
    expect(world.modes.switchTo(OVERVIEW.id).status).toBe('committed');
    world.ws.transaction(
      [
        { type: 'selection.set', ids: ['window-05'] },
        { type: 'focus.set', id: 'window-05' },
      ],
      { source: 'user' },
    );
    expect(world.modes.switchTo(FOCUS_ID, { target: 'window-05' }).status).toBe('committed');
    world.modes.back({ source: 'user' });
    expect(world.modes.current()).toBe(OVERVIEW.id);
    expect(world.modes.switchTo(PANORAMA.id).status).toBe('committed');
    await expect(record(world, trace)).toMatchFileSnapshot(golden('mode-overview'));
  });
});

describe('golden scenes and scripted traces: the eight behaviour modules (QA-012)', () => {
  const only = (enabled: Partial<FeatureSettings['enabled']>) =>
    updateFeatures(DEFAULT_FEATURES, {
      enabled: {
        focus: false,
        orbit: false,
        map: false,
        cursor: false,
        snap: false,
        depth: false,
        composition: false,
        persistence: false,
        ...enabled,
      },
    });

  it('focus and context: stepping through the context to the left and back', async () => {
    const { world, trace } = scripted('sparse', only({ focus: true }));
    world.modes.switchTo(FOCUS_ID, { target: 'window-04' });
    const eye = world.ws.getState().cameras.get(CAMERA_ID)?.position ?? [0, 0, 0];
    const left = focusContext(world.ws.getState(), 'window-04', eye).left.map((n) => n.id);
    for (const id of left.slice(0, 2)) {
      world.modes.switchTo(FOCUS_ID, { target: id });
    }
    world.modes.back({ source: 'user' });
    await expect(record(world, trace, { left })).toMatchFileSnapshot(golden('module-focus'));
  });

  it('workspace orbit: the designated group turned by a drag and by command, the camera still', async () => {
    const { world, trace } = scripted('sparse', only({ orbit: true }));
    const before = camera(world.ws);
    world.policies.navigate('orbit');
    drag(world.input, [400, 30], [480, 30]);
    expect(world.policies.turnWorkspace(15).status).toBe('committed');
    expect(camera(world.ws)).toEqual(before);
    await expect(record(world, trace)).toMatchFileSnapshot(golden('module-orbit'));
  });

  it('spatial map: a window carried round the camera keeps facing it', async () => {
    const { world, trace } = scripted('sparse', only({ map: true }));
    world.modes.switchTo(MAP.id);
    const m = world.ws.getState().nodes.get('window-01')?.transform.position ?? [0, 0, 0];
    const marker = new MarkerDrag(world.ws, VIEWPORT, 'window-01', [m[0], m[2]]);
    marker.moveTo(m[0] + 2, m[2] - 1);
    marker.moveTo(3, 0);
    marker.commit();
    await expect(record(world, trace)).toMatchFileSnapshot(golden('module-map'));
  });

  it('wrapped cursor: a window carried past the right edge comes in at the left', async () => {
    const { world, trace } = scripted('seam', only({ cursor: true }));
    const [x, y] = screenOf(world.ws, pointOn(world.ws, 'window-01', [-0.6, 0, 0]), W);
    world.input.pointer('down', VIEWPORT, x, y, { modifiers: { alt: true } });
    for (const step of [x + 10, W - 1, W + 10, W + 30, W + 45]) {
      world.input.pointer('move', VIEWPORT, step, y);
    }
    world.input.pointer('up', VIEWPORT, W + 45, y, { buttons: 0 });
    await expect(record(world, trace)).toMatchFileSnapshot(golden('module-cursor'));
  });

  it('magnetic positioning: a window moved near a neighbour snaps beside it', async () => {
    const { world, trace } = scripted('sparse', only({ snap: true }));
    const node = world.ws.getState().nodes.get('window-02');
    const [, y] = screenOf(world.ws, pointOn(world.ws, 'window-02', [0, 0, 0]));
    // Its centre brought within a degree of the horizon: the move snaps level with it.
    takeAndMove(world, 'window-02', 40, 200 - y + 2);
    expect(world.ws.getState().nodes.get('window-02')?.bounds).toEqual(node?.bounds);
    await expect(
      record(world, trace, {
        snapped: JSON.parse(JSON.stringify(world.policies.status().ended)) as JsonValue,
      }),
    ).toMatchFileSnapshot(golden('module-snap'));
  });

  it('semantic depth: the dense scene by distance bands, full, compact and label', async () => {
    const { world, trace } = scripted('dense', only({ depth: true }));
    const state = world.ws.getState();
    const view = viewGeometryOf(state, VIEWPORT);
    const bands = world.policies.status().features.depth;
    const tiers: Record<string, string> = {};
    for (const node of state.nodes.values()) {
      if (node.kind === 'window') {
        tiers[node.id] = representationAt(distanceFrom(state, node.id, view), bands);
      }
    }
    const counts = Object.values(tiers).reduce<Record<string, number>>(
      (c, t) => ({ ...c, [t]: (c[t] ?? 0) + 1 }),
      {},
    );
    expect(Object.keys(counts).sort()).toEqual(['compact', 'full', 'label']);
    expect((JSON.parse(trace.serialize()) as { entries: unknown[] }).entries).toEqual([]);
    await expect(record(world, trace, { tiers, counts }, { scene: false })).toMatchFileSnapshot(
      golden('module-depth'),
    );
  });

  it('composition: a surface detached, moved to another window, and two windows merged', async () => {
    const { world, trace } = scripted('composed', only({ composition: true }));
    const commit = (plan: ReturnType<typeof detachSurface>) => {
      if (plan.kind === 'refused') {
        throw new Error(`${plan.field}: ${plan.reason}`);
      }
      expect(world.ws.transaction(plan.commands, { source: 'user' }).status).toBe('committed');
    };
    commit(
      detachSurface(world.ws.getState(), 'window-02-surface', () => ({ tags: [], metadata: {} })),
    );
    commit(moveSurface(world.ws.getState(), 'window-02-surface', 'window-04'));
    commit(mergeWindow(world.ws.getState(), 'window-05', 'board'));
    await expect(record(world, trace)).toMatchFileSnapshot(golden('module-composition'));
  });

  it('saving and opening workspaces: a named save as the store holds it, and opened again', async () => {
    const { world, trace } = scripted('seam', only({ persistence: true }));
    const store = createMemoryStore({ now: () => 0 });
    const workspaces = createWorkspaces({
      workspace: world.ws,
      store,
      now: () => 0,
      timer: () => 0,
      autosaveDelayMs: 0,
      extensions: [],
      policies: [],
    });
    try {
      await workspaces.saveAs('Golden');
      world.ws.dispatch(
        { type: 'node.patch', id: 'window-03', label: 'Changed after saving' },
        { source: 'user' },
      );
      expect((await workspaces.openNamed('Golden')).status).toBe('restored');
      const keys = (await store.list()).map((entry) => entry.key);
      expect(keys).toHaveLength(1);
      const stored = (await store.load(keys[0] ?? ''))?.document ?? '';
      await expect(
        record(world, trace, { stored: JSON.parse(stored) as JsonValue }),
      ).toMatchFileSnapshot(golden('module-persistence'));
    } finally {
      workspaces.dispose();
    }
  });
});
