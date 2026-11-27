import type { JsonValue, SceneCommand, Workspace } from '@swf/core';
import { createWorkspace, makeError, SwfFailure } from '@swf/core';
import type { SnapshotStore } from '@swf/persistence';
import { createMemoryStore, spaceKey } from '@swf/persistence';
import { createPresentationRegistry } from '@swf/presentation';
import { createProjectionRegistry, equirectangular } from '@swf/projections';
import { afterEach, describe, expect, it } from 'vitest';
import type { PresetId } from '../src/presets.js';
import { planPreset, presetCommands } from '../src/presets.js';
import { CAMERA_ID, PANORAMA } from '@swf/navigation';
import type { SpaceMemory, Workspaces } from '../src/workspaces.js';
import {
  createWorkspaces,
  hostExtension,
  migrateStore,
  WorkspaceRefusal,
} from '../src/workspaces.js';

/** The seeded spaces of the rig, each made from a preset. */
const SEEDS: Readonly<Record<string, PresetId>> = Object.freeze({
  Research: 'sparse',
  Planning: 'seam',
  Studio: 'composed',
});

/** A workspace with the camera and viewport the application gives it, and nothing else. */
function bare(): Workspace {
  const ws = createWorkspace({ id: 'reference', now: () => 0 });
  const projections = createProjectionRegistry({
    kinds: ws.mutator(),
    projectors: createPresentationRegistry().registrar(),
  });
  projections.register(equirectangular);
  const result = ws.transaction([
    { type: 'camera.create', camera: { id: CAMERA_ID } },
    {
      type: 'viewport.create',
      viewport: {
        id: 'main',
        cameraId: CAMERA_ID,
        mode: PANORAMA.id,
        projection: PANORAMA.projection,
        size: { width: 1440, height: 480, devicePixelRatio: 1 },
      },
    },
  ]);
  expect(result.status).toBe('committed');
  return ws;
}

/** A bare workspace with a preset's windows: what a seeded space shows. */
function seededWith(preset: PresetId): Workspace {
  const ws = bare();
  expect(ws.transaction(presetCommands(planPreset(preset, 1))).status).toBe('committed');
  return ws;
}

/** The commands that replace a workspace's windows with a preset's, the camera straight ahead. */
function presetIn(ws: Workspace, preset: PresetId): SceneCommand[] {
  return [
    ...ws
      .getState()
      .rootIds.map((id): SceneCommand => ({ type: 'node.delete', id, mode: 'subtree' })),
    { type: 'camera.patch', id: CAMERA_ID, rotation: [0, 0, 0, 1] },
    ...presetCommands(planPreset(preset, 1)),
  ];
}

const open: Workspaces[] = [];
afterEach(() => {
  for (const w of open.splice(0)) {
    w.dispose();
  }
});

/** A memory of the space shown, as the browser's would keep it. */
function memoryOf(value: string | null = null): SpaceMemory & { value: string | null } {
  const memory = {
    value,
    get: () => memory.value,
    set: (name: string) => {
      memory.value = name;
    },
  };
  return memory;
}

