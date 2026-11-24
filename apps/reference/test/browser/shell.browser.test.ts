import '@wsb/uikit/styles/uikit.scss';
import '@wsb/uikit/fonts';
import { installAutomation } from '@wsb/uikit/automation';
import type { SurfaceAutomation } from '@wsb/uikit/automation';
import { ROOT_CLASS, setAppearance, setDensity } from '@wsb/uikit/primitives';
import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { createMessages, ENGLISH } from '../../src/messages.js';
import { planPreset } from '../../src/presets.js';
import { ShellModel } from '../../src/shell/model.svelte.js';
import DiagnosticsView from '../../src/shell/DiagnosticsView.svelte';
import Shell from '../../src/shell/Shell.svelte';

/** The shell, mounted as the page mounts it: the kit's root class, appearance and density set. */
interface Mounted {
  readonly model: ShellModel;
  readonly root: HTMLElement;
  readonly driver: SurfaceAutomation;
  /** Waits until the driver's handles are settled and the scene's status has caught up. */
  readonly settle: () => Promise<void>;
}

let current: { model: ShellModel; shell: ReturnType<typeof mount>; root: HTMLElement } | null =
  null;

afterEach(async () => {
  if (current !== null) {
    await current.model.dispose();
    await unmount(current.shell);
    current.root.remove();
    current = null;
  }
});

