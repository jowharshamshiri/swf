import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Id, SceneCommand, SceneState, TxResult, Workspace } from '../src/index.js';
import { at, makeWorkspace } from './helpers.js';

/**
 * Abstract operations: `pick` values choose among the nodes that exist when the step runs, so
 * most generated commands are valid and the sequences exercise real commits.
 */
type Op =
  | { op: 'create'; parent: number | null; x: number; a: number; s: number }
  | { op: 'move'; pick: number; x: number; a: number }
  | { op: 'reparent'; pick: number; parent: number | null; keep: 'world' | 'local' }
  | { op: 'reorder'; pick: number; index: number }
  | { op: 'delete'; pick: number; mode: 'subtree' | 'detachChildren' | 'rejectIfChildren' }
  | { op: 'group'; picks: number[] }
  | { op: 'ungroup'; pick: number }
  | { op: 'archive'; pick: number }
  | { op: 'restore'; pick: number }
  | { op: 'duplicate'; pick: number; reuse: boolean }
  | { op: 'select'; picks: number[] }
  | { op: 'attachSurface'; pick: number; index: number }
  | { op: 'moveSurface'; pick: number; owner: number; keep: 'world' | 'local' }
  | { op: 'reorderSurface'; pick: number; index: number }
  | { op: 'rebindSurface'; pick: number; key: number | null }
  | { op: 'detachSurface'; pick: number };

type Step = { kind: 'tx'; ops: Op[] } | { kind: 'undo' } | { kind: 'redo' };

const pick = fc.nat(1000);
const coord = fc.double({ min: -20, max: 20, noNaN: true });
const angle = fc.double({ min: -Math.PI, max: Math.PI, noNaN: true });

const op: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      op: fc.constant('create' as const),
      parent: fc.option(pick, { nil: null }),
      x: coord,
      a: angle,
      s: fc.double({ min: 0.5, max: 2, noNaN: true }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({ op: fc.constant('move' as const), pick, x: coord, a: angle }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('reparent' as const),
      pick,
      parent: fc.option(pick, { nil: null }),
      keep: fc.constantFrom('world' as const, 'local' as const),
    }),
  },
  fc.record({ op: fc.constant('reorder' as const), pick, index: fc.nat(3) }),
  fc.record({
    op: fc.constant('delete' as const),
    pick,
    mode: fc.constantFrom(
      'subtree' as const,
      'detachChildren' as const,
      'rejectIfChildren' as const,
    ),
  }),
  fc.record({
    op: fc.constant('group' as const),
    picks: fc.array(pick, { minLength: 1, maxLength: 3 }),
  }),
  fc.record({ op: fc.constant('ungroup' as const), pick }),
  { weight: 2, arbitrary: fc.record({ op: fc.constant('archive' as const), pick }) },
  { weight: 4, arbitrary: fc.record({ op: fc.constant('restore' as const), pick }) },
  fc.record({ op: fc.constant('duplicate' as const), pick, reuse: fc.boolean() }),
  fc.record({ op: fc.constant('select' as const), picks: fc.array(pick, { maxLength: 2 }) }),
  {
    weight: 3,
    arbitrary: fc.record({ op: fc.constant('attachSurface' as const), pick, index: fc.nat(2) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      op: fc.constant('moveSurface' as const),
      pick,
      owner: pick,
      keep: fc.constantFrom('world' as const, 'local' as const),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({ op: fc.constant('reorderSurface' as const), pick, index: fc.nat(1) }),
  },
  fc.record({
    op: fc.constant('rebindSurface' as const),
    pick,
    key: fc.option(fc.nat(5), { nil: null }),
  }),
  fc.record({ op: fc.constant('detachSurface' as const), pick }),
);

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 8,
    arbitrary: fc
      .array(op, { minLength: 1, maxLength: 2 })
      .map((ops) => ({ kind: 'tx' as const, ops })),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'undo' as const }) },
  { weight: 1, arbitrary: fc.constant({ kind: 'redo' as const }) },
);

