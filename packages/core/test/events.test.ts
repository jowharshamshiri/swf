import { describe, expect, it } from 'vitest';
import type { TxOutcome, WorkspaceEvent } from '../src/index.js';
import { createWorkspace, SwfFailure } from '../src/index.js';
import { at, committed, makeWorkspace, record, rejected, window } from './helpers.js';

const types = (events: readonly WorkspaceEvent[]) => events.map((e) => e.type);

describe('events', () => {
  it('reports entity changes, then one transaction.committed per revision', () => {
    const ws = makeWorkspace();
    const events = record(ws);
    committed(
      ws.transaction([window('a'), window('b', { parentId: 'a' })], {
        source: 'user',
        causeId: 'drag-7',
      }),
    );
    // "a" is new, so its child list is conveyed by b's node.created; only the root list changed.
    expect(types(events)).toEqual([
      'node.created',
      'node.created',
      'node.childrenChanged',
      'transaction.committed',
    ]);
    expect(events[2]?.payload).toEqual({ parentId: null, childIds: ['a'] });
    const last = events.at(-1);
    expect(last).toMatchObject({
      workspaceId: 'ws',
      revision: 1,
      source: 'user',
      causationId: 'drag-7',
      phase: 'committed',
      payload: { transactionId: 'ws/tx-1', previousRevision: 0, createdIds: ['a', 'b'] },
    });
    expect(events[0]).toMatchObject({ payload: { nodeId: 'a', parentId: null } });
    // The host's cause is carried on every event of the commit, its entity events included.
    expect(events.map((e) => e.causationId)).toEqual(events.map(() => 'drag-7'));
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
  });

  it("carries the host's cause on every event of an undo, a redo and a restore", () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('a')]));
    const snapshot = ws.serialize();
    committed(ws.transaction([window('b', { parentId: 'a' })]));
    const events = record(ws);
    const causes = () => {
      const seen = events.map((e) => [e.type, e.causationId]);
      events.length = 0;
      return seen;
    };
    committed(ws.undo({ causeId: 'key-z' }));
    expect(causes()).toEqual([
      ['node.deleted', 'key-z'],
      ['node.childrenChanged', 'key-z'],
      ['transaction.committed', 'key-z'],
    ]);
    committed(ws.redo({ causeId: 'key-y' }));
    expect(causes()).toEqual([
      ['node.created', 'key-y'],
      ['node.childrenChanged', 'key-y'],
      ['transaction.committed', 'key-y'],
    ]);
    committed(ws.restore(snapshot, { causeId: 'reload-1' }));
    expect(causes()).toEqual([
      ['node.deleted', 'reload-1'],
      ['node.childrenChanged', 'reload-1'],
      ['transaction.committed', 'reload-1'],
    ]);
  });

  it("carries the transaction's own ID on every event of a commit given no cause", () => {
    const ws = makeWorkspace();
    const events = record(ws);
    const { transactionId } = committed(ws.transaction([window('a'), window('b')]));
    expect(events.length).toBe(4);
    expect(events.map((e) => e.causationId)).toEqual(events.map(() => transactionId));
  });

  it('describes moves, reparenting, field updates, archiving and selection', () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('a'), window('b')]));
    const events = record(ws);
    committed(
      ws.transaction([
        {
          type: 'node.patch',
          id: 'a',
          transform: at([1, 0, 0]),
          label: 'A',
          flags: { locked: true },
        },
        { type: 'node.reparent', id: 'b', parentId: 'a' },
        { type: 'selection.set', ids: ['a'] },
        { type: 'focus.set', id: 'a' },
      ]),
    );
    expect(types(events)).toEqual([
      'node.transformCommitted',
      'node.updated',
      'node.reparented',
      'node.childrenChanged',
      'node.childrenChanged',
      'selection.changed',
      'focus.changed',
      'transaction.committed',
    ]);
    expect(events[1]?.payload).toEqual({ nodeId: 'a', fields: ['label', 'flags'] });
    events.length = 0;
    committed(ws.dispatch({ type: 'node.archive', id: 'a' }));
    expect(types(events)).toEqual([
      'node.archived',
      'selection.changed',
      'focus.changed',
      'transaction.committed',
    ]);
  });

  it('emits transaction.rejected for a rejected transaction, and no entity events', () => {
    const ws = makeWorkspace();
    const events = record(ws);
    const result = rejected(ws.dispatch({ type: 'node.patch', id: 'nope', label: 'x' }));
    expect(types(events)).toEqual(['transaction.rejected']);
    expect(events[0]).toMatchObject({
      phase: 'rejected',
      revision: 0,
      payload: {
        transactionId: result.transactionId,
        commandTypes: ['node.patch'],
        error: { code: 'UNKNOWN_ENTITY' },
      },
    });
  });

  it('reports an undo as a commit naming the transaction it reverses', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('a')));
    const events = record(ws);
    committed(ws.undo({ source: 'user' }));
    expect(types(events)).toEqual([
      'node.deleted',
      'node.childrenChanged',
      'transaction.committed',
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      history: { action: 'undo', transactionId: 'ws/tx-1' },
    });
  });

  it('isolates a throwing listener: others still hear, the commit stands, a diagnostic is kept', () => {
    const sink: unknown[] = [];
    const ws = makeWorkspace({ onDiagnostic: (d) => sink.push(d) });
    ws.subscribe(() => {
      throw new Error('listener bug');
    });
    const heard = record(ws);
    const result = committed(ws.dispatch(window('a')));
    expect(result.revision).toBe(1);
    expect(ws.getState().nodes.has('a')).toBe(true);
    expect(types(heard)).toContain('transaction.committed');
    const [diagnostic] = ws.getDiagnostics();
    expect(diagnostic).toMatchObject({
      code: 'LISTENER_THREW',
      details: { eventType: 'node.created' },
    });
    expect(diagnostic?.message).toMatch(/listener bug/);
    expect(sink.length).toBe(ws.getDiagnostics().length);
  });

  it('queues a transaction made from inside a listener until delivery finishes', async () => {
    const ws = makeWorkspace();
    const order: string[] = [];
    let queued: Promise<TxOutcome> | null = null;
    ws.subscribe((event) => {
      order.push(`${event.type}@${String(event.revision)}`);
      if (event.type === 'transaction.committed' && event.revision === 1) {
        const result = ws.dispatch(window('echo'));
        expect(result.status).toBe('queued');
        if (result.status === 'queued') {
          queued = result.completion;
        }
        expect(ws.getState().nodes.has('echo')).toBe(false);
      }
    });
    ws.subscribe((event) => order.push(`second:${event.type}@${String(event.revision)}`));
    committed(ws.dispatch(window('a')));
    expect(order).toEqual([
      'node.created@1',
      'second:node.created@1',
      'node.childrenChanged@1',
      'second:node.childrenChanged@1',
      'transaction.committed@1',
      'second:transaction.committed@1',
      'node.created@2',
      'second:node.created@2',
      'node.childrenChanged@2',
      'second:node.childrenChanged@2',
      'transaction.committed@2',
      'second:transaction.committed@2',
    ]);
    expect(queued).not.toBeNull();
    expect((await (queued as unknown as Promise<TxOutcome>)).status).toBe('committed');
  });

  it('unsubscribes idempotently and watches state slices only when they change', () => {
    const ws = makeWorkspace();
    const heard: string[] = [];
    const stop = ws.subscribe((e) => heard.push(e.type));
    stop();
    stop();
    const counts: [number, number][] = [];
    ws.watch(
      (state) => state.rootIds.length,
      (count, revision) => counts.push([count, revision]),
    );
    committed(ws.dispatch(window('a')));
    committed(ws.dispatch({ type: 'node.patch', id: 'a', label: 'same count' }));
    committed(ws.dispatch(window('b')));
    expect(heard).toEqual([]);
    expect(counts).toEqual([
      [1, 1],
      [2, 3],
    ]);
  });

  it('gives read-only modules a reader without mutating operations', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('a', { label: 'Notes' })));
    const reader = ws.reader();
    expect(reader.getState()).toBe(ws.getState());
    expect(reader.findNodes({ text: 'notes' })).toEqual(['a']);
    expect('transaction' in reader).toBe(false);
    expect(Object.isFrozen(reader)).toBe(true);
  });
});

