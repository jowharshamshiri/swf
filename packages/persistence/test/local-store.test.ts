import { SwfFailure } from '@swf/core';
import { describe, expect, it } from 'vitest';
import type { SaveRequest, WebStorage } from '../src/index.js';
import { createSaver, createWebStorageStore } from '../src/index.js';
import { commit, layout, persistenceOf, workspace } from './fixtures.js';

/**
 * Web Storage in memory, as a browser keeps it: a quota in characters, and a way to make a write
 * fail as a crash or a full disk would.
 */
class MemoryStorage implements WebStorage {
  readonly items = new Map<string, string>();
  quota = Infinity;
  /** A write to a key matching this fails, as if the page died there. */
  failOn: RegExp | null = null;
  /** A write to a key matching this lands, and then throws all the same. */
  landThenFail: RegExp | null = null;
  /**
   * Calls of each method that throw: every call (true), or those whose key matches or passes.
   */
  faults: Partial<
    Record<'length' | 'key' | 'getItem' | 'removeItem', RegExp | true | ((key: string) => boolean)>
  > = {};

  #fault(method: keyof MemoryStorage['faults'], key = ''): void {
    const fault = this.faults[method];
    if (fault === true || (fault instanceof RegExp ? fault.test(key) : fault?.(key) === true)) {
      throw new Error(`${method} is refused`);
    }
  }

  get length(): number {
    this.#fault('length');
    return this.items.size;
  }

  key(index: number): string | null {
    this.#fault('key');
    return [...this.items.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    this.#fault('getItem', key);
    return this.items.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failOn?.test(key) === true) {
      throw new Error('the page went away');
    }
    if (this.landThenFail?.test(key) === true) {
      this.items.set(key, value);
      throw new Error('the write landed, then the call failed');
    }
    const used = [...this.items].reduce(
      (n, [k, v]) => n + (k === key ? 0 : k.length + v.length),
      0,
    );
    if (used + key.length + value.length > this.quota) {
      const error = new Error('exceeded the quota');
      error.name = 'QuotaExceededError';
      throw error;
    }
    this.items.set(key, value);
  }

  removeItem(key: string): void {
    this.#fault('removeItem', key);
    this.items.delete(key);
  }
}

