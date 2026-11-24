import type { Workspace } from '@swf/core';
import { createWorkspace, worldMatrix } from '@swf/core';
import { createPresentationRegistry, viewGeometryOf } from '@swf/presentation';
import {
  cameraRotation,
  createProjectionRegistry,
  equirectangular,
  projectionFor,
} from '@swf/projections';
import { describe, expect, it } from 'vitest';
import type { Fixture, FixtureSize } from '../src/index.js';
import {
  DRAWN_ADAPTER,
  LIVE_ADAPTER,
  PAGE,
  planFixture,
  sizeIssue,
  STANDARD,
  STRESS,
} from '../src/index.js';

/** A workspace made from a fixture's commands, as one transaction. */
function made(fixture: Fixture): Workspace {
  const ws = createWorkspace({ id: 'bench', now: () => 0 });
  const presentation = createPresentationRegistry();
  createProjectionRegistry({ kinds: ws.mutator(), projectors: presentation.registrar() }).register(
    equirectangular,
  );
  const result = ws.transaction(fixture.commands);
  if (result.status !== 'committed') {
    throw new Error(`the fixture could not be made: ${JSON.stringify(result)}`);
  }
  return ws;
}

/** Surfaces any part of which a viewport shows, with its camera turned to a heading. */
function visibleIn(ws: Workspace, viewportId: string, headingDegrees: number): number {
  const viewport = ws.getState().viewports.get(viewportId);
  if (viewport === undefined) {
    throw new Error(`no viewport ${viewportId}`);
  }
  const turned = ws.dispatch({
    type: 'camera.patch',
    id: viewport.cameraId,
    rotation: cameraRotation((headingDegrees * Math.PI) / 180, 0),
  });
  if (turned.status !== 'committed') {
    throw new Error('the camera could not be turned');
  }
  const state = ws.getState();
  const view = viewGeometryOf(state, viewportId);
  const projection = projectionFor(equirectangular, view);
  let count = 0;
  for (const { id } of state.surfaces.values()) {
    const geometry = ws.surfaceGeometry(id);
    if (geometry !== undefined && projection.clipVisibility(geometry, view).state !== 'outside') {
      count += 1;
    }
  }
  return count;
}

