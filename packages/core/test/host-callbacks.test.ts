import { describe, expect, it } from 'vitest';
import type {
  Constraint,
  SceneCommand,
  TxOutcome,
  TxResult,
  Workspace,
  WorkspaceEvent,
  WorkspaceOptions,
} from '../src/index.js';
import { createWorkspace, SwfFailure } from '../src/index.js';
import { at, committed, record, rejected, window } from './helpers.js';

const unnamed: SceneCommand = {
  type: 'node.create',
  node: { kind: 'window', bounds: [1.6, 0.9, 0.01] },
};

const move = (id: string, x: number): SceneCommand => ({
  type: 'node.patch',
  id,
  transform: at([x, 0, -3]),
});

const accept: Constraint['resolve'] = (input) => ({ kind: 'accept', transform: input.transform });

const types = (events: readonly WorkspaceEvent[]) => events.map((e) => e.type);

/** A clock that ticks by one on every reading, and throws while `stopped` is set. */
function clock(name: string) {
  let tick = 1_000;
  const control = {
    stopped: false,
    read: () => {
      if (control.stopped) {
        throw new Error(`${name} stopped`);
      }
      return (tick += 1);
    },
  };
  return control;
}

function make(options: Partial<WorkspaceOptions>): Workspace {
  const now = clock('now');
  return createWorkspace({ id: 'ws', now: now.read, ...options });
}

/** The operation a listener queued, once the call it was made from has returned. */
function queuedOf(result: TxResult | undefined): Promise<TxOutcome> {
  if (result?.status !== 'queued') {
    throw new Error(`expected a queued operation, got ${JSON.stringify(result)}`);
  }
  return result.completion;
}

