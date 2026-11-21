import { SwfFailure } from '@swf/core';
import { describe, expect, it } from 'vitest';
import type { SaveRequest, SaveState, SnapshotStore } from '../src/index.js';
import { createMemoryStore, createSaver, utf8Length } from '../src/index.js';
import { commit, layout, persistenceOf } from './fixtures.js';

const request = (over: Partial<SaveRequest> = {}): SaveRequest => ({
  key: 'main',
  document: '{"x":1}',
  revision: 1,
  expectedRevision: null,
  ...over,
});

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SwfFailure) {
      return error.error;
    }
    throw error;
  }
  throw new Error('it succeeded');
}

describe('the in-memory store (FR-164, SEC-017)', () => {
  it('saves, loads, lists and deletes, acknowledging exactly what it stored', async () => {
    const store = createMemoryStore({ now: () => 7 });
    expect(store.guarantees).toEqual({ atomic: true, compareAndSwap: true });
    expect(await store.load('main')).toBeNull();
    const document = '{"label":"é"}';
    const ack = await store.save(request({ document }));
    expect(ack).toEqual({ key: 'main', revision: 1, savedAt: 7, bytes: utf8Length(document) });
    expect(utf8Length(document)).toBe(14);
    expect(await store.load('main')).toEqual({ ...ack, document });
    await store.save(request({ key: 'other', revision: 3 }));
    expect((await store.list()).map((e) => [e.key, e.revision])).toEqual([
      ['main', 1],
      ['other', 3],
    ]);
    expect(await store.delete('other')).toBe(true);
    expect(await store.delete('other')).toBe(false);
    expect((await store.list()).map((e) => e.key)).toEqual(['main']);
  });

  it('compares and swaps: a stale expectation or an older revision is refused, the stored one kept', async () => {
    const store = createMemoryStore();
    await store.save(request({ revision: 5 }));
    expect(
      await rejection(store.save(request({ revision: 6, expectedRevision: null }))),
    ).toMatchObject({
      code: 'CONFLICT',
      details: { storedRevision: 5 },
    });
    expect(
      await rejection(store.save(request({ revision: 6, expectedRevision: 4 }))),
    ).toMatchObject({
      code: 'CONFLICT',
    });
    expect(
      await rejection(store.save(request({ revision: 4, expectedRevision: 5 }))),
    ).toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/newer than 4/) as unknown,
    });
    expect((await store.load('main'))?.revision).toBe(5);
    expect((await store.save(request({ revision: 6, expectedRevision: 5 }))).revision).toBe(6);
  });

  it('refuses what it has no room for, keeping what it held', async () => {
    const store = createMemoryStore({ maxBytes: 20 });
    await store.save(request({ document: '"0123456789"' }));
    expect(
      await rejection(
        store.save(
          request({ document: '"012345678901234567890"', revision: 2, expectedRevision: 1 }),
        ),
      ),
    ).toMatchObject({ code: 'QUOTA_EXCEEDED', details: { limit: 20 } });
    expect((await store.load('main'))?.document).toBe('"0123456789"');
    expect(await rejection(store.load(' '))).toMatchObject({ code: 'INVALID_INPUT', path: 'key' });
    expect(await rejection(store.save(request({ revision: -1 })))).toMatchObject({
      path: 'revision',
    });
    expect(() => createMemoryStore({ maxBytes: 0 })).toThrow(/maxBytes/);
  });
});

/** A store that can be made to fail, hold a save open, or acknowledge something else. */
function controllable(inner: SnapshotStore = createMemoryStore()) {
  const control = {
    fail: null as string | null,
    wrongAck: false,
    hold: null as Promise<void> | null,
    saves: [] as SaveRequest[],
  };
  const store: SnapshotStore = {
    guarantees: inner.guarantees,
    load: (key) => inner.load(key),
    list: () => inner.list(),
    delete: (key) => inner.delete(key),
    async save(req) {
      control.saves.push(req);
      await control.hold;
      if (control.fail !== null) {
        throw new Error(control.fail);
      }
      const ack = await inner.save(req);
      return control.wrongAck ? { ...ack, revision: ack.revision + 1 } : ack;
    },
  };
  return { store, control, inner };
}

