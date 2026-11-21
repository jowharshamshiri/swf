import { describe, expect, it } from 'vitest';
import type { SceneCommand, SceneSnapshot, Workspace } from '../src/index.js';
import { SwfFailure, validateSceneSnapshot } from '../src/index.js';
import { at, committed, makeWorkspace, window } from './helpers.js';

const pano = { id: 'test.pano/1', configIssue: () => null };

/** A scene with a hierarchy, surfaces, a camera, a viewport, metadata, an orbit root and focus. */
function scene(order: 'forward' | 'reverse' = 'forward'): Workspace {
  const ws = makeWorkspace({ now: () => 1000, projectionKinds: [pano] });
  const windows: SceneCommand[] = [
    window('b', {
      transform: at([1, 0, -3], 0.3),
      label: 'B',
      metadata: { 'host.z': 1, 'host.a': { y: 2, x: 1 } },
    }),
    window('a', { transform: at([-1, 0.5, -3]), tags: ['pinned'] }),
  ];
  committed(
    ws.transaction([
      ...(order === 'forward' ? windows : [...windows].reverse()),
      window('c', { parentId: 'a', transform: at([0, 0.2, 0.1]) }),
      {
        type: 'surface.attach',
        surface: {
          id: 'a-s',
          ownerNodeId: 'a',
          bindingKey: 'key-a',
          adapterTypeId: 'host.view/1',
          bounds: [1.2, 0.6, 0.01],
        },
      },
      { type: 'camera.create', camera: { id: 'cam', position: [0, 1.6, 0] } },
      {
        type: 'viewport.create',
        viewport: {
          id: 'v',
          cameraId: 'cam',
          projection: { id: 'test.pano/1', config: { vertical: 120, horizontal: 360 } },
          size: { width: 800, height: 400, devicePixelRatio: 2 },
        },
      },
      { type: 'orbitRoot.set', nodeId: 'a' },
      { type: 'focus.set', id: 'b' },
    ]),
  );
  return ws;
}

const REMOVE = Symbol('remove');

/**
 * A copy of a snapshot with the values at dot-separated paths (indices as numbers) replaced, or
 * removed: a snapshot broken on purpose.
 */
function edited(s: SceneSnapshot, ...edits: (readonly [string, unknown])[]): unknown {
  const out = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  for (const [path, value] of edits) {
    const keys = path.split('.');
    const last = keys.pop() ?? '';
    let at = out;
    for (const key of keys) {
      at = at[key] as Record<string, unknown>;
    }
    if (value === REMOVE) {
      Reflect.deleteProperty(at, last);
    } else {
      at[last] = value;
    }
  }
  return out;
}

function failure(value: unknown): { path: string | undefined; message: string } {
  try {
    validateSceneSnapshot(value);
  } catch (error) {
    if (error instanceof SwfFailure) {
      expect(error.error.code).toBe('SNAPSHOT_INVALID');
      return { path: error.error.path, message: error.message };
    }
    throw error;
  }
  throw new Error('the snapshot was accepted');
}

describe('scene snapshots (FR-002, FR-160, FR-161)', () => {
  it('holds every node, surface, camera and viewport field, the hierarchy, orbit root and focus', () => {
    const s = scene().serialize();
    expect(s.workspaceId).toBe('ws');
    expect(s.revision).toBe(1);
    expect(s.rootIds).toEqual(['b', 'a']);
    expect(s.nodes.map((n) => n.id)).toEqual(['a', 'b', 'c']);
    expect(s.nodes[0]).toMatchObject({
      childIds: ['c'],
      surfaceIds: ['a-s'],
      tags: ['pinned'],
      status: 'active',
      createdAt: 1000,
    });
    expect(s.surfaces[0]).toMatchObject({
      bindingKey: 'key-a',
      adapterTypeId: 'host.view/1',
      geometry: { kind: 'rect', params: null },
      interaction: 'content',
    });
    expect(s.viewports[0]?.projection).toEqual({
      id: 'test.pano/1',
      config: { horizontal: 360, vertical: 120 },
    });
    expect(s.cameras[0]?.position).toEqual([0, 1.6, 0]);
    expect(s).toMatchObject({ orbitRootId: 'a', selection: [], focusedId: 'b' });
    expect(Object.isFrozen(s.nodes[0]?.transform.position)).toBe(true);
  });

  it('is canonical: the same scene gives the same text whatever order it was built in', () => {
    const one = JSON.stringify(scene('forward').serialize());
    const two = JSON.stringify(scene('reverse').serialize());
    // Root order is presentation order, so it differs; everything else is identical.
    expect(one.replace('"rootIds":["b","a"]', '')).toBe(two.replace('"rootIds":["a","b"]', ''));
    // Metadata keys are sorted, records keep a fixed field order.
    expect(one).toContain('"metadata":{"host.a":{"x":1,"y":2},"host.z":1}');
    expect(Object.keys(scene().serialize().nodes[0] ?? {})).toEqual([
      'id',
      'kind',
      'parentId',
      'childIds',
      'surfaceIds',
      'transform',
      'bounds',
      'flags',
      'label',
      'tags',
      'metadata',
      'status',
      'createdAt',
      'updatedAt',
    ]);
  });

  it('is the committed scene: open previews are not part of it', () => {
    const ws = scene();
    ws.preview('drag', [{ type: 'node.patch', id: 'a', transform: at([5, 0, -3]) }]);
    expect(ws.serialize().nodes[0]?.transform.position).toEqual([-1, 0.5, -3]);
  });

  it('is offered alone by the persistence scope, frozen and with no other operation (SEC-002)', () => {
    const ws = scene();
    const scope = ws.persistence();
    expect(Object.keys(scope).sort()).toEqual(['id', 'revision', 'serialize', 'subscribe']);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(scope.revision()).toBe(1);
    expect(scope.serialize()).toEqual(ws.serialize());
    const heard: number[] = [];
    scope.subscribe((e) => heard.push(e.revision));
    committed(ws.dispatch({ type: 'node.patch', id: 'a', label: 'A' }));
    expect(heard).toContain(2);
  });
});

