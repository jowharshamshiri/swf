import { describe, expect, it } from 'vitest';
import type { SceneCommand } from '../src/index.js';
import { at, committed, makeWorkspace, rejected, window } from './helpers.js';

describe('atomic transactions', () => {
  it('applies every command of a transaction as one revision', () => {
    const ws = makeWorkspace();
    const result = committed(
      ws.transaction([window('a'), window('b'), window('c', { parentId: 'a' })]),
    );
    expect(result.revision).toBe(1);
    expect(result.previousRevision).toBe(0);
    expect(result.createdIds).toEqual(['a', 'b', 'c']);
    const state = ws.getState();
    expect(state.revision).toBe(1);
    expect(state.rootIds).toEqual(['a', 'b']);
    expect(state.nodes.get('a')?.childIds).toEqual(['c']);
  });

  it('applies nothing when any command fails, leaving revision, history and selection unchanged', () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('a'), { type: 'selection.set', ids: ['a'] }]));
    const before = ws.getState();
    const history = ws.history();
    const result = rejected(
      ws.transaction([
        { type: 'node.patch', id: 'a', transform: at([5, 0, 0]) },
        window('b'),
        { type: 'selection.set', ids: [] },
        { type: 'node.create', node: { id: 'c', kind: 'window', bounds: [1, -1, 1] } },
      ]),
    );
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.path).toBe('commands[3].node.bounds');
    expect(result.revision).toBe(1);
    expect(ws.getState()).toBe(before);
    expect(ws.history()).toEqual(history);
    expect(ws.getState().selection).toEqual(['a']);
  });

  it('rejects an empty transaction and malformed commands, naming the field', () => {
    const ws = makeWorkspace();
    expect(rejected(ws.transaction([])).error.path).toBe('commands');
    const bad = (command: unknown) => rejected(ws.transaction([command as SceneCommand])).error;
    expect(bad({ type: 'node.fly' }).path).toBe('commands[0].type');
    expect(
      bad({ type: 'node.create', node: { id: 'x', kind: 'w', bounds: [1, 1, 1], colour: 'red' } })
        .path,
    ).toBe('commands[0].node.colour');
    expect(bad({ type: 'node.create', node: { id: ' ', kind: 'w', bounds: [1, 1, 1] } }).path).toBe(
      'commands[0].node.id',
    );
    expect(
      bad({
        type: 'node.create',
        node: { id: 'x', kind: 'w', bounds: [1, 1, 1], transform: at([NaN, 0, 0]) },
      }).path,
    ).toBe('commands[0].node.transform.position');
    expect(
      bad({
        type: 'node.create',
        node: {
          id: 'x',
          kind: 'w',
          bounds: [1, 1, 1],
          transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1.1], scale: [1, 1, 1] },
        },
      }).path,
    ).toBe('commands[0].node.transform.rotation');
    expect(bad({ type: 'node.delete', id: 'x', mode: 'subtree' }).code).toBe('UNKNOWN_ENTITY');
    expect(ws.getState().revision).toBe(0);
  });

  it('stores rotations within tolerance of unit length renormalized', () => {
    const ws = makeWorkspace();
    committed(
      ws.dispatch(
        window('a', {
          transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1 + 5e-7], scale: [1, 1, 1] },
        }),
      ),
    );
    expect(ws.getState().nodes.get('a')?.transform.rotation).toEqual([0, 0, 0, 1]);
  });

  it('rejects a duplicate ID, including one held by an archived node', () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('a'), { type: 'node.archive', id: 'a' }]));
    const result = rejected(ws.dispatch(window('a')));
    expect(result.error.code).toBe('INVALID_INPUT');
    expect(result.error.message).toMatch(/already in use/);
  });

  it('frees an ID only when its node is deleted', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('a')));
    committed(ws.dispatch({ type: 'node.delete', id: 'a', mode: 'subtree' }));
    committed(ws.dispatch(window('a')));
  });

  it('generates reproducible IDs and never reuses one in use', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('node-2')));
    const result = committed(
      ws.transaction([
        { type: 'node.create', node: { kind: 'window', bounds: [1, 1, 1] } },
        { type: 'node.create', node: { kind: 'window', bounds: [1, 1, 1] } },
      ]),
    );
    expect(result.createdIds).toEqual(['node-1', 'node-3']);
  });

  it('rejects a host ID generator that returns an ID in use', () => {
    const ws = makeWorkspace({ createId: () => 'same' });
    committed(ws.dispatch({ type: 'node.create', node: { kind: 'window', bounds: [1, 1, 1] } }));
    const result = rejected(
      ws.dispatch({ type: 'node.create', node: { kind: 'window', bounds: [1, 1, 1] } }),
    );
    expect(result.error.message).toMatch(/"same" is already in use/);
  });
});

describe('optimistic concurrency', () => {
  it('commits at the expected revision and rejects a stale one with CONFLICT', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('a'), { expectedRevision: 0 }));
    const stale = rejected(ws.dispatch(window('b'), { expectedRevision: 0 }));
    expect(stale.error.code).toBe('CONFLICT');
    expect(stale.error.retryable).toBe(true);
    expect(stale.error.details).toEqual({ currentRevision: 1 });
    expect(stale.revision).toBe(1);
    expect(ws.getState().nodes.has('b')).toBe(false);
  });

  it('rejects invalid options by name', () => {
    const ws = makeWorkspace();
    expect(rejected(ws.dispatch(window('a'), { expectedRevision: -1 })).error.path).toBe(
      'options.expectedRevision',
    );
    expect(rejected(ws.dispatch(window('a'), { retries: 3 } as never)).error.path).toBe(
      'options.retries',
    );
    expect(rejected(ws.dispatch(window('a'), { source: 'robot' } as never)).error.path).toBe(
      'options.source',
    );
  });
});

