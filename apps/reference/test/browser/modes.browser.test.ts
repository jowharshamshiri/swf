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
import { MAP_SCALE, mapScene, toMap } from '../../src/map.js';
import { createMessages, ENGLISH } from '../../src/messages.js';
import { overviewScene } from '../../src/overview.js';
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
  const shell = mount(Shell, { target: root, props: { model, developer: null } });
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

  it('selects a window pressed on the map without moving it, even when the pointer stirs (UX-004)', async () => {
    const { app, driver, settle } = await start('?preset=seam');
    driver.act('editor.actions.mode#map', 'press');
    await settle();
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
    const [x, y] = [surface.box.x + px + 3, surface.box.y + py - 2];
    const before = layout(app);
    const history = app.workspace.history().length;
    await commands.mouse('move', x, y);
    await commands.mouse('down', x, y);
    // A hand pressing a mouse button stirs it a pixel or two.
    await commands.mouse('move', x + 2, y + 1);
    await commands.mouse('up', x + 2, y + 1);
    await settle();
    expect(app.workspace.getState().selection).toEqual(['window-07']);
    expect(layout(app)).toBe(before);
    expect(app.workspace.history()).toHaveLength(history);
  });

  it('names every window, the ground in front and behind at its edges, and its rings by distance', async () => {
    const { app, root, driver, settle } = await start('?preset=studio');
    driver.act('editor.actions.mode#map', 'press');
    await settle();
    // Out far enough to hold most of the studio.
    for (let i = 0; i < 3; i++) {
      driver.act('page.map.zoom-out', 'press');
      await settle();
    }
    const map = reading(driver, 'page.map');
    const titled = [...root.querySelectorAll('[data-wsb^="page.map.unit#"]')]
      .filter((unit) => unit.classList.contains('wsb-stage__unit--titled'))
      .map((unit) => ({
        key: (unit.getAttribute('data-wsb') ?? '').slice('page.map.unit#'.length),
        box: unit.getBoundingClientRect(),
      }));
    const keys = titled.map((t) => t.key);
    // Every window whose name falls on the map is named: none is left out for the readings.
    const placed = [...root.querySelectorAll('[data-wsb^="page.map.unit#"]')]
      .map((unit) => (unit.getAttribute('data-wsb') ?? '').slice('page.map.unit#'.length))
      .filter((key) => app.workspace.getState().nodes.get(key)?.kind === 'window');
    expect(placed.length).toBeGreaterThanOrEqual(8);
    for (const id of placed) {
      expect(keys, id).toContain(id);
    }
    // In front and behind, each named once, at the map's top and bottom edges as it faces.
    expect(keys.filter((k) => k === 'region.front')).toHaveLength(1);
    expect(keys.filter((k) => k === 'region.behind')).toHaveLength(1);
    const front = titled.find((t) => t.key === 'region.front')?.box;
    const behind = titled.find((t) => t.key === 'region.behind')?.box;
    expect((front?.top ?? 0) - map.box.y).toBeLessThan(20);
    expect(map.box.y + map.box.height - (behind?.bottom ?? 0)).toBeLessThan(20);
    // A ring's distance is written.
    expect(keys.some((k) => k.startsWith('ring.'))).toBe(true);
    // No two names written over each other.
    for (const a of titled) {
      for (const b of titled) {
        if (a === b) continue;
        const apart =
          a.box.right <= b.box.left + 0.5 ||
          b.box.right <= a.box.left + 0.5 ||
          a.box.bottom <= b.box.top + 0.5 ||
          b.box.bottom <= a.box.top + 0.5;
        expect(apart, `${a.key} and ${b.key}`).toBe(true);
      }
    }
    // A name is not written across its own window's line where a place clear of it is free: the
    // project board, straight ahead, has its line across the map, and is named above or below it.
    const surface = reading(driver, 'page.map.surface');
    const view = {
      centre: [0, 0] as const,
      scale: MAP_SCALE.initial / MAP_SCALE.step ** 3,
      width: surface.box.width,
      height: surface.box.height,
    };
    const board = mapScene(app.workspace.getState(), 'main').markers.find((m) => m.id === 'board');
    const name = titled.find((t) => t.key === 'board')?.box;
    if (board === undefined || name === undefined)
      throw new Error('the project board is not named');
    const [a, b] = board.ends.map((end) => toMap(view, end[0], end[1]));
    if (a === undefined || b === undefined) throw new Error('the project board has no line');
    expect(Math.abs(a[1] - b[1])).toBeLessThan(0.5);
    for (let i = 0; i <= 200; i++) {
      const x = surface.box.x + a[0] + ((b[0] - a[0]) * i) / 200;
      const y = surface.box.y + a[1] + ((b[1] - a[1]) * i) / 200;
      const inside =
        x > name.left + 0.5 && x < name.right - 0.5 && y > name.top + 0.5 && y < name.bottom - 0.5;
      expect(inside, 'the project board is named across its line').toBe(false);
    }
  });

  it('gives a name with few places room before names that have others', async () => {
    // Wide, three steps out: Media Notes stands at the map's right edge, where its name fits only
    // to its left, above or below, each a place Code Review's name, to the right of its own mark,
    // would take; Code Review has room to its left.
    const { app, root, driver, settle } = await start('?preset=studio', {
      width: 1600,
      height: 1000,
    });
    driver.act('editor.actions.mode#map', 'press');
    await settle();
    for (let i = 0; i < 3; i++) {
      driver.act('page.map.zoom-out', 'press');
      await settle();
    }
    const units = [...root.querySelectorAll('[data-wsb^="page.map.unit#"]')].map((unit) => ({
      key: (unit.getAttribute('data-wsb') ?? '').slice('page.map.unit#'.length),
      titled: unit.classList.contains('wsb-stage__unit--titled'),
    }));
    const windows = units.filter(
      (u) => app.workspace.getState().nodes.get(u.key)?.kind === 'window',
    );
    expect(windows.map((u) => u.key)).toContain('media');
    expect(windows.filter((u) => !u.titled).map((u) => u.key)).toEqual([]);
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

describe('the spatial overview (FR-128, UX-005)', () => {
  /** A card's box on the page, from the stage's unit for it. */
  function cardBox(root: HTMLElement, id: string): DOMRect {
    const unit = root.querySelector(`[data-wsb="page.overview.board.unit#${id}"]`);
    if (unit === null) throw new Error(`no card for "${id}"`);
    return unit.getBoundingClientRect();
  }
  function boardViewport(root: HTMLElement): HTMLElement {
    const canvas = root.querySelector('[data-wsb="page.overview.board.surface"]');
    const viewport = canvas?.parentElement;
    if (!(viewport instanceof HTMLElement)) throw new Error('no overview board');
    return viewport;
  }

  it('lays every window out as a card where it stands, named, with the list beside it', async () => {
    const { app, driver, root, settle } = await start('?preset=studio');
    const history = app.workspace.history().length;
    const before = layout(app);
    driver.act('editor.actions.mode#overview', 'press');
    await settle();
    expect(app.status().mode).toBe('overview');
    // Every window is a card, its name written on it; the regions are named across the top.
    const ids = [...app.workspace.getState().nodes.values()]
      .filter((n) => n.kind === 'window')
      .map((n) => n.id);
    expect(ids).toHaveLength(13);
    for (const id of ids) {
      const card = reading(driver, `page.overview.board.unit#${id}`);
      expect(card.visible, id).toBe(true);
      expect(card.text, id).toContain(app.workspace.getState().nodes.get(id)?.label ?? id);
    }
    for (const region of ['ahead', 'left', 'right', 'behind-left', 'behind-right']) {
      expect(driver.read(`page.overview.board.unit#region.${region}`).present, region).toBe(true);
    }
    // Spatially: straight ahead in the middle, left to the left, behind at the edges.
    const board = boardViewport(root).getBoundingClientRect();
    const centre = (id: string) => {
      const box = cardBox(root, id);
      return (box.left + box.right) / 2 - board.left;
    };
    expect(centre('board')).toBeCloseTo(board.width / 2, -1);
    expect(centre('desk')).toBeLessThan(centre('board'));
    expect(centre('builds')).toBeGreaterThan(centre('board'));
    expect(centre('reading')).toBeGreaterThan(board.width * 0.85);
    expect(centre('calendar')).toBeLessThan(board.width * 0.25);
    // Above the horizon higher up: the sketches (32° up) over the signal monitor (28° down).
    expect(cardBox(root, 'sketches').top).toBeLessThan(cardBox(root, 'signals').top);
    // The searchable list is still there, every window in it.
    for (const id of ids) {
      expect(driver.read(`page.overview.tile#${id}`).present, id).toBe(true);
    }
    // Looking changed nothing.
    expect(layout(app)).toBe(before);
    expect(app.workspace.history()).toHaveLength(history);
  });

  it('selects from a card, focuses from a double press, and reveals from the selected actions', async () => {
    const { app, root, driver, settle } = await start('?preset=studio');
    driver.act('editor.actions.mode#overview', 'press');
    await settle();
    const box = cardBox(root, 'metrics');
    const frame = root.getBoundingClientRect();
    const [x, y] = [box.left + box.width / 2 - frame.left, box.top + box.height / 2 - frame.top];
    await commands.mouse('move', x, y);
    await commands.mouse('down', x, y);
    await commands.mouse('up', x, y);
    await settle();
    expect(app.workspace.getState().selection).toEqual(['metrics']);
    // The row for it in the list is selected too: one selection, the scene's.
    expect(reading(driver, 'page.overview.tile#metrics').state['data-selected']).toBe('true');
    // Centre the view on it: the panorama, turned to face it.
    driver.act('page.overview.selected.reveal#metrics', 'press');
    await settle();
    expect(app.status().mode).toBe('panorama');
    const metrics = overviewScene(app.workspace.getState(), 'main').entries.find(
      (e) => e.id === 'metrics',
    );
    expect(Math.abs(metrics?.heading ?? 180)).toBeLessThan(1);
    // Back in the overview its card stands in the middle; a double press on another focuses it.
    driver.act('editor.actions.mode#overview', 'press');
    await settle();
    await expect
      .poll(() => Math.abs(cardCentre(root, 'metrics') - boardCentre(root)), { timeout: 2000 })
      .toBeLessThan(4);
    const archive = cardBox(root, 'archive');
    boardViewport(root).dispatchEvent(
      new MouseEvent('dblclick', {
        bubbles: true,
        clientX: archive.left + archive.width / 2,
        clientY: archive.top + archive.height / 2,
      }),
    );
    await settle();
    expect(app.status().mode).toBe('focus');
    expect(app.workspace.getState().focusedId).toBe('archive');
  });

  it('opens a row of the list to focus its window, as before, in a scene of hundreds', async () => {
    const { app, driver, settle } = await start('?preset=dense');
    driver.act('editor.actions.mode#overview', 'press');
    await settle();
    expect(app.status().mode).toBe('overview');
    // A page of rows, and the rest a press away; every window a card on the board.
    expect(driver.has('page.overview.tile#window-01')).toBe(true);
    expect(driver.has('page.overview.more')).toBe(true);
    expect(driver.has('page.overview.board.unit#window-250')).toBe(true);
    driver.act('page.overview.tile#window-11', 'press');
    await settle();
    expect(app.workspace.getState().selection).toEqual(['window-11']);
    driver.act('page.overview.tile#window-11', 'open');
    await settle();
    expect(app.status().mode).toBe('focus');
    expect(app.workspace.getState().focusedId).toBe('window-11');
  });

  it('follows the scene as it changes and keeps nothing of its own', async () => {
    const { app, root, driver, settle } = await start('?preset=studio');
    driver.act('editor.actions.mode#overview', 'press');
    await settle();
    const wasBehind = cardCentre(root, 'reading');
    // The reading list, behind the camera, brought in front: its card moves to the middle.
    await app.commands.run('reference.window.bringFront', { id: 'reading' });
    await settle();
    await expect
      .poll(() => Math.abs(cardCentre(root, 'reading') - boardCentre(root)), { timeout: 2000 })
      .toBeLessThan(60);
    // Undone, it is back where it was.
    app.workspace.undo();
    await settle();
    await expect
      .poll(() => cardCentre(root, 'reading'), { timeout: 2000 })
      .toBeCloseTo(wasBehind, 0);
    // Searching fades the cards it leaves out and never takes one off the board.
    driver.act('page.overview.search.field', 'type', 'research');
    await expect.poll(() => app.search.query().text, { timeout: 2000 }).toBe('research');
    await settle();
    expect(driver.has('page.overview.tile#board')).toBe(false);
    expect(driver.has('page.overview.tile#reading')).toBe(true);
    expect(driver.has('page.overview.board.unit#board')).toBe(true);
    const quiet = (id: string) =>
      root
        .querySelector(`[data-wsb="page.overview.board.unit#${id}"]`)
        ?.classList.contains('wsb-stage__unit--quiet');
    const named = (id: string) =>
      root
        .querySelector(`[data-wsb="page.overview.board.unit#${id}"]`)
        ?.classList.contains('wsb-stage__unit--titled');
    expect(quiet('board')).toBe(true);
    expect(named('board')).toBe(false);
    expect(quiet('reading')).toBe(false);
    expect(named('reading')).toBe(true);
    // Into a group of its own, a window's card says so, and the group is named beside the board.
    await app.commands.run('reference.window.regroup', {
      id: 'reading',
      groupId: null,
      label: 'Research',
    });
    await settle();
    const groups = [...root.querySelectorAll('[data-wsb^="page.overview.group#"]')];
    expect(groups.map((tag) => tag.textContent.trim())).toEqual(['Research']);
    // Away and back: the same cards in the same places, read again from the scene.
    const places = () =>
      [...root.querySelectorAll('[data-wsb^="page.overview.board.unit#"]')].map(
        (unit) => `${unit.getAttribute('data-wsb') ?? ''} ${(unit as HTMLElement).style.transform}`,
      );
    const shown = places();
    driver.act('editor.actions.mode#panorama', 'press');
    await settle();
    expect(driver.has('page.overview.board')).toBe(false);
    driver.act('editor.actions.mode#overview', 'press');
    await settle();
    await expect.poll(places, { timeout: 2000 }).toEqual(shown);
  });
});

/** Where a card's middle is across the overview's board, in CSS pixels. */
function cardCentre(root: HTMLElement, id: string): number {
  const unit = root.querySelector(`[data-wsb="page.overview.board.unit#${id}"]`);
  const canvas = root.querySelector('[data-wsb="page.overview.board.surface"]');
  if (unit === null || canvas === null) throw new Error(`no card for "${id}"`);
  const box = unit.getBoundingClientRect();
  return (box.left + box.right) / 2 - canvas.getBoundingClientRect().left;
}

/** The middle of the overview's board, across. */
function boardCentre(root: HTMLElement): number {
  const canvas = root.querySelector('[data-wsb="page.overview.board.surface"]');
  if (canvas === null) throw new Error('no overview board');
  return canvas.getBoundingClientRect().width / 2;
}

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