describe('a host callback that fails inside a transaction', () => {
  it('rejects a constraint whose appliesTo throws, naming it, and changes nothing', () => {
    const ws = make({
      constraints: [
        {
          id: 'picky',
          order: 0,
          required: true,
          appliesTo: () => {
            throw new Error('boom');
          },
          resolve: accept,
        },
      ],
    });
    const before = ws.getState();
    const events = record(ws);
    const { error } = rejected(ws.dispatch(window('a')));
    expect(error.code).toBe('CONSTRAINT_REJECTED');
    expect(error.message).toMatch(/constraint "picky".*"a".*its appliesTo threw: boom/);
    expect(error.details).toEqual({ constraintId: 'picky' });
    expect(ws.getState()).toBe(before);
    expect(types(events)).toEqual(['transaction.rejected']);
  });

  it('rejects a constraint whose appliesTo answers something other than a boolean', () => {
    const ws = make({
      constraints: [
        {
          id: 'vague',
          order: 0,
          required: false,
          appliesTo: () => 'yes' as never,
          resolve: accept,
        },
      ],
    });
    const { error } = rejected(ws.dispatch(window('a')));
    expect(error.code).toBe('CONSTRAINT_REJECTED');
    expect(error.message).toMatch(/"vague".*its appliesTo returned a string, not a boolean/);
  });

  it('names a resolve that throws, also while checking that the required constraints hold', () => {
    let calls = 0;
    const ws = make({
      constraints: [
        {
          id: 'flaky',
          order: 0,
          required: true,
          resolve: (input) => {
            calls += 1;
            if (calls > 1) {
              throw new Error('second look');
            }
            return accept(input);
          },
        },
      ],
    });
    const { error } = rejected(ws.dispatch(window('a')));
    expect(error.code).toBe('CONSTRAINT_REJECTED');
    expect(error.details).toEqual({ constraintId: 'flaky' });
    expect(error.message).toMatch(/"flaky".*its resolve threw: second look/);
    expect(ws.getState().nodes.has('a')).toBe(false);
  });

  it('rejects a resolve that returns something other than an outcome', () => {
    const ws = make({
      constraints: [{ id: 'mute', order: 0, required: false, resolve: () => undefined as never }],
    });
    const { error } = rejected(ws.dispatch(window('a')));
    expect(error.code).toBe('CONSTRAINT_REJECTED');
    expect(error.message).toMatch(/"mute".*its resolve returned undefined, not an outcome/);
  });

  it('rejects at the generated ID when createId throws, and changes nothing', () => {
    const ws = make({
      createId: () => {
        throw new Error('no ids left');
      },
    });
    const before = ws.getState();
    const events = record(ws);
    const { error } = rejected(ws.transaction([window('a'), unnamed]));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.path).toBe('commands[1].node.id (generated)');
    expect(error.message).toMatch(/createId threw: no ids left/);
    expect(ws.getState()).toBe(before);
    expect(types(events)).toEqual(['transaction.rejected']);
  });

  it('names a geometry validate or projection configIssue that answers neither null nor text', () => {
    const ws = make({
      geometry: [
        {
          kind: 'host.odd',
          fidelity: 'exact',
          validate: () => 42 as never,
          localBounds: () => ({ min: [0, 0, 0], max: [1, 1, 1] }),
          normal: () => null,
          intersect: () => null,
        },
      ],
    });
    committed(ws.dispatch(window('w')));
    const { error } = rejected(
      ws.dispatch({
        type: 'surface.attach',
        surface: {
          id: 's',
          ownerNodeId: 'w',
          bindingKey: 'key-s',
          adapterTypeId: 'host.view/1',
          bounds: [1.6, 0.9, 0.01],
          geometry: { kind: 'host.odd', params: null },
        },
      }),
    );
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toMatch(/geometry provider "host\.odd": its validate returned 42/);
  });

  it('rejects any operation whose clock throws, sending nothing and changing nothing', () => {
    const now = clock('now');
    const ws = createWorkspace({ id: 'ws', now: now.read });
    committed(ws.dispatch(window('a')));
    const snapshot = ws.serialize();
    const before = ws.getState();
    const events = record(ws);
    now.stopped = true;
    for (const result of [
      ws.dispatch(window('b')),
      ws.undo(),
      ws.restore(snapshot),
      ws.preview('drag', [move('a', 1)]),
    ]) {
      const { error } = rejected(result as TxResult);
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.path).toBe('options.now');
      expect(error.message).toMatch(/the workspace's now clock threw: now stopped/);
    }
    expect(ws.getState()).toBe(before);
    expect(ws.getPreview('drag')).toBeUndefined();
    expect(events).toEqual([]);
    now.stopped = false;
    committed(ws.dispatch(window('b')));
  });

  it('rejects a commit whose timer fails as it finishes, before anything changes', () => {
    const timer = clock('timer');
    let reads = 0;
    const ws = make({
      timer: () => {
        reads += 1;
        // The second reading is the one that times the commit.
        timer.stopped = reads === 2;
        return timer.read();
      },
    });
    const before = ws.getState();
    const { error } = rejected(ws.dispatch(window('a')));
    expect(error.path).toBe('options.timer');
    expect(error.message).toMatch(/the workspace's timer clock threw: timer stopped/);
    expect(ws.getState()).toBe(before);
  });

  it('rejects a clock that reads as something other than a finite number', () => {
    const ws = createWorkspace({ id: 'ws', now: () => NaN });
    const { error } = rejected(ws.dispatch(window('a')));
    expect(error.path).toBe('options.now');
    expect(error.message).toMatch(/the workspace's now clock returned NaN, not a finite number/);
  });

  it('delivers held previews at once when frameBoundary throws, and says so', () => {
    const ws = make({
      frameBoundary: () => {
        throw new Error('no frames');
      },
    });
    committed(ws.transaction([window('a'), window('b')]));
    const events = record(ws);
    expect(ws.preview('drag', [move('a', 1)]).status).toBe('previewed');
    expect(types(events)).toEqual(['transform.preview']);
    // A commit that re-applies an open preview still commits.
    committed(ws.dispatch(move('b', 2)));
    expect(types(events)).toEqual([
      'transform.preview',
      'node.transformCommitted',
      'transaction.committed',
      'transform.preview',
    ]);
    const diagnostics = ws.getDiagnostics();
    expect(diagnostics.map((d) => d.code)).toEqual([
      'FRAME_BOUNDARY_THREW',
      'FRAME_BOUNDARY_THREW',
    ]);
    expect(diagnostics[0]?.message).toMatch(/frameBoundary threw: no frames/);
    expect(diagnostics[0]?.timestamp).toBe(events[0]?.timestamp);
  });

  it('stamps every event of one operation, and its diagnostics, with one reading of the clock', () => {
    const now = clock('now');
    const ws = createWorkspace({ id: 'ws', now: now.read });
    ws.subscribe((event) => {
      if (event.type === 'transaction.committed') {
        // The clock fails from here on; the operation has already read it.
        now.stopped = true;
        throw new Error('listener');
      }
    });
    const events = record(ws);
    committed(ws.transaction([window('a'), window('b')]));
    expect(types(events)).toContain('node.created');
    expect(types(events).at(-1)).toBe('transaction.committed');
    expect(new Set(events.map((e) => e.timestamp)).size).toBe(1);
    const [diagnostic] = ws.getDiagnostics();
    expect(diagnostic?.code).toBe('LISTENER_THREW');
    expect(diagnostic?.timestamp).toBe(events.at(-1)?.timestamp);
  });

  it('presents open previews without calling host code again after a preview is cancelled', () => {
    let refuse = false;
    const ws = make({
      constraints: [
        {
          id: 'moody',
          order: 0,
          required: true,
          appliesTo: () => {
            if (refuse) {
              throw new Error('moody');
            }
            return true;
          },
          resolve: accept,
        },
      ],
    });
    committed(ws.transaction([window('a'), window('b')]));
    ws.preview('drag-a', [move('a', 1)]);
    ws.preview('drag-b', [move('b', 1)]);
    ws.cancelPreview('drag-a', 'escape');
    refuse = true;
    expect(ws.getPresented().nodes.get('b')?.transform.position).toEqual([1, 0, -3]);
  });

  it('refuses disposal while the clock fails, leaving the workspace ready', async () => {
    const now = clock('now');
    const ws = createWorkspace({ id: 'ws', now: now.read });
    committed(ws.dispatch(window('a')));
    now.stopped = true;
    const failed = ws.dispose();
    await expect(failed).rejects.toBeInstanceOf(SwfFailure);
    await expect(failed).rejects.toMatchObject({
      error: { code: 'INVALID_INPUT', path: 'options.now' },
    });
    expect(ws.lifecycle).toBe('ready');
    now.stopped = false;
    const events = record(ws);
    await ws.dispose();
    expect(ws.lifecycle).toBe('disposed');
    expect(types(events)).toEqual(['workspace.disposed']);
  });
});

describe('an operation a listener queues', () => {
  it('settles with the rejection when a host callback throws, and the queue drains on', async () => {
    const ws = make({
      createId: () => {
        throw new Error('no ids left');
      },
    });
    let first: TxResult | undefined;
    let second: TxResult | undefined;
    ws.subscribe((event) => {
      if (event.type === 'transaction.committed' && first === undefined) {
        first = ws.dispatch(unnamed);
        second = ws.dispatch(window('b'));
      }
    });
    committed(ws.dispatch(window('a')));
    const failed = rejected(await queuedOf(first));
    expect(failed.error.message).toMatch(/createId threw: no ids left/);
    committed(await queuedOf(second));
    expect([...ws.getState().nodes.ids()].sort()).toEqual(['a', 'b']);
  });

  it('rejects its completion with what it threw, and the queue drains on', async () => {
    const ws = make({});
    const hostile = {
      get type(): never {
        throw new Error('unreadable command');
      },
    } as unknown as SceneCommand;
    let first: TxResult | undefined;
    let second: TxResult | undefined;
    ws.subscribe((event) => {
      if (event.type === 'transaction.committed' && first === undefined) {
        first = ws.dispatch(hostile);
        second = ws.dispatch(window('b'));
      }
    });
    committed(ws.dispatch(window('a')));
    await expect(queuedOf(first)).rejects.toThrow('unreadable command');
    committed(await queuedOf(second));
  });

  it('rejects its completion with an Error carrying a thrown non-Error as its cause', async () => {
    const ws = make({});
    const hostile = {
      get type(): never {
        // Host code may throw a value that is not an Error.
        throw Object.freeze({ reason: 'bare' }) as unknown as Error;
      },
    } as unknown as SceneCommand;
    let queued: TxResult | undefined;
    ws.subscribe((event) => {
      if (event.type === 'transaction.committed' && queued === undefined) {
        queued = ws.dispatch(hostile);
      }
    });
    committed(ws.dispatch(window('a')));
    await expect(queuedOf(queued)).rejects.toMatchObject({
      message: 'the operation threw an object',
      cause: { reason: 'bare' },
    });
  });
});
