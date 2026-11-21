import { SwfFailure } from '@swf/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { IdbFactory, SaveRequest, SnapshotStore } from '../../src/index.js';
import {
  createIndexedDbStore,
  createWebStorageStore,
  DEFAULT_SNAPSHOT_LIMITS,
} from '../../src/index.js';
import { layout, persistenceOf, workspace } from '../fixtures.js';

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

const databases: string[] = [];
let serial = 0;
function database(): string {
  serial += 1;
  const name = `swf-test-${String(Date.now())}-${String(serial)}`;
  databases.push(name);
  return name;
}

afterEach(async () => {
  for (const name of databases.splice(0)) {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => {
        resolve();
      };
      req.onerror = () => {
        resolve();
      };
      req.onblocked = () => {
        resolve();
      };
    });
  }
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i);
    if (key?.startsWith('swf-test') === true) {
      localStorage.removeItem(key);
    }
  }
});

/** The real IndexedDB, whose read-write transactions abort after a write, before they commit. */
function interrupting(factory: IDBFactory): IdbFactory {
  /** A proxy that calls the real object's methods and sets its handlers on the real object. */
  const forward = <T extends object>(target: T, override: (key: PropertyKey) => unknown): T =>
    new Proxy(target, {
      get(t, key) {
        const replaced = override(key);
        if (replaced !== undefined) {
          return replaced;
        }
        const value: unknown = Reflect.get(t, key);
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(t)
          : value;
      },
      set(t, key, value) {
        return Reflect.set(t, key, value);
      },
    });
  return {
    open(name, version) {
      const open = factory.open(name, version);
      return forward(open, (key) =>
        key === 'result'
          ? forward(open.result, (k) =>
              k === 'transaction'
                ? (store: string, mode: IDBTransactionMode) => {
                    const tx = open.result.transaction(store, mode);
                    return forward(tx, (kk) =>
                      kk === 'objectStore' && mode === 'readwrite'
                        ? (n: string) =>
                            forward(tx.objectStore(n), (op) =>
                              op === 'put'
                                ? (value: unknown) => {
                                    // The write itself succeeds; the transaction is cut short
                                    // just after, before it commits.
                                    const req = tx.objectStore(n).put(value);
                                    return new Proxy(req, {
                                      get: (t, k) => Reflect.get(t, k) as unknown,
                                      set(t, k, handler) {
                                        if (k !== 'onsuccess' || typeof handler !== 'function') {
                                          return Reflect.set(t, k, handler);
                                        }
                                        t.onsuccess = (event) => {
                                          (handler as (e: Event) => void)(event);
                                          tx.abort();
                                        };
                                        return true;
                                      },
                                    });
                                  }
                                : undefined,
                            )
                        : undefined,
                    );
                  }
                : undefined,
            )
          : undefined,
      );
    },
  };
}

describe('the Web Storage store in a real browser (ARCH-024, NFR-011)', () => {
  it('saves and reloads, and keeps the last good snapshot when the storage is full', async () => {
    const store = createWebStorageStore(localStorage, { prefix: 'swf-test' });
    await store.save(request({ document: '{"good":true}' }));
    // Far more than any browser keeps for one origin.
    const huge = `"${'x'.repeat(12 * 1024 * 1024)}"`;
    expect(
      await rejection(store.save(request({ document: huge, revision: 2, expectedRevision: 1 }))),
    ).toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    const reloaded = createWebStorageStore(localStorage, { prefix: 'swf-test' });
    expect(await reloaded.load('main')).toMatchObject({ revision: 1, document: '{"good":true}' });
    expect(
      await reloaded.save(request({ document: '{"next":1}', revision: 2, expectedRevision: 1 })),
    ).toMatchObject({
      revision: 2,
    });
  });
});

describe('the IndexedDB store in a real browser (ARCH-024, NFR-011)', () => {
  it('saves and reloads a large snapshot, comparing and swapping in one transaction', async () => {
    const name = database();
    const store: SnapshotStore = createIndexedDbStore(indexedDB, { database: name });
    // Larger than Web Storage holds: what IndexedDB is for.
    const large = `"${'y'.repeat(16 * 1024 * 1024)}"`;
    expect(await store.save(request({ document: large }))).toMatchObject({
      revision: 1,
      bytes: large.length,
    });
    const reloaded = createIndexedDbStore(indexedDB, { database: name });
    expect((await reloaded.load('main'))?.document.length).toBe(large.length);
    expect(await rejection(reloaded.save(request({ revision: 2 })))).toMatchObject({
      code: 'CONFLICT',
    });
    expect(
      await rejection(reloaded.save(request({ revision: 0, expectedRevision: 1 }))),
    ).toMatchObject({
      code: 'CONFLICT',
    });
    await reloaded.save(request({ key: 'other', revision: 3 }));
    expect((await reloaded.list()).map((e) => [e.key, e.revision])).toEqual([
      ['main', 1],
      ['other', 3],
    ]);
    expect(await reloaded.delete('other')).toBe(true);
    expect(await reloaded.delete('other')).toBe(false);
  });

  it('keeps the last good snapshot when a save’s transaction is cut short, and never reports it saved', async () => {
    const name = database();
    await createIndexedDbStore(indexedDB, { database: name }).save(
      request({ document: '{"good":true}' }),
    );
    const cut = createIndexedDbStore(interrupting(indexedDB), { database: name });
    expect(
      await rejection(
        cut.save(request({ document: '{"newer":1}', revision: 2, expectedRevision: 1 })),
      ),
    ).toMatchObject({ code: 'STORAGE_FAILED' });
    const reloaded = createIndexedDbStore(indexedDB, { database: name });
    expect(await reloaded.load('main')).toMatchObject({ revision: 1, document: '{"good":true}' });
  });

  it('carries a layout through a save, a reload and a restore', async () => {
    const name = database();
    const ws = layout();
    const p = persistenceOf(ws);
    const text = p.export((await p.capture()).document);
    expect(text.length).toBeLessThan(DEFAULT_SNAPSHOT_LIMITS.maxBytes);
    await createIndexedDbStore(indexedDB, { database: name }).save(request({ document: text }));
    const stored = await createIndexedDbStore(indexedDB, { database: name }).load('main');
    const fresh = workspace();
    const outcome = await persistenceOf(fresh).restore(stored?.document);
    expect(outcome.status).toBe('restored');
    expect({ ...fresh.serialize(), revision: 0 }).toEqual({ ...ws.serialize(), revision: 0 });
  });
});
