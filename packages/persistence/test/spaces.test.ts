import type { Workspace } from '@swf/core';
import { SwfFailure } from '@swf/core';
import { describe, expect, it } from 'vitest';
import type { SaveRequest, SnapshotStore } from '../src/index.js';
import { createMemoryStore, createSpaces, spaceKey, spaceOfKey } from '../src/index.js';
import { commit, persistenceOf, workspace } from './fixtures.js';

/** A memory store whose saves fail while `failing` is set, as a full disk would. */
function flakyStore(): SnapshotStore & { failing: boolean } {
  const inner = createMemoryStore({ now: () => 9 });
  const store = {
    failing: false,
    guarantees: inner.guarantees,
    load: (key: string) => inner.load(key),
    list: () => inner.list(),
    delete: (key: string) => inner.delete(key),
    save(request: SaveRequest) {
      if (store.failing) {
        return Promise.reject(
          new SwfFailure({ code: 'QUOTA_EXCEEDED', message: 'the disk is full', retryable: false }),
        );
      }
      return inner.save(request);
    },
  };
  return store;
}

/** The windows of the workspace, by ID, with their label and position. */
const windows = (ws: Workspace) =>
  [...ws.getState().nodes.values()].map((n) => [n.id, n.label, [...n.transform.position]]);