/** Turns abstract operations into commands against the scene as it stands. */
function toCommands(state: SceneState, ops: readonly Op[], fresh: () => Id): SceneCommand[] {
  const existing = [...state.nodes.ids()];
  const active = [...state.nodes.values()].filter((n) => n.status === 'active').map((n) => n.id);
  const archived = [...state.nodes.values()]
    .filter((n) => n.status === 'archived')
    .map((n) => n.id);
  const surfaces = [...state.surfaces.ids()];
  const choose = (list: readonly Id[], n: number): Id =>
    list[n % Math.max(list.length, 1)] ?? 'missing';
  return ops.map((o): SceneCommand => {
    switch (o.op) {
      case 'create':
        return {
          type: 'node.create',
          node: {
            id: fresh(),
            kind: 'window',
            parentId:
              o.parent === null || existing.length === 0 ? null : choose(existing, o.parent),
            bounds: [1, 1, 0.1],
            transform: at([o.x, 0, -5], o.a, [o.s, o.s, o.s]),
          },
        };
      case 'move':
        return {
          type: 'node.patch',
          id: choose(existing, o.pick),
          transform: at([o.x, 1, -3], o.a),
        };
      case 'reparent':
        return {
          type: 'node.reparent',
          id: choose(existing, o.pick),
          parentId: o.parent === null ? null : choose(existing, o.parent),
          keep: o.keep,
        };
      case 'reorder':
        return { type: 'node.reorder', id: choose(existing, o.pick), index: o.index };
      case 'delete':
        return { type: 'node.delete', id: choose(existing, o.pick), mode: o.mode };
      case 'group':
        return {
          type: 'node.group',
          nodeIds: [...new Set(o.picks.map((p) => choose(existing, p)))],
        };
      case 'ungroup':
        return { type: 'node.ungroup', id: choose(existing, o.pick) };
      case 'archive':
        return { type: 'node.archive', id: choose(active, o.pick) };
      case 'restore':
        return { type: 'node.restoreArchived', id: choose(archived, o.pick) };
      case 'duplicate':
        return { type: 'node.duplicate', id: choose(active, o.pick), reuseBindingKeys: o.reuse };
      case 'select':
        return { type: 'selection.set', ids: [...new Set(o.picks.map((p) => choose(active, p)))] };
      case 'attachSurface':
        return {
          type: 'surface.attach',
          surface: {
            id: fresh(),
            ownerNodeId: choose(existing, o.pick),
            bindingKey: `key-${String(o.pick % 4)}`,
            adapterTypeId: 'host.view/1',
            bounds: [1, 0.5, 0.01],
            index: o.index,
          },
        };
      case 'moveSurface':
        return {
          type: 'surface.move',
          id: choose(surfaces, o.pick),
          ownerNodeId: choose(existing, o.owner),
          keep: o.keep,
        };
      case 'reorderSurface':
        return { type: 'surface.reorder', id: choose(surfaces, o.pick), index: o.index };
      case 'rebindSurface':
        return {
          type: 'surface.rebind',
          id: choose(surfaces, o.pick),
          bindingKey: o.key === null ? null : `key-${String(o.key)}`,
        };
      case 'detachSurface':
        return { type: 'surface.detach', id: choose(surfaces, o.pick) };
    }
  });
}

function run(ws: Workspace, s: Step, commands: SceneCommand[]): TxResult {
  return s.kind === 'tx' ? ws.transaction(commands) : s.kind === 'undo' ? ws.undo() : ws.redo();
}

/** Structural invariants every committed scene must satisfy. */
function checkScene(state: SceneState): void {
  const seen = new Set<string>();
  const visit = (nodeId: string, parentId: string | null, path: string[]): void => {
    expect(path, `cycle through ${nodeId}`).not.toContain(nodeId);
    expect(seen.has(nodeId), `${nodeId} reachable twice`).toBe(false);
    seen.add(nodeId);
    const node = state.nodes.get(nodeId);
    expect(node, `child ${nodeId} missing`).toBeDefined();
    expect(node?.parentId).toBe(parentId);
    for (const child of node?.childIds ?? []) {
      visit(child, nodeId, [...path, nodeId]);
    }
  };
  for (const root of state.rootIds) {
    visit(root, null, []);
  }
  expect(seen.size, 'every node is reachable from a root').toBe(state.nodes.size);
  for (const selected of state.selection) {
    expect(state.nodes.get(selected)?.status).toBe('active');
  }
  // Every surface belongs to an existing node that lists it exactly once, and every slot names
  // an existing surface of that node; no ID is both a node and a surface.
  const slotted = new Set<string>();
  for (const node of state.nodes) {
    for (const surfaceId of node.surfaceIds) {
      expect(slotted.has(surfaceId), `${surfaceId} slotted twice`).toBe(false);
      slotted.add(surfaceId);
      expect(state.surfaces.get(surfaceId)?.ownerNodeId, `slot ${surfaceId}`).toBe(node.id);
    }
  }
  expect(slotted.size, 'every surface has a slot').toBe(state.surfaces.size);
  for (const surface of state.surfaces) {
    expect(state.nodes.has(surface.id), `${surface.id} is both node and surface`).toBe(false);
  }
}

