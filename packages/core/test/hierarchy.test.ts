import type { Quat, Transform3D, Vec3 } from '@swf/math';
import {
  mat4ApproxEquals,
  mat4TransformPoint,
  quatFromAxisAngle,
  quatNormalize,
  ray,
} from '@swf/math';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { NodeRecord, RecordLookup, SceneCommand } from '../src/index.js';
import {
  ancestorIds,
  descendantIds,
  effectiveState,
  findNodes,
  nodesInBox,
  raycastBounds,
  worldBounds,
  worldMatrix,
  worldTransform,
} from '../src/index.js';
import { at, committed, expectClose, makeWorkspace, rejected, window } from './helpers.js';

describe('hierarchy walks', () => {
  it('fail explicitly on a cyclic hierarchy instead of looping', () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('a'), window('b', { parentId: 'a' })]));
    const { nodes } = ws.getState();
    const a = nodes.get('a');
    const b = nodes.get('b');
    if (a === undefined || b === undefined) {
      throw new Error('fixture missing');
    }
    // A hand-built corrupt lookup: a and b are each other's parent and child.
    const corrupt = new Map<string, NodeRecord>([
      ['a', { ...a, parentId: 'b' }],
      ['b', { ...b, childIds: ['a'] }],
    ]);
    const lookup: RecordLookup<NodeRecord> = {
      get: (id) => corrupt.get(id),
      has: (id) => corrupt.has(id),
      size: corrupt.size,
      values: () => corrupt.values(),
    };
    expect(() => ancestorIds(lookup, 'a')).toThrow(/cycle/);
    expect(() => descendantIds(lookup, 'a')).toThrow(/cycle/);
  });
});

const coord = fc.double({ min: -50, max: 50, noNaN: true });
const vec = fc.tuple(coord, coord, coord) as fc.Arbitrary<Vec3>;
const quat: fc.Arbitrary<Quat> = fc
  .tuple(
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
    fc.double({ min: -1, max: 1, noNaN: true }),
  )
  .filter((q) => Math.hypot(...q) > 0.1)
  .map((q) => quatNormalize(q));
/** Uniformly scaled transforms: any chain of them stays expressible as position/rotation/scale. */
const uniform: fc.Arbitrary<Transform3D> = fc.record({
  position: vec,
  rotation: quat,
  scale: fc.double({ min: 0.25, max: 4, noNaN: true }).map((s) => [s, s, s] as const),
});

describe('world transforms and reparenting', () => {
  it('keeps the world placement when reparenting with keep "world"', () => {
    fc.assert(
      fc.property(uniform, uniform, uniform, uniform, (pa, ca, pb, cb) => {
        const ws = makeWorkspace();
        committed(
          ws.transaction([
            window('pa', { transform: pa }),
            window('ca', { parentId: 'pa', transform: ca }),
            window('pb', { transform: pb }),
            window('child', { parentId: 'ca', transform: cb }),
          ]),
        );
        const before = worldMatrix(ws.getState().nodes, 'child');
        committed(
          ws.dispatch({ type: 'node.reparent', id: 'child', parentId: 'pb', keep: 'world' }),
        );
        const after = worldMatrix(ws.getState().nodes, 'child');
        const scale = Math.max(...(before ?? []).map(Math.abs), 1);
        return (
          before !== undefined &&
          after !== undefined &&
          mat4ApproxEquals(before, after, 1e-9 * scale * 100)
        );
      }),
    );
  });

  it('keeps the local transform with keep "local", the default for host changes', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('p', { transform: at([10, 0, 0]) }),
        window('c', { transform: at([1, 2, 3]) }),
      ]),
    );
    committed(ws.dispatch({ type: 'node.reparent', id: 'c', parentId: 'p' }));
    expect(ws.getState().nodes.get('c')?.transform.position).toEqual([1, 2, 3]);
    const world = worldMatrix(ws.getState().nodes, 'c');
    expectClose(world === undefined ? [] : mat4TransformPoint(world, [0, 0, 0]), [11, 2, 3]);
  });

  it('defaults to keeping the world placement for operator (user) changes', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('p', { transform: at([10, 0, 0]) }),
        window('c', { transform: at([1, 2, 3]) }),
      ]),
    );
    committed(ws.dispatch({ type: 'node.reparent', id: 'c', parentId: 'p' }, { source: 'user' }));
    expectClose(ws.getState().nodes.get('c')?.transform.position ?? [], [-9, 2, 3]);
  });

  it('rejects a reparent that would create a cycle', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([window('a'), window('b', { parentId: 'a' }), window('c', { parentId: 'b' })]),
    );
    const self = rejected(ws.dispatch({ type: 'node.reparent', id: 'a', parentId: 'a' }));
    expect(self.error.path).toBe('commands[0].parentId');
    const loop = rejected(ws.dispatch({ type: 'node.reparent', id: 'a', parentId: 'c' }));
    expect(loop.error.message).toMatch(/its own ancestor/);
    expect(ws.getState().revision).toBe(1);
  });

  it('rejects keeping a world placement that would need shear', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('stretched', { transform: at([0, 0, 0], 0, [3, 1, 1]) }),
        window('turned', { transform: at([0, 0, -2], Math.PI / 4) }),
      ]),
    );
    const result = rejected(
      ws.dispatch({ type: 'node.reparent', id: 'turned', parentId: 'stretched', keep: 'world' }),
    );
    expect(result.error.message).toMatch(/shear/);
  });

  it('moves a node among its siblings with node.reorder and with an index', () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('a'), window('b'), window('c'), window('d', { index: 0 })]));
    expect(ws.getState().rootIds).toEqual(['d', 'a', 'b', 'c']);
    committed(ws.dispatch({ type: 'node.reorder', id: 'd', index: 3 }));
    expect(ws.getState().rootIds).toEqual(['a', 'b', 'c', 'd']);
    expect(rejected(ws.dispatch({ type: 'node.reorder', id: 'd', index: 4 })).error.path).toBe(
      'commands[0].index',
    );
  });
});

