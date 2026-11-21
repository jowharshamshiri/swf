import { describe, expect, it } from 'vitest';
import type { SceneCommand, WorkspaceEvent } from '../src/index.js';
import { at, committed, makeWorkspace, record, window } from './helpers.js';

const move = (id: string, x: number): SceneCommand => ({
  type: 'node.patch',
  id,
  transform: at([x, 0, -3]),
});

const types = (events: readonly WorkspaceEvent[]) => events.map((e) => e.type);

describe('frame-boundary coalescing (FR-143, NFR-009)', () => {
  function coalescing() {
    const boundaries: (() => void)[] = [];
    const ws = makeWorkspace({ frameBoundary: (flush) => boundaries.push(flush) });
    committed(ws.transaction([window('a'), window('b')]));
    const events = record(ws);
    return { ws, events, boundaries };
  }

  it('holds preview events until the frame boundary, then delivers the latest of each once', () => {
    const { ws, events, boundaries } = coalescing();
    for (let x = 0; x < 50; x++) {
      ws.preview('drag-a', [move('a', x)], { source: 'user' });
    }
    ws.preview('drag-b', [move('b', 1)], { source: 'user' });
    expect(events).toEqual([]);
    // One boundary is asked for, however many events wait.
    expect(boundaries).toHaveLength(1);
    boundaries.shift()?.();
    expect(events.map((e) => e.type === 'transform.preview' && e.payload.previewId)).toEqual([
      'drag-a',
      'drag-b',
    ]);
    expect(events[0]?.payload).toEqual({
      previewId: 'drag-a',
      changedNodeIds: ['a'],
      changedSurfaceIds: [],
    });
    // The preview itself is current at once; only its notification waits.
    expect(ws.getPreview('drag-a')?.nodes.get('a')?.transform.position).toEqual([49, 0, -3]);
    // Nothing more is held, and the next preview asks for the next boundary.
    ws.preview('drag-a', [move('a', 60)], { source: 'user' });
    expect(boundaries).toHaveLength(1);
  });

  it('merges what each held preview changed since it was last delivered', () => {
    const { ws, events, boundaries } = coalescing();
    ws.preview('p', [move('a', 1)], { source: 'user' });
    ws.preview('p', [move('b', 1)], { source: 'user' });
    boundaries.shift()?.();
    expect(events[0]?.payload).toEqual({
      previewId: 'p',
      changedNodeIds: ['a', 'b'],
      changedSurfaceIds: [],
    });
  });

  it('never drops or reorders a lifecycle event: held previews go out before it', () => {
    const { ws, events, boundaries } = coalescing();
    ws.preview('drag-a', [move('a', 2)], { source: 'user' });
    ws.preview('drag-b', [move('b', 2)], { source: 'user' });
    committed(ws.transaction([move('a', 2)], { previewId: 'drag-a', source: 'user' }));
    expect(types(events)).toEqual([
      'transform.preview',
      'transform.preview',
      'node.transformCommitted',
      'transaction.committed',
      // The other preview is re-applied to the new revision and held again.
    ]);
    events.length = 0;
    ws.cancelPreview('drag-b', 'escape');
    expect(types(events)).toEqual(['transform.preview', 'preview.cancelled']);
    // A boundary that comes after everything went out delivers nothing.
    events.length = 0;
    for (const flush of boundaries.splice(0)) {
      flush();
    }
    expect(events).toEqual([]);
  });

  it('delivers every event as it happens without a frame boundary', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('a')));
    const events = record(ws);
    ws.preview('p', [move('a', 1)], { source: 'user' });
    ws.preview('p', [move('a', 2)], { source: 'user' });
    expect(types(events)).toEqual(['transform.preview', 'transform.preview']);
  });

  it('refuses a frame boundary that is not a function', () => {
    expect(() => makeWorkspace({ frameBoundary: 1 as never })).toThrow(/frameBoundary/);
  });
});

describe('the presented scene', () => {
  it('shows every open preview at once, in the order they were opened', () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('a'), window('b')]));
    expect(ws.getPresented()).toBe(ws.getState());
    ws.preview('drag-a', [move('a', 1)], { source: 'user' });
    ws.preview('drag-b', [move('b', 2)], { source: 'user' });
    ws.preview('nudge-a', [move('a', 3)], { source: 'user' });
    const presented = ws.getPresented();
    expect(presented.nodes.get('a')?.transform.position).toEqual([3, 0, -3]);
    expect(presented.nodes.get('b')?.transform.position).toEqual([2, 0, -3]);
    expect(presented.revision).toBe(ws.getState().revision);
    expect(ws.getState().nodes.get('a')?.transform.position).toEqual([0, 0, 0]);
    // The same answer until something changes.
    expect(ws.getPresented()).toBe(presented);
    expect(ws.presentedGeometry('a')).toBeUndefined();
    ws.cancelPreview('drag-b', 'host');
    expect(ws.getPresented().nodes.get('b')?.transform.position).toEqual([0, 0, 0]);
  });

  it('places surfaces as presented', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('a'),
        {
          type: 'surface.attach',
          surface: {
            id: 's',
            ownerNodeId: 'a',
            bindingKey: 'k',
            adapterTypeId: 'host.view/1',
            bounds: [1, 1, 0.01],
          },
        },
      ]),
    );
    ws.preview('drag', [move('a', 5)], { source: 'user' });
    expect(ws.presentedGeometry('s')?.world[12]).toBe(5);
    expect(ws.surfaceGeometry('s')?.world[12]).toBe(0);
  });

  it('refuses a preview that cannot join the open ones, keeping them as they were', () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('a'), window('b')]));
    ws.preview('remove', [{ type: 'node.delete', id: 'a', mode: 'subtree' }], { source: 'user' });
    // On its own the move applies; after the removal it cannot.
    const refused = ws.preview('move', [move('a', 1)], { source: 'user' });
    expect(refused.status === 'rejected' && refused.error.code).toBe('UNKNOWN_ENTITY');
    expect(ws.getPreview('move')).toBeUndefined();
    expect(ws.getPresented().nodes.has('a')).toBe(false);
    // A refused update of an open preview keeps its last valid version.
    ws.preview('nudge', [move('b', 1)], { source: 'user' });
    expect(ws.preview('nudge', [move('a', 2)], { source: 'user' }).status).toBe('rejected');
    expect(ws.getPresented().nodes.get('b')?.transform.position).toEqual([1, 0, -3]);
  });

  it('drops the newest preview when a commit leaves the open ones unable to apply together', () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('w'), window('v')]));
    ws.preview('remove-w', [{ type: 'node.delete', id: 'w', mode: 'subtree' }], { source: 'user' });
    ws.preview('move-v', [move('v', 4)], { source: 'user' });
    const events = record(ws);
    // Each still applies alone, but removing w now removes v too.
    committed(ws.dispatch({ type: 'node.reparent', id: 'v', parentId: 'w' }));
    const cancelled = events.filter((e) => e.type === 'preview.cancelled');
    expect(cancelled.map((e) => e.payload)).toEqual([
      { previewId: 'move-v', reason: 'invalidated' },
    ]);
    expect(ws.getPreview('remove-w')).toBeDefined();
    expect(ws.getPresented().nodes.has('w')).toBe(false);
  });
});