async function start(search: string, size = { width: 1280, height: 760 }): Promise<Mounted> {
  const html = document.documentElement;
  html.classList.add(ROOT_CLASS);
  setAppearance(html, 'light');
  setDensity(html, 'default');
  const root = document.createElement('div');
  root.style.setProperty('position', 'absolute');
  root.style.setProperty('inset', '0 auto auto 0');
  root.style.setProperty('width', `${String(size.width)}px`);
  root.style.setProperty('height', `${String(size.height)}px`);
  document.body.append(root);
  const model = new ShellModel(createMessages(), parseConfig(search));
  const shell = mount(Shell, { target: root, props: { model, diagnostics: DiagnosticsView } });
  current = { model, shell, root };
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

/** The panorama's own presentation: what the framework draws, not the shell. */
const PANORAMA = '[data-wsb="page.panorama"]';

describe('the shell (UX-001, UX-015)', () => {
  it('builds every control from the kit: each one carries a handle and only the kit’s classes', async () => {
    const { root } = await start('?preset=sparse');
    const controls = [
      ...root.querySelectorAll(
        'button, input, select, textarea, a[href], [role="button"], [role="tab"], [tabindex]',
      ),
    ].filter((element) => element.closest(PANORAMA) === null);
    expect(controls.length).toBeGreaterThan(10);
    const unaddressed = controls
      .filter((element) => element.closest('[data-wsb]') === null)
      .map((element) => element.outerHTML.slice(0, 120));
    expect(unaddressed).toEqual([]);
    const foreign = [...root.querySelectorAll('[class]')]
      .filter((element) => element.closest(PANORAMA) === null)
      .flatMap((element) => [...element.classList].filter((c) => !c.startsWith('wsb-')))
      .filter((c) => !c.startsWith('svelte-') && !c.startsWith('lucide'));
    expect([...new Set(foreign)]).toEqual([]);
  });

  it('lays the window out as the kit does: the scene and windows on the left, the inspector on the right, the panorama in the centre, status in the panel', async () => {
    const { driver } = await start('?preset=sparse');
    for (const handle of [
      'workshop.view#scene',
      'workshop.view#windows',
      'worktree.view#inspector',
      'worktree.view#diagnostics',
      'page.scene.preset',
      'page.panorama',
      'editor.actions.backend',
      'editor.actions.commands',
      'application.panel.tabs#status',
      'page.inspector',
    ]) {
      expect(driver.has(handle), handle).toBe(true);
    }
  });

  it('says every string from the message catalogue', async () => {
    const { root } = await start('?preset=sparse');
    const text = root.textContent;
    for (const id of [
      'scene.preset',
      'scene.seed',
      'command.scene.reset',
      'view.takeover',
    ] as const) {
      expect(text).toContain(ENGLISH[id]);
    }
  });
});

describe('the scene’s controls (FR-012, FR-131)', () => {
  it('loads a preset, reseeds from a typed seed, reseeds to the next and resets', async () => {
    const { model, driver, settle } = await start('?preset=sparse&seed=1');
    driver.act('page.scene.preset', 'choose', 'seam');
    await settle();
    expect(model.status?.scene).toEqual({ preset: 'seam', seed: 1 });
    expect(model.status?.windows).toBe(planPreset('seam', 1).length);

    driver.act('page.scene.seed', 'set', '7');
    driver.act('page.scene.seed', 'key', 'Enter');
    await settle();
    expect(model.status?.scene).toEqual({ preset: 'seam', seed: 7 });

    driver.act('page.scene.reseed', 'press');
    await settle();
    expect(model.status?.scene).toEqual({ preset: 'seam', seed: 8 });

    const app = model.app;
    if (app === null) {
      throw new Error('no application');
    }
    app.workspace.dispatch({
      type: 'node.patch',
      id: 'window-01',
      transform: { position: [0, 1, -2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    });
    driver.act('page.scene.reset', 'press');
    await settle();
    expect(app.workspace.getState().nodes.get('window-01')?.transform.position).not.toEqual([
      0, 1, -2,
    ]);
    expect(model.status?.scene).toEqual({ preset: 'seam', seed: 8 });
  });

  it('refuses a seed out of range, saying why at the field, and keeps the scene', async () => {
    const { model, driver, root, settle } = await start('?preset=sparse&seed=3');
    driver.act('page.scene.seed', 'set', '4294967296');
    driver.act('page.scene.seed', 'key', 'Enter');
    await settle();
    expect(root.textContent).toContain(ENGLISH['scene.seed.invalid']);
    expect(model.status?.scene).toEqual({ preset: 'sparse', seed: 3 });
  });
});

describe('the empty state (UX-009)', () => {
  it('explains how windows are added, and adds them in one press', async () => {
    const { model, driver, root, settle } = await start('?preset=empty');
    expect(model.status?.windows).toBe(0);
    expect(root.textContent).toContain(ENGLISH['empty.title']);
    expect(root.textContent).toContain(ENGLISH['empty.body']);
    driver.act('page.panorama.load', 'press');
    await settle();
    expect(model.status?.windows).toBe(6);
    expect(driver.has('page.panorama.load')).toBe(false);
  });
});

describe('command and search (UX-001)', () => {
  it('opens on Ctrl+Shift+P, finds a window by its name, and goes to it', async () => {
    const { model, driver, root, settle } = await start('?preset=seam');
    driver.act('page.panorama', 'key', 'Control+Shift+P');
    await settle();
    expect(driver.has('application.palette')).toBe(true);
    driver.act('application.palette.field', 'type', 'note 05');
    await settle();
    driver.act('application.palette.list#window.window-05', 'press');
    await settle();
    expect(driver.has('application.palette')).toBe(false);
    expect(model.selected?.id).toBe('window-05');
    expect(model.app?.workspace.getState().focusedId).toBe('window-05');
    expect(root.querySelector('[data-wsb="page.inspector"]')?.textContent).toContain('window-05');
  });

  it('runs a command from the list', async () => {
    const { model, driver, settle } = await start('?preset=sparse');
    driver.act('editor.actions.commands', 'press');
    await settle();
    driver.act('application.palette.list#preset.dense', 'press');
    await settle();
    expect(model.status).toMatchObject({ scene: { preset: 'dense', seed: 1 }, windows: 250 });
  });
});

describe('the panorama in the centre (UX-002)', () => {
  it('switches the backend from the editor actions', async () => {
    const { model, driver, settle } = await start('?preset=seam');
    expect(model.status?.backend).toBe('dom');
    driver.act('editor.actions.backend#geometry', 'press');
    await expect.poll(() => model.status?.backend, { timeout: 5000 }).toBe('geometry');
    await settle();
  });

  it('keeps presenting the same workspace when its tab is closed and shown again', async () => {
    const { model, driver, root, settle } = await start('?preset=seam');
    /** The scene's layout: everything but view state, which follows the view's new size. */
    const layout = () => {
      const s = model.app?.workspace.serialize();
      return JSON.stringify([s?.nodes, s?.surfaces, s?.selection]);
    };
    const before = layout();
    driver.act('editor.tabs.tab.close#group:1|panorama', 'press');
    await settle();
    expect(root.querySelectorAll('[data-swf-viewport]')).toHaveLength(0);
    expect(root.textContent).toContain(ENGLISH['panorama.closed.title']);
    driver.act('editor.panorama.open', 'press');
    await settle();
    await expect
      .poll(() => root.querySelectorAll(`${PANORAMA} [data-swf-viewport]`).length, {
        timeout: 5000,
      })
      .toBe(1);
    expect(layout()).toBe(before);
    expect(root.querySelectorAll('[data-reference-content]').length).toBe(
      planPreset('seam', 1).filter((w) => w.content === 'note').length,
    );
  });
});

describe('a narrow window (UX-001)', () => {
  it('keeps the panorama, floating one side over it at a time', async () => {
    const { driver, root, settle } = await start('?preset=sparse', { width: 560, height: 760 });
    const panorama = root.querySelector(PANORAMA)?.getBoundingClientRect();
    expect(panorama?.height ?? 0).toBeGreaterThan(300);
    expect(panorama?.width ?? 0).toBeGreaterThan(400);
    driver.act('workshop.view#scene', 'press');
    await settle();
    driver.act('workshop.view#scene', 'press');
    await settle();
    expect(driver.read('page.scene.preset').present).toBe(true);
  });
});
