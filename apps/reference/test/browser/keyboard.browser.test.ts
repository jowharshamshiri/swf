// §33.2 scenario 10, on its own: the reference application operated with the keyboard alone, from
// finding a window to restoring the layout in a new visit, with nothing pressed by a pointer.
// It mounts the application as the page does and needs nothing from any other test file, so the
// cross-browser conformance suite can run it as it is.
import '@wsb/uikit/styles/uikit.scss';
import '@wsb/uikit/fonts';
import { installAutomation } from '@wsb/uikit/automation';
import { ROOT_CLASS, setAppearance, setDensity } from '@wsb/uikit/primitives';
import { worldMatrix } from '@swf/core';
import type { SnapshotStore } from '@swf/persistence';
import { createMemoryStore } from '@swf/persistence';
import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { parseConfig } from '../../src/config.js';
import { createMessages } from '../../src/messages.js';
import { planPreset, PRESETS } from '../../src/presets.js';
import { ShellModel } from '../../src/shell/model.svelte.js';
import Shell from '../../src/shell/Shell.svelte';

const mounted: { model: ShellModel; shell: ReturnType<typeof mount>; root: HTMLElement }[] = [];

afterEach(async () => {
  for (const { model, shell, root } of mounted.splice(0)) {
    await model.dispose();
    await unmount(shell);
    root.remove();
  }
});

/** The application, mounted as the page mounts it, saving to `store`. */
async function start(search: string, store: SnapshotStore) {
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
  const model = new ShellModel(createMessages(), parseConfig(search), { store });
  const shell = mount(Shell, { target: root, props: { model } });
  mounted.push({ model, shell, root });
  const driver = installAutomation(root, () => 'reference');
  await expect.poll(() => model.status, { timeout: 10_000 }).not.toBeNull();
  const settle = async () => {
    await driver.settled();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await driver.settled();
  };
  await settle();
  return { model, root, settle };
}

/** The element with the keyboard, or the one the handle names inside it. */
const focusedHandle = () => {
  const active = document.activeElement;
  return active instanceof HTMLElement
    ? active.closest('[data-wsb]')?.getAttribute('data-wsb')
    : null;
};

/** Presses Tab until the control the handle names has the keyboard; fails past `limit` stops. */
async function tabTo(handle: string, limit = 200): Promise<void> {
  for (let stop = 0; stop < limit; stop += 1) {
    if (focusedHandle() === handle) {
      return;
    }
    await userEvent.tab();
  }
  throw new Error(`Tab never reached ${handle} (it stopped at ${String(focusedHandle())})`);
}

