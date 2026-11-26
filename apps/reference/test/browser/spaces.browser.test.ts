import { makeError, SwfFailure } from '@swf/core';
import { keyed } from '@wsb/uikit/handles';
import type { SnapshotStore } from '@swf/persistence';
import { createMemoryStore } from '@swf/persistence';
import { CAMERA_ID } from '@swf/navigation';
import { describe, expect, it } from 'vitest';
import type { ReferenceApp } from '../../src/app.js';
import type { NoteTexts } from '../../src/content.js';
import type { ShellModel } from '../../src/shell/model.svelte.js';
import type { Mounted } from './shell-harness.js';
import { start } from './shell-harness.js';

/** Note texts kept in memory, as a host keeps its documents. */
function memoryTexts(): NoteTexts {
  const kept = new Map<string, string>();
  return {
    get: (key) => kept.get(key) ?? null,
    set: (key, text) => {
      kept.set(key, text);
    },
  };
}

function appOf(model: ShellModel): ReferenceApp {
  const app = model.app;
  if (app === null) {
    throw new Error('the application has not started');
  }
  return app;
}

/** The tabs across the top of the centre: each space's name, and whether it is the one shown. */
const tabs = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('[data-wsb^="editor.spaces#"][role="tab"]')].map((tab) => [
    tab.textContent.trim(),
    tab.getAttribute('aria-selected') === 'true',
  ]);

/** Where every active window stands, by ID, and where the camera faces. */
function layoutOf(app: ReferenceApp) {
  const state = app.workspace.getState();
  return {
    windows: [...state.nodes.values()]
      .filter((n) => n.kind === 'window' && n.status === 'active')
      .map((n) => [n.id, [...n.transform.position]] as const)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
    camera: [...(state.cameras.get(CAMERA_ID)?.rotation ?? [])],
  };
}

/** Each number of two layouts the same, to the precision a snapshot keeps. */
function expectSameLayout(a: ReturnType<typeof layoutOf>, b: ReturnType<typeof layoutOf>) {
  expect(a.windows.map(([id]) => id)).toEqual(b.windows.map(([id]) => id));
  a.windows.forEach(([id, position], i) => {
    position.forEach((v, k) => {
      expect(v, id).toBeCloseTo(b.windows[i]?.[1][k] ?? Number.NaN, 9);
    });
  });
  a.camera.forEach((v, k) => {
    expect(v).toBeCloseTo(b.camera[k] ?? Number.NaN, 9);
  });
}

/** Presses a space's tab and waits until it is shown. */
async function press(m: Mounted, name: string): Promise<void> {
  m.driver.act(keyed('editor.spaces', name), 'press');
  await expect.poll(() => m.model.workspaces?.space, { timeout: 10_000 }).toBe(name);
  await expect.poll(() => m.model.workspaces?.phase).toBe('idle');
  await m.settle();
}