describe('deleting', () => {
  const tree: SceneCommand[] = [
    window('root', { transform: at([0, 0, -5]) }),
    window('parent', { parentId: 'root', transform: at([2, 0, 0], Math.PI / 2) }),
    window('kid', { parentId: 'parent', transform: at([1, 0, 0]) }),
    window('grandkid', { parentId: 'kid' }),
  ];

  it('removes the whole subtree in mode "subtree"', () => {
    const ws = makeWorkspace();
    committed(ws.transaction(tree));
    committed(ws.dispatch({ type: 'node.delete', id: 'parent', mode: 'subtree' }));
    const { nodes } = ws.getState();
    expect([...nodes.ids()]).toEqual(['root']);
    expect(nodes.get('root')?.childIds).toEqual([]);
  });

  it('moves the children to the parent, keeping world placement, in mode "detachChildren"', () => {
    const ws = makeWorkspace();
    committed(ws.transaction(tree));
    const before = worldMatrix(ws.getState().nodes, 'kid');
    committed(ws.dispatch({ type: 'node.delete', id: 'parent', mode: 'detachChildren' }));
    const { nodes } = ws.getState();
    expect(nodes.has('parent')).toBe(false);
    expect(nodes.get('kid')?.parentId).toBe('root');
    expect(nodes.get('root')?.childIds).toEqual(['kid']);
    expect(nodes.get('grandkid')?.parentId).toBe('kid');
    expect(
      mat4ApproxEquals(worldMatrix(nodes, 'kid') ?? ([] as never), before ?? ([] as never), 1e-12),
    ).toBe(true);
  });

  it('refuses while children exist in mode "rejectIfChildren", and requires a mode', () => {
    const ws = makeWorkspace();
    committed(ws.transaction(tree));
    expect(
      rejected(ws.dispatch({ type: 'node.delete', id: 'parent', mode: 'rejectIfChildren' })).error
        .message,
    ).toMatch(/still has 1 children/);
    committed(ws.dispatch({ type: 'node.delete', id: 'grandkid', mode: 'rejectIfChildren' }));
    expect(
      rejected(ws.dispatch({ type: 'node.delete', id: 'kid' } as unknown as SceneCommand)).error
        .path,
    ).toBe('commands[0].mode');
  });

  it('drops deleted nodes from the selection and focus', () => {
    const ws = makeWorkspace();
    committed(ws.transaction(tree));
    committed(
      ws.transaction([
        { type: 'selection.set', ids: ['kid', 'root'] },
        { type: 'focus.set', id: 'kid' },
      ]),
    );
    committed(ws.dispatch({ type: 'node.delete', id: 'parent', mode: 'subtree' }));
    expect(ws.getState().selection).toEqual(['root']);
    expect(ws.getState().focusedId).toBeNull();
  });
});

