import type { Id, SceneState } from '@swf/core';
import { createWorkspace } from '@swf/core';
import { createPresentationRegistry } from '@swf/presentation';
import { createProjectionRegistry, equirectangular } from '@swf/projections';
import { describe, expect, it } from 'vitest';
import { PANORAMA } from '../src/modes.js';
import {
  CAMERA_ID,
  colourName,
  planPreset,
  SEARCHABLE_METADATA,
  presetCommands,
} from '../src/presets.js';
import type { Attachment, Coverage, Timers } from '../src/search.js';
import { createSearch, DEFAULT_QUERY, PAGE_SIZE } from '../src/search.js';

/** Timers the test runs by hand. */
function manualTimers() {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  const timers: Timers = {
    set: (run, ms) => {
      pending.set(++next, { run, ms });
      return next;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
  };
  return {
    timers,
    pending,
    fire() {
      const all = [...pending.values()];
      pending.clear();
      for (const { run } of all) run();
    },
  };
}

function scene(preset: 'sparse' | 'dense' | 'seam') {
  const ws = createWorkspace({ id: 'test' });
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
        id: 'v',
        cameraId: CAMERA_ID,
        mode: PANORAMA.id,
        projection: PANORAMA.projection,
        size: { width: 800, height: 400, devicePixelRatio: 1 },
      },
    },
    ...presetCommands(planPreset(preset, 1)),
  ]);
  expect(result.status).toBe('committed');
  return ws;
}

function searchOf(
  ws: ReturnType<typeof scene>,
  extra: {
    attachment?: (state: SceneState, id: Id) => Attachment;
    coverage?: (state: SceneState, id: Id) => Coverage;
  } = {},
) {
  const clock = manualTimers();
  const search = createSearch({
    workspace: ws,
    viewportId: 'v',
    metadataKeys: SEARCHABLE_METADATA,
    attachment: extra.attachment ?? (() => 'attached'),
    coverage: extra.coverage ?? (() => 'in-view'),
    timers: clock.timers,
  });
  return { search, clock };
}