describe('named spaces, switched in one press (Orbit D2)', () => {
  it('lists the seeded spaces as tabs across the centre, and keeps each one’s windows, layout, camera and host content across switches', async () => {
    const texts = memoryTexts();
    const m = await start('', { store: createMemoryStore(), autosaveDelayMs: 0, noteTexts: texts });
    const app = appOf(m.model);
    await expect
      .poll(() => tabs(m.root))
      .toEqual([
        ['Research', false],
        ['Planning', false],
        ['Studio', true],
      ]);
    // The studio: its Writing Desk moved, the camera turned, and something written in the desk.
    expect(m.model.scene?.preset).toBe('studio');
    expect(await m.model.run('swf.window.place', { id: 'desk', x: -2.4, z: -1.2 })).toBe(true);
    expect(await m.model.run('swf.view.heading', { degrees: 40 })).toBe(true);
    const deskKey = app.workspace.getState().surfaces.get('desk-surface')?.bindingKey ?? '';
    const desk = () => m.root.querySelector<HTMLElement>(`[data-reference-content="${deskKey}"]`);
    await expect.poll(desk).not.toBeNull();
    const deskElement = desk();
    const writing = deskElement?.querySelector<HTMLElement>('[contenteditable]');
    if (writing === null || writing === undefined) {
      throw new Error('the desk has nowhere to write');
    }
    writing.textContent = 'Written in the studio';
    writing.dispatchEvent(new InputEvent('input', { bubbles: true }));
    await m.settle();
    const studio = layoutOf(app);

    // One press shows Research: its own windows, the studio's gone from the page.
    await press(m, 'Research');
    expect(tabs(m.root)).toEqual([
      ['Research', true],
      ['Planning', false],
      ['Studio', false],
    ]);
    expect(m.model.scene?.preset).toBe('research');
    expect(app.workspace.getState().nodes.has('question')).toBe(true);
    expect(app.workspace.getState().nodes.has('desk')).toBe(false);
    await expect.poll(() => desk()?.isConnected ?? false).toBe(false);
    // Nothing done in the studio can be undone into Research.
    expect(m.model.history.undo).toBe(false);
    expect(await m.model.run('swf.window.place', { id: 'question', x: 1.5, z: -2.5 })).toBe(true);
    expect(await m.model.run('swf.view.heading', { degrees: -75 })).toBe(true);
    await m.settle();
    const research = layoutOf(app);

    // Back to the studio in one press: every window and the camera as left, and the desk the very
    // same content, with what was written in it.
    await press(m, 'Studio');
    expectSameLayout(layoutOf(app), studio);
    await expect.poll(desk).not.toBeNull();
    expect(desk()).toBe(deskElement);
    expect(desk()?.querySelector('[contenteditable]')?.textContent).toBe('Written in the studio');
    expect(m.model.history.undo).toBe(false);

    // And Research as it was left.
    await press(m, 'Research');
    expectSameLayout(layoutOf(app), research);

    // Planning, never opened, comes as seeded.
    await press(m, 'Planning');
    expect(m.model.scene?.preset).toBe('planning');
    expect(app.workspace.getState().nodes.has('roadmap')).toBe(true);
  });

  it('saves what is shown as a new space from the tabs’ own button, which is then a tab of its own', async () => {
    const m = await start('', { store: createMemoryStore(), autosaveDelayMs: 0 });
    m.driver.act('editor.spaces.new', 'press');
    await m.settle();
    // The Workspaces view opens on the name of the new space.
    await expect.poll(() => m.driver.has('page.workspaces.name')).toBe(true);
    expect(document.activeElement?.id).toBe('reference-workspace-name');
    m.driver.act('page.workspaces.name', 'set', 'Review');
    await m.settle();
    m.driver.act('page.workspaces.save', 'press');
    await expect.poll(() => m.model.workspaces?.space).toBe('Review');
    await expect
      .poll(() => tabs(m.root))
      .toEqual([
        ['Research', false],
        ['Planning', false],
        ['Studio', false],
        ['Review', true],
      ]);
    await press(m, 'Studio');
    await press(m, 'Review');
    expect(appOf(m.model).workspace.getState().nodes.has('board')).toBe(true);
  });

  it('asks before switching away from changes it could not save, and stays or switches as answered', async () => {
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
    // Saved only on request, so the change below is still unsaved when the tab is pressed.
    const m = await start('', { store, autosaveDelayMs: 600_000 });
    expect(await m.model.run('reference.workspace.saveNow', {})).toBe(true);
    failing = true;
    expect(await m.model.run('swf.window.place', { id: 'desk', x: -2.4, z: -1.2 })).toBe(true);
    const changed = layoutOf(appOf(m.model));
    m.driver.act(keyed('editor.spaces', 'Research'), 'press');
    await expect.poll(() => m.driver.has('page.switch'), { timeout: 10_000 }).toBe(true);
    expect(m.root.querySelector('[data-wsb="page.switch"]')?.textContent).toContain(
      'the storage is full',
    );
    m.driver.act('page.switch.stay', 'press');
    await expect.poll(() => m.driver.has('page.switch')).toBe(false);
    expect(m.model.workspaces?.space).toBe('Studio');
    expectSameLayout(layoutOf(appOf(m.model)), changed);
    m.driver.act(keyed('editor.spaces', 'Research'), 'press');
    await expect.poll(() => m.driver.has('page.switch'), { timeout: 10_000 }).toBe(true);
    m.driver.act('page.switch.discard', 'press');
    await expect.poll(() => m.model.workspaces?.space, { timeout: 10_000 }).toBe('Research');
    expect(m.driver.has('page.switch')).toBe(false);
    failing = false;
    // The studio kept what it saved: the desk where it was planned.
    await press(m, 'Studio');
    const desk = layoutOf(appOf(m.model)).windows.find(([id]) => id === 'desk')?.[1];
    expect(desk?.[0]).not.toBeCloseTo(-2.4, 3);
  });
});
