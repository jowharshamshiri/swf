import { describe, expect, it } from 'vitest';
import type { SceneSnapshot, TxResult, Workspace } from '../src/index.js';
import { at, committed, makeWorkspace, record, rejected, window } from './helpers.js';

const pano = { id: 'test.pano/1', configIssue: () => null };

function fresh(): Workspace {
  return makeWorkspace({ now: () => 1000, projectionKinds: [pano] });
}

/** A layout with a hierarchy, surfaces, a camera and a viewport. */
function layout(ws: Workspace = fresh(), prefix = ''): Workspace {
  const id = (name: string) => `${prefix}${name}`;
  committed(
    ws.transaction([
      window(id('a'), { transform: at([-1, 0, -3]), label: 'A' }),
      window(id('b'), { parentId: id('a'), transform: at([0, 0.3, 0.1]) }),
      {
        type: 'surface.attach',
        surface: {
          id: id('a-s'),
          ownerNodeId: id('a'),
          bindingKey: 'key-a',
          adapterTypeId: 'host.view/1',
          bounds: [1, 0.6, 0.01],
        },
      },
      { type: 'camera.create', camera: { id: id('cam') } },
      {
        type: 'viewport.create',
        viewport: {
          id: id('v'),
          cameraId: id('cam'),
          projection: { id: 'test.pano/1', config: {} },
          size: { width: 800, height: 400, devicePixelRatio: 1 },
        },
      },
      { type: 'focus.set', id: id('a') },
    ]),
  );
  return ws;
}

const done = (result: TxResult) => {
  if (result.status === 'queued') {
    throw new Error('queued');
  }
  return result;
};

/** The scene of a snapshot without what identifies one workspace's copy of it. */
const sceneOf = (s: SceneSnapshot) => ({ ...s, workspaceId: null, revision: null });