describe('grouping', () => {
  it('groups nodes keeping their world placement, around their combined box', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('a', { transform: at([2, 0, -4]), bounds: [1, 1, 1] }),
        window('b', { transform: at([-2, 1, -4]), bounds: [1, 1, 1] }),
        window('c'),
      ]),
    );
    const worldA = worldMatrix(ws.getState().nodes, 'a');
    committed(
      ws.dispatch({ type: 'node.group', nodeIds: ['a', 'b'], group: { id: 'g', label: 'pair' } }),
    );
    const { nodes, rootIds } = ws.getState();
    expect(rootIds).toEqual(['g', 'c']);
    const group = nodes.get('g');
    expect(group?.kind).toBe('group');
    expect(group?.childIds).toEqual(['a', 'b']);
    expectClose(group?.transform.position ?? [], [0, 0.5, -4]);
    expectClose(group?.bounds ?? [], [5, 2, 1]);
    expect(
      mat4ApproxEquals(worldMatrix(nodes, 'a') ?? ([] as never), worldA ?? ([] as never), 1e-12),
    ).toBe(true);
  });

  it('nests groups and ungroups back to the same world placement', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('a', { transform: at([1, 0, -3], 0.3) }),
        window('b', { transform: at([-1, 0, -3], -0.3) }),
        window('c', { transform: at([0, 2, -3]) }),
      ]),
    );
    const world = (id: string) => worldMatrix(ws.getState().nodes, id) ?? ([] as never);
    const before = ['a', 'b', 'c'].map(world);
    committed(ws.dispatch({ type: 'node.group', nodeIds: ['a', 'b'], group: { id: 'inner' } }));
    committed(ws.dispatch({ type: 'node.group', nodeIds: ['inner', 'c'], group: { id: 'outer' } }));
    expect(ws.getState().nodes.get('outer')?.childIds).toEqual(['inner', 'c']);
    ['a', 'b', 'c'].forEach((id, i) => {
      expect(mat4ApproxEquals(world(id), before[i] ?? ([] as never), 1e-12)).toBe(true);
    });
    committed(ws.dispatch({ type: 'node.ungroup', id: 'outer' }));
    committed(ws.dispatch({ type: 'node.ungroup', id: 'inner' }));
    expect(ws.getState().rootIds).toEqual(['a', 'b', 'c']);
    ['a', 'b', 'c'].forEach((id, i) => {
      expect(mat4ApproxEquals(world(id), before[i] ?? ([] as never), 1e-12)).toBe(true);
    });
  });

  it('rejects members inside other members and members without a shared parent', () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('a'), window('b', { parentId: 'a' }), window('c')]));
    expect(rejected(ws.dispatch({ type: 'node.group', nodeIds: ['a', 'b'] })).error.path).toBe(
      'commands[0].nodeIds[1]',
    );
    expect(rejected(ws.dispatch({ type: 'node.group', nodeIds: ['b', 'c'] })).error.path).toBe(
      'commands[0].group.parentId',
    );
    committed(
      ws.dispatch({ type: 'node.group', nodeIds: ['b', 'c'], group: { parentId: null, id: 'g' } }),
    );
    expect(
      rejected(ws.dispatch({ type: 'node.group', nodeIds: ['g'], group: { parentId: 'c' } })).error
        .message,
    ).toMatch(/inside member "g"/);
  });
});

