import '@wsb/uikit/styles/uikit.scss';
import '@wsb/uikit/fonts';
import { installAutomation } from '@wsb/uikit/automation';
import type { SurfaceAutomation } from '@wsb/uikit/automation';
import { ROOT_CLASS, setAppearance, setDensity } from '@wsb/uikit/primitives';
import { mount, unmount } from 'svelte';
import { worldMatrix } from '@swf/core';
import { viewGeometryOf } from '@swf/presentation';
import { equirectangular } from '@swf/projections';
import { afterEach, describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { VIEWPORT_ID } from '../../src/app.js';
import { FEATURE_IDS } from '../../src/features.js';
import { MAGNETIC_POLICY_ID } from '../../src/magnetic-policy.js';
import { WORKSPACE_GROUP_ID } from '../../src/presets.js';
import { parseConfig } from '../../src/config.js';
import { createMessages, ENGLISH } from '../../src/messages.js';
import { planPreset } from '../../src/presets.js';
import { ShellModel } from '../../src/shell/model.svelte.js';
import DiagnosticsView from '../../src/shell/DiagnosticsView.svelte';
import Shell from '../../src/shell/Shell.svelte';

declare module 'vitest/browser' {
  interface BrowserCommands {
    mouse: (
      action: 'move' | 'down' | 'up',
      x: number,
      y: number,
      modifiers?: readonly string[],
    ) => Promise<void>;
  }
}

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

  it('is the whole centre: the view the kit hosts, with no tab, strip or group around it', async () => {
    const { driver, root } = await start('?preset=seam');
    const centre = root.querySelector('[data-wsb="editor.view"]');
    expect(centre?.getAttribute('aria-label')).toBe(ENGLISH['view.label']);
    expect(centre?.querySelector(PANORAMA)).not.toBeNull();
    expect(centre?.querySelectorAll('[data-swf-viewport]')).toHaveLength(1);
    for (const handle of ['editor.tabs', 'editor.group', 'editor.menu']) {
      const named = [...root.querySelectorAll('[data-wsb]')].filter((element) =>
        element.getAttribute('data-wsb')?.startsWith(handle),
      );
      expect(named, handle).toEqual([]);
    }
    // The view's commands end the head across the centre's top.
    expect(driver.has('editor.actions.backend')).toBe(true);
    expect(driver.has('editor.actions.commands')).toBe(true);
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

describe('the optional policies (FR-130, UX-006, UX-007, UX-010, §33.2 scenario 5)', () => {
  /** Every node's place and every surface's binding: what turning a policy off must not change. */
  const layoutOf = (model: ShellModel) => {
    const state = model.app?.workspace.getState();
    return JSON.stringify([
      [...(state?.nodes.values() ?? [])].map((n) => [n.id, n.parentId, n.transform]),
      [...(state?.surfaces.values() ?? [])].map((s) => [s.id, s.bindingKey]),
      state?.orbitRootId,
    ]);
  };

  it('turns each policy off on its own, taking its controls away and keeping the layout, and resets to all on', async () => {
    const { model, driver, settle } = await start('?preset=sparse');
    driver.act('workshop.view#features', 'press');
    await settle();
    const layout = layoutOf(model);
    const affordance: Record<(typeof FEATURE_IDS)[number], () => boolean> = {
      orbit: () => driver.has('editor.actions.navigation'),
      depth: () => driver.has('page.features.depth-full'),
      snap: () => model.app?.router.policyIds().includes(MAGNETIC_POLICY_ID) === true,
      cursor: () => driver.has('page.features.cursor.limits'),
    };
    for (const feature of FEATURE_IDS) {
      expect(affordance[feature](), feature).toBe(true);
      driver.act(`page.features.${feature}.enabled`, 'toggle');
      await settle();
      expect(model.policies?.features.enabled[feature], feature).toBe(false);
      expect(affordance[feature](), feature).toBe(false);
      // The others stay on.
      for (const other of FEATURE_IDS.filter((f) => f !== feature)) {
        expect(model.policies?.features.enabled[other], other).toBe(true);
      }
      expect(layoutOf(model), feature).toBe(layout);
      driver.act(`page.features.${feature}.enabled`, 'toggle');
      await settle();
    }
    for (const feature of FEATURE_IDS) {
      driver.act(`page.features.${feature}.enabled`, 'toggle');
    }
    await settle();
    expect(Object.values(model.policies?.features.enabled ?? {})).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(layoutOf(model)).toBe(layout);
    driver.act('page.features.reset', 'press');
    await settle();
    expect(model.policies?.features.enabled).toEqual({
      orbit: true,
      depth: true,
      snap: true,
      cursor: true,
    });
  });

  it('says what background drags turn, switches it where the view is, and undoes a workspace turn', async () => {
    const { model, driver, root, settle } = await start('?preset=sparse');
    const said = (handle: string) =>
      root.querySelector(`[data-wsb="${handle}"]`)?.textContent ?? '';
    expect(said('application.panel.navigation')).toContain(ENGLISH['navigation.status.camera']);
    expect(driver.has('page.panorama.navigation')).toBe(false);
    driver.act('editor.actions.navigation#orbit', 'press');
    await settle();
    expect(model.policies?.orbit.navigation).toBe('orbit');
    expect(said('application.panel.navigation')).toContain(ENGLISH['navigation.status.orbit']);
    expect(said('page.panorama.navigation')).toContain('Workspace group');
    const undo = () => root.querySelector<HTMLButtonElement>('[data-wsb="editor.actions.undo"]');
    const turned = () => model.app?.workspace.getState().nodes.get(WORKSPACE_GROUP_ID)?.transform;
    const before = turned();
    driver.act('workshop.view#features', 'press');
    await settle();
    driver.act('page.features.orbit.right', 'press');
    await settle();
    expect(turned()).not.toEqual(before);
    expect(undo()?.disabled).toBe(false);
    driver.act('editor.actions.undo', 'press');
    await settle();
    expect(turned()).toEqual(before);
    driver.act('editor.actions.redo', 'press');
    await settle();
    expect(turned()).not.toEqual(before);
    // Orbit off: the switch goes, and drags turn the camera again.
    driver.act('page.features.orbit.enabled', 'toggle');
    await settle();
    expect(model.policies?.orbit.navigation).toBe('camera');
    expect(driver.has('page.panorama.navigation')).toBe(false);
  });

  it('refuses a band that ends before the one inside it, saying why at its field', async () => {
    const { model, driver, root, settle } = await start('?preset=sparse');
    driver.act('workshop.view#features', 'press');
    await settle();
    const bands = model.policies?.features.depth;
    driver.act('page.features.depth-compact', 'set', '2');
    driver.act('page.features.depth-compact', 'key', 'Enter');
    await settle();
    expect(model.policies?.features.depth).toEqual(bands);
    expect(root.querySelector('[data-wsb="page.features.depth"]')?.textContent).toContain(
      'the compact band must end farther than the full one',
    );
    driver.act('page.features.depth-compact', 'set', '7');
    driver.act('page.features.depth-compact', 'key', 'Enter');
    await settle();
    expect(model.policies?.features.depth.compact).toBe(7);
  });

  it('shows a move’s preview, the snap in force and how to cancel it, then how it ended, with undo', async () => {
    const { model, driver, root, settle } = await start('?preset=seam');
    const app = model.app;
    if (app === null) {
      throw new Error('no application');
    }
    // window-07 straight ahead, pressed on its content with the takeover modifier and lifted.
    const state = app.workspace.getState();
    const m = worldMatrix(state.nodes, 'window-07');
    const view = viewGeometryOf(state, VIEWPORT_ID);
    const image = equirectangular
      .create(view.projectionConfig)
      .projectDirection([m?.[12] ?? 0, m?.[13] ?? 0, m?.[14] ?? 0], view).images[0];
    const box = root.querySelector('[data-swf-viewport]')?.getBoundingClientRect();
    if (image === undefined || box === undefined) {
      throw new Error('window-07 is not in view');
    }
    const x = box.left + image[0];
    const y = box.top + image[1];
    const before = app.workspace.getState().nodes.get('window-07')?.transform;
    const lift = async () => {
      await commands.mouse('move', x, y);
      await commands.mouse('down', x, y, ['Alt']);
      for (let dy = 2; dy <= 24; dy += 2) {
        await commands.mouse('move', x + dy, y - dy);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      await settle();
    };
    await lift();
    const strip = () =>
      root.querySelector(`[aria-label="${ENGLISH['gesture.label']}"]`)?.textContent ?? '';
    expect(strip()).toContain('Moving Note 07');
    expect(driver.has('page.gesture.cancel')).toBe(true);
    driver.act('page.gesture.cancel', 'press');
    await settle();
    await commands.mouse('up', x + 24, y - 24);
    await settle();
    expect(strip()).toContain(ENGLISH['gesture.cancelled']);
    expect(app.workspace.getState().nodes.get('window-07')?.transform).toEqual(before);

    await lift();
    await commands.mouse('up', x + 24, y - 24);
    await settle();
    expect(strip()).toContain('Moved Note 07');
    expect(app.workspace.getState().nodes.get('window-07')?.transform).not.toEqual(before);
    driver.act('page.gesture.undo', 'press');
    await settle();
    expect(app.workspace.getState().nodes.get('window-07')?.transform).toEqual(before);
  });
});