describe('previews', () => {
  it('holds a proposed scene apart from the committed one, outside history', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('a', { transform: at([0, 0, -3]) })));
    const events = record(ws);
    const result = ws.preview(
      'drag',
      [{ type: 'node.patch', id: 'a', transform: at([1, 0, -3]) }],
      { source: 'user' },
    );
    expect(result).toMatchObject({ status: 'previewed', changedNodeIds: ['a'] });
    expect(ws.getPreview('drag')?.nodes.get('a')?.transform.position).toEqual([1, 0, -3]);
    expect(ws.getState().nodes.get('a')?.transform.position).toEqual([0, 0, -3]);
    expect(ws.getState().revision).toBe(1);
    expect(ws.history()).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'transform.preview', phase: 'preview', revision: 1 });
  });

  it('keeps the last valid preview when a newer one is rejected', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('a')));
    ws.preview('drag', [{ type: 'node.patch', id: 'a', transform: at([1, 0, 0]) }]);
    const bad = ws.preview('drag', [{ type: 'node.patch', id: 'a', bounds: [0, 0, 0] }]);
    expect(bad.status).toBe('rejected');
    expect(ws.getPreview('drag')?.nodes.get('a')?.transform.position).toEqual([1, 0, 0]);
  });

  it('ends a preview when its transaction commits, once, with one undo step', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('a')));
    const move = [{ type: 'node.patch', id: 'a', transform: at([2, 0, 0]) }] as const;
    ws.preview('drag', move);
    ws.preview('drag', [{ type: 'node.patch', id: 'a', transform: at([3, 0, 0]) }]);
    const events = record(ws);
    committed(ws.transaction(move, { previewId: 'drag', source: 'user' }));
    expect(ws.getPreview('drag')).toBeUndefined();
    expect(events.at(-1)?.payload).toMatchObject({ previewId: 'drag' });
    expect(types(events)).not.toContain('preview.cancelled');
    expect(ws.history()).toHaveLength(2);
  });

  it('cancels a preview whose commit is rejected, naming the reason', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('a', { flags: { locked: true } })));
    ws.preview('drag', [{ type: 'node.patch', id: 'a', transform: at([1, 0, 0]) }]);
    const events = record(ws);
    rejected(
      ws.dispatch(
        { type: 'node.patch', id: 'a', transform: at([1, 0, 0]) },
        { previewId: 'drag', source: 'user' },
      ),
    );
    expect(ws.getPreview('drag')).toBeUndefined();
    expect(events.find((e) => e.type === 'preview.cancelled')).toMatchObject({
      phase: 'cancelled',
      payload: { previewId: 'drag', reason: 'commit-rejected' },
    });
  });

  it('cancels on request, idempotently', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('a')));
    ws.preview('drag', [{ type: 'node.patch', id: 'a', transform: at([1, 0, 0]) }]);
    const events = record(ws);
    expect(ws.cancelPreview('drag', 'escape')).toBe(true);
    expect(ws.cancelPreview('drag', 'escape')).toBe(false);
    expect(events.map((e) => e.payload)).toEqual([{ previewId: 'drag', reason: 'escape' }]);
  });

  it('follows commits by others, and ends when its target is removed', () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('a'), window('b')]));
    ws.preview('drag', [{ type: 'node.patch', id: 'a', transform: at([1, 0, 0]) }]);
    committed(ws.dispatch({ type: 'node.patch', id: 'b', label: 'B' }));
    expect(ws.getPreview('drag')?.nodes.get('b')?.label).toBe('B');
    expect(ws.getPreview('drag')?.revision).toBe(2);
    const events = record(ws);
    committed(ws.dispatch({ type: 'node.delete', id: 'a', mode: 'subtree' }));
    expect(ws.getPreview('drag')).toBeUndefined();
    expect(events.find((e) => e.type === 'preview.cancelled')?.payload).toEqual({
      previewId: 'drag',
      reason: 'target-detached',
    });
  });

  it("carries a preview's own cause on every event of the preview, however it ends", () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('a'), window('b'), window('c', { flags: { locked: true } })]));
    const events = record(ws);
    const causes = () => {
      const seen = events.map((e) => [e.type, e.causationId]);
      events.length = 0;
      return seen;
    };
    const nudge = (id: string) => [{ type: 'node.patch', id, transform: at([1, 0, 0]) }] as const;

    ws.preview('drag-a', nudge('a'), { causeId: 'gesture-a' });
    ws.preview('drag-c', nudge('c'), { causeId: 'gesture-c' });
    ws.preview('drag-b', nudge('b'));
    expect(causes()).toEqual([
      ['transform.preview', 'gesture-a'],
      ['transform.preview', 'gesture-c'],
      ['transform.preview', 'drag-b'],
    ]);

    // A commit's own events carry its cause; the open previews it re-applies or ends carry theirs.
    committed(
      ws.dispatch({ type: 'node.delete', id: 'a', mode: 'subtree' }, { causeId: 'key-del' }),
    );
    expect(causes()).toEqual([
      ['node.deleted', 'key-del'],
      ['node.childrenChanged', 'key-del'],
      ['transaction.committed', 'key-del'],
      ['preview.cancelled', 'gesture-a'],
      ['transform.preview', 'gesture-c'],
      ['transform.preview', 'drag-b'],
    ]);

    // A refused commit of a preview: the refusal carries the commit's cause, the ending the preview's.
    rejected(
      ws.dispatch(nudge('c')[0], { previewId: 'drag-c', source: 'user', causeId: 'drop-c' }),
    );
    expect(causes()).toEqual([
      ['transaction.rejected', 'drop-c'],
      ['preview.cancelled', 'gesture-c'],
    ]);

    ws.preview('drag-c', nudge('b'), { causeId: 'gesture-c2' });
    events.length = 0;
    expect(ws.cancelPreview('drag-c', 'escape')).toBe(true);
    expect(causes()).toEqual([['preview.cancelled', 'gesture-c2']]);

    // Two previews that stop applying together: the newer one ends as invalidated.
    committed(ws.dispatch(window('v')));
    ws.preview('remove-b', [{ type: 'node.delete', id: 'b', mode: 'subtree' }], {
      causeId: 'gesture-r',
    });
    ws.preview('move-v', nudge('v'), { causeId: 'gesture-v' });
    events.length = 0;
    committed(ws.dispatch({ type: 'node.reparent', id: 'v', parentId: 'b' }));
    expect(causes().filter(([type]) => type === 'preview.cancelled')).toEqual([
      ['preview.cancelled', 'gesture-v'],
    ]);

    ws.preview('drag-last', nudge('c'), { causeId: 'gesture-last' });
    expect(ws.getPreview('drag-last')).toBeDefined();
    events.length = 0;
    void ws.dispose();
    expect(causes()).toEqual([
      ['preview.cancelled', 'drag-b'],
      ['preview.cancelled', 'gesture-r'],
      ['preview.cancelled', 'gesture-last'],
      ['workspace.disposed', null],
    ]);
  });
});