describe('the save state machine (§13.4, FR-166)', () => {
  it('goes clean → dirty → saving → clean, and only a matching acknowledgement cleans', async () => {
    const ws = layout();
    const p = persistenceOf(ws);
    const { store, inner } = controllable();
    const saver = createSaver({ persistence: p, store, key: 'main' });
    const states: SaveState[] = [];
    saver.subscribe((s) => states.push(s));
    expect(saver.state).toBe('dirty');
    const outcome = await saver.save();
    expect(outcome).toMatchObject({
      status: 'saved',
      ack: { key: 'main', revision: 1 },
      failures: [],
    });
    expect(saver.state).toBe('clean');
    expect(saver.savedRevision).toBe(1);
    expect(await saver.save()).toEqual({ status: 'unchanged' });
    commit(ws, [{ type: 'node.patch', id: 'a', label: 'A' }]);
    expect(saver.state).toBe('dirty');
    await saver.save();
    expect(states).toEqual(['saving', 'clean', 'dirty', 'saving', 'clean']);
    // What the store holds is the layout, readable again.
    const stored = await inner.load('main');
    expect(p.import(stored?.document ?? '').nodes[0]?.label).toBe('A');
  });

  it('stays dirty when the workspace changes during a save', async () => {
    const ws = layout();
    const { store, control } = controllable();
    const saver = createSaver({ persistence: persistenceOf(ws), store, key: 'main' });
    let release: () => void = () => undefined;
    control.hold = new Promise((resolve) => {
      release = resolve;
    });
    const saving = saver.save();
    await Promise.resolve();
    commit(ws, [{ type: 'node.patch', id: 'a', label: 'during' }]);
    release();
    expect(await saving).toMatchObject({ status: 'saved', ack: { revision: 1 } });
    expect(saver.state).toBe('dirty');
    // The next save stores the newer revision.
    expect(await saver.save()).toMatchObject({ status: 'saved', ack: { revision: 2 } });
    expect(saver.state).toBe('clean');
  });

  it('fails without losing anything: dirty is kept and the store holds what it held', async () => {
    const ws = layout();
    const { store, control, inner } = controllable();
    const saver = createSaver({ persistence: persistenceOf(ws), store, key: 'main' });
    await saver.save();
    commit(ws, [{ type: 'node.patch', id: 'a', label: 'unsaved' }]);
    control.fail = 'disk unplugged';
    expect(await saver.save()).toMatchObject({
      status: 'failed',
      error: {
        code: 'STORAGE_FAILED',
        message: expect.stringMatching(/disk unplugged/) as unknown,
      },
    });
    expect(saver.state).toBe('failed');
    expect(saver.lastError?.code).toBe('STORAGE_FAILED');
    expect((await inner.load('main'))?.revision).toBe(1);
    // An acknowledgement of something else does not clean either.
    control.fail = null;
    control.wrongAck = true;
    expect(await saver.save()).toMatchObject({
      status: 'failed',
      error: { code: 'STORAGE_FAILED' },
    });
    expect(saver.state).toBe('failed');
    expect(saver.savedRevision).toBe(1);
  });

  it('never lets a retry overwrite a newer revision another session stored', async () => {
    const shared = createMemoryStore();
    const ws = layout();
    const saver = createSaver({ persistence: persistenceOf(ws), store: shared, key: 'main' });
    await saver.save();
    // Another session, working on a copy of the same layout, saves revision 3.
    const other = layout();
    commit(other, [{ type: 'node.patch', id: 'a', label: 'x' }]);
    commit(other, [{ type: 'node.patch', id: 'a', label: 'elsewhere' }]);
    await createSaver({
      persistence: persistenceOf(other),
      store: shared,
      key: 'main',
      saved: { revision: 1, changes: -1 },
    }).save();
    expect((await shared.load('main'))?.revision).toBe(3);
    commit(ws, [{ type: 'node.patch', id: 'a', label: 'mine' }]);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await saver.save()).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
    }
    const stored = await shared.load('main');
    expect(stored?.revision).toBe(3);
    expect(stored?.document).toContain('"label":"elsewhere"');
    expect(saver.state).toBe('failed');
  });

  it('runs saves one at a time, in order, and starts clean when told what is stored', async () => {
    const ws = layout();
    const p = persistenceOf(ws);
    const { store, control } = controllable();
    const saver = createSaver({ persistence: p, store, key: 'main' });
    let release: () => void = () => undefined;
    control.hold = new Promise((resolve) => {
      release = resolve;
    });
    const first = saver.save();
    // The first save is at the store when the workspace changes and a second save is asked for.
    while (control.saves.length === 0) {
      await Promise.resolve();
    }
    commit(ws, [{ type: 'node.patch', id: 'a', label: 'A' }]);
    const second = saver.save();
    expect(saver.state).toBe('saving');
    release();
    expect((await first).status).toBe('saved');
    expect(await second).toMatchObject({ status: 'saved', ack: { revision: 2 } });
    expect(control.saves.map((s) => [s.revision, s.expectedRevision])).toEqual([
      [1, null],
      [2, 1],
    ]);
    const resumed = createSaver({
      persistence: p,
      store,
      key: 'main',
      saved: { revision: 2, changes: p.changes() },
    });
    expect(resumed.state).toBe('clean');
    expect(() => createSaver({ persistence: p, store, key: ' ' })).toThrow(/key/);
  });
});