const request = (over: Partial<SaveRequest> = {}): SaveRequest => ({
  key: 'main',
  document: '{"v":1}',
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

describe('the Web Storage store (ARCH-024, NFR-011)', () => {
  it('commits a candidate slot with one marker write, and loads what the marker names', async () => {
    const storage = new MemoryStorage();
    const store = createWebStorageStore(storage, { now: () => 9 });
    expect(store.guarantees).toEqual({ atomic: true, compareAndSwap: true });
    expect(await store.save(request())).toEqual({ key: 'main', revision: 1, savedAt: 9, bytes: 7 });
    expect([...storage.items.keys()].sort()).toEqual(['swf/main/0', 'swf/main/commit']);
    await store.save(request({ document: '{"v":2}', revision: 2, expectedRevision: 1 }));
    // The new snapshot went into the other slot; the old one was let go after the commit.
    expect([...storage.items.keys()].sort()).toEqual(['swf/main/1', 'swf/main/commit']);
    expect(await store.load('main')).toMatchObject({ revision: 2, document: '{"v":2}' });
    await store.save(request({ key: 'a/b c', revision: 4 }));
    expect((await store.list()).map((e) => e.key)).toEqual(['a/b c', 'main']);
    expect(await store.delete('main')).toBe(true);
    expect(await store.load('main')).toBeNull();
    expect([...storage.items.keys()].every((k) => !k.startsWith('swf/main/'))).toBe(true);
    // Another prefix is another store.
    expect(await createWebStorageStore(storage, { prefix: 'other' }).list()).toEqual([]);
  });

  it('keeps the last good snapshot when a save is cut short or the storage is full', async () => {
    const storage = new MemoryStorage();
    const store = createWebStorageStore(storage);
    await store.save(request({ document: '{"good":true}' }));
    // Cut short after the candidate was written, before the commit.
    storage.failOn = /\/commit$/;
    expect(
      await rejection(
        store.save(request({ document: '{"newer":1}', revision: 2, expectedRevision: 1 })),
      ),
    ).toMatchObject({
      code: 'STORAGE_FAILED',
      message: expect.stringMatching(/the page went away/) as unknown,
    });
    storage.failOn = null;
    // A full storage.
    storage.quota = 100;
    expect(
      await rejection(
        store.save(request({ document: `"${'x'.repeat(200)}"`, revision: 2, expectedRevision: 1 })),
      ),
    ).toMatchObject({ code: 'QUOTA_EXCEEDED', retryable: false });
    // Reloading, by a new store over the same storage, gives the last good snapshot, and the failed
    // candidates take no room.
    const reloaded = createWebStorageStore(storage);
    expect(await reloaded.load('main')).toMatchObject({ revision: 1, document: '{"good":true}' });
    expect([...storage.items.keys()].sort()).toEqual(['swf/main/0', 'swf/main/commit']);
  });

  it('compares and swaps, and says when what it holds is damaged', async () => {
    const storage = new MemoryStorage();
    const store = createWebStorageStore(storage);
    await store.save(request({ revision: 5 }));
    expect(await rejection(store.save(request({ revision: 6 })))).toMatchObject({
      code: 'CONFLICT',
    });
    expect(
      await rejection(store.save(request({ revision: 4, expectedRevision: 5 }))),
    ).toMatchObject({
      code: 'CONFLICT',
    });
    storage.items.set('swf/main/0', '{"v":1');
    expect(await rejection(store.load('main'))).toMatchObject({
      code: 'STORAGE_FAILED',
      message: expect.stringMatching(/is damaged/) as unknown,
    });
    storage.items.set('swf/main/commit', '{"slot":7}');
    expect(await rejection(store.load('main'))).toMatchObject({ code: 'STORAGE_FAILED' });
    expect(() => createWebStorageStore(storage, { prefix: 'a/b' })).toThrow(/prefix/);
    expect(() => createWebStorageStore({} as WebStorage)).toThrow(/getItem/);
  });

  it('answers every storage fault with its own rejection, before the commit', async () => {
    const storage = new MemoryStorage();
    const store = createWebStorageStore(storage);
    await store.save(request({ document: '{"good":true}' }));
    const next = request({ document: '{"newer":1}', revision: 2, expectedRevision: 1 });
    // The read-back of the candidate fails: nothing is committed and the candidate is let go.
    storage.faults.getItem = /\/1$/;
    expect(await rejection(store.save(next))).toMatchObject({
      code: 'STORAGE_FAILED',
      message: 'saving "main" failed: getItem is refused',
    });
    delete storage.faults.getItem;
    expect([...storage.items.keys()].sort()).toEqual(['swf/main/0', 'swf/main/commit']);
    // The commit fails and so does letting go of the candidate: the commit's failure is reported.
    storage.failOn = /\/commit$/;
    storage.faults.removeItem = /\/1$/;
    expect(await rejection(store.save(next))).toMatchObject({
      code: 'STORAGE_FAILED',
      message: 'committing "main" failed: the page went away',
    });
    storage.failOn = null;
    delete storage.faults.removeItem;
    // The commit fails and what the marker holds cannot be read: it is not known to have landed.
    storage.failOn = /\/commit$/;
    let reads = 0;
    storage.faults.getItem = (key) => key.endsWith('/commit') && ++reads > 1;
    expect(await rejection(store.save(next))).toMatchObject({
      code: 'STORAGE_FAILED',
      message: 'committing "main" failed: the page went away',
    });
    storage.failOn = null;
    delete storage.faults.getItem;
    expect(await store.load('main')).toMatchObject({ revision: 1, document: '{"good":true}' });
  });

  it('reports a save that committed as committed, whatever fails after', async () => {
    const storage = new MemoryStorage();
    const store = createWebStorageStore(storage, { now: () => 3 });
    await store.save(request({ document: '{"good":true}' }));
    // Letting go of the old slot fails after the commit: the save stands.
    storage.faults.removeItem = /\/0$/;
    expect(
      await store.save(request({ document: '{"newer":1}', revision: 2, expectedRevision: 1 })),
    ).toEqual({ key: 'main', revision: 2, savedAt: 3, bytes: 11 });
    delete storage.faults.removeItem;
    expect(await store.load('main')).toMatchObject({ revision: 2, document: '{"newer":1}' });
    // The next save writes over the slot that was not let go.
    await store.save(request({ document: '{"third":3}', revision: 3, expectedRevision: 2 }));
    expect([...storage.items.keys()].sort()).toEqual(['swf/main/0', 'swf/main/commit']);
    // The marker's write lands but its call throws: the save committed, and says so.
    storage.landThenFail = /\/commit$/;
    expect(
      await store.save(request({ document: '{"fourth":4}', revision: 4, expectedRevision: 3 })),
    ).toMatchObject({ revision: 4 });
    storage.landThenFail = null;
    expect(await store.load('main')).toMatchObject({ revision: 4, document: '{"fourth":4}' });
    expect([...storage.items.keys()].sort()).toEqual(['swf/main/1', 'swf/main/commit']);
    // A saver hears it as saved.
    const ws = layout();
    const saver = createSaver({
      persistence: persistenceOf(ws),
      store: createWebStorageStore(storage),
      key: 'other',
    });
    await saver.save();
    commit(ws, [{ type: 'node.patch', id: 'a', label: 'edited' }]);
    storage.faults.removeItem = /^swf\/other\//;
    expect(await saver.save()).toMatchObject({ status: 'saved' });
    expect(saver.state).toBe('clean');
  });

  it('deletes and lists with typed failures, and skips items it did not write', async () => {
    const storage = new MemoryStorage();
    const store = createWebStorageStore(storage);
    await store.save(request());
    await store.save(request({ document: '{"v":2}', revision: 2, expectedRevision: 1 }));
    // Removing the marker fails: nothing is deleted.
    storage.faults.removeItem = /\/commit$/;
    expect(await rejection(store.delete('main'))).toMatchObject({
      code: 'STORAGE_FAILED',
      message: 'deleting "main" failed: removeItem is refused',
    });
    delete storage.faults.removeItem;
    expect(await store.load('main')).toMatchObject({ revision: 2 });
    // Letting go of the committed slot fails once the marker is gone: the snapshot is deleted.
    storage.faults.removeItem = /\/1$/;
    expect(await store.delete('main')).toBe(true);
    delete storage.faults.removeItem;
    expect(await store.load('main')).toBeNull();
    // A later save of the key takes that room back in time.
    await store.save(request());
    await store.save(request({ document: '{"v":2}', revision: 2, expectedRevision: 1 }));
    expect([...storage.items.keys()].sort()).toEqual(['swf/main/1', 'swf/main/commit']);
    // Items under the prefix that this store could not have written are not its own.
    storage.items.set('swf/%E0%A4%A/commit', '{}');
    storage.items.set('swf/a/b/commit', '{}');
    expect((await store.list()).map((e) => e.key)).toEqual(['main']);
    // The storage refusing to be read is a typed failure.
    storage.faults.key = true;
    expect(await rejection(store.list())).toMatchObject({
      code: 'STORAGE_FAILED',
      message: 'listing failed: key is refused',
    });
    delete storage.faults.key;
    storage.faults.length = true;
    expect(await rejection(store.list())).toMatchObject({ code: 'STORAGE_FAILED' });
  });
});

describe('a failed save never reports success, and the last good layout reloads (AC-010)', () => {
  it('survives an interrupted save and a full storage', async () => {
    const storage = new MemoryStorage();
    const ws = layout();
    const saver = createSaver({
      persistence: persistenceOf(ws),
      store: createWebStorageStore(storage),
      key: 'main',
    });
    expect(await saver.save()).toMatchObject({ status: 'saved' });
    commit(ws, [{ type: 'node.patch', id: 'a', label: 'unsaved edit' }]);
    storage.failOn = /\/commit$/;
    const interrupted = await saver.save();
    expect(interrupted.status).toBe('failed');
    expect(saver.state).toBe('failed');
    storage.failOn = null;
    storage.quota = 1000;
    expect(await saver.save()).toMatchObject({
      status: 'failed',
      error: { code: 'QUOTA_EXCEEDED' },
    });
    expect(saver.state).toBe('failed');

    // The page reloads: a new workspace restores what the store holds, the last good layout.
    const store = createWebStorageStore(storage);
    const stored = await store.load('main');
    const fresh = workspace();
    const p = persistenceOf(fresh);
    const outcome = await p.restore(stored?.document);
    expect(outcome.status).toBe('restored');
    expect(fresh.getState().nodes.get('a')?.label).toBe('Notes');
    // And it is clean against the store until it changes.
    const resumed = createSaver({
      persistence: p,
      store,
      key: 'main',
      saved: { revision: stored?.revision ?? -1, changes: p.changes() },
    });
    expect(resumed.state).toBe('clean');
    commit(fresh, [{ type: 'node.patch', id: 'a', label: 'after reload' }]);
    storage.quota = Infinity;
    expect(await resumed.save()).toMatchObject({ status: 'saved' });
  });
});