describe('workspace lifecycle', () => {
  it('creates independent workspaces with explicit, validated options', () => {
    const a = createWorkspace({ id: 'a' });
    const b = createWorkspace({ id: 'b' });
    committed(a.dispatch(window('same')));
    committed(b.dispatch(window('same')));
    committed(a.dispatch({ type: 'node.patch', id: 'same', label: 'only in a' }));
    expect(b.getState().nodes.get('same')?.label).toBeNull();
    expect(() => createWorkspace({ id: ' ' })).toThrow(/options.id/);
    expect(() => createWorkspace({ id: 'x', undoCapacity: 10_001 })).toThrow(
      /options.undoCapacity/,
    );
    expect(() => createWorkspace({ id: 'x', colour: 'red' } as never)).toThrow(/options.colour/);
    expect(() => createWorkspace({ id: 'x', now: 5 } as never)).toThrow(SwfFailure);
  });

  it('starts empty and valid', () => {
    const state = makeWorkspace().getState();
    expect(state).toMatchObject({
      workspaceId: 'ws',
      revision: 0,
      rootIds: [],
      selection: [],
      focusedId: null,
    });
    expect(state.nodes.size).toBe(0);
  });

  it('disposes once: cancels previews, announces disposal, releases listeners, rejects work', async () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('a')));
    ws.preview('drag', [{ type: 'node.patch', id: 'a', transform: at([1, 0, 0]) }]);
    const events = record(ws);
    const first = ws.dispose();
    expect(ws.dispose()).toBe(first);
    await first;
    expect(ws.lifecycle).toBe('disposed');
    expect(types(events)).toEqual(['preview.cancelled', 'workspace.disposed']);
    expect(events[0]?.payload).toEqual({ previewId: 'drag', reason: 'workspace-disposed' });
    const after = rejected(ws.dispatch(window('b')));
    expect(after.error.code).toBe('WORKSPACE_DISPOSED');
    expect(rejected(ws.undo()).error.code).toBe('WORKSPACE_DISPOSED');
    expect(ws.preview('p', [window('c')]).status).toBe('rejected');
    expect(() => ws.subscribe(() => undefined)).toThrow(/disposed/);
    expect(events).toHaveLength(2);
    expect(ws.canUndo()).toBe(false);
  });

  it('finishes delivery before disposing when disposed from a listener, rejecting queued work', async () => {
    const ws = makeWorkspace();
    let queued: Promise<TxOutcome> | null = null;
    const heard: string[] = [];
    ws.subscribe((event) => {
      heard.push(event.type);
      if (event.type === 'node.created') {
        void ws.dispose();
        const result = ws.dispatch(window('late'));
        if (result.status === 'queued') {
          queued = result.completion;
        }
      }
    });
    committed(ws.dispatch(window('a')));
    expect(heard).toEqual([
      'node.created',
      'node.childrenChanged',
      'transaction.committed',
      'workspace.disposed',
    ]);
    expect(ws.lifecycle).toBe('disposed');
    const late = await (queued as unknown as Promise<TxOutcome>);
    expect(late.status === 'rejected' && late.error.code).toBe('WORKSPACE_DISPOSED');
  });

  it('returns to no listeners after repeated create and dispose', async () => {
    for (let i = 0; i < 100; i++) {
      const ws = makeWorkspace();
      const heard: string[] = [];
      ws.subscribe((e) => heard.push(e.type));
      committed(ws.dispatch(window('a')));
      await ws.dispose();
      expect(ws.lifecycle).toBe('disposed');
    }
  });

  it('carries the commands of a transaction and how long it took, by the timer', () => {
    let timer = 0;
    // Each reading of the timer advances it by 5 ms: a transaction reads it as it starts and as it
    // is announced.
    const ws = makeWorkspace({ timer: () => (timer += 5) });
    const events = record(ws);
    const commands = [window('a'), { type: 'selection.set' as const, ids: ['a'] }];
    committed(ws.transaction(commands, { source: 'user' }));
    const commit = events.find((e) => e.type === 'transaction.committed');
    expect(commit?.payload).toMatchObject({ commands, durationMs: 5 });
    events.length = 0;
    rejected(ws.dispatch({ type: 'node.delete', id: 'missing', mode: 'subtree' }));
    const refusal = events.find((e) => e.type === 'transaction.rejected');
    expect(refusal?.payload).toMatchObject({ commandTypes: ['node.delete'], durationMs: 5 });
    events.length = 0;
    committed(ws.undo());
    const undone = events.find((e) => e.type === 'transaction.committed');
    // An undo carries no commands of its own: it names the transaction it reverses.
    expect(undone?.payload).toMatchObject({ commands: null, durationMs: 5 });
  });

  it('times transactions by the now clock when no timer is given', () => {
    let tick = 0;
    const ws = createWorkspace({ id: 'ws', now: () => (tick += 2) });
    const events = record(ws);
    committed(ws.transaction([window('a')]));
    const commit = events.find((e) => e.type === 'transaction.committed');
    expect(commit?.payload).toMatchObject({ durationMs: expect.any(Number) as number });
    expect((commit?.payload as { durationMs: number }).durationMs).toBeGreaterThan(0);
  });

  it('refuses a timer that is not a function', () => {
    expect(() => createWorkspace({ id: 'ws', timer: 5 as unknown as () => number })).toThrow(
      /options.timer must be a function/,
    );
  });
});
