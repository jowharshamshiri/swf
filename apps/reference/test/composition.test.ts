import type { SceneState, Workspace } from '@swf/core';
import { createWorkspace, surfaceWorldMatrix, worldMatrix } from '@swf/core';
import { mat4ApproxEquals, mat4InvertAffine, mat4TransformPoint } from '@swf/math';
import { createPersistence } from '@swf/persistence';
import { createPresentationRegistry } from '@swf/presentation';
import { createProjectionRegistry, equirectangular } from '@swf/projections';
import { describe, expect, it } from 'vitest';
import type { CompositionPlan } from '../src/composition.js';
import {
  detachSurface,
  groupWindows,
  layoutSurfaces,
  mergeWindow,
  moveSurface,
  regroupWindow,
  WINDOW_FRAME,
} from '../src/composition.js';
import { PANORAMA } from '../src/modes.js';
import { CAMERA_ID, planPreset, presetCommands, WORKSPACE_GROUP_ID } from '../src/presets.js';

/** A workspace holding the composed preset: Board (three surfaces), window-04 and window-05. */
function composed(): Workspace {
  const ws = createWorkspace({ id: 'test', now: () => 0 });
  const projections = createProjectionRegistry({
    kinds: ws.mutator(),
    projectors: createPresentationRegistry().registrar(),
  });
  projections.register(equirectangular);
  const result = ws.transaction([
    { type: 'camera.create', camera: { id: CAMERA_ID } },
    {
      type: 'viewport.create',
      viewport: {
        id: 'main',
        cameraId: CAMERA_ID,
        mode: PANORAMA.id,
        projection: PANORAMA.projection,
        size: { width: 1440, height: 480, devicePixelRatio: 1 },
      },
    },
    ...presetCommands(planPreset('composed', 1)),
  ]);
  expect(result.status).toBe('committed');
  return ws;
}

const NEW = { tags: ['note'], metadata: {} };

function commit(ws: Workspace, plan: CompositionPlan): void {
  if (plan.kind !== 'plan') {
    throw new Error(`refused: ${plan.reason}`);
  }
  expect(ws.transaction(plan.commands, { source: 'user' }).status).toBe('committed');
}

/** Every surface's and node's world matrix, by ID. */
function worldOf(state: SceneState) {
  return {
    surfaces: new Map(
      [...state.surfaces.values()].map(({ id }) => [id, surfaceWorldMatrix(state, id)]),
    ),
    nodes: new Map([...state.nodes.values()].map(({ id }) => [id, worldMatrix(state.nodes, id)])),
  };
}

const same = (a: ReturnType<typeof surfaceWorldMatrix>, b: ReturnType<typeof surfaceWorldMatrix>) =>
  a !== undefined && b !== undefined && mat4ApproxEquals(a, b, 1e-9);

describe('laying out a window round its surfaces', () => {
  it('puts surfaces side by side with a gap, framed, and one surface as presets always did', () => {
    const { side, top, bottom, gap } = WINDOW_FRAME;
    expect(layoutSurfaces([[1, 0.5]])).toEqual({
      bounds: [1 + 2 * side, 0.5 + top + bottom, 0.01],
      offsets: [[0, (bottom - top) / 2, 0]],
    });
    const two = layoutSurfaces([
      [1, 0.5],
      [2, 0.8],
    ]);
    expect(two.bounds[0]).toBeCloseTo(3 + gap + 2 * side, 12);
    expect(two.bounds[1]).toBeCloseTo(0.8 + top + bottom, 12);
    expect(two.offsets[0]?.[0]).toBeCloseTo(-(3 + gap) / 2 + 0.5, 12);
    expect(two.offsets[1]?.[0]).toBeCloseTo((3 + gap) / 2 - 1, 12);
    expect(() => layoutSurfaces([])).toThrow(RangeError);
  });
});