describe('the standard benchmark fixture (§26.1)', () => {
  const fixture = planFixture(STANDARD, 1);
  const ws = made(fixture);
  const state = ws.getState();
  const nodes = [...state.nodes.values()];

  it('holds 250 windows and 300 surfaces, every window holding one or two', () => {
    const windows = nodes.filter((n) => n.kind === 'window');
    expect(windows).toHaveLength(250);
    expect(state.surfaces.size).toBe(300);
    expect(windows.filter((w) => w.surfaceIds.length === 2)).toHaveLength(50);
    expect(windows.every((w) => w.surfaceIds.length >= 1 && w.surfaceIds.length <= 2)).toBe(true);
    // Paired windows are spread through the scene, not bunched: one in every five.
    const paired = fixture.windows.flatMap((w, i) => (w.surfaces.length === 2 ? [i] : []));
    expect(paired.every((index, k) => index === k * 5 + 4)).toBe(true);
    // Content is lightweight: plain elements, and a drawn one the DOM backend shows by proxy.
    const adapters = [...state.surfaces.values()].map((s) => s.adapterTypeId);
    expect(adapters.filter((a) => a === LIVE_ADAPTER)).toHaveLength(250);
    expect(adapters.filter((a) => a === DRAWN_ADAPTER)).toHaveLength(50);
  });

  it('nests five groups, one inside the next, with windows at every depth', () => {
    const groups = nodes.filter((n) => n.kind === 'group');
    expect(groups.map((g) => g.id)).toEqual([
      'group-1',
      'group-2',
      'group-3',
      'group-4',
      'group-5',
    ]);
    expect(groups.map((g) => g.parentId)).toEqual([
      null,
      'group-1',
      'group-2',
      'group-3',
      'group-4',
    ]);
    for (const group of groups) {
      expect(group.childIds.filter((id) => state.nodes.get(id)?.kind === 'window')).toHaveLength(
        50,
      );
    }
  });

  it('places every window where it is planned in the world, its nested groups’ turns undone', () => {
    for (const w of fixture.windows) {
      const m = worldMatrix(state.nodes, w.id);
      expect(m).toBeDefined();
      const [x, y, z] = [m?.[12] ?? 0, m?.[13] ?? 0, m?.[14] ?? 0];
      const heading = (Math.atan2(x, -z) * 180) / Math.PI;
      const elevation = (Math.atan2(y, Math.hypot(x, z)) * 180) / Math.PI;
      const wrapped = ((heading - w.heading + 540) % 360) - 180;
      expect(wrapped).toBeCloseTo(0, 9);
      expect(elevation).toBeCloseTo(w.elevation, 9);
      expect(Math.hypot(x, y, z)).toBeCloseTo(w.distance, 9);
      // It faces the camera: its front (+Z) points back at the origin.
      const front = [m?.[8] ?? 0, m?.[9] ?? 0, m?.[10] ?? 0];
      const back = [-x, -y, -z].map((v) => v / w.distance);
      expect(front[0]).toBeCloseTo(back[0] ?? 0, 9);
      expect(front[1]).toBeCloseTo(back[1] ?? 0, 9);
      expect(front[2]).toBeCloseTo(back[2] ?? 0, 9);
    }
  });

  it('lays two viewports side by side on the 1920×1080 page, at the same degrees per pixel each way', () => {
    expect(fixture.viewports).toHaveLength(2);
    const [a, b] = fixture.viewports;
    expect(a?.left).toBe(0);
    expect((a?.width ?? 0) + (b?.width ?? 0)).toBe(PAGE.width);
    for (const v of fixture.viewports) {
      expect(v.top).toBe(0);
      expect(v.height).toBe(PAGE.height);
      expect(v.horizontal / v.width).toBeCloseTo(v.vertical / v.height, 12);
      expect(state.viewports.get(v.id)?.cameraId).toBe(v.cameraId);
    }
  });

  it('shows 30 to 50 surfaces in each viewport, wherever its camera turns', () => {
    const fresh = made(fixture);
    for (const v of fixture.viewports) {
      const counts: number[] = [];
      for (let heading = -180; heading < 180; heading += 2.5) {
        counts.push(visibleIn(fresh, v.id, heading));
      }
      expect(Math.min(...counts)).toBeGreaterThanOrEqual(30);
      expect(Math.max(...counts)).toBeLessThanOrEqual(50);
    }
  });

  it('plans the same scene from the same seed, and another from another', () => {
    expect(planFixture(STANDARD, 1)).toEqual(fixture);
    expect(planFixture(STANDARD, 2).windows).not.toEqual(fixture.windows);
    // Every planned value is a whole number of tenths of a degree or hundredths of a unit.
    for (const w of fixture.windows) {
      expect(Number.isInteger(Math.round(w.heading * 10 * 1e6) / 1e6)).toBe(true);
      expect(Number.isInteger(Math.round(w.distance * 100 * 1e6) / 1e6)).toBe(true);
    }
  });
});

describe('the stress fixture (NFR-008)', () => {
  it('doubles the standard scene, nested alike', () => {
    const fixture = planFixture(STRESS, 1);
    const state = made(fixture).getState();
    const nodes = [...state.nodes.values()];
    expect(nodes.filter((n) => n.kind === 'window')).toHaveLength(500);
    expect(state.surfaces.size).toBe(600);
    expect(nodes.filter((n) => n.kind === 'group')).toHaveLength(5);
  });
});

describe('fixture sizes', () => {
  it('refuses sizes it cannot plan, saying which count is wrong', () => {
    const bad: [FixtureSize, RegExp][] = [
      [{ windows: 252, surfaces: 300, groups: 5 }, /windows must be a positive multiple of 5/],
      [{ windows: 0, surfaces: 0, groups: 5 }, /windows must be/],
      [{ windows: 250, surfaces: 200, groups: 5 }, /surfaces must be from windows to twice/],
      [{ windows: 250, surfaces: 501, groups: 5 }, /surfaces must be from windows to twice/],
      [{ windows: 250, surfaces: 300, groups: 0 }, /groups must be a positive whole number/],
    ];
    for (const [size, message] of bad) {
      expect(sizeIssue(size)).toMatch(message);
      expect(() => planFixture(size, 1)).toThrow(message);
    }
    expect(() => planFixture(STANDARD, -1)).toThrow(/seed must be an integer/);
  });

  it('plans other sizes in proportion, for growth measures', () => {
    for (const windows of [125, 1000]) {
      const fixture = planFixture({ windows, surfaces: windows * 1.2, groups: 5 }, 3);
      expect(fixture.windows).toHaveLength(windows);
      expect(fixture.windows.reduce((n, w) => n + w.surfaces.length, 0)).toBe(windows * 1.2);
    }
  });
});