describe('the keyboard alone (§33.2 scenario 10, AC-014, UX-012, FR-109)', () => {
  it('finds, selects, focuses, moves on each axis, changes depth, turns, resizes, groups, locks, undoes, redoes, cancels, saves and restores windows', async () => {
    const store = createMemoryStore();
    const { model, root, settle } = await start('?preset=sparse', store);
    const app = model.app;
    if (app === null) {
      throw new Error('the application did not start');
    }
    const plan = planPreset('sparse', PRESETS.sparse.defaultSeed);
    const [first, second] = plan;
    if (first === undefined || second === undefined) {
      throw new Error('the sparse scene has fewer than two windows');
    }
    const pose = (id: string) => {
      const found = app.poseOf(id);
      if (found === null) {
        throw new Error(`no window "${id}"`);
      }
      return found;
    };
    const history = () => app.workspace.history().length;
    const said = () =>
      root.querySelector('[role="status"][data-wsb="application.announcer"]')?.textContent ?? '';
    const keys = async (text: string) => {
      await userEvent.keyboard(text);
      await settle();
    };
    /** Runs a command from the command list, typed. */
    const palette = async (text: string) => {
      await keys('{F1}');
      expect(focusedHandle()).toBe('application.palette.field');
      await userEvent.keyboard(text);
      await keys('{Enter}');
    };

    // Discover: the command list finds a window by its name and goes to it.
    await palette(`Go to ${first.label}`);
    expect(app.workspace.getState().selection).toEqual([first.id]);
    // The panorama takes the keyboard, says what it is and shows its keys.
    await palette('Go to the panorama');
    expect(document.activeElement).toBe(app.root);
    expect(app.root.getAttribute('role')).toBe('application');
    expect(app.root.getAttribute('aria-description')).toMatch(/Arrows move/);
    expect(root.querySelector('[data-wsb="application.panel.keys"]')).not.toBeNull();

    // Select: N and P step through the windows, each said.
    await keys('n');
    const next = app.workspace.getState().selection[0];
    expect(next).not.toBe(first.id);
    await keys('p');
    expect(app.workspace.getState().selection).toEqual([first.id]);
    expect(said()).toContain(`${first.label} selected`);

    // Move on each axis, and in depth: one change apiece, each said.
    let before = pose(first.id);
    let count = history();
    await keys('{ArrowRight}');
    expect(pose(first.id).heading).toBeGreaterThan(before.heading);
    await keys('{ArrowLeft}');
    expect(pose(first.id).heading).toBeCloseTo(before.heading, 6);
    await keys('{ArrowUp}');
    expect(pose(first.id).elevation).toBeGreaterThan(before.elevation);
    await keys('{ArrowDown}');
    expect(pose(first.id).elevation).toBeCloseTo(before.elevation, 6);
    expect(said()).toContain(`${first.label} moved`);
    await keys('{PageUp}');
    expect(pose(first.id).distance).not.toBeCloseTo(before.distance, 3);
    await keys('{PageDown}');
    expect(pose(first.id).distance).toBeCloseTo(before.distance, 6);
    expect(history()).toBe(count + 6);

    // Turn and resize.
    before = pose(first.id);
    await keys(']');
    expect(pose(first.id).turned).toBeCloseTo(before.turned + 5, 6);
    expect(said()).toContain(`${first.label} turned`);
    await keys('+');
    expect(pose(first.id).width).toBeCloseTo(before.width + 0.05, 6);
    expect(said()).toContain(`${first.label} is now`);

    // Undo and redo in the panorama.
    await keys('{Control>}z{/Control}');
    expect(pose(first.id).width).toBeCloseTo(before.width, 6);
    await keys('{Control>}{Shift>}z{/Shift}{/Control}');
    expect(pose(first.id).width).toBeCloseTo(before.width + 0.05, 6);

    // Cancel: pick it up, move it, and Escape puts it back with nothing changed.
    before = pose(first.id);
    count = history();
    const committed = app.workspace.getState().nodes.get(first.id)?.transform;
    await keys(' ');
    expect(model.policies?.gesture?.operation).toBe('gesture.grab');
    expect(said()).toContain(`${first.label} picked up`);
    await keys('{ArrowRight}{ArrowRight}{PageUp}');
    // The panorama shows it moved; nothing is committed while it is held.
    expect(pose(first.id).heading).toBeGreaterThan(before.heading);
    expect(app.workspace.getState().nodes.get(first.id)?.transform).toBe(committed);
    expect(said()).toContain(`${first.label} would be`);
    await keys('{Escape}');
    expect(model.policies?.gesture).toBeNull();
    expect(pose(first.id).heading).toBeCloseTo(before.heading, 6);
    expect(history()).toBe(count);
    expect(said()).toContain('Cancelled');
    // Picked up again and put down with Enter: one change, which one undo takes back.
    await keys(' {ArrowUp}{ArrowUp}{Enter}');
    expect(history()).toBe(count + 1);
    expect(pose(first.id).elevation).toBeGreaterThan(before.elevation);
    expect(said()).toContain(`${first.label} put down`);

    // Undo from anywhere but a field: the inspector's controls have the keyboard.
    await tabTo('page.inspector.lock');
    await keys('{Control>}z{/Control}');
    expect(pose(first.id).elevation).toBeCloseTo(before.elevation, 6);
    expect(said()).toContain('Undone');
    await keys('{Control>}y{/Control}');
    expect(pose(first.id).elevation).toBeGreaterThan(before.elevation);

    // Lock: the window refuses every key that would move it, saying why, until unlocked.
    await keys(' ');
    expect(app.workspace.getState().nodes.get(first.id)?.flags.locked).toBe(true);
    expect(said()).toContain(`${first.label} locked`);
    await palette('Go to the panorama');
    const locked = pose(first.id);
    await keys('{ArrowRight}');
    expect(pose(first.id).heading).toBe(locked.heading);
    const refusal = root.querySelector('[data-wsb="page.panorama.keys.refusal"]');
    expect(refusal?.getAttribute('role')).toBe('alert');
    expect(refusal?.textContent).toMatch(/Move did nothing: .*locked/);
    await palette(`Unlock ${first.label}`);
    expect(app.workspace.getState().nodes.get(first.id)?.flags.locked).toBe(false);

    // Group: into a new group of its own, from the inspector's controls.
    await tabTo('page.inspector.group.target');
    await keys('{End}');
    await tabTo('page.inspector.group.name');
    await keys('Pinned');
    await tabTo('page.inspector.group');
    await keys('{Enter}');
    const parent = app.workspace.getState().nodes.get(first.id)?.parentId ?? null;
    expect(parent === null ? null : app.workspace.getState().nodes.get(parent)?.label).toBe(
      'Pinned',
    );

    // Focus it, and leave the focus with Escape.
    await palette(`Focus ${first.label}`);
    expect(model.status?.mode).toBe('focus');
    expect(app.workspace.getState().focusedId).toBe(first.id);
    await keys('{Escape}');
    expect(model.status?.mode).toBe('panorama');

    // Save with Ctrl+S, and a new visit restores exactly this layout.
    await keys('{Control>}s{/Control}');
    await expect.poll(() => model.workspaces?.save).toBe('clean');
    expect(said()).toContain('Workspace saved');
    const saved = worldMatrix(app.workspace.getState().nodes, first.id);
    const savedGroup = app.workspace.getState().nodes.get(first.id)?.parentId;
    const again = await start('', store);
    const restored = again.model.app?.workspace.getState();
    expect(restored?.nodes.get(first.id)?.parentId).toBe(savedGroup);
    expect(restored === undefined ? undefined : worldMatrix(restored.nodes, first.id)).toEqual(
      saved,
    );
  });
});