describe('scene metadata search (§19, FR-190–FR-193)', () => {
  it('waits for typing to pause 100 ms before it searches', () => {
    const ws = scene('sparse');
    const { search, clock } = searchOf(ws);
    const all = search.ids();
    search.setText('n');
    search.setText('no');
    search.setText('note');
    expect(search.typed()).toBe('note');
    expect(search.pending()).toBe(true);
    expect(search.ids()).toEqual(all);
    // Each keystroke restarts the one wait.
    expect([...clock.pending.values()].map((t) => t.ms)).toEqual([100]);
    clock.fire();
    expect(search.pending()).toBe(false);
    expect(search.query().text).toBe('note');
    expect(search.ids().every((id) => ws.getState().nodes.get(id)?.tags.includes('note'))).toBe(
      true,
    );
    expect(search.ids().length).toBe(3);
  });

  it('matches labels, tags and exposed metadata, normalized and in any case', () => {
    const ws = scene('sparse');
    const { search, clock } = searchOf(ws);
    const state = ws.getState();
    const first = state.nodes.get('window-01');
    if (first === undefined) throw new Error('no window');
    const colour = first.metadata['host.reference.colour'];
    if (typeof colour !== 'string') throw new Error('no colour');
    // Full-width letters fold to the same text.
    search.setText(
      colour.toUpperCase().replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)),
    );
    clock.fire();
    expect(search.ids()).toContain('window-01');
    expect(
      search.ids().every((id) => state.nodes.get(id)?.metadata['host.reference.colour'] === colour),
    ).toBe(true);
    const label = state.nodes.get('window-02')?.label ?? '';
    search.setText(
      label.replace(/./g, (c, i: number) => (i % 2 === 0 ? c.toLowerCase() : c.toUpperCase())),
    );
    clock.fire();
    expect(search.ids()).toEqual(['window-02']);
  });

  it('never matches metadata the host did not expose', () => {
    const ws = scene('sparse');
    ws.dispatch({
      type: 'node.patch',
      id: 'window-03',
      metadata: { set: { 'host.private': 'zebra' } },
    });
    const { search, clock } = searchOf(ws);
    search.setText('zebra');
    clock.fire();
    expect(search.ids()).toEqual([]);
  });

  it('pages results by 50, every one reachable, none cut off', () => {
    const ws = scene('dense');
    const { search } = searchOf(ws);
    const ids = search.ids();
    expect(ids.length).toBe(250);
    expect(search.pageCount()).toBe(5);
    const read = Array.from({ length: search.pageCount() }, (_, i) => search.page(i)).flat();
    expect(read.length).toBe(250);
    expect(read.map((r) => r.id)).toEqual(ids);
    expect(search.page(0).length).toBe(PAGE_SIZE);
    expect(() => search.page(5)).toThrow(RangeError);
    // A page is read once, and read again only after the results change.
    expect(search.page(1)).toBe(search.page(1));
  });

  it('sorts by recent focus first by default, then by name, then ID', () => {
    const ws = scene('sparse');
    const { search } = searchOf(ws);
    expect(search.query()).toEqual(DEFAULT_QUERY);
    expect(search.ids()).toEqual(
      ['window-01', 'window-03', 'window-05', 'window-02', 'window-04', 'window-06'].sort(
        (a, b) => {
          const label = (id: string) => ws.getState().nodes.get(id)?.label ?? '';
          return label(a) < label(b) ? -1 : label(a) > label(b) ? 1 : 0;
        },
      ),
    );
    ws.dispatch({ type: 'focus.set', id: 'window-04' });
    ws.dispatch({ type: 'focus.set', id: 'window-02' });
    expect(search.ids().slice(0, 2)).toEqual(['window-02', 'window-04']);
    search.setSort('label', true);
    const labels = search.ids().map((id) => ws.getState().nodes.get(id)?.label ?? '');
    expect(labels).toEqual([...labels].sort().reverse());
    search.setSort('distance');
    const distances = search.page(0).map((r) => r.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    search.setSort('id');
    expect(search.ids()).toEqual([...search.ids()].sort());
  });

  it('orders names as they are read, numbers by their value', () => {
    const ws = scene('dense');
    const { search } = searchOf(ws);
    search.setSort('label');
    const labels = search.page(0).map((r) => r.label);
    expect(labels.slice(0, 3)).toEqual(['Note 01', 'Note 06', 'Note 11']);
    expect(labels.indexOf('Note 96')).toBeLessThan(labels.indexOf('Note 101'));
  });

  it('filters by group, visibility, lock, attachment and viewport coverage, together', () => {
    const ws = scene('sparse');
    ws.transaction([
      {
        type: 'node.group',
        nodeIds: ['window-01', 'window-02'],
        group: { id: 'left', label: 'Left wall' },
      },
      { type: 'node.patch', id: 'window-02', flags: { locked: true } },
      { type: 'node.patch', id: 'window-05', flags: { visible: false } },
    ]);
    const { search, clock } = searchOf(ws, {
      attachment: (_, id) => (id === 'window-03' ? 'failed' : 'attached'),
      coverage: (_, id) => (id === 'window-04' ? 'out-of-view' : 'in-view'),
    });
    // Every preset window is in the workspace group; the new group is inside it.
    expect(search.groups()).toEqual([
      { id: 'workspace', label: 'Workspace' },
      { id: 'left', label: 'Workspace / Left wall' },
    ]);
    search.setFilters({ group: 'left' });
    expect([...search.ids()].sort()).toEqual(['window-01', 'window-02']);
    search.setFilters({ lock: 'locked' });
    expect(search.ids()).toEqual(['window-02']);
    search.clearFilters();
    search.setFilters({ visibility: 'hidden' });
    expect(search.ids()).toEqual(['window-05']);
    search.setFilters({ visibility: 'any', attachment: 'failed' });
    expect(search.ids()).toEqual(['window-03']);
    search.setFilters({ attachment: 'any', coverage: 'out-of-view' });
    expect(search.ids()).toEqual(['window-04']);
    // The text and filters compose: nothing in view is both.
    search.setText(ws.getState().nodes.get('window-04')?.label ?? '');
    clock.fire();
    search.setFilters({ coverage: 'in-view' });
    expect(search.ids()).toEqual([]);
    // Group paths are searched: the group's label finds its windows.
    search.reset();
    search.setText('left wall');
    clock.fire();
    expect([...search.ids()].sort()).toEqual(['window-01', 'window-02']);
    expect(search.page(0)[0]?.groups).toEqual(['Workspace', 'Left wall']);
    expect(() => {
      search.setFilters({ group: 'window-01' });
    }).toThrow('group must name a group');
    expect(() => {
      search.setFilters({ lock: 'maybe' as 'any' });
    }).toThrow('lock must be one of');
  });

  it('reads results again as the scene changes, and tells its listeners', () => {
    const ws = scene('sparse');
    const { search } = searchOf(ws);
    let told = 0;
    search.subscribe(() => {
      told += 1;
    });
    ws.dispatch({ type: 'node.delete', id: 'window-01', mode: 'subtree' });
    expect(told).toBe(1);
    expect(search.ids()).not.toContain('window-01');
  });

  it('names colours from hues, twelve names round the circle', () => {
    expect(colourName(0)).toBe('Red');
    expect(colourName(14)).toBe('Red');
    expect(colourName(15)).toBe('Orange');
    expect(colourName(359)).toBe('Red');
    expect(colourName(240)).toBe('Blue');
  });
});