describe('duplicating', () => {
  it('copies the active subtree with fresh IDs and its layout, leaving archived children out', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('w', {
          transform: at([1, 0, -2]),
          label: 'Notes',
          tags: ['work'],
          metadata: { 'host.colour': 'red' },
        }),
        window('panel', { parentId: 'w', transform: at([0, 0.5, 0]) }),
        window('old', { parentId: 'w' }),
        { type: 'node.archive', id: 'old' },
      ]),
    );
    const result = committed(
      ws.dispatch({ type: 'node.duplicate', id: 'w', ids: { w: 'w2' }, transform: at([3, 0, -2]) }),
    );
    expect(result.createdIds).toEqual(['w2', 'node-1']);
    const { nodes } = ws.getState();
    const copy = nodes.get('w2');
    expect(copy).toMatchObject({
      label: 'Notes',
      tags: ['work'],
      metadata: { 'host.colour': 'red' },
      parentId: null,
    });
    expect(copy?.transform.position).toEqual([3, 0, -2]);
    expect(copy?.childIds).toEqual(['node-1']);
    expect(nodes.get('node-1')?.transform.position).toEqual([0, 0.5, 0]);
    expect(nodes.get('w')?.childIds).toEqual(['panel', 'old']);
  });

  it('refuses to duplicate an archived node or reuse an ID', () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('a'), window('b'), { type: 'node.archive', id: 'b' }]));
    expect(rejected(ws.dispatch({ type: 'node.duplicate', id: 'b' })).error.message).toMatch(
      /archived/,
    );
    expect(
      rejected(ws.dispatch({ type: 'node.duplicate', id: 'a', ids: { a: 'b' } })).error.message,
    ).toMatch(/already in use/);
    expect(
      rejected(ws.dispatch({ type: 'node.duplicate', id: 'a', ids: { zzz: 'q' } })).error.path,
    ).toBe('commands[0].ids.zzz');
  });
});

describe('archiving, visibility and locks', () => {
  it('archives a subtree in effect while keeping it in the scene', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('a'),
        window('b', { parentId: 'a' }),
        { type: 'selection.set', ids: ['b'] },
      ]),
    );
    committed(ws.dispatch({ type: 'node.archive', id: 'a' }));
    const { nodes } = ws.getState();
    expect(nodes.get('b')?.status).toBe('active');
    expect(effectiveState(nodes, 'b')).toEqual({
      active: false,
      visible: false,
      selectable: false,
    });
    expect(ws.getState().selection).toEqual([]);
    expect(rejected(ws.dispatch({ type: 'node.archive', id: 'a' })).error.message).toMatch(
      /already archived/,
    );
    committed(ws.dispatch({ type: 'node.restoreArchived', id: 'a' }));
    expect(effectiveState(ws.getState().nodes, 'b')?.active).toBe(true);
  });

  it('inherits visibility and selectability from ancestors, keeping hidden children in state', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('a', { flags: { visible: false } }),
        window('b', { parentId: 'a' }),
        window('c', { flags: { selectable: false } }),
      ]),
    );
    const { nodes } = ws.getState();
    expect(effectiveState(nodes, 'b')).toEqual({ active: true, visible: false, selectable: false });
    expect(effectiveState(nodes, 'c')).toEqual({ active: true, visible: true, selectable: false });
    expect(nodes.has('b')).toBe(true);
    expect(rejected(ws.dispatch({ type: 'selection.set', ids: ['b'] })).error.path).toBe(
      'commands[0].ids[0]',
    );
    expect(rejected(ws.dispatch({ type: 'focus.set', id: 'c' })).error.path).toBe('commands[0].id');
  });

  it('blocks operator changes to a locked node but not host changes, and allows unlocking', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('a', { flags: { locked: true } })));
    const user = { source: 'user' } as const;
    for (const command of [
      { type: 'node.patch', id: 'a', transform: at([1, 0, 0]) },
      { type: 'node.patch', id: 'a', bounds: [2, 2, 2] },
      { type: 'node.reparent', id: 'a', parentId: null },
      { type: 'node.delete', id: 'a', mode: 'subtree' },
      { type: 'node.archive', id: 'a' },
      { type: 'node.group', nodeIds: ['a'] },
      { type: 'node.ungroup', id: 'a' },
    ] as SceneCommand[]) {
      const result = rejected(ws.dispatch(command, user));
      expect(result.error.code).toBe('LOCKED');
      expect(result.error.entityId).toBe('a');
    }
    committed(ws.dispatch({ type: 'node.patch', id: 'a', label: 'still labelled' }, user));
    committed(ws.dispatch({ type: 'node.patch', id: 'a', transform: at([1, 0, 0]) }));
    committed(ws.dispatch({ type: 'node.patch', id: 'a', flags: { locked: false } }, user));
    committed(ws.dispatch({ type: 'node.patch', id: 'a', transform: at([2, 0, 0]) }, user));
  });

  it('rejects user deletion of a subtree holding a locked descendant', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([window('a'), window('b', { parentId: 'a', flags: { locked: true } })]),
    );
    expect(
      rejected(ws.dispatch({ type: 'node.delete', id: 'a', mode: 'subtree' }, { source: 'user' }))
        .error.entityId,
    ).toBe('b');
  });
});