/** The workspaces of a workspace, with host state of its own the test can read and set. */
function rig(ws: Workspace, store: SnapshotStore = createMemoryStore(), memory = memoryOf()) {
  const host = { state: { note: 'one' } as JsonValue };
  const watchers = new Set<() => void>();
  const workspaces = createWorkspaces({
    workspace: ws,
    store,
    now: () => 1000,
    timer: () => 1000,
    autosaveDelayMs: 0,
    seeds: Object.keys(SEEDS),
    defaultSpace: 'Studio',
    seed: (name) => {
      const preset = SEEDS[name];
      if (preset === undefined) {
        return Promise.reject(new Error(`no seed "${name}"`));
      }
      const done = ws.transaction(presetIn(ws, preset));
      return done.status === 'committed'
        ? Promise.resolve()
        : Promise.reject(new Error('the seed was refused'));
    },
    memory,
    extensions: [
      hostExtension('host.test', {
        capture: () => host.state,
        restore: (data) => {
          host.state = data;
        },
        watch: (changed) => {
          watchers.add(changed);
          return () => watchers.delete(changed);
        },
      }),
    ],
    policies: [],
  });
  open.push(workspaces);
  return { workspaces, store, host, memory };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** The IDs of the active windows, in order. */
const windows = (ws: Workspace) =>
  [...ws.getState().nodes.values()]
    .filter((n) => n.kind === 'window' && n.status === 'active')
    .map((n) => n.id)
    .sort();

/** A preset's scene as a snapshot, as the application stores one. */
async function snapshotOf(preset: PresetId): Promise<string> {
  const { workspaces } = rig(seededWith(preset));
  return workspaces.exportText();
}

describe('the spaces in local storage (FR-127, FR-168, UX-016)', () => {
  it('opens the default space on a first visit, and the space shown last, as it was left, on the next', async () => {
    const ws = bare();
    const { workspaces, store, memory } = rig(ws);
    expect(await workspaces.start()).toBe('Studio');
    expect(windows(ws)).toEqual(windows(seededWith('composed')));
    workspaces.setAutosave(true);
    await settle();
    expect(workspaces.status()).toMatchObject({ autosave: true, save: 'clean', space: 'Studio' });
    expect(await store.load(spaceKey('Studio'))).not.toBeNull();
    await workspaces.switchTo('Research');
    expect(memory.value).toBe('Research');
    ws.dispatch({ type: 'node.delete', id: 'window-01', mode: 'subtree' });
    await settle();
    // Off: a change is not saved, and the space cannot change; what is saved stays as it is.
    workspaces.setAutosave(false);
    ws.dispatch({ type: 'node.delete', id: 'window-02', mode: 'subtree' });
    await expect(workspaces.switchTo('Studio')).rejects.toMatchObject({
      field: 'space',
      message: 'saving is off: the spaces cannot change',
    });
    // The next visit shows Research as it was saved: one window fewer than seeded, not two.
    const next = bare();
    const again = rig(next, store, memory);
    expect(await again.workspaces.start()).toBe('Research');
    expect(windows(next)).toEqual(windows(seededWith('sparse')).slice(1));
    expect(again.workspaces.status().save).toBe('clean');
    expect(again.workspaces.measures()).toMatchObject({ restores: 1, switches: 1 });
  });

  it('keeps each space’s windows, layout, camera and host state across switches, with nothing to undo into another', async () => {
    const ws = bare();
    const { workspaces, host } = rig(ws);
    await workspaces.start();
    workspaces.setAutosave(true);
    ws.dispatch({ type: 'camera.patch', id: CAMERA_ID, rotation: [0, 0.6, 0, 0.8] });
    ws.dispatch({ type: 'node.delete', id: 'window-04', mode: 'subtree' });
    host.state = { note: 'studio' };
    const studio = windows(ws);
    const camera = ws.getState().cameras.get(CAMERA_ID)?.rotation ?? [];
    expect((await workspaces.switchTo('Planning')).status).toBe('switched');
    expect(windows(ws)).toEqual(windows(seededWith('seam')));
    expect(ws.canUndo()).toBe(false);
    host.state = { note: 'planning' };
    await settle();
    expect((await workspaces.switchTo('Studio')).status).toBe('switched');
    expect(windows(ws)).toEqual(studio);
    const back = ws.getState().cameras.get(CAMERA_ID)?.rotation ?? [];
    camera.forEach((v, i) => {
      expect(back[i]).toBeCloseTo(v, 12);
    });
    expect(host.state).toEqual({ note: 'studio' });
    expect(ws.canUndo()).toBe(false);
    await workspaces.switchTo('Planning');
    expect(host.state).toEqual({ note: 'planning' });
    expect(workspaces.measures().switches).toBe(4);
  });

  it('asks before switching away from changes it could not save, and stays or switches as answered', async () => {
    const ws = bare();
    const memory = createMemoryStore();
    let failing = false;
    const store: SnapshotStore = {
      guarantees: memory.guarantees,
      load: (key) => memory.load(key),
      list: () => memory.list(),
      delete: (key) => memory.delete(key),
      save: (request) =>
        failing
          ? Promise.reject(new SwfFailure(makeError('QUOTA_EXCEEDED', 'the storage is full')))
          : memory.save(request),
    };
    const { workspaces } = rig(ws, store);
    await workspaces.start();
    workspaces.setAutosave(true);
    await settle();
    failing = true;
    ws.dispatch({ type: 'node.delete', id: 'window-04', mode: 'subtree' });
    const asked = await workspaces.switchTo('Research');
    expect(asked).toMatchObject({ status: 'asking', name: 'Research' });
    expect(workspaces.status()).toMatchObject({
      space: 'Studio',
      phase: 'asking',
      asking: { name: 'Research', error: { message: 'the storage is full' } },
    });
    expect((await workspaces.answer(false)).status).toBe('stayed');
    expect(workspaces.status()).toMatchObject({ space: 'Studio', asking: null });
    expect(windows(ws)).not.toContain('window-04');
    await workspaces.switchTo('Research');
    expect((await workspaces.answer(true)).status).toBe('switched');
    expect(workspaces.status()).toMatchObject({ space: 'Research', asking: null });
    failing = false;
    // Studio kept what it saved last: the window removed after it was never saved.
    await workspaces.switchTo('Studio');
    expect(windows(ws)).toContain('window-04');
  });

  it('saves what is shown as a space of the operator’s, deletes it, and resets a seeded one', async () => {
    const ws = bare();
    const { workspaces, store, memory } = rig(ws);
    await workspaces.start();
    workspaces.setAutosave(true);
    ws.dispatch({ type: 'node.delete', id: 'window-04', mode: 'subtree' });
    await settle();
    const entry = await workspaces.saveAs('Mine');
    expect(entry).toMatchObject({ name: 'Mine', seeded: false });
    expect(workspaces.status().space).toBe('Mine');
    expect(memory.value).toBe('Mine');
    expect((await workspaces.list()).map((s) => s.name)).toEqual([
      'Research',
      'Planning',
      'Studio',
      'Mine',
    ]);
    await expect(workspaces.saveAs('Studio')).rejects.toMatchObject({
      field: 'name',
      message: '“Studio” is a seeded space: save under another name',
    });
    await expect(workspaces.saveAs(' padded ')).rejects.toThrow(/spaces/);
    await expect(workspaces.remove('Mine')).rejects.toThrow(/space shown/);
    await workspaces.switchTo('Studio');
    expect(await workspaces.remove('Mine')).toBe('deleted');
    expect(await store.load(spaceKey('Mine'))).toBeNull();
    // Studio, shown, goes back as it was seeded.
    expect(windows(ws)).not.toContain('window-04');
    expect(await workspaces.remove('Studio')).toBe('reset');
    expect(windows(ws)).toContain('window-04');
    expect(ws.canUndo()).toBe(false);
  });

  it('reports a remembered space that cannot be opened, and opens the default one', async () => {
    const store = createMemoryStore();
    await store.save({
      key: spaceKey('Broken'),
      document: '{"schema":',
      revision: 1,
      expectedRevision: null,
    });
    const ws = bare();
    const { workspaces } = rig(ws, store, memoryOf('Broken'));
    expect(await workspaces.start()).toBe('Studio');
    expect(workspaces.status().restoreError?.code).toBe('SNAPSHOT_INVALID');
    expect(workspaces.measures().restoreFailures).toBe(1);
    expect(windows(ws)).toEqual(windows(seededWith('composed')));
  });

  it('makes spaces of what the application stored before it kept spaces, and deletes those entries', async () => {
    const store = createMemoryStore();
    const put = async (key: string, preset: PresetId) =>
      store.save({ key, document: await snapshotOf(preset), revision: 3, expectedRevision: null });
    // Two visits, the later one last; two saves of one name, the later one newest; a name to
    // encode; a name already a space (kept as it is); and an entry the application never wrote.
    await put('session/1000', 'sparse');
    await put('session/2000', 'seam');
    await put('named/Golden/5', 'sparse');
    await put('named/Golden/9', 'dense');
    await put(`named/${encodeURIComponent('Notes / two')}/4`, 'composed');
    await put('named/Kept/4', 'composed');
    await put(spaceKey('Kept'), 'sparse');
    await put('host-owned', 'sparse');
    const kept = await store.load(spaceKey('Kept'));
    expect(await migrateStore(store, 'Studio')).toBe(3);
    expect((await store.list()).map((e) => e.key).sort()).toEqual(
      [
        'host-owned',
        spaceKey('Golden'),
        spaceKey('Kept'),
        spaceKey('Notes / two'),
        spaceKey('Studio'),
      ].sort(),
    );
    const documentOf = async (name: string) => (await store.load(spaceKey(name)))?.document;
    expect(await documentOf('Studio')).toBe(await snapshotOf('seam'));
    expect(await documentOf('Golden')).toBe(await snapshotOf('dense'));
    expect(await documentOf('Notes / two')).toBe(await snapshotOf('composed'));
    expect(await store.load(spaceKey('Kept'))).toEqual(kept);
    // Run again, there is nothing left to make.
    expect(await migrateStore(store, 'Studio')).toBe(0);
    // And the application opens the spaces made.
    const ws = bare();
    const { workspaces } = rig(ws, store);
    expect(await workspaces.start()).toBe('Studio');
    expect(windows(ws)).toEqual(windows(seededWith('seam')));
    expect((await workspaces.list()).map((s) => [s.name, s.stored !== null])).toEqual([
      ['Research', false],
      ['Planning', false],
      ['Studio', true],
      ['Golden', true],
      ['Kept', true],
      ['Notes / two', true],
    ]);
  });

  it('refuses to save or change saving once disposed, and takes a second disposal as done', async () => {
    const ws = bare();
    const { workspaces, store } = rig(ws);
    await workspaces.start();
    workspaces.setAutosave(true);
    await settle();
    const saved = await store.load(spaceKey('Studio'));
    workspaces.dispose();
    workspaces.dispose();
    ws.dispatch({ type: 'node.delete', id: 'window-04', mode: 'subtree' });
    await expect(workspaces.saveNow()).rejects.toThrow(
      new WorkspaceRefusal('save', 'the workspaces are disposed'),
    );
    expect(() => {
      workspaces.setAutosave(false);
    }).toThrow(new WorkspaceRefusal('save', 'the workspaces are disposed'));
    await expect(workspaces.switchTo('Research')).rejects.toThrow(/disposed/);
    await settle();
    // Nothing more was stored for the change made after disposal.
    expect(await store.load(spaceKey('Studio'))).toEqual(saved);
  });

  it('previews an import and replaces the space shown only on request; refuses a file that is not a snapshot, by line', async () => {
    const exported = await snapshotOf('seam');
    const ws = bare();
    const { workspaces } = rig(ws);
    await workspaces.start();
    const shown = windows(ws);
    expect(workspaces.previewImport('seam.json', exported)).toMatchObject({
      windows: 7,
      surfaces: 7,
      viewports: 1,
    });
    // A preview changes nothing.
    expect(windows(ws)).toEqual(shown);
    expect(() => workspaces.previewImport('seam.txt', exported)).toThrow(/\.json file/);
    const broken = '{\n  "schema": "swf.workspace/1",\n  "nodes": [,]\n}';
    expect(() => workspaces.previewImport('broken.json', broken)).toThrow(
      /at line 3, column 13, a value was expected/,
    );
    const wrong = exported.replace('"swf.workspace/2"', '"swf.workspace/9"');
    let caught: unknown;
    try {
      workspaces.previewImport('wrong.json', wrong);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkspaceRefusal);
    expect((caught as WorkspaceRefusal).message).toMatch(/schema/);
    expect(windows(ws)).toEqual(shown);
    expect((await workspaces.importText('seam.json', exported)).status).toBe('restored');
    expect(windows(ws)).toEqual(windows(seededWith('seam')));
    // An import is one undoable change of the space shown.
    expect(ws.undo().status).toBe('committed');
    expect(windows(ws)).toEqual(shown);
  });

  it('deletes every layout it saved, saying how many, and leaves the space on screen as it is (PRIV-002)', async () => {
    const ws = bare();
    const store = createMemoryStore();
    await store.save({ key: 'host-owned', document: '{}', revision: 1, expectedRevision: null });
    const { workspaces } = rig(ws, store);
    await workspaces.start();
    workspaces.setAutosave(true);
    ws.dispatch({ type: 'node.delete', id: 'window-04', mode: 'subtree' });
    await settle();
    await workspaces.saveAs('A');
    await workspaces.switchTo('Research');
    await settle();
    expect(await workspaces.deleteAll()).toBe(3);
    expect(workspaces.status()).toMatchObject({ space: 'Research', save: 'dirty' });
    expect((await workspaces.list()).every((s) => s.stored === null)).toBe(true);
    // What the application did not save is not its to delete.
    expect(await store.load('host-owned')).not.toBeNull();
    expect(windows(ws)).toEqual(windows(seededWith('sparse')));
    // The space on screen is saved again as it changes.
    await settle();
    expect(workspaces.status().save).toBe('clean');
    // Clearing is saving's: refused while it is off.
    workspaces.setAutosave(false);
    await expect(workspaces.deleteAll()).rejects.toThrow(/saving is off/);
  });

  it('measures what it saves and restores (AN-007)', async () => {
    const ws = bare();
    const { workspaces } = rig(ws);
    await workspaces.start();
    workspaces.setAutosave(true);
    await workspaces.saveNow();
    await workspaces.switchTo('Research');
    await workspaces.switchTo('Studio');
    await workspaces.exportText();
    const measures = workspaces.measures();
    expect(measures.restores).toBe(1);
    expect(measures.switches).toBe(3);
    expect(measures.saves).toBeGreaterThanOrEqual(2);
    expect(measures.lastSnapshotBytes).toBeGreaterThan(1000);
    expect(measures.lastCaptureMs).toBe(0);
    expect(measures.lastSerializeMs).toBe(0);
    expect(measures.lastRestoreMs).toBe(0);
    expect(measures.lastSaveMs).toBe(0);
  });
});