describe('restore (FR-002, FR-163, FR-165, FR-167, API-011)', () => {
  it('replaces the whole scene with a snapshot’s, as one revision with ordinary events', () => {
    const snapshot = layout().serialize();
    const ws = layout(fresh(), 'old-');
    const events = record(ws);
    const result = committed(ws.restore(snapshot));
    expect(sceneOf(ws.serialize())).toEqual(sceneOf(snapshot));
    expect(result.changedNodeIds).toEqual(['a', 'b', 'old-a', 'old-b']);
    const types = events.map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'node.created',
        'node.deleted',
        'surface.attached',
        'surface.detached',
        'camera.created',
        'viewport.deleted',
        'focus.changed',
      ]),
    );
    const commit = events.find((e) => e.type === 'transaction.committed');
    expect(commit).toMatchObject({
      source: 'restore',
      payload: { commandTypes: ['scene.restore'] },
    });
  });

  it('replaces, never duplicates: restoring the same snapshot again changes nothing', () => {
    const snapshot = layout().serialize();
    const ws = fresh();
    committed(ws.restore(snapshot));
    const state = ws.getState();
    const history = ws.history().length;
    const again = committed(ws.restore(snapshot));
    expect(again.changedNodeIds).toEqual([]);
    expect(ws.getState().nodes.size).toBe(2);
    expect(ws.getState().nodes.get('a')).toBe(state.nodes.get('a'));
    expect(ws.history()).toHaveLength(history);
  });

  it('validates before replacing anything: a failure leaves the workspace exactly as it was', () => {
    const snapshot = layout().serialize();
    const ws = layout(fresh(), 'old-');
    const before = ws.getState();
    const events = record(ws);
    const broken = (s: SceneSnapshot) => rejected(done(ws.restore(s))).error;
    const [a, b] = snapshot.nodes;
    const [surface] = snapshot.surfaces;
    const [viewport] = snapshot.viewports;
    if (a === undefined || b === undefined || surface === undefined || viewport === undefined) {
      throw new Error('fixture');
    }
    // a and b parent each other: a cycle.
    expect(
      broken({
        ...snapshot,
        rootIds: [],
        nodes: [
          { ...a, parentId: 'b' },
          { ...b, childIds: ['a'] },
        ],
      }),
    ).toMatchObject({ code: 'SNAPSHOT_INVALID', path: 'nodes[0].parentId' });
    expect(broken({ ...snapshot, nodes: [a, { ...b, bounds: [1, -1, 1] }] })).toMatchObject({
      code: 'SNAPSHOT_INVALID',
      path: 'nodes[1].bounds',
    });
    // Kinds this workspace does not have: named at the snapshot's own index.
    expect(
      broken({
        ...snapshot,
        nodes: [a, { ...b, surfaceIds: ['z-s'] }],
        surfaces: [
          {
            ...surface,
            id: 'z-s',
            ownerNodeId: 'b',
            geometry: { kind: 'host.blob', params: null },
          },
          surface,
        ],
      }),
    ).toMatchObject({ code: 'SNAPSHOT_INVALID', path: 'surfaces[0].geometry.kind' });
    expect(
      broken({
        ...snapshot,
        viewports: [{ ...viewport, projection: { id: 'test.flat/1', config: {} } }],
      }),
    ).toMatchObject({ code: 'SNAPSHOT_INVALID', path: 'viewports[0].projection.id' });
    expect(rejected(done(ws.restore(snapshot, { expectedRevision: 0 }))).error).toMatchObject({
      code: 'CONFLICT',
      path: 'options.expectedRevision',
    });
    expect(ws.getState()).toBe(before);
    expect(events.every((e) => e.type === 'transaction.rejected')).toBe(true);
    expect(events.find((e) => e.type === 'transaction.rejected')?.payload).toMatchObject({
      commandTypes: ['scene.restore'],
    });
  });

  it('checks geometry parameters with the workspace’s own providers', () => {
    const ws = fresh();
    committed(
      ws.transaction([
        window('a'),
        {
          type: 'surface.attach',
          surface: {
            id: 'p',
            ownerNodeId: 'a',
            bindingKey: null,
            adapterTypeId: 'host.view/1',
            bounds: [1, 1, 0.01],
            geometry: {
              kind: 'polygon',
              params: {
                points: [
                  [-0.5, -0.5],
                  [0.5, -0.5],
                  [0, 0.5],
                ],
              },
            },
          },
        },
      ]),
    );
    const s = ws.serialize();
    const surface = s.surfaces[0];
    if (surface === undefined) {
      throw new Error('no surface');
    }
    const snapshot: SceneSnapshot = {
      ...s,
      surfaces: [{ ...surface, geometry: { kind: 'polygon', params: { points: [[0, 0]] } } }],
    };
    expect(rejected(done(fresh().restore(snapshot))).error).toMatchObject({
      code: 'SNAPSHOT_INVALID',
      path: 'surfaces[0].geometry.params',
    });
  });

  it('holds geometry to the workspace’s maxParamsBytes, as a transaction does', () => {
    const points = Array.from({ length: 12 }, (_, i) => {
      const a = (2 * Math.PI * i) / 12;
      return [0.4 * Math.cos(a), 0.4 * Math.sin(a)];
    });
    const attach = {
      type: 'surface.attach',
      surface: {
        id: 'p',
        ownerNodeId: 'a',
        bindingKey: null,
        adapterTypeId: 'host.view/1',
        bounds: [1, 1, 0.01],
        geometry: { kind: 'polygon', params: { points } },
      },
    } as const;
    const source = fresh();
    committed(source.transaction([window('a'), attach]));
    const small = () =>
      makeWorkspace({ projectionKinds: [pano], geometryLimits: { maxParamsBytes: 64 } });
    const transacted = rejected(small().transaction([window('a'), attach])).error;
    expect(transacted).toMatchObject({ path: 'commands[1].surface.geometry.params' });
    expect(transacted.message).toMatch(/more than the maxParamsBytes limit of 64/);
    const target = small();
    const restored = rejected(done(target.restore(source.serialize()))).error;
    expect(restored).toMatchObject({
      code: 'SNAPSHOT_INVALID',
      path: 'surfaces[0].geometry.params',
    });
    expect(restored.message).toMatch(/more than the maxParamsBytes limit of 64/);
    expect(target.getState().revision).toBe(0);
  });

  it('takes a flag as present only when the snapshot itself holds it', () => {
    const ws = fresh();
    committed(ws.dispatch(window('a')));
    const s = ws.serialize();
    const node = s.nodes[0];
    if (node === undefined) {
      throw new Error('no node');
    }
    const flags = Object.fromEntries(
      Object.entries(node.flags).filter(([name]) => name !== 'visible'),
    );
    const snapshot = { ...s, nodes: [{ ...node, flags }] } as unknown as SceneSnapshot;
    // An inherited flag, as polluting Object.prototype would give every object, is not the
    // snapshot's own.
    Object.defineProperty(Object.prototype, 'visible', { value: true, configurable: true });
    try {
      expect(rejected(done(fresh().restore(snapshot))).error).toMatchObject({
        code: 'SNAPSHOT_INVALID',
        path: 'nodes[0].flags.visible',
      });
    } finally {
      delete (Object.prototype as Record<string, unknown>)['visible'];
    }
  });

  it('never moves the revision back', () => {
    const snapshot = layout().serialize();
    const ws = fresh();
    expect(committed(ws.restore({ ...snapshot, revision: 40 })).revision).toBe(40);
    expect(committed(ws.restore({ ...snapshot, revision: 3 })).revision).toBe(41);
  });

  it('keeps undo coherent across a restore (AUD-001)', () => {
    const ws = fresh();
    committed(ws.dispatch(window('mine', { label: 'Mine' })));
    committed(ws.dispatch({ type: 'node.patch', id: 'mine', label: 'Mine, renamed' }));
    const snapshot = layout().serialize();
    committed(ws.restore(snapshot));
    expect([...ws.getState().nodes.values()].map((n) => n.id).sort()).toEqual(['a', 'b']);
    // Undo takes the restore back: the previous nodes return, the restored ones go.
    committed(done(ws.undo()));
    expect([...ws.getState().nodes.values()].map((n) => [n.id, n.label])).toEqual([
      ['mine', 'Mine, renamed'],
    ]);
    // Cameras and viewports are view state: they stay as restored.
    expect(ws.getState().viewports.has('v')).toBe(true);
    // Earlier history is still coherent.
    committed(done(ws.undo()));
    expect(ws.getState().nodes.get('mine')?.label).toBe('Mine');
    committed(done(ws.redo()));
    committed(done(ws.redo()));
    expect(sceneOf(ws.serialize()).nodes).toEqual(snapshot.nodes);
    // Later edits undo first, then the restore itself.
    committed(ws.dispatch({ type: 'node.patch', id: 'a', label: 'edited' }));
    committed(done(ws.undo()));
    expect(ws.getState().nodes.get('a')?.label).toBe('A');
    committed(done(ws.undo()));
    expect([...ws.getState().nodes.ids()]).toEqual(['mine']);
  });

  it('drops previews that no longer apply, and refuses a disposed workspace', async () => {
    const ws = layout(fresh(), 'old-');
    ws.preview('drag', [{ type: 'node.patch', id: 'old-a', transform: at([0, 0, -2]) }]);
    const events = record(ws);
    committed(ws.restore(layout().serialize()));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'preview.cancelled',
        payload: { previewId: 'drag', reason: 'target-detached' },
      }),
    );
    await ws.dispose();
    expect(rejected(done(ws.restore(layout().serialize()))).error.code).toBe('WORKSPACE_DISPOSED');
  });
});