describe('scene snapshot validation (SEC-011, DATA-017)', () => {
  it('accepts what a workspace produces, and puts entities in canonical order', () => {
    const s = scene().serialize();
    expect(validateSceneSnapshot(s)).toEqual(s);
    const shuffled = edited(s, ['nodes', [...s.nodes].reverse()]);
    expect(validateSceneSnapshot(shuffled)).toEqual(s);
  });

  it('rejects malformed, unknown, missing and non-finite fields, naming the path', () => {
    const s = scene().serialize();
    const broken = (...edits: (readonly [string, unknown])[]) => failure(edited(s, ...edits));
    expect(broken(['nodes.1.bounds', REMOVE]).path).toBe('nodes[1].bounds');
    expect(broken(['nodes.0.extra', 1]).path).toBe('nodes[0].extra');
    expect(broken(['handle', {}]).path).toBe('handle');
    expect(broken(['nodes.0.transform.position.1', Infinity]).path).toBe(
      'nodes[0].transform.position',
    );
    expect(broken(['cameras.0.rotation', [0, 0, 0, 2]]).path).toBe('cameras[0].rotation');
    expect(broken(['surfaces.0.flags.locked', REMOVE]).path).toBe('surfaces[0].flags.locked');
    expect(broken(['revision', -1]).path).toBe('revision');
    expect(failure([]).path).toBe('the snapshot');
  });

  it('rejects broken references, duplicate IDs and cycles in the hierarchy', () => {
    const s = scene().serialize();
    const broken = (...edits: (readonly [string, unknown])[]) => failure(edited(s, ...edits));
    expect(broken(['cameras.0.id', 'a']).message).toMatch(
      /repeats the ID "a", already used by a node/,
    );
    // The first broken reference found is named: a's child that no longer names a as parent.
    expect(broken(['nodes.2.parentId', 'nope']).path).toBe('nodes[0].childIds[0]');
    expect(broken(['nodes.2.parentId', 'nope']).message).toMatch(/whose parentId is not "a"/);
    expect(broken(['nodes.0.childIds', []]).path).toBe('nodes[2].parentId');
    expect(broken(['rootIds', ['a']]).path).toBe('nodes[1].parentId');
    expect(broken(['surfaces.0.ownerNodeId', 'b']).path).toBe('nodes[0].surfaceIds[0]');
    expect(broken(['viewports.0.cameraId', 'gone']).path).toBe('viewports[0].cameraId');
    expect(broken(['focusedId', 'gone']).path).toBe('focusedId');
    // a and c parent each other: a cycle, detached from every root.
    const cycle = broken(
      ['rootIds', ['b']],
      ['nodes.0.parentId', 'c'],
      ['nodes.2.childIds', ['a']],
    );
    expect(cycle.message).toMatch(/cycle of the hierarchy/);
  });

  it('rejects prototype-polluting keys and cyclic data, and copies nothing callable', () => {
    const s = scene().serialize();
    const polluted = JSON.parse(
      JSON.stringify(s).replace(
        '"metadata":{}',
        '"metadata":{"host.x":{"__proto__":{"admin":true}}}',
      ),
    ) as unknown;
    expect(failure(polluted).message).toMatch(/must not use the key "__proto__"/);
    expect(({} as Record<string, unknown>)['admin']).toBeUndefined();
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    expect(failure(edited(s, ['nodes.0.metadata', { 'host.loop': loop }])).message).toMatch(
      /contains itself \(a cycle\)/,
    );
    expect(failure(edited(s, ['nodes.0.metadata', { 'host.f': () => 1 }])).path).toBe(
      'nodes[0].metadata.host.f',
    );
  });
});
