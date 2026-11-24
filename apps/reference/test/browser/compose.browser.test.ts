import '@wsb/uikit/styles/uikit.scss';
import '@wsb/uikit/fonts';
import { installAutomation } from '@wsb/uikit/automation';
import { keyed } from '@wsb/uikit/handles';
import type { SurfaceAutomation } from '@wsb/uikit/automation';
import { ROOT_CLASS, setAppearance, setDensity } from '@wsb/uikit/primitives';
import { mount, unmount } from 'svelte';
import { surfaceWorldMatrix, worldMatrix } from '@swf/core';
import { mat4ApproxEquals } from '@swf/math';
import { standInReason } from '@swf/presentation';
import type { SnapshotStore } from '@swf/persistence';
import { createMemoryStore } from '@swf/persistence';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { SECOND_VIEWPORT_ID } from '../../src/devtools.js';
import { createMessages, ENGLISH } from '../../src/messages.js';
import type { ShellAppOptions } from '../../src/shell/model.svelte.js';
import { ShellModel } from '../../src/shell/model.svelte.js';
import DeveloperView from '../../src/shell/DeveloperView.svelte';
import Shell from '../../src/shell/Shell.svelte';
import { sessionKey } from '../../src/workspaces.js';

interface Mounted {
  readonly model: ShellModel;
  readonly root: HTMLElement;
  readonly driver: SurfaceAutomation;
  readonly settle: () => Promise<void>;
}

const mounted: { model: ShellModel; shell: ReturnType<typeof mount>; root: HTMLElement }[] = [];

/**
 * Ends every visit mounted: a page holds one application at a time, with its one announcer, so
 * the next visit starts once the last has ended, as a reload does.
 */
async function endVisits(): Promise<void> {
  for (const m of mounted.splice(0)) {
    await m.model.dispose();
    await unmount(m.shell);
    m.root.remove();
  }
}

afterEach(endVisits);

/** Mounts the shell as the page does, with the developer panel and a store of the test's own. */
async function start(search: string, appOptions: ShellAppOptions): Promise<Mounted> {
  const html = document.documentElement;
  html.classList.add(ROOT_CLASS);
  setAppearance(html, 'light');
  setDensity(html, 'default');
  const root = document.createElement('div');
  root.style.setProperty('position', 'absolute');
  root.style.setProperty('inset', '0 auto auto 0');
  root.style.setProperty('width', '1280px');
  root.style.setProperty('height', '760px');
  document.body.append(root);
  const model = new ShellModel(createMessages(), parseConfig(search), appOptions);
  const shell = mount(Shell, { target: root, props: { model, developer: DeveloperView } });
  mounted.push({ model, shell, root });
  const driver = installAutomation(root, () => 'reference');
  const settle = async () => {
    await driver.settled();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await driver.settled();
  };
  await expect.poll(() => model.status, { timeout: 10_000 }).not.toBeNull();
  await settle();
  return { model, root, driver, settle };
}

const same = (a: Float64Array | readonly number[] | undefined, b: typeof a) =>
  a !== undefined && b !== undefined && mat4ApproxEquals(a as never, b as never, 1e-9);