describe('metadata', () => {
  it('accepts namespaced JSON metadata and patches it by key', () => {
    const ws = makeWorkspace();
    committed(
      ws.dispatch(
        window('a', { metadata: { 'host.owner': { name: 'x', n: [1, 2] }, 'ext.map.pin': true } }),
      ),
    );
    committed(
      ws.dispatch({
        type: 'node.patch',
        id: 'a',
        metadata: { set: { 'host.colour': 'blue' }, remove: ['ext.map.pin'] },
      }),
    );
    expect(ws.getState().nodes.get('a')?.metadata).toEqual({
      'host.owner': { name: 'x', n: [1, 2] },
      'host.colour': 'blue',
    });
  });

  it('rejects unnamespaced or reserved keys, non-JSON values and prototype keys', () => {
    const ws = makeWorkspace();
    const bad = (metadata: unknown) =>
      rejected(ws.dispatch(window('a', { metadata: metadata as never }))).error.path;
    expect(bad({ colour: 'red' })).toBe('commands[0].node.metadata.colour');
    expect(bad({ 'swf.revision': 1 })).toBe('commands[0].node.metadata.swf.revision');
    expect(bad({ 'host.n': Infinity })).toBe('commands[0].node.metadata.host.n');
    expect(bad({ 'host.when': new Date(0) })).toBe('commands[0].node.metadata.host.when');
    expect(bad({ 'host.f': () => 1 })).toBe('commands[0].node.metadata.host.f');
    expect(bad(JSON.parse('{"host.x": {"__proto__": {"polluted": true}}}'))).toBe(
      'commands[0].node.metadata.host.x.__proto__',
    );
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('never lets a caller mutate committed state through its own objects', () => {
    const ws = makeWorkspace();
    const position: [number, number, number] = [1, 2, 3];
    const tags = ['x'];
    const metadata = { 'host.list': [1, 2] };
    committed(
      ws.dispatch(
        window('a', {
          transform: { position, rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          tags,
          metadata,
        }),
      ),
    );
    position[0] = 99;
    tags.push('y');
    metadata['host.list'].push(3);
    const node = ws.getState().nodes.get('a');
    expect(node?.transform.position).toEqual([1, 2, 3]);
    expect(node?.tags).toEqual(['x']);
    expect(node?.metadata).toEqual({ 'host.list': [1, 2] });
    expect(Object.isFrozen(node)).toBe(true);
    expect(Object.isFrozen(node?.metadata['host.list'])).toBe(true);
  });
});

describe('spatial and metadata queries', () => {
  it('computes world bounds and finds nodes by box and by ray, nearest first', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('near', { transform: at([0, 0, -2]), bounds: [1, 1, 0.1] }),
        window('far', { transform: at([0, 0, -6]), bounds: [1, 1, 0.1] }),
        window('far-front', {
          transform: at([0, 0, -6]),
          bounds: [1, 1, 0.1],
          flags: { presentationPriority: 5 },
        }),
        window('hidden', {
          transform: at([0, 0, -4]),
          bounds: [1, 1, 0.1],
          flags: { visible: false },
        }),
        window('aside', { transform: at([5, 0, -2]), bounds: [1, 1, 0.1] }),
      ]),
    );
    const state = ws.getState();
    const box = worldBounds(state.nodes, 'near');
    expectClose([...(box?.min ?? []), ...(box?.max ?? [])], [-0.5, -0.5, -2.05, 0.5, 0.5, -1.95]);
    expect(raycastBounds(state, ray([0, 0, 0], [0, 0, -1])).map((h) => h.nodeId)).toEqual([
      'near',
      'far-front',
      'far',
    ]);
    expect(
      raycastBounds(state, ray([0, 0, 0], [0, 0, -1]), { includeHidden: true }).map(
        (h) => h.nodeId,
      ),
    ).toContain('hidden');
    expect(nodesInBox(state, { min: [-1, -1, -3], max: [6, 1, -1] })).toEqual(['near', 'aside']);
  });

  it('finds nodes by Unicode-normalized, case-insensitive text, tags and kind', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('a', { label: 'Ｒｅｐｏｒｔ Draft', tags: ['work'] }),
        window('b', { label: 'Holiday', tags: ['home'] }),
        {
          type: 'node.create',
          node: { id: 'g', kind: 'group', bounds: [1, 1, 1], label: 'report group' },
        },
        window('c', { label: 'old report' }),
        { type: 'node.archive', id: 'c' },
      ]),
    );
    const state = ws.getState();
    expect(findNodes(state, { text: 'REPORT' })).toEqual(['a', 'g']);
    expect(findNodes(state, { text: 'report', kinds: ['window'] })).toEqual(['a']);
    expect(findNodes(state, { tags: ['home'] })).toEqual(['b']);
    expect(findNodes(state, { text: 'report', includeArchived: true })).toEqual(['a', 'g', 'c']);
    expect(ws.findNodes({ text: 'work' })).toEqual(['a']);
  });

  it('matches exposed metadata and group paths only when asked, never other metadata', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        {
          type: 'node.create',
          node: { id: 'g', kind: 'group', bounds: [1, 1, 1], label: 'Ｗｅｓｔ Wall' },
        },
        window('a', {
          parentId: 'g',
          label: 'Notes',
          metadata: { 'host.colour': 'Teal', 'host.secret': 'teal', 'host.count': 42 },
        }),
        window('b', { label: 'Plans', metadata: { 'host.colour': 'Amber' } }),
        window('c', { label: 'Logs', metadata: { 'host.colour': { nested: 'teal' } } }),
      ]),
    );
    const state = ws.getState();
    // Metadata is never searched unless its key is exposed.
    expect(findNodes(state, { text: 'teal' })).toEqual([]);
    expect(findNodes(state, { text: 'TEAL', metadataKeys: ['host.colour'] })).toEqual(['a']);
    // Numbers are matched as written; objects and arrays are not descriptive text.
    expect(findNodes(state, { text: '42', metadataKeys: ['host.count'] })).toEqual(['a']);
    // A window is found by the label of a group it is in, when group paths are searched.
    expect(findNodes(state, { text: 'west wall', kinds: ['window'] })).toEqual([]);
    expect(findNodes(state, { text: 'west wall', kinds: ['window'], groupPath: true })).toEqual([
      'a',
    ]);
    expect(() => findNodes(state, { text: 'x', metadataKeys: ['colour'] })).toThrow(/colour/);
  });

  it('filters by effective group membership, visibility and lock', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        { type: 'node.create', node: { id: 'g', kind: 'group', bounds: [1, 1, 1] } },
        { type: 'node.create', node: { id: 'h', kind: 'group', bounds: [1, 1, 1], parentId: 'g' } },
        window('a', { parentId: 'h' }),
        window('b', { flags: { locked: true } }),
        window('c'),
      ]),
    );
    committed(ws.dispatch({ type: 'node.patch', id: 'g', flags: { visible: false } }));
    const state = ws.getState();
    expect(findNodes(state, { kinds: ['window'], within: 'g' })).toEqual(['a']);
    expect(findNodes(state, { kinds: ['window'], within: 'a' })).toEqual([]);
    // Hidden through its group: effectively hidden, though its own flag is visible.
    expect(findNodes(state, { kinds: ['window'], visible: false })).toEqual(['a']);
    expect(findNodes(state, { kinds: ['window'], visible: true })).toEqual(['b', 'c']);
    expect(findNodes(state, { kinds: ['window'], locked: true })).toEqual(['b']);
    expect(findNodes(state, { kinds: ['window'], locked: false })).toEqual(['a', 'c']);
    expect(() => findNodes(state, { within: 'missing' })).toThrow(/missing/);
  });

  it('reports world transforms through nested rotated parents', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('p', {
          transform: {
            position: [0, 0, -5],
            rotation: quatFromAxisAngle([0, 1, 0], Math.PI / 2),
            scale: [2, 2, 2],
          },
        }),
        window('c', { parentId: 'p', transform: at([1, 0, 0]) }),
      ]),
    );
    const world = worldTransform(ws.getState().nodes, 'c');
    expect(world?.ok).toBe(true);
    if (world?.ok === true) {
      expectClose(world.transform.position, [0, 0, -7]);
      expectClose(world.transform.scale, [2, 2, 2]);
    }
  });
});