describe('idempotency keys', () => {
  it('returns the first result for a repeated key without applying again', () => {
    const ws = makeWorkspace();
    const first = committed(ws.dispatch(window('a'), { idempotencyKey: 'k1' }));
    const again = committed(ws.dispatch(window('a'), { idempotencyKey: 'k1' }));
    expect(again).toEqual({ ...first, replayed: true });
    expect(ws.getState().revision).toBe(1);
  });

  it('rejects a key reused for different commands', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('a'), { idempotencyKey: 'k1' }));
    const result = rejected(ws.dispatch(window('b'), { idempotencyKey: 'k1' }));
    expect(result.error.path).toBe('options.idempotencyKey');
    expect(ws.getState().nodes.has('b')).toBe(false);
  });

  it('does not remember rejected transactions, so a corrected retry with the key commits', () => {
    const ws = makeWorkspace();
    rejected(ws.dispatch(window('a', { bounds: [0, 1, 1] }), { idempotencyKey: 'k' }));
    committed(ws.dispatch(window('a', { bounds: [1, 1, 1] }), { idempotencyKey: 'k' }));
  });

  it('forgets the oldest keys beyond its capacity', () => {
    const ws = makeWorkspace({ idempotencyCapacity: 2 });
    committed(ws.dispatch(window('a'), { idempotencyKey: 'k1' }));
    committed(ws.dispatch(window('b'), { idempotencyKey: 'k2' }));
    committed(ws.dispatch(window('c'), { idempotencyKey: 'k3' }));
    // k1 is forgotten: the same request is applied again, and fails because "a" exists now.
    expect(rejected(ws.dispatch(window('a'), { idempotencyKey: 'k1' })).error.message).toMatch(
      /already in use/,
    );
    expect(committed(ws.dispatch(window('c'), { idempotencyKey: 'k3' })).replayed).toBe(true);
  });
});

describe('undo and redo', () => {
  it('undoes and redoes exactly one layout transaction at a time', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('a', { transform: at([0, 0, -3]) })));
    const placed = ws.getState().nodes.get('a');
    committed(ws.dispatch({ type: 'node.patch', id: 'a', transform: at([2, 0, -3]) }));
    const moved = ws.getState().nodes.get('a');

    const undo = committed(ws.undo());
    expect(undo.revision).toBe(3);
    expect(ws.getState().nodes.get('a')).toBe(placed);
    committed(ws.undo());
    expect(ws.getState().nodes.has('a')).toBe(false);
    expect(ws.getState().rootIds).toEqual([]);
    expect(ws.canUndo()).toBe(false);
    expect(rejected(ws.undo()).error.message).toMatch(/nothing to undo/);

    committed(ws.redo());
    expect(ws.getState().nodes.get('a')).toBe(placed);
    committed(ws.redo());
    expect(ws.getState().nodes.get('a')).toBe(moved);
    expect(ws.canRedo()).toBe(false);
  });

  it('clears redo on a new layout commit but not on a selection change', () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('a'), window('b')]));
    committed(ws.dispatch({ type: 'node.patch', id: 'a', label: 'A' }));
    committed(ws.undo());
    committed(ws.dispatch({ type: 'selection.set', ids: ['b'] }));
    expect(ws.canRedo()).toBe(true);
    committed(ws.dispatch({ type: 'node.patch', id: 'b', label: 'B' }));
    expect(ws.canRedo()).toBe(false);
  });

  it('keeps at most undoCapacity transactions, and none with capacity 0', () => {
    const bounded = makeWorkspace({ undoCapacity: 2 });
    for (const id of ['a', 'b', 'c']) {
      committed(bounded.dispatch(window(id)));
    }
    expect(bounded.history().map((h) => h.revision)).toEqual([2, 3]);
    const none = makeWorkspace({ undoCapacity: 0 });
    committed(none.dispatch(window('a')));
    expect(none.canUndo()).toBe(false);
  });

  it('records the history entry of each layout transaction', () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('a'), window('b')], { source: 'user' }));
    const [entry] = ws.history();
    expect(entry).toMatchObject({
      transactionId: 'ws/tx-1',
      source: 'user',
      previousRevision: 0,
      revision: 1,
      commandTypes: ['node.create', 'node.create'],
      changedNodeIds: ['a', 'b'],
    });
  });

  it('undoes a grouping as one step, restoring the hierarchy and world placement', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('a', { transform: at([1, 0, -3]) }),
        window('b', { transform: at([-1, 0, -3]) }),
      ]),
    );
    const before = ws.getState();
    committed(ws.dispatch({ type: 'node.group', nodeIds: ['a', 'b'], group: { id: 'g' } }));
    committed(ws.undo());
    const after = ws.getState();
    expect(after.rootIds).toEqual(before.rootIds);
    expect(after.nodes.get('a')).toBe(before.nodes.get('a'));
    expect(after.nodes.get('b')).toBe(before.nodes.get('b'));
    expect(after.nodes.has('g')).toBe(false);
  });

  it('drops undone nodes from the selection and focus', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('a')));
    committed(
      ws.transaction([
        { type: 'selection.set', ids: ['a'] },
        { type: 'focus.set', id: 'a' },
      ]),
    );
    committed(ws.undo());
    expect(ws.getState().selection).toEqual([]);
    expect(ws.getState().focusedId).toBeNull();
  });
});