/** A space's seed: its scene replaced by one window named after it, and the camera put back. */
function seeder(ws: Workspace) {
  return (name: string) => {
    commit(ws, [
      ...ws
        .getState()
        .rootIds.map((id) => ({ type: 'node.delete' as const, id, mode: 'subtree' as const })),
      {
        type: 'node.create',
        node: {
          id: `${name.toLowerCase()}-1`,
          kind: 'window',
          bounds: [1, 1, 0.01],
          label: `${name} window`,
          transform: { position: [0, 0, -3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        },
      },
      ...(ws.getState().cameras.has('cam')
        ? [
            {
              type: 'camera.patch' as const,
              id: 'cam',
              rotation: [0, 0, 0, 1] as [number, number, number, number],
            },
          ]
        : [{ type: 'camera.create' as const, camera: { id: 'cam' } }]),
    ]);
    return Promise.resolve();
  };
}

function setup(options: { saving?: () => boolean } = {}) {
  const ws = workspace();
  const persistence = persistenceOf(ws);
  const store = flakyStore();
  const seeded: string[] = [];
  const seed = seeder(ws);
  const spaces = createSpaces({
    persistence,
    store,
    seeds: ['Research', 'Planning', 'Studio'],
    seed: (name) => {
      seeded.push(name);
      return seed(name);
    },
    saving: options.saving ?? (() => true),
  });
  return { ws, persistence, store, spaces, seeded };
}

const move = (ws: Workspace, id: string, x: number) => {
  commit(ws, [
    {
      type: 'node.patch',
      id,
      transform: { position: [x, 0, -3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    },
  ]);
};

async function failureOf(promise: Promise<unknown>) {
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

describe('named spaces', () => {
  it('lists the seeded spaces first, in their order, then the stored ones by name', async () => {
    const { spaces, store } = setup();
    await store.save({
      key: spaceKey('zeta'),
      document: '{}',
      revision: 1,
      expectedRevision: null,
    });
    await store.save({
      key: spaceKey('Alpha'),
      document: '{}',
      revision: 1,
      expectedRevision: null,
    });
    await store.save({ key: 'other', document: '{}', revision: 1, expectedRevision: null });
    expect((await spaces.list()).map((s) => [s.name, s.seeded, s.stored !== null])).toEqual([
      ['Research', true, false],
      ['Planning', true, false],
      ['Studio', true, false],
      ['Alpha', false, true],
      ['zeta', false, true],
    ]);
  });

  it('opens the first space at once, seeding it with nothing to undo', async () => {
    const { ws, spaces, seeded } = setup();
    expect(spaces.state.active).toBeNull();
    const outcome = await spaces.switchTo('Studio');
    expect(outcome).toEqual({ status: 'switched', name: 'Studio', restore: null });
    expect(seeded).toEqual(['Studio']);
    expect(spaces.state).toMatchObject({ active: 'Studio', phase: 'idle', save: 'dirty' });
    expect(windows(ws)).toEqual([['studio-1', 'Studio window', [0, 0, -3]]]);
    expect(ws.canUndo()).toBe(false);
  });

  it('keeps each space’s windows, layout and camera across switches, saving the one shown first', async () => {
    const { ws, store, spaces } = setup();
    await spaces.switchTo('Studio');
    move(ws, 'studio-1', 1.5);
    commit(ws, [{ type: 'camera.patch', id: 'cam', rotation: [0, 0.38268343, 0, 0.92387953] }]);
    const turned = ws.getState().cameras.get('cam')?.rotation;
    // Studio has unsaved changes: the switch saves it first.
    expect(spaces.state.save).toBe('dirty');
    expect(await spaces.switchTo('Research')).toMatchObject({
      status: 'switched',
      name: 'Research',
    });
    expect(await store.load(spaceKey('Studio'))).not.toBeNull();
    expect(windows(ws)).toEqual([['research-1', 'Research window', [0, 0, -3]]]);
    move(ws, 'research-1', -2);
    // Back to Studio: as it was left, camera included, and nothing of Research to undo into it.
    const back = await spaces.switchTo('Studio');
    expect(back).toMatchObject({ status: 'switched', restore: { status: 'restored' } });
    expect(windows(ws)).toEqual([['studio-1', 'Studio window', [1.5, 0, -3]]]);
    // The camera's turn, to the precision a snapshot keeps it.
    const restored = ws.getState().cameras.get('cam')?.rotation ?? [];
    restored.forEach((v, i) => {
      expect(v).toBeCloseTo(turned?.[i] ?? Number.NaN, 12);
    });
    expect(turned?.[1]).toBeCloseTo(0.38268343, 6);
    expect(ws.canUndo()).toBe(false);
    expect(spaces.state.save).toBe('clean');
    // And Research kept its change.
    await spaces.switchTo('Research');
    expect(windows(ws)).toEqual([['research-1', 'Research window', [-2, 0, -3]]]);
  });

  it('asks before giving up changes it could not save, and stays or switches as answered', async () => {
    const { ws, store, spaces } = setup();
    await spaces.switchTo('Studio');
    await spaces.save();
    move(ws, 'studio-1', 2);
    store.failing = true;
    const asked = await spaces.switchTo('Planning');
    expect(asked).toMatchObject({
      status: 'asking',
      name: 'Planning',
      error: { code: 'QUOTA_EXCEEDED' },
    });
    expect(spaces.state).toMatchObject({ active: 'Studio', phase: 'asking', target: 'Planning' });
    // While the question is open, no other change of space is taken.
    expect((await failureOf(spaces.switchTo('Research'))).code).toBe('INVALID_TRANSITION');
    expect(await spaces.answer(false)).toEqual({ status: 'stayed' });
    expect(spaces.state).toMatchObject({ active: 'Studio', phase: 'idle' });
    expect(windows(ws)).toEqual([['studio-1', 'Studio window', [2, 0, -3]]]);
    // Asked again, the person gives the changes up: Planning is shown, Studio keeps what it saved.
    expect(await spaces.switchTo('Planning')).toMatchObject({ status: 'asking' });
    expect(await spaces.answer(true)).toMatchObject({ status: 'switched', name: 'Planning' });
    store.failing = false;
    await spaces.switchTo('Studio');
    expect(windows(ws)).toEqual([['studio-1', 'Studio window', [0, 0, -3]]]);
    expect((await failureOf(spaces.answer(true))).code).toBe('INVALID_TRANSITION');
  });

  it('saves asked for during a switch once it has ended, under the space then shown', async () => {
    const { ws, store, spaces } = setup();
    await spaces.switchTo('Studio');
    move(ws, 'studio-1', 1);
    const switched = spaces.switchTo('Research');
    const saved = spaces.save();
    await switched;
    expect(spaces.state.active).toBe('Research');
    expect(await saved).toMatchObject({ status: 'saved', ack: { key: spaceKey('Research') } });
    const studio = await store.load(spaceKey('Studio'));
    expect(studio?.document).toContain('"studio-1"');
    expect(studio?.document).not.toContain('research-1');
  });

  it('refuses a space it does not have, the space shown asked again does nothing, and saving off keeps the space', async () => {
    let on = true;
    const { ws, spaces } = setup({ saving: () => on });
    expect(await failureOf(spaces.switchTo('Nowhere'))).toMatchObject({
      code: 'INVALID_INPUT',
      path: 'name',
    });
    on = false;
    // The first space is opened even while saving is off.
    await spaces.switchTo('Studio');
    expect(await spaces.switchTo('Studio')).toEqual({ status: 'unchanged' });
    expect((await failureOf(spaces.switchTo('Research'))).code).toBe('INVALID_TRANSITION');
    expect(spaces.state.active).toBe('Studio');
    expect(windows(ws)).toEqual([['studio-1', 'Studio window', [0, 0, -3]]]);
  });

  it('keeps what is shown as a new space and shows it, leaving the space before as it last saved', async () => {
    const { ws, store, spaces } = setup();
    await spaces.switchTo('Studio');
    await spaces.save();
    move(ws, 'studio-1', 3);
    const entry = await spaces.saveAs('My layout');
    expect(entry).toMatchObject({ name: 'My layout', seeded: false, stored: { savedAt: 9 } });
    expect(spaces.state).toMatchObject({ active: 'My layout', save: 'clean' });
    const xOf = async (name: string) => {
      const text = (await store.load(spaceKey(name)))?.document ?? '{}';
      const doc = JSON.parse(text) as {
        nodes: { id: string; transform: { position: number[] } }[];
      };
      return doc.nodes.find((n) => n.id === 'studio-1')?.transform.position[0];
    };
    expect(await xOf('My layout')).toBe(3);
    expect(await xOf('Studio')).toBe(0);
    expect(await failureOf(spaces.saveAs('Studio'))).toMatchObject({
      code: 'INVALID_INPUT',
      message: '“Studio” is a seeded space: save under another name',
    });
    // A space of the person's is replaced by a save under its name, and shown.
    await spaces.switchTo('Research');
    const again = await spaces.saveAs('My layout');
    expect(again.name).toBe('My layout');
    expect(spaces.state.active).toBe('My layout');
    expect(await xOf('My layout')).toBeUndefined();
    expect(await failureOf(spaces.saveAs(' padded'))).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'a name cannot start or end with spaces',
    });
    expect((await spaces.list()).map((s) => s.name)).toEqual([
      'Research',
      'Planning',
      'Studio',
      'My layout',
    ]);
  });

  it('deletes a stored space, resets a seeded one, and never removes a space of the person’s that is shown', async () => {
    const { ws, store, spaces, seeded } = setup();
    await spaces.switchTo('Studio');
    await spaces.saveAs('Mine');
    expect((await failureOf(spaces.remove('Mine'))).code).toBe('INVALID_TRANSITION');
    await spaces.switchTo('Studio');
    expect(await spaces.remove('Mine')).toBe('deleted');
    expect(await store.load(spaceKey('Mine'))).toBeNull();
    expect(await spaces.remove('Research')).toBe('unchanged');
    // The shown seeded space goes back to its seed, its history afresh.
    move(ws, 'studio-1', 4);
    await spaces.save();
    seeded.length = 0;
    expect(await spaces.remove('Studio')).toBe('reset');
    expect(seeded).toEqual(['Studio']);
    expect(await store.load(spaceKey('Studio'))).toBeNull();
    expect(windows(ws)).toEqual([['studio-1', 'Studio window', [0, 0, -3]]]);
    expect(ws.canUndo()).toBe(false);
    expect(spaces.state).toMatchObject({ active: 'Studio', save: 'dirty' });
  });

  it('fails a switch to a space whose snapshot cannot be restored, leaving the space shown', async () => {
    const { ws, store, spaces } = setup();
    await spaces.switchTo('Studio');
    await spaces.save();
    await store.save({
      key: spaceKey('Broken'),
      document: '{"schema":"nothing"}',
      revision: 1,
      expectedRevision: null,
    });
    const outcome = await spaces.switchTo('Broken');
    expect(outcome).toMatchObject({
      status: 'failed',
      name: 'Broken',
      error: { code: 'SNAPSHOT_INVALID' },
    });
    expect(spaces.state).toMatchObject({ active: 'Studio', phase: 'idle', save: 'clean' });
    expect(windows(ws)).toEqual([['studio-1', 'Studio window', [0, 0, -3]]]);
  });

  it('clears every stored space and keeps the one shown, as not saved', async () => {
    const { store, spaces } = setup();
    await spaces.switchTo('Studio');
    await spaces.save();
    await spaces.saveAs('Mine');
    await store.save({ key: 'other', document: '{}', revision: 1, expectedRevision: null });
    expect(await spaces.clear()).toBe(2);
    expect((await store.list()).map((e) => e.key)).toEqual(['other']);
    expect(spaces.state).toMatchObject({ active: 'Mine', save: 'dirty' });
    await spaces.save();
    expect(await store.load(spaceKey('Mine'))).not.toBeNull();
  });

  it('refuses everything once disposed, and invalid seeds when made', async () => {
    const { spaces } = setup();
    spaces.dispose();
    spaces.dispose();
    expect((await failureOf(spaces.switchTo('Studio'))).code).toBe('INVALID_TRANSITION');
    expect((await failureOf(spaces.save())).code).toBe('INVALID_TRANSITION');
    const ws = workspace();
    const base = {
      persistence: persistenceOf(ws),
      store: createMemoryStore(),
      seed: () => Promise.resolve(),
      saving: () => true,
    };
    expect(() => createSpaces({ ...base, seeds: ['A', 'A'] })).toThrow('“A” is given twice');
    expect(() => createSpaces({ ...base, seeds: [''] })).toThrow('a space needs a name');
  });

  it('keys each space by its name, and reads back only keys it wrote', () => {
    expect(spaceKey('a/b c')).toBe('space/a%2Fb%20c');
    expect(spaceOfKey('space/a%2Fb%20c')).toBe('a/b c');
    expect(spaceOfKey('space/%E0%A4%A')).toBeNull();
    expect(spaceOfKey('named/x/1')).toBeNull();
  });
});
