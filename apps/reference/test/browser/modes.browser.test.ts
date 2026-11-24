import '@wsb/uikit/styles/uikit.scss';
import '@wsb/uikit/fonts';
import { worldMatrix } from '@swf/core';
import type { ViewportFrame } from '@swf/presentation';
import { installAutomation } from '@wsb/uikit/automation';
import type { SurfaceAutomation } from '@wsb/uikit/automation';
import { ROOT_CLASS, setAppearance, setDensity } from '@wsb/uikit/primitives';
import { mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import type { ReferenceApp } from '../../src/app.js';
import { parseConfig } from '../../src/config.js';
import { MAP_SCALE, toMap } from '../../src/map.js';
import { createMessages, ENGLISH } from '../../src/messages.js';
import { ShellModel } from '../../src/shell/model.svelte.js';
import Shell from '../../src/shell/Shell.svelte';

interface Mounted {
  readonly model: ShellModel;
  readonly app: ReferenceApp;
  readonly root: HTMLElement;
  readonly driver: SurfaceAutomation;
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

async function start(search: string, size = { width: 1280, height: 860 }): Promise<Mounted> {
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
  const shell = mount(Shell, { target: root, props: { model, diagnostics: null } });
  current = { model, shell, root };
  const driver = installAutomation(root, () => 'reference');
  const settle = async () => {
    await driver.settled();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await driver.settled();
  };
  await expect.poll(() => model.status, { timeout: 10_000 }).not.toBeNull();
  await settle();
  const app = model.app;
  if (app === null) throw new Error('no application');
  return { model, app, root, driver, settle };
}

/** A frame presented now, once every surface has settled its binding. */
async function frame(app: ReferenceApp): Promise<ViewportFrame> {
  await expect
    .poll(() => app.runtime.list().every((s) => s.state !== 'binding'), { timeout: 5000 })
    .toBe(true);
  const update = await app.viewport.update();
  if (update.status !== 'presented') throw new Error(update.error.message);
  return update;
}

/** The horizontal centre of a surface's fragments in a frame, or null when it shows none. */
function fragmentCentre(f: ViewportFrame, surfaceId: string): number | null {
  const fragments = f.frame.planned.filter((p) => p.fragment.surfaceId === surfaceId);
  const first = fragments[0];
  return first === undefined ? null : first.fragment.bounds[0] + first.fragment.bounds[2] / 2;
}

/** A control's reading, which must be on the surface. */
function reading(driver: SurfaceAutomation, handle: string) {
  const read = driver.read(handle);
  if (!read.present) throw new Error(`${handle} is not on the surface`);
  return read;
}

/** The scene's layout: nodes and surfaces as the snapshot holds them. */
function layout(app: ReferenceApp) {
  const s = app.workspace.serialize();
  return JSON.stringify([s.rootIds, s.nodes, s.surfaces]);
}

function origin(app: ReferenceApp, id: string) {
  const m = worldMatrix(app.workspace.getState().nodes, id);
  if (m === undefined) throw new Error(`no ${id}`);
  return [m[12], m[13], m[14]] as const;
}

describe('focus and context in the shell (FR-120, UX-003)', () => {
  it('shows one window readably with its neighbours reachable, and Escape puts the view back', async () => {
    const { app, driver, root, settle } = await start('?preset=sparse');
    const before = layout(app);
    const camera = app.workspace.getState().cameras.get('camera')?.rotation;
    // Focus is offered once a window is selected.
    expect(reading(driver, 'editor.actions.mode#focus').enabled).toBe(false);
    driver.act('workshop.view#windows', 'press');
    await settle();
    driver.act('page.windows.window#window-03', 'press');
    await settle();
    driver.act('editor.actions.mode#focus', 'press');
    await settle();
    expect(app.status().mode).toBe('focus');
    expect(root.textContent).toContain('Focus: ');
    // The focused window fills most of the view, centred.
    const f = await frame(app);
    const fragment = f.frame.planned.find((p) => p.fragment.surfaceId === 'window-03-surface');
    const size = app.workspace.getState().viewports.get('main')?.size;
    if (fragment === undefined || size === undefined) throw new Error('not shown');
    const [x, y, w, h] = fragment.fragment.bounds;
    expect(Math.max(w / size.width, h / size.height)).toBeGreaterThan(0.5);
    expect(Math.abs(x + w / 2 - size.width / 2)).toBeLessThan(size.width * 0.05);
    expect(Math.abs(y + h / 2 - size.height / 2)).toBeLessThan(size.height * 0.1);
    // Its neighbours are named and reachable: pressing one focuses it.
    const context = app.focusNeighbours();
    const next = context?.right[0] ?? context?.left[0];
    if (next === undefined) throw new Error('no context');
    expect(driver.has(`page.focus.context#${next.id}`)).toBe(true);
    driver.act(`page.focus.context#${next.id}`, 'press');
    await settle();
    expect(app.workspace.getState().focusedId).toBe(next.id);
    expect(app.status().mode).toBe('focus');
    // Escape leaves focus: the panorama, its projection and its camera as they were.
    driver.act('page.panorama', 'key', 'Escape');
    await settle();
    expect(app.status().mode).toBe('panorama');
    expect(app.workspace.getState().cameras.get('camera')?.rotation).toEqual(camera);
    expect(app.workspace.getState().viewports.get('main')?.projection).toEqual({
      id: 'equirectangular/1',
      config: { horizontal: 360, vertical: 120 },
    });
    expect(layout(app)).toBe(before);
    expect(driver.has('page.focus.close')).toBe(false);
  });

  it('refuses focus with nothing to focus, saying why', async () => {
    const { model, root, settle } = await start('?preset=sparse');
    await model.run('reference.focus.enter', {});
    await settle();
    expect(root.textContent).toContain('select a window to focus');
  });
});

describe('the spatial map (FR-124, UX-004, WF-05)', () => {
  it('drags a window on the map, every view following it, and commits once', async () => {
    const { app, driver, settle } = await start('?preset=seam');
    driver.act('editor.actions.mode#map', 'press');
    await settle();
    expect(app.status().mode).toBe('map');
    // The panorama stays presented beside the map.
    expect(reading(driver, 'page.panorama').visible).toBe(true);
    expect(reading(driver, 'page.map').visible).toBe(true);
    // Front and behind are told apart: the window straight behind the camera is quiet.
    expect(driver.read('page.map.unit#window-07').present).toBe(true);
    expect(driver.read('page.map.unit#region.front').present).toBe(true);
    expect(driver.read('page.map.unit#region.behind').present).toBe(true);

    const surface = driver.read('page.map.surface');
    if (!surface.present) throw new Error('no map');
    const view = {
      centre: [0, 0] as const,
      scale: MAP_SCALE.initial,
      width: surface.box.width,
      height: surface.box.height,
    };
    const [wx, , wz] = origin(app, 'window-07');
    const [px, py] = toMap(view, wx, wz);
    const at = (x: number, y: number) => [surface.box.x + x, surface.box.y + y] as const;
    const revision = app.workspace.getState().revision;
    const before = fragmentCentre(await frame(app), 'window-07-surface');

    await commands.mouse('move', ...at(px, py));
    await commands.mouse('down', ...at(px, py));
    // Ninety degrees to the right of the camera, on the ground.
    const [tx, ty] = toMap(view, 3, 0);
    await commands.mouse('move', ...at((px + tx) / 2, (py + ty) / 2));
    await commands.mouse('move', ...at(tx, ty));
    await settle();
    // Selected by the press; previewed in every view, nothing committed yet.
    expect(app.workspace.getState().selection).toEqual(['window-07']);
    const selectedAt = app.workspace.getState().revision;
    const during = fragmentCentre(await frame(app), 'window-07-surface');
    expect(during).not.toBeNull();
    expect(during).not.toBeCloseTo(before ?? 0, 0);
    await commands.mouse('up', ...at(tx, ty));
    await settle();
    expect(app.workspace.getState().revision).toBe(selectedAt + 1);
    expect(selectedAt).toBe(revision + 1);
    const [x, , z] = origin(app, 'window-07');
    expect(x).toBeCloseTo(3, 1);
    expect(z).toBeCloseTo(0, 1);
    // The panorama shows it a quarter turn to the right of straight ahead.
    const size = app.workspace.getState().viewports.get('main')?.size;
    if (size === undefined) throw new Error('no size');
    const after = fragmentCentre(await frame(app), 'window-07-surface');
    expect(after).toBeCloseTo(size.width * 0.75, -1);
  });

  it('raises a window with the height control, which a map from above cannot show', async () => {
    const { app, driver, root, settle } = await start('?preset=seam');
    await current?.model.showInMap('window-02');
    await settle();
    expect(app.status().mode).toBe('map');
    const [x, , z] = origin(app, 'window-02');
    driver.act('page.map.height', 'set', '1.5');
    await settle();
    const [x2, y2, z2] = origin(app, 'window-02');
    expect(y2).toBeCloseTo(1.5, 9);
    expect(x2).toBeCloseTo(x, 9);
    expect(z2).toBeCloseTo(z, 9);
    driver.act('page.map.height', 'set', 'high');
    await settle();
    expect(root.textContent).toContain(ENGLISH['map.number.invalid']);
    expect(origin(app, 'window-02')[1]).toBeCloseTo(1.5, 9);
  });
});

describe('the tiled overview (FR-128, UX-005)', () => {
  it('selects and focuses the original windows, sharing focus with every mode', async () => {
    const { app, driver, settle } = await start('?preset=dense');
    driver.act('editor.actions.mode#overview', 'press');
    await settle();
    expect(app.status().mode).toBe('overview');
    // A page of tiles, and the rest a press away.
    expect(driver.has('page.overview.tile#window-01')).toBe(true);
    expect(driver.has('page.overview.more')).toBe(true);
    driver.act('page.overview.tile#window-11', 'press');
    await settle();
    expect(app.workspace.getState().selection).toEqual(['window-11']);
    driver.act('page.overview.tile#window-11', 'open');
    await settle();
    expect(app.status().mode).toBe('focus');
    expect(app.workspace.getState().focusedId).toBe('window-11');
  });
});

describe('search (§19, FR-190–FR-193)', () => {
  it('finds windows by metadata after typing pauses, lists hundreds without drawing them all, and acts on one', async () => {
    const { app, driver, root, settle } = await start('?preset=dense');
    driver.act('workshop.view#windows', 'press');
    await settle();
    const rows = () => root.querySelectorAll('[data-wsb^="page.windows.window#"]').length;
    // 250 windows, a few dozen rows drawn.
    expect(root.textContent).toContain('250 windows');
    expect(rows()).toBeGreaterThan(0);
    expect(rows()).toBeLessThan(80);
    const colour = app.workspace.getState().nodes.get('window-01')?.metadata[
      'host.reference.colour'
    ];
    if (typeof colour !== 'string') throw new Error('no colour');
    driver.act('page.windows.search.field', 'type', colour.toLowerCase());
    // Typing waits for its pause before it searches.
    expect(app.search.pending()).toBe(true);
    expect(app.search.query().text).toBe('');
    await expect.poll(() => app.search.query().text, { timeout: 2000 }).toBe(colour.toLowerCase());
    await settle();
    const found = app.search.ids();
    expect(found).toContain('window-01');
    expect(found.length).toBeLessThan(250);
    expect(root.textContent).toContain(`${String(found.length)} windows`);
    // Show in map: selected, the map shown, and nothing moved.
    const before = layout(app);
    driver.act('page.windows.window#window-01', 'hover');
    driver.act('page.windows.row.map#window-01', 'press');
    await settle();
    expect(app.status().mode).toBe('map');
    expect(app.workspace.getState().selection).toEqual(['window-01']);
    expect(layout(app)).toBe(before);
  });

  it('says when nothing matches, and clears its filters or resets', async () => {
    const { driver, root, settle } = await start('?preset=sparse');
    driver.act('workshop.view#windows', 'press');
    await settle();
    driver.act('page.windows.filters', 'press');
    await settle();
    driver.act('page.windows.filter.lock', 'choose', 'locked');
    await settle();
    expect(root.textContent).toContain(ENGLISH['search.empty']);
    driver.act('page.windows.empty.clear', 'press');
    await settle();
    expect(root.textContent).toContain('6 windows');
    driver.act('page.windows.search.field', 'type', 'nothing like this');
    await expect.poll(() => root.textContent.includes(ENGLISH['search.empty'])).toBe(true);
    driver.act('page.windows.empty.reset', 'press');
    await settle();
    expect(root.textContent).toContain('6 windows');
  });
});

describe('switching every mode over one scene (FR-129, AC-007, §33.2 scenario 3)', () => {
  it('focus, map, overview, another window, panorama: IDs, attachments and transforms unchanged', async () => {
    const { app, driver, root, settle } = await start('?preset=seam');
    await frame(app);
    const before = layout(app);
    const handles = new Map(
      app.runtime.list().map((s) => [s.surfaceId, app.runtime.handleOf(s.surfaceId)]),
    );
    const states = JSON.stringify(
      app.runtime.list().map((s) => [s.surfaceId, s.state, s.generation]),
    );
    const camera = app.workspace.getState().cameras.get('camera')?.rotation;
    // The panorama's own element: presented in the page all the way through.
    const viewport = root.querySelector('[data-swf-viewport]');

    driver.act('workshop.view#windows', 'press');
    await settle();
    driver.act('page.windows.window#window-01', 'press');
    await settle();
    driver.act('editor.actions.mode#focus', 'press');
    await settle();
    driver.act('editor.actions.mode#map', 'press');
    await settle();
    driver.act('editor.actions.mode#overview', 'press');
    await settle();
    driver.act('page.overview.tile#window-04', 'press');
    await settle();
    driver.act('editor.actions.mode#panorama', 'press');
    await settle();
    await frame(app);

    expect(app.status().mode).toBe('panorama');
    expect(root.querySelector('[data-swf-viewport]')).toBe(viewport);
    expect(viewport?.isConnected).toBe(true);
    expect(app.workspace.getState().selection).toEqual(['window-04']);
    expect(app.workspace.getState().cameras.get('camera')?.rotation).toEqual(camera);
    expect(layout(app)).toBe(before);
    for (const [id, handle] of handles) {
      expect(app.runtime.handleOf(id), id).toBe(handle);
    }
    expect(
      JSON.stringify(app.runtime.list().map((s) => [s.surfaceId, s.state, s.generation])),
    ).toBe(states);
  });
});