/** Every node's parent and world matrix, and every surface's owner and world matrix. */
function layout(model: ShellModel) {
  const state = model.app?.workspace.getState();
  if (state === undefined) {
    throw new Error('no application');
  }
  return {
    nodes: [...state.nodes.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((n) => ({
        id: n.id,
        parentId: n.parentId,
        world: worldMatrix(state.nodes, n.id),
      })),
    surfaces: [...state.surfaces.values()]
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map((s) => ({
        id: s.id,
        owner: s.ownerNodeId,
        world: surfaceWorldMatrix(state, s.id),
      })),
  };
}

describe('multi-surface composition in the shell (FR-126, AC-016, §33.2 scenario 4)', () => {
  it('detaches a surface into its own window, reattaches it, saves, reloads and finds every transform', async () => {
    const store = createMemoryStore();
    const { model, driver, settle, root } = await start('?preset=composed', {
      store,
      autosaveDelayMs: 0,
    });
    await model.inspect('board');
    await settle();
    const before = layout(model);
    // A window of one surface offers no split: its only surface cannot be detached from it.
    await model.inspect('window-04');
    await settle();
    expect(driver.read('page.inspector.detach#window-04-surface')).toMatchObject({
      present: true,
      enabled: false,
    });
    await model.inspect('board');
    await settle();
    driver.act('page.inspector.detach#window-02-surface', 'press');
    await settle();
    let state = model.app?.workspace.getState();
    expect(state?.surfaces.get('window-02-surface')?.ownerNodeId).toBe('window-02');
    expect(state?.nodes.get('board')?.surfaceIds).toHaveLength(2);
    // The detached surface is still the same endpoint, presented live in its new window.
    await expect
      .poll(
        () =>
          root.querySelectorAll('[data-wsb="page.panorama"] [data-swf-node="window-02"]').length,
      )
      .toBeGreaterThan(0);
    // Back into the board, from the detached window's inspector.
    await model.inspect('window-02');
    await settle();
    driver.act('page.inspector.move.window', 'choose', 'board');
    await settle();
    driver.act('page.inspector.move', 'press');
    await settle();
    state = model.app?.workspace.getState();
    expect(state?.nodes.has('window-02')).toBe(false);
    expect(state?.nodes.get('board')?.surfaceIds).toEqual([
      'window-01-surface',
      'window-03-surface',
      'window-02-surface',
    ]);
    // Saved as it changes, and under a name.
    expect(await model.saveAs('Board rearranged')).toBe(true);
    await expect.poll(() => model.workspaces?.save).toBe('clean');
    const saved = layout(model);
    // The next visit restores it, whole.
    await endVisits();
    const next = await start('', { store, autosaveDelayMs: 0 });
    const restored = layout(next.model);
    expect(restored.nodes.map((n) => [n.id, n.parentId])).toEqual(
      saved.nodes.map((n) => [n.id, n.parentId]),
    );
    for (const [i, n] of saved.nodes.entries()) {
      expect(same(restored.nodes[i]?.world, n.world), n.id).toBe(true);
    }
    for (const [i, s] of saved.surfaces.entries()) {
      expect(restored.surfaces[i]?.owner, s.id).toBe(s.owner);
      expect(same(restored.surfaces[i]?.world, s.world), s.id).toBe(true);
    }
    // Composition never moved a node that it was not asked to move.
    for (const n of before.nodes.filter((n) => n.id !== 'board')) {
      const now = restored.nodes.find((r) => r.id === n.id);
      expect(same(now?.world, n.world), n.id).toBe(true);
    }
    expect((await next.model.app?.workspaces.named())?.map((w) => w.name)).toEqual([
      'Board rearranged',
    ]);
    // Listed in the workspaces view; pressing it asks before replacing the workspace with it.
    next.driver.act('workshop.view#workspaces', 'press');
    await next.settle();
    await expect
      .poll(() => next.driver.has(keyed('page.workspaces.entry', 'Board rearranged')))
      .toBe(true);
    next.driver.act(keyed('page.workspaces.entry', 'Board rearranged'), 'press');
    await expect.poll(() => next.driver.has('page.replace')).toBe(true);
    next.driver.act('page.replace.confirm', 'press');
    await next.settle();
    expect(next.model.workspaceNote).toEqual({ kind: 'opened', name: 'Board rearranged' });
  });
});

describe('removing a window (UX-011)', () => {
  it('says it removes from the workspace, never deletes or stops content, and undo brings it back', async () => {
    const { model, driver, settle, root } = await start('?preset=sparse', {
      store: createMemoryStore(),
    });
    await model.inspect('window-02');
    await settle();
    expect(driver.read('page.inspector.remove')).toMatchObject({
      present: true,
      text: ENGLISH['inspector.remove'],
    });
    const content = () => root.querySelector('[data-reference-content="sparse/note/1/02"]');
    await expect.poll(content).not.toBeNull();
    const element = content();
    driver.act('page.inspector.remove', 'press');
    await settle();
    expect(model.app?.workspace.getState().nodes.has('window-02')).toBe(false);
    expect(root.textContent).toContain(ENGLISH['removed.text'].replace('{label}', 'Note 02'));
    driver.act('page.removed.undo', 'press');
    await settle();
    expect(model.app?.workspace.getState().nodes.has('window-02')).toBe(true);
    // The very same content comes back: it was never the framework's to delete.
    await expect.poll(content).toBe(element);
    expect(driver.has('page.removed.undo')).toBe(false);
  });
});

describe('importing a workspace (FR-201, UX-016)', () => {
  it('previews the counts and replaces only once confirmed; a broken file says its line', async () => {
    const seam = await start('?preset=seam', { store: createMemoryStore() });
    const text = (await seam.model.app?.workspaces.exportText()) ?? '';
    await endVisits();
    const { model, driver, settle, root } = await start('?preset=sparse', {
      store: createMemoryStore(),
    });
    driver.act('workshop.view#workspaces', 'press');
    await settle();
    model.beginImport('seam.json', text);
    await settle();
    expect(driver.has('page.replace')).toBe(true);
    const facts = [...root.querySelectorAll('[data-wsb="page.replace"] dt')].map((term) => [
      term.textContent.trim(),
      term.nextElementSibling?.textContent.trim(),
    ]);
    expect(facts.slice(0, 4)).toEqual([
      [ENGLISH['replace.windows'], '7'],
      [ENGLISH['replace.groups'], '1'],
      [ENGLISH['replace.surfaces'], '7'],
      [ENGLISH['replace.viewports'], '1'],
    ]);
    const dialog = root.querySelector('[data-wsb="page.replace"]')?.textContent ?? '';
    expect(dialog).toContain('It replaces the 6 windows on screen');
    driver.act('page.replace.cancel', 'press');
    await settle();
    expect(model.status?.windows).toBe(6);
    model.beginImport('seam.json', text);
    await settle();
    driver.act('page.replace.confirm', 'press');
    await settle();
    expect(model.status?.windows).toBe(7);
    // Replacing is one undoable change.
    await model.run('reference.history.undo', {});
    await settle();
    expect(model.status?.windows).toBe(6);
    model.beginImport('broken.json', '{\n  "schema": "swf.workspace/1",\n  "nodes": [,]\n}');
    await settle();
    expect(driver.has('page.replace')).toBe(false);
    expect(root.querySelector('[data-wsb="page.workspaces.note"]')?.textContent).toContain(
      'at line 3, column 13',
    );
    expect(model.status?.windows).toBe(6);
  });

  it('says a saved workspace could not be restored, and loads the demo instead (FR-195)', async () => {
    const store: SnapshotStore = createMemoryStore();
    await store.save({
      key: sessionKey(1),
      document: '{"schema": 1}',
      revision: 1,
      expectedRevision: null,
    });
    const { model, root } = await start('', { store });
    expect(model.status?.windows).toBe(6);
    expect(root.textContent).toContain('Restore failed:');
    expect(root.textContent).toContain('The workspace on screen is unchanged.');
  });
});

describe('the developer panel (FR-194, ADM-001–004, §33.2 scenario 7)', () => {
  /** What each simulated window's stand-in says in a view, by its surface. */
  const standIn = (root: HTMLElement, viewport: string, surfaceId: string) =>
    root
      .querySelector(
        `[data-swf-viewport="${viewport}"] [data-swf-surface="${surfaceId}"][data-swf-stand-in]`,
      )
      ?.getAttribute('data-swf-stand-in') ?? null;

  it('simulates a missing, a slow and a throwing adapter and a non-shareable surface, each said honestly, the rest usable', async () => {
    const { model, driver, settle, root } = await start('?preset=sparse', {
      store: createMemoryStore(),
    });
    driver.act('worktree.view#developer', 'press');
    await settle();
    driver.act('page.developer.section#simulate', 'press');
    await settle();
    for (const failure of ['missing', 'slow', 'throwing']) {
      driver.act(`page.developer.simulate.add#${failure}`, 'press');
    }
    await settle();
    await expect
      .poll(() => [
        standIn(root, 'main', 'simulated-missing-surface'),
        standIn(root, 'main', 'simulated-slow-surface'),
        standIn(root, 'main', 'simulated-throwing-surface'),
      ])
      .toEqual(['unsupported', 'pending', 'unavailable']);
    expect(root.textContent).toContain(ENGLISH['standIn.unavailable']);
    // Every other window is presented as itself and still takes commands.
    const app = model.app;
    expect(app?.runtime.get('window-02-surface')?.state).toBe('presented');
    expect(await model.run('reference.window.place', { id: 'window-02', y: 0.5 })).toBe(true);
    // A note is single-owner: the second view says it is shown in the first.
    driver.act('page.developer.second.open', 'press');
    // The second view draws on canvases: what it stands in for, and why, is read from its frame.
    await expect
      .poll(() => {
        const planned = app?.presenter
          .viewport(SECOND_VIEWPORT_ID)
          ?.lastFrame()
          ?.frame.planned.find((p) => p.fragment.surfaceId === 'window-02-surface');
        return planned === undefined ? null : standInReason(planned);
      })
      .toBe('elsewhere');
    expect(app?.runtime.get('window-02-surface')?.viewports.map((v) => v.viewportId)).toEqual([
      'main',
    ]);
    driver.act('page.developer.second.close', 'press');
    await settle();
    // The host's recovery brings each back in place (ADM-003).
    for (const failure of ['missing', 'slow', 'throwing']) {
      driver.act(`page.developer.simulate.recover#${failure}`, 'press');
    }
    await expect
      .poll(() =>
        ['missing', 'slow', 'throwing'].map(
          (f) => app?.runtime.get(`simulated-${f}-surface`)?.state,
        ),
      )
      .toEqual(['presented', 'presented', 'presented']);
    driver.act('page.developer.simulate.clear', 'press');
    await settle();
    expect(model.status?.windows).toBe(6);
  });

  it('takes the renderers away: falls back, then says the backend is unavailable, then recovers', async () => {
    const { model, driver, settle, root } = await start('?preset=sparse', {
      store: createMemoryStore(),
    });
    driver.act('worktree.view#developer', 'press');
    await settle();
    driver.act('page.developer.section#simulate', 'press');
    await settle();
    driver.act('page.developer.renderer.remove#dom', 'press');
    await expect.poll(() => model.status?.backend).toBe('geometry');
    driver.act('page.developer.renderer.remove#geometry', 'press');
    await expect.poll(() => model.status?.backend).toBeNull();
    await expect
      .poll(() => root.querySelector('[data-swf-degraded]')?.textContent ?? '')
      .toMatch(/^Backend unavailable/);
    expect(model.status?.windows).toBe(6);
    driver.act('page.developer.renderer.restore#dom', 'press');
    await expect.poll(() => model.status?.backend).toBe('dom');
    driver.act('page.developer.renderer.restore#geometry', 'press');
    await settle();
  });

  it('inspects the selected window without changing it, and overlays its fragments taking no input', async () => {
    const { model, driver, settle, root } = await start('?preset=seam', {
      store: createMemoryStore(),
    });
    await model.inspect('window-01');
    driver.act('worktree.view#developer', 'press');
    await settle();
    const revision = model.app?.workspace.getState().revision;
    const text = () => root.querySelector('[data-wsb="page.developer"]')?.textContent ?? '';
    await expect.poll(text).toContain('window-01-surface');
    // On the seam: two fragments, one owning input and its duplicate, one surface.
    expect(text()).toContain(ENGLISH['dev.fragment.owner']);
    expect(text()).toContain(ENGLISH['dev.fragment.duplicate']);
    for (const term of [
      'dev.transform.world.position',
      'dev.tier',
      'dev.occlusion',
      'dev.error',
      'dev.scheduling',
    ] as const) {
      expect(text()).toContain(ENGLISH[term]);
    }
    driver.act('page.developer.overlay', 'toggle');
    await settle();
    const overlay = root.querySelector<HTMLCanvasElement>('[data-reference-debug-overlay]');
    expect(overlay).not.toBeNull();
    expect(overlay === null ? '' : getComputedStyle(overlay).pointerEvents).toBe('none');
    expect(model.app?.workspace.getState().revision).toBe(revision);
  });

  it('exports diagnostics and the trace without labels or binding keys unless chosen (PRIV-003)', async () => {
    const files: { name: string; text: string }[] = [];
    const { model, driver, settle } = await start('?preset=sparse', {
      store: createMemoryStore(),
      saveFile: (name, text) => files.push({ name, text }),
    });
    await model.run('reference.window.place', { id: 'window-02', y: 0.4 });
    driver.act('worktree.view#developer', 'press');
    await settle();
    driver.act('page.developer.section#measures', 'press');
    await settle();
    driver.act('page.developer.export.diagnostics', 'press');
    driver.act('page.developer.export.trace', 'press');
    expect(files.map((f) => f.name)).toEqual(['diagnostics.json', 'operation-trace.json']);
    for (const { text } of files) {
      expect(text).not.toContain('Note 02');
      expect(text).not.toContain('sparse/note/1/02');
      expect(text).not.toContain('host.reference.colour');
    }
    expect(JSON.parse(files[0]?.text ?? '{}')).toMatchObject({
      measures: { persistence: {}, input: {}, navigation: {} },
    });
    driver.act('page.developer.disclose#labels', 'toggle');
    driver.act('page.developer.disclose#bindingKeys', 'toggle');
    await settle();
    driver.act('page.developer.export.diagnostics', 'press');
    expect(files[2]?.text).toContain('Note 02');
    expect(files[2]?.text).toContain('sparse/note/1/02');
  });
});