function snapshot(state: SceneState): unknown {
  return {
    revision: state.revision,
    rootIds: state.rootIds,
    selection: state.selection,
    focusedId: state.focusedId,
    nodes: [...state.nodes],
    surfaces: [...state.surfaces],
  };
}

/** Every sequence starts from three windows with two surfaces each, so early steps have work. */
const SEED: SceneCommand[] = [
  ...['s1', 's2', 's3'].map((id, i): SceneCommand => ({
    type: 'node.create',
    node: { id, kind: 'window', bounds: [1, 1, 0.1], transform: at([i * 2, 0, -5]) },
  })),
  ...['s1', 's2', 's3'].flatMap((owner) =>
    ['a', 'b'].map((slot): SceneCommand => ({
      type: 'surface.attach',
      surface: {
        id: `${owner}${slot}`,
        ownerNodeId: owner,
        bindingKey: `key-${slot}`,
        adapterTypeId: 'host.view/1',
        bounds: [1, 0.5, 0.01],
      },
    })),
  ),
];

const KINDS = [
  'node.create',
  'node.patch',
  'node.reparent',
  'node.reorder',
  'node.delete',
  'node.group',
  'node.ungroup',
  'node.archive',
  'node.restoreArchived',
  'node.duplicate',
  'selection.set',
  'surface.attach',
  'surface.move',
  'surface.reorder',
  'surface.rebind',
  'surface.detach',
  'undo',
  'redo',
];

describe('scene invariants under random command sequences', () => {
  it('keeps the hierarchy consistent, advances the revision by one per commit, and is deterministic', () => {
    const committedKinds = new Map<string, number>();
    let total = 0;
    let commits = 0;
    fc.assert(
      fc.property(fc.array(step, { maxLength: 40 }), (steps) => {
        const left = makeWorkspace();
        const right = makeWorkspace();
        for (const ws of [left, right]) {
          ws.transaction(SEED);
        }
        let n = 0;
        for (const s of steps) {
          const before = left.getState();
          const commands =
            s.kind === 'tx' ? toCommands(before, s.ops, () => `n${String(++n)}`) : [];
          const result = run(left, s, commands);
          run(right, s, commands);
          total += 1;
          if (result.status === 'committed') {
            commits += 1;
            for (const kind of s.kind === 'tx' ? commands.map((c) => c.type) : [s.kind]) {
              committedKinds.set(kind, (committedKinds.get(kind) ?? 0) + 1);
            }
            expect(left.getState().revision).toBe(before.revision + 1);
          } else {
            expect(result.status).toBe('rejected');
            expect(left.getState()).toBe(before);
          }
          checkScene(left.getState());
          expect(snapshot(right.getState())).toEqual(snapshot(left.getState()));
        }
      }),
      { numRuns: 300 },
    );
    // The sequences must exercise real commits of every kind, not only rejections.
    expect(commits / total).toBeGreaterThan(0.3);
    for (const kind of KINDS) {
      expect(committedKinds.get(kind) ?? 0, kind).toBeGreaterThan(5);
    }
  });

  it('undoing every step returns to the empty scene', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(op, { minLength: 1, maxLength: 2 }), { maxLength: 25 }),
        (txs) => {
          const ws = makeWorkspace({ undoCapacity: 10_000 });
          let n = 0;
          for (const ops of txs) {
            ws.transaction(toCommands(ws.getState(), ops, () => `n${String(++n)}`));
          }
          while (ws.canUndo()) {
            expect(ws.undo().status).toBe('committed');
            checkScene(ws.getState());
          }
          expect(ws.getState().nodes.size).toBe(0);
          expect(ws.getState().surfaces.size).toBe(0);
          expect(ws.getState().rootIds).toEqual([]);
        },
      ),
      { numRuns: 200 },
    );
  });
});
