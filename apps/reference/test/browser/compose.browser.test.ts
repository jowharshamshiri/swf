import { keyed } from '@wsb/uikit/handles';
import { standInReason } from '@swf/presentation';
import type { SnapshotStore } from '@swf/persistence';
import { createMemoryStore, spaceKey } from '@swf/persistence';
import { describe, expect, it } from 'vitest';
import { SECOND_VIEWPORT_ID } from '../../src/devtools.js';
import { ENGLISH } from '../../src/messages.js';
import { endVisits, layout, same, start } from './shell-harness.js';

describe('multi-surface composition in the shell (FR-126, AC-016, §33.2 scenario 4)', () => {
  it('detaches a surface into its own window, reattaches it, saves, reloads and finds every transform', async () => {
    const store = createMemoryStore();
    // It reads the DOM backend's own elements: the DOM backend, by name.
    const { model, driver, settle, root } = await start('?preset=composed&backend=dom', {
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
    // Saved as it changes, and as a space of its own, shown from then on.
    expect(await model.saveAs('Board rearranged')).toBe(true);
    expect(model.workspaces?.space).toBe('Board rearranged');
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
    expect(next.model.workspaces?.space).toBe('Board rearranged');
    expect((await next.model.app?.workspaces.list())?.map((w) => w.name)).toEqual([
      'Research',
      'Planning',
      'Studio',
      'Board rearranged',
    ]);
    // Listed in the workspaces view: pressing another space shows it, and pressing this one
    // again brings it back as it was left.
    next.driver.act('workshop.view#workspaces', 'press');
    await next.settle();
    await expect.poll(() => next.driver.has(keyed('page.workspaces.entry', 'Studio'))).toBe(true);
    next.driver.act(keyed('page.workspaces.entry', 'Studio'), 'press');
    await expect.poll(() => next.model.workspaces?.space).toBe('Studio');
    next.driver.act(keyed('page.workspaces.entry', 'Board rearranged'), 'press');
    await expect.poll(() => next.model.workspaces?.space).toBe('Board rearranged');
    await next.settle();
    const again = layout(next.model);
    for (const [i, n] of saved.nodes.entries()) {
      expect(same(again.nodes[i]?.world, n.world), n.id).toBe(true);
    }
  });
});

describe('the inspector’s composition choices after they act', () => {
  it('keeps working once a window moved into a group, a surface moved and a window merged: no choice is left naming what is gone', async () => {
    const errors: string[] = [];
    const heard = (event: ErrorEvent) => errors.push(event.message);
    window.addEventListener('error', heard);
    try {
      const { model, driver, settle } = await start('?preset=composed', {
        store: createMemoryStore(),
      });
      await model.inspect('window-04');
      await settle();
      // Into a new group: the window's parent is now that group, which the choices leave out.
      driver.act('page.inspector.group.target', 'choose', '\u0000new');
      await settle();
      driver.act('page.inspector.group.name', 'type', 'Left');
      await settle();
      driver.act('page.inspector.group', 'press');
      await settle();
      const groupId = model.app?.workspace.getState().nodes.get('window-04')?.parentId ?? '';
      expect(model.app?.workspace.getState().nodes.get(groupId)?.label).toBe('Left');
      // The inspector still follows the scene: a step of the angle moves it and is shown.
      const heading = model.selected?.heading ?? NaN;
      driver.act('page.inspector.pose#heading', 'key', 'ArrowRight');
      await settle();
      expect(model.selected?.heading).toBeGreaterThan(heading);
      expect(driver.read('page.inspector.group.target')).toMatchObject({ present: true });
      // Into a group that exists: it becomes the window's parent, which the choices leave out.
      await model.inspect('window-05');
      await settle();
      driver.act('page.inspector.group.target', 'choose', groupId);
      await settle();
      driver.act('page.inspector.group', 'press');
      await settle();
      expect(model.app?.workspace.getState().nodes.get('window-05')?.parentId).toBe(groupId);
      expect(errors).toEqual([]);
      const turned = model.selected?.turned ?? NaN;
      driver.act('page.inspector.pose#turned', 'key', 'ArrowRight');
      await settle();
      expect(model.selected?.turned).toBeGreaterThan(turned);
      // A surface moved out of the board, and a window merged away: their choices go too.
      await model.inspect('board');
      await settle();
      driver.act('page.inspector.move.surface', 'choose', 'window-02-surface');
      driver.act('page.inspector.move.window', 'choose', 'window-05');
      await settle();
      driver.act('page.inspector.move', 'press');
      await settle();
      expect(model.app?.workspace.getState().surfaces.get('window-02-surface')?.ownerNodeId).toBe(
        'window-05',
      );
      driver.act('page.inspector.merge.window', 'choose', 'window-05');
      await settle();
      driver.act('page.inspector.merge', 'press');
      await settle();
      expect(model.app?.workspace.getState().nodes.has('board')).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      window.removeEventListener('error', heard);
    }
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
    await model.run('swf.history.undo', {});
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

  it('says a remembered space could not be restored, and shows the demo instead (FR-195)', async () => {
    const store: SnapshotStore = createMemoryStore();
    await store.save({
      key: spaceKey('Mine'),
      document: '{"schema": 1}',
      revision: 1,
      expectedRevision: null,
    });
    const { model, root } = await start('', {
      store,
      spaceMemory: { get: () => 'Mine', set: () => undefined },
    });
    expect(model.workspaces?.space).toBe('Studio');
    // The demo: the studio and its thirteen windows.
    expect(model.scene?.preset).toBe('studio');
    expect(model.status?.windows).toBe(13);
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
    // It reads the DOM backend's own elements: the DOM backend, by name.
    const { model, driver, settle, root } = await start('?preset=sparse&backend=dom', {
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
    expect(await model.run('swf.window.place', { id: 'window-02', y: 0.5 })).toBe(true);
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
    await model.run('swf.window.place', { id: 'window-02', y: 0.4 });
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
