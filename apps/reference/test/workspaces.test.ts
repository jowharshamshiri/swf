import type { JsonValue, Workspace } from '@swf/core';
import { createWorkspace, SwfFailure, makeError } from '@swf/core';
import type { SnapshotStore } from '@swf/persistence';
import { createMemoryStore } from '@swf/persistence';
import { createPresentationRegistry } from '@swf/presentation';
import { createProjectionRegistry, equirectangular } from '@swf/projections';
import { afterEach, describe, expect, it } from 'vitest';
import type { PresetId } from '../src/presets.js';
import { planPreset, presetCommands } from '../src/presets.js';
import { CAMERA_ID, PANORAMA } from '@swf/navigation';
import type { Workspaces } from '../src/workspaces.js';
import {
  createWorkspaces,
  hostExtension,
  nameIssue,
  sessionKey,
  WorkspaceRefusal,
} from '../src/workspaces.js';

/** A workspace holding a preset, as the application seeds it. */
function seeded(preset: PresetId): Workspace {
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
    ...presetCommands(planPreset(preset, 1)),
  ]);
  expect(result.status).toBe('committed');
  return ws;
}

const open: Workspaces[] = [];
afterEach(() => {
  for (const w of open.splice(0)) {
    w.dispose();
  }
});

/** The workspaces of a workspace, with host state of its own the test can read and set. */
function rig(ws: Workspace, store: SnapshotStore = createMemoryStore(), clock = { now: 1000 }) {
  const host = { state: { note: 'one' } as JsonValue };
  const watchers = new Set<() => void>();
  const workspaces = createWorkspaces({
    workspace: ws,
    store,
    now: () => clock.now,
    timer: () => clock.now,
    autosaveDelayMs: 0,
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
  return { workspaces, store, host, clock };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** The visits the store holds, by key. */
const visits = async (store: SnapshotStore) =>
  (await store.list()).map((e) => e.key).filter((key) => key.startsWith('session/'));

const windows = (ws: Workspace) =>
  [...ws.getState().nodes.values()].filter((n) => n.kind === 'window').length;

describe('workspaces in local storage (FR-127, FR-168, UX-016)', () => {
  it('saves the workspace as it changes only while saving is on, and restores it next time', async () => {
    const ws = seeded('sparse');
    const { workspaces, store } = rig(ws);
    ws.dispatch({ type: 'node.delete', id: 'window-01', mode: 'subtree' });
    await settle();
    expect(await visits(store)).toEqual([]);
    workspaces.setAutosave(true);
    await settle();
    expect(workspaces.status()).toMatchObject({ autosave: true, save: 'clean' });
    expect(await visits(store)).toEqual(['session/1000']);
    // Off: a change is not saved; what is saved stays as it is.
    workspaces.setAutosave(false);
    ws.dispatch({ type: 'node.delete', id: 'window-02', mode: 'subtree' });
    await settle();
    expect(workspaces.status().save).toBe('dirty');
    // The next visit restores what was saved: five windows, not four.
    const next = seeded('dense');
    const again = rig(next, store);
    const outcome = await again.workspaces.restoreLast();
    expect(outcome?.status).toBe('restored');
    expect(windows(next)).toBe(5);
    expect(again.workspaces.status().save).toBe('clean');
    expect(again.workspaces.measures()).toMatchObject({ restores: 1, restoreFailures: 0 });
  });

  it('saves a visit that loaded a scene of its own under its own key, removing older visits once it is stored', async () => {
    const store = createMemoryStore();
    // An earlier visit, far along: its workspace is at a revision the next one will not reach.
    const earlier = seeded('dense');
    for (let i = 1; i <= 30; i++) {
      earlier.dispatch({
        type: 'node.delete',
        id: `window-${String(i).padStart(2, '0')}`,
        mode: 'subtree',
      });
    }
    const first = rig(earlier, store, { now: 1000 });
    first.workspaces.setAutosave(true);
    await settle();
    expect(await visits(store)).toEqual(['session/1000']);
    first.workspaces.dispose();
    // The next visit names a scene of its own: it does not restore, and saves beside it.
    const ws = seeded('sparse');
    const next = rig(ws, store, { now: 2000 });
    next.workspaces.setAutosave(true);
    ws.dispatch({ type: 'node.delete', id: 'window-01', mode: 'subtree' });
    await settle();
    expect(next.workspaces.status().save).toBe('clean');
    expect(await visits(store)).toEqual(['session/2000']);
    // And that is the one the visit after restores.
    const after = seeded('seam');
    expect((await rig(after, store, { now: 3000 }).workspaces.restoreLast())?.status).toBe(
      'restored',
    );
    expect(windows(after)).toBe(5);
  });

  it('refuses to save or change saving once disposed, and takes a second disposal as done', async () => {
    const ws = seeded('sparse');
    const { workspaces, store } = rig(ws);
    workspaces.setAutosave(true);
    await settle();
    workspaces.dispose();
    workspaces.dispose();
    ws.dispatch({ type: 'node.delete', id: 'window-01', mode: 'subtree' });
    await expect(workspaces.saveNow()).rejects.toThrow(
      new WorkspaceRefusal('save', 'the workspaces are disposed'),
    );
    expect(() => {
      workspaces.setAutosave(false);
    }).toThrow(new WorkspaceRefusal('save', 'the workspaces are disposed'));
    await settle();
    // Nothing more was stored for the change made after disposal.
    expect(await visits(store)).toEqual(['session/1000']);
    expect((await store.load('session/1000'))?.revision).toBe(ws.getState().revision - 1);
  });

  it('restores nothing when nothing is saved, and keeps the workspace when the saved one is broken', async () => {
    const ws = seeded('sparse');
    const store = createMemoryStore();
    expect(await rig(ws, store).workspaces.restoreLast()).toBeNull();
    await store.save({
      key: sessionKey(1),
      document: '{"schema":',
      revision: 1,
      expectedRevision: null,
    });
    const { workspaces } = rig(ws, store);
    const outcome = await workspaces.restoreLast();
    expect(outcome?.status).toBe('rejected');
    expect(windows(ws)).toBe(6);
    expect(workspaces.status().restoreError?.code).toBe('SNAPSHOT_INVALID');
    expect(workspaces.measures().restoreFailures).toBe(1);
  });

  it('saves, lists, previews, opens and deletes named workspaces, with the host’s own state', async () => {
    const ws = seeded('sparse');
    const { workspaces, host, clock } = rig(ws);
    await workspaces.saveAs('Six windows');
    ws.dispatch({ type: 'node.delete', id: 'window-01', mode: 'subtree' });
    host.state = { note: 'two' };
    clock.now = 2000;
    await workspaces.saveAs('Five windows');
    expect((await workspaces.named()).map((n) => n.name)).toEqual(['Five windows', 'Six windows']);
    expect(await workspaces.previewNamed('Six windows')).toMatchObject({
      windows: 6,
      groups: 1,
      surfaces: 6,
      viewports: 1,
      cameras: 1,
      extensions: ['host.test'],
      schema: 'swf.workspace/1',
    });
    expect((await workspaces.openNamed('Six windows')).status).toBe('restored');
    expect(windows(ws)).toBe(6);
    expect(host.state).toEqual({ note: 'one' });
    // Opening is one undoable change.
    expect(ws.undo().status).toBe('committed');
    expect(windows(ws)).toBe(5);
    await workspaces.deleteNamed('Six windows');
    expect((await workspaces.named()).map((n) => n.name)).toEqual(['Five windows']);
    await expect(workspaces.openNamed('Six windows')).rejects.toThrow(WorkspaceRefusal);
    await expect(workspaces.saveAs(' padded ')).rejects.toThrow(/spaces/);
    expect(nameIssue('')).toMatch(/needs a name/);
    expect(nameIssue('x'.repeat(81))).toMatch(/at most 80/);
  });

  it('replaces a named workspace only once the new one is stored', async () => {
    const ws = seeded('sparse');
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
    const { workspaces, clock } = rig(ws, store);
    await workspaces.saveAs('Mine');
    ws.dispatch({ type: 'node.delete', id: 'window-01', mode: 'subtree' });
    clock.now = 3000;
    failing = true;
    await expect(workspaces.saveAs('Mine')).rejects.toThrow(/the storage is full/);
    // The old one is still there, whole.
    expect((await workspaces.previewNamed('Mine')).windows).toBe(6);
    failing = false;
    await workspaces.saveAs('Mine');
    expect((await workspaces.previewNamed('Mine')).windows).toBe(5);
    expect((await memory.list()).filter((e) => e.key.startsWith('named/'))).toHaveLength(1);
  });

  it('previews an import and replaces only on request; refuses a file that is not a snapshot, by line', async () => {
    const source = seeded('seam');
    const exported = await rig(source).workspaces.exportText();
    const ws = seeded('sparse');
    const { workspaces } = rig(ws);
    expect(workspaces.previewImport('seam.json', exported)).toMatchObject({
      windows: 7,
      surfaces: 7,
      viewports: 1,
    });
    // A preview changes nothing.
    expect(windows(ws)).toBe(6);
    expect(() => workspaces.previewImport('seam.txt', exported)).toThrow(/\.json file/);
    const broken = '{\n  "schema": "swf.workspace/1",\n  "nodes": [,]\n}';
    expect(() => workspaces.previewImport('broken.json', broken)).toThrow(
      /at line 3, column 13, a value was expected/,
    );
    const wrong = exported.replace('"swf.workspace/1"', '"swf.workspace/9"');
    let caught: unknown;
    try {
      workspaces.previewImport('wrong.json', wrong);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkspaceRefusal);
    expect((caught as WorkspaceRefusal).message).toMatch(/schema/);
    expect(windows(ws)).toBe(6);
    expect((await workspaces.importText('seam.json', exported)).status).toBe('restored');
    expect(windows(ws)).toBe(7);
  });

  it('deletes every layout it saved, saying how many, and leaves the workspace on screen as it is (PRIV-002)', async () => {
    const ws = seeded('sparse');
    const store = createMemoryStore();
    await store.save({ key: 'host-owned', document: '{}', revision: 1, expectedRevision: null });
    const { workspaces } = rig(ws, store);
    workspaces.setAutosave(true);
    ws.dispatch({ type: 'node.delete', id: 'window-01', mode: 'subtree' });
    await settle();
    await workspaces.saveAs('A');
    await workspaces.saveAs('B');
    workspaces.setAutosave(false);
    expect(await workspaces.deleteAll()).toBe(3);
    expect(await workspaces.named()).toEqual([]);
    expect(await visits(store)).toEqual([]);
    // What the application did not save is not its to delete.
    expect(await store.load('host-owned')).not.toBeNull();
    expect(windows(ws)).toBe(5);
    expect(workspaces.status().save).toBe('dirty');
  });

  it('measures what it saves and restores (AN-007)', async () => {
    const ws = seeded('sparse');
    const { workspaces } = rig(ws);
    await workspaces.saveAs('M');
    await workspaces.openNamed('M');
    const measures = workspaces.measures();
    expect(measures.saves).toBe(1);
    expect(measures.restores).toBe(1);
    expect(measures.lastSnapshotBytes).toBeGreaterThan(1000);
    expect(measures.lastCaptureMs).toBe(0);
    expect(measures.lastSerializeMs).toBe(0);
    expect(measures.lastRestoreMs).toBe(0);
    // Saving as it changes is timed too.
    workspaces.setAutosave(true);
    ws.dispatch({ type: 'node.delete', id: 'window-01', mode: 'subtree' });
    await settle();
    expect(workspaces.measures().lastSaveMs).toBe(0);
  });
});