describe('multi-surface composition (FR-126, WF-06, AC-016)', () => {
  it('detaches a surface into a window of its own beside the one it left, neither covering the other, as one change', () => {
    const ws = composed();
    const before = ws.getState();
    const board = before.nodes.get('board');
    expect(board?.surfaceIds).toEqual([
      'window-01-surface',
      'window-02-surface',
      'window-03-surface',
    ]);
    const plan = detachSurface(before, 'window-02-surface', NEW);
    expect(plan).toMatchObject({ kind: 'plan', createdWindowId: 'window-02' });
    commit(ws, plan);
    const after = ws.getState();
    // The same endpoint, in the new window.
    expect(after.surfaces.get('window-02-surface')).toMatchObject({
      ownerNodeId: 'window-02',
      bindingKey: before.surfaces.get('window-02-surface')?.bindingKey,
      adapterTypeId: before.surfaces.get('window-02-surface')?.adapterTypeId,
    });
    const made = after.nodes.get('window-02');
    expect(made).toMatchObject({
      kind: 'window',
      parentId: WORKSPACE_GROUP_ID,
      label: 'Tile 02',
      tags: ['note'],
      surfaceIds: ['window-02-surface'],
    });
    // The board closed up round the two it kept, narrower.
    const closed = after.nodes.get('board');
    expect(closed?.surfaceIds).toEqual(['window-01-surface', 'window-03-surface']);
    expect(closed?.bounds[0]).toBeLessThan(board?.bounds[0] ?? 0);
    // The new window stands to the board's right, edge to edge with a gap, turned as it is.
    const boardWorld = worldMatrix(after.nodes, 'board');
    const madeWorld = worldMatrix(after.nodes, 'window-02');
    const inverse = boardWorld === undefined ? null : mat4InvertAffine(boardWorld);
    if (inverse === null || madeWorld === undefined || closed === undefined || made === undefined) {
      throw new Error('no placement');
    }
    const [x, y, z] = mat4TransformPoint(inverse, [madeWorld[12], madeWorld[13], madeWorld[14]]);
    expect(x).toBeCloseTo((closed.bounds[0] + made.bounds[0]) / 2 + WINDOW_FRAME.gap, 9);
    expect(y).toBeCloseTo(0, 9);
    expect(z).toBeCloseTo(0, 9);
    expect(made.transform.rotation).toEqual(closed.transform.rotation);
    // One undo puts everything back exactly.
    expect(ws.undo().status).toBe('committed');
    expect(JSON.stringify(ws.serialize().nodes)).toBe(JSON.stringify(composedSnapshot().nodes));
    expect(JSON.stringify(ws.serialize().surfaces)).toBe(
      JSON.stringify(composedSnapshot().surfaces),
    );
  });

  it('never splits a window’s only surface: there is nothing to detach', () => {
    const ws = composed();
    expect(detachSurface(ws.getState(), 'window-04-surface', NEW)).toEqual({
      kind: 'refused',
      field: 'surfaceId',
      reason:
        '“Note 04” is the only surface of “Note 04”: there is nothing to detach it from, and a surface’s own content is never split',
    });
    expect(detachSurface(ws.getState(), 'nope', NEW)).toMatchObject({ kind: 'refused' });
  });

  it('moves a surface into another window, closing up both, and removes a window it empties', () => {
    const ws = composed();
    commit(ws, moveSurface(ws.getState(), 'window-04-surface', 'board'));
    const state = ws.getState();
    expect(state.nodes.get('board')?.surfaceIds).toEqual([
      'window-01-surface',
      'window-02-surface',
      'window-03-surface',
      'window-04-surface',
    ]);
    // window-04 held only that surface: it is gone, and undo brings it back.
    expect(state.nodes.has('window-04')).toBe(false);
    ws.undo();
    expect(ws.getState().nodes.get('window-04')?.surfaceIds).toEqual(['window-04-surface']);
    expect(moveSurface(ws.getState(), 'window-01-surface', 'board')).toMatchObject({
      kind: 'refused',
      field: 'windowId',
    });
    expect(moveSurface(ws.getState(), 'window-01-surface', WORKSPACE_GROUP_ID)).toMatchObject({
      kind: 'refused',
      reason: 'no window "workspace"',
    });
  });

  it('merges one window’s surfaces into another and removes the emptied one', () => {
    const ws = composed();
    commit(ws, mergeWindow(ws.getState(), 'board', 'window-05'));
    const state = ws.getState();
    expect(state.nodes.has('board')).toBe(false);
    expect(state.nodes.get('window-05')?.surfaceIds).toEqual([
      'window-05-surface',
      'window-01-surface',
      'window-02-surface',
      'window-03-surface',
    ]);
    expect(mergeWindow(state, 'window-05', 'window-05')).toMatchObject({ kind: 'refused' });
  });

  it('moves a window into a new group or another, keeping it in the world, and removes an emptied group', () => {
    const ws = composed();
    const was = worldMatrix(ws.getState().nodes, 'window-04');
    commit(
      ws,
      regroupWindow(ws.getState(), 'window-04', { kind: 'new', id: 'group-1', label: 'Left' }),
    );
    let state = ws.getState();
    expect(state.nodes.get('window-04')?.parentId).toBe('group-1');
    expect(state.nodes.get('group-1')).toMatchObject({ kind: 'group', label: 'Left' });
    expect(same(worldMatrix(state.nodes, 'window-04'), was)).toBe(true);
    // Back into the workspace: the group it leaves empty goes with it.
    commit(ws, regroupWindow(state, 'window-04', { kind: 'group', id: WORKSPACE_GROUP_ID }));
    state = ws.getState();
    expect(state.nodes.get('window-04')?.parentId).toBe(WORKSPACE_GROUP_ID);
    expect(state.nodes.has('group-1')).toBe(false);
    expect(same(worldMatrix(state.nodes, 'window-04'), was)).toBe(true);
    expect(
      regroupWindow(state, 'window-04', { kind: 'group', id: WORKSPACE_GROUP_ID }),
    ).toMatchObject({ kind: 'refused', field: 'groupId' });
  });

  it('gathers several windows into a new group at once, keeping each in the world, and removes a group they empty', () => {
    const ws = composed();
    const was = worldOf(ws.getState());
    const history = ws.history().length;
    // Two windows of the workspace group: their group is made inside it.
    commit(
      ws,
      groupWindows(ws.getState(), ['window-04', 'window-05'], { id: 'group-1', label: 'Pair' }),
    );
    let state = ws.getState();
    expect(state.nodes.get('group-1')).toMatchObject({
      kind: 'group',
      label: 'Pair',
      parentId: WORKSPACE_GROUP_ID,
    });
    expect(state.nodes.get('window-04')?.parentId).toBe('group-1');
    expect(state.nodes.get('window-05')?.parentId).toBe('group-1');
    // Windows from different groups: their group is made at the root, and a group left holding
    // another window stays.
    commit(ws, groupWindows(state, ['board', 'window-04'], { id: 'group-2', label: 'Mixed' }));
    state = ws.getState();
    expect(state.nodes.get('group-2')?.parentId).toBeNull();
    expect(state.nodes.get('group-1')?.childIds).toEqual(['window-05']);
    // Its last window gathered elsewhere, a group goes with it.
    commit(ws, groupWindows(state, ['window-05', 'window-04'], { id: 'group-3', label: 'Again' }));
    state = ws.getState();
    expect(state.nodes.has('group-1')).toBe(false);
    expect(state.nodes.get('group-2')?.childIds).toEqual(['board']);
    for (const id of ['board', 'window-04', 'window-05']) {
      expect(same(worldMatrix(state.nodes, id), was.nodes.get(id)), id).toBe(true);
    }
    // Each gathering is one change: three undos put the scene back.
    expect(ws.history()).toHaveLength(history + 3);
    for (let i = 0; i < 3; i += 1) {
      expect(ws.undo({ source: 'user' }).status).toBe('committed');
    }
    expect(ws.getState().nodes.get('window-04')?.parentId).toBe(WORKSPACE_GROUP_ID);
    expect(ws.getState().nodes.has('group-1')).toBe(false);
  });

  it('refuses to group fewer than two windows, one named twice, one that is not there, or an ID in use', () => {
    const state = composed().getState();
    const refused = (ids: readonly unknown[], id = 'group-1') =>
      groupWindows(state, ids, { id, label: 'G' });
    expect(refused(['window-04'])).toMatchObject({ kind: 'refused', field: 'windowIds' });
    expect(refused(['window-04', 'window-04'])).toMatchObject({
      kind: 'refused',
      field: 'windowIds',
      reason: expect.stringContaining('named twice') as unknown,
    });
    expect(refused(['window-04', 'nowhere'])).toMatchObject({
      kind: 'refused',
      field: 'windowIds',
      reason: 'no window "nowhere"',
    });
    expect(refused(['window-04', 42])).toMatchObject({ kind: 'refused', field: 'windowIds' });
    expect(refused(['window-04', 'window-05'], 'board')).toMatchObject({
      kind: 'refused',
      field: 'groupId',
    });
  });

  it('detaches, reattaches, saves and restores with every world transform kept (§33.2 scenario 4)', async () => {
    const ws = composed();
    const original = worldOf(ws.getState());
    commit(ws, detachSurface(ws.getState(), 'window-03-surface', NEW));
    commit(ws, moveSurface(ws.getState(), 'window-03-surface', 'board'));
    const state = ws.getState();
    expect(state.nodes.has('window-03')).toBe(false);
    expect(state.nodes.get('board')?.surfaceIds).toEqual([
      'window-01-surface',
      'window-02-surface',
      'window-03-surface',
    ]);
    // Back in the board in its place: every surface is where it was in the world.
    for (const [id, matrix] of original.surfaces) {
      expect(same(surfaceWorldMatrix(state, id), matrix), id).toBe(true);
    }
    const saved = worldOf(state);
    const persistence = createPersistence({ workspace: ws.persistence() });
    const text = persistence.export((await persistence.capture()).document);
    // Reloaded into a new workspace: parents, children and world transforms come back.
    const reloaded = composed();
    const restoring = createPersistence({ workspace: reloaded.persistence() });
    expect((await restoring.restore(text)).status).toBe('restored');
    const back = reloaded.getState();
    for (const [id, matrix] of saved.surfaces) {
      expect(same(surfaceWorldMatrix(back, id), matrix), id).toBe(true);
      expect(back.surfaces.get(id)?.ownerNodeId).toBe(state.surfaces.get(id)?.ownerNodeId);
    }
    for (const [id, matrix] of saved.nodes) {
      expect(same(worldMatrix(back.nodes, id), matrix), id).toBe(true);
      expect(back.nodes.get(id)?.parentId).toBe(state.nodes.get(id)?.parentId);
    }
  });
});

/** The composed preset's scene as it is first laid out. */
function composedSnapshot() {
  return composed().serialize();
}
