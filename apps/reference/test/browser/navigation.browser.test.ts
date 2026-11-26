import { worldMatrix } from '@swf/core';
import { createMemoryStore } from '@swf/persistence';
import { viewGeometryOf } from '@swf/presentation';
import { equirectangular, headingPitchOf } from '@swf/projections';
import type { Vec3 } from '@swf/math';
import { resolvePalette } from '@wsb/uikit/primitives';
import { describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { VIEWPORT_ID } from '../../src/app.js';
import { FOCUS_ID } from '../../src/focus.js';
import { inView, mapScene, radarView, toMap } from '../../src/map.js';
import { ENGLISH } from '../../src/messages.js';
import { FIELD_OF_VIEW, MAP, OVERVIEW } from '../../src/modes.js';
import { orbitHeading } from '../../src/orbit.js';
import { CAMERA_ID } from '../../src/presets.js';
import type { ShellModel } from '../../src/shell/model.svelte.js';
import { RADAR_MARGIN } from '../../src/shell/map-drawer.js';
import { layout, start } from './shell-harness.js';

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

const DEGREES = 180 / Math.PI;

/** A value the test needs to be there: it fails, naming it, when it is not. */
function there<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`${what} is not there`);
  }
  return value;
}
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** Heading of a point round the camera at the origin, in degrees to the right. */
const headingOf = ([x, , z]: readonly number[]) => Math.atan2(x ?? 0, -(z ?? 0)) * DEGREES;
/** The difference between two headings, the shorter way round, in (-180, 180]. */
const turn = (from: number, to: number) => ((((to - from) % 360) + 540) % 360) - 180;

const visit = (search = '?preset=sparse') => start(search, { store: createMemoryStore() });

function app(model: ShellModel) {
  const a = model.app;
  if (a === null) {
    throw new Error('the application has not started');
  }
  return a;
}

/** A window's world centre, as committed or as every view presents it now. */
function centreOf(model: ShellModel, id: string, presented = false): Vec3 {
  const a = app(model);
  const state = presented ? a.workspace.getPresented() : a.workspace.getState();
  const m = worldMatrix(state.nodes, id);
  if (m === undefined) {
    throw new Error(`no ${id}`);
  }
  return [m[12], m[13], m[14]];
}

const cameraDegrees = (model: ShellModel) =>
  headingPitchOf(
    there(app(model).workspace.getState().cameras.get(CAMERA_ID), 'the camera').rotation,
  ).heading * DEGREES;

const fieldOfView = (model: ShellModel) => {
  const config = app(model).workspace.getState().viewports.get(VIEWPORT_ID)?.projection.config as
    { horizontal: number } | undefined;
  return config?.horizontal;
};

/** The radar's drawing surface and its canvas. */
function radar(root: HTMLElement) {
  const viewport = root.querySelector<HTMLElement>('[data-wsb="page.radar"] .wsb-stage__viewport');
  const canvas = root.querySelector<HTMLCanvasElement>('[data-wsb="page.radar"] canvas');
  if (viewport === null || canvas === null) {
    throw new Error('the radar is not shown');
  }
  return { viewport, canvas };
}

/** Where a window's dot is on the page, as the radar lays the scene out now. */
function dotOf(model: ShellModel, root: HTMLElement, id: string): [number, number] {
  const { viewport } = radar(root);
  const box = viewport.getBoundingClientRect();
  const scene = mapScene(app(model).workspace.getState(), VIEWPORT_ID);
  const view = radarView(scene, box.width, box.height, RADAR_MARGIN);
  const marker = scene.markers.find((m) => m.id === id);
  if (marker === undefined) {
    throw new Error(`no ${id} on the radar`);
  }
  const [x, y] = toMap(view, marker.x, marker.z);
  return [box.left + x, box.top + y];
}

/** The colour drawn at a page point of a canvas, as `r,g,b,a`. */
function pixel(canvas: HTMLCanvasElement, x: number, y: number): [number, number, number, number] {
  const box = canvas.getBoundingClientRect();
  const ratio = canvas.width / box.width;
  const g = canvas.getContext('2d');
  if (g === null) {
    throw new Error('no 2D context');
  }
  const d = g.getImageData(
    Math.round((x - box.left) * ratio),
    Math.round((y - box.top) * ratio),
    1,
    1,
  ).data;
  return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, d[3] ?? 0];
}

/** A palette colour as `r,g,b`, as the browser resolves it. */
function rgbOf(name: string): [number, number, number] {
  const value = resolvePalette(document.documentElement)[name];
  if (value === undefined) {
    throw new Error(`no palette colour ${name}`);
  }
  const probe = document.createElement('span');
  probe.style.setProperty('color', value);
  document.body.append(probe);
  const [r = 0, g = 0, b = 0] = (getComputedStyle(probe).color.match(/\d+(\.\d+)?/g) ?? []).map(
    Number,
  );
  probe.remove();
  return [r, g, b];
}

const near = (a: readonly number[], b: readonly number[], tolerance = 12) =>
  a.slice(0, 3).every((v, i) => Math.abs(v - (b[i] ?? 0)) <= tolerance);

/** A window's chrome in the panorama: its outline's box on the page. */
function chromeOf(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-swf-layer="chrome"][data-swf-node="${id}"]`);
}

/** Where a world point is drawn in the panorama, the image nearest `nearX`, on the page. */
function panoramaPoint(model: ShellModel, point: Vec3, nearX?: number) {
  const a = app(model);
  const view = viewGeometryOf(a.workspace.getState(), VIEWPORT_ID);
  const images = equirectangular.create(view.projectionConfig).projectDirection(point, view).images;
  const box = a.root.getBoundingClientRect();
  const best = [...images].sort(
    (p, q) =>
      Math.abs(p[0] - (nearX ?? view.width / 2)) - Math.abs(q[0] - (nearX ?? view.width / 2)),
  )[0];
  return best === undefined ? null : { x: box.left + best[0], y: box.top + best[1], view };
}

describe('the radar beside the panorama', () => {
  it('is shown while the panorama is in use, folds and opens again, and says what it draws', async () => {
    const { model, root, driver, settle } = await visit();
    expect(model.status?.mode).toBe('panorama');
    expect(driver.has('page.radar')).toBe(true);
    expect(driver.has('page.inspector')).toBe(true);
    // Its readings: the bearings round its rim, the distance of each ring.
    const units = [...root.querySelectorAll('[data-wsb^="page.radar.unit"]')].map((u) =>
      u.textContent.trim(),
    );
    for (const bearing of ['0°', '90°', '180°', '-90°']) {
      expect(units.some((u) => u.includes(bearing.replace('-', '−')) || u.includes(bearing))).toBe(
        true,
      );
    }
    expect(units.length).toBeGreaterThan(5);
    expect(root.textContent).toContain(ENGLISH['radar.legend']);
    // Folded, the inspector keeps working and the radar's controls go with it.
    driver.act('page.radar.toggle', 'press');
    await settle();
    expect(driver.has('page.radar')).toBe(false);
    expect(driver.has('page.radar.arrange')).toBe(false);
    expect(driver.has('page.inspector')).toBe(true);
    // The view's own controls stay across the top of the panorama.
    expect(driver.has('page.view.fov')).toBe(true);
    driver.act('page.radar.toggle', 'press');
    await settle();
    expect(driver.has('page.radar')).toBe(true);
  });

  it('draws the camera’s heading, what lies in front and behind, and the selected, focused and unseen windows apart', async () => {
    const { model, root, settle } = await visit('?preset=seam');
    const a = app(model);
    // window-07 is straight ahead; window-01 is on the seam straight behind.
    await model.run('reference.window.inspect', { id: 'window-07' });
    a.workspace.dispatch({ type: 'focus.set', id: 'window-04' }, { source: 'user' });
    await model.run('reference.view.fov', { degrees: 120 });
    await settle();
    await nextFrame();
    await nextFrame();
    const { canvas } = radar(root);
    const accent = rgbOf('focusBorder');
    const behindInk = rgbOf('input.background');
    const warning = rgbOf('editorWarning.foreground');
    // Selected: a dot in the selection's colour.
    const [sx, sy] = dotOf(model, root, 'window-07');
    expect(near(pixel(canvas, sx, sy), accent)).toBe(true);
    // Behind and out of view: hollow, its centre the ground behind the camera.
    const [bx, by] = dotOf(model, root, 'window-01');
    expect(inView(a.workspace.getState(), VIEWPORT_ID, a.projections, 'window-01')).toBe(false);
    expect(near(pixel(canvas, bx, by), behindInk, 20)).toBe(true);
    // Focused: ringed in the warning colour, ten pixels out from its dot.
    const [fx, fy] = dotOf(model, root, 'window-04');
    const ring = [0, 45, 90, 135, 180, 225, 270, 315].map((d) =>
      pixel(canvas, fx + 10 * Math.cos(d / DEGREES), fy + 10 * Math.sin(d / DEGREES)),
    );
    expect(ring.some((p) => near(p, warning, 24))).toBe(true);
    // The camera's heading: the wedge the panorama shows is drawn ahead, not behind.
    const { viewport } = radar(root);
    const box = viewport.getBoundingClientRect();
    const [cx, cy] = [box.left + box.width / 2, box.top + box.height / 2];
    const ahead = pixel(canvas, cx, cy - 30);
    const behind = pixel(canvas, cx, cy + 30);
    expect(near(ahead, behind, 4)).toBe(false);
    expect(near(behind, behindInk, 20)).toBe(true);
  });

  it('moves a window dragged on it round the camera, behind it too, and the panorama follows as it goes', async () => {
    const { model, root, settle } = await visit();
    const a = app(model);
    a.policies.configure({ enabled: { snap: false } });
    await settle();
    const id = 'window-01';
    const before = centreOf(model, id);
    expect(Math.abs(headingOf(before))).toBeLessThan(90);
    const history = a.workspace.history().length;
    const [x, y] = dotOf(model, root, id);
    const { viewport } = radar(root);
    const box = viewport.getBoundingClientRect();
    const [cx, cy] = [box.left + box.width / 2, box.top + box.height / 2];
    // Straight through the camera's place to the other side of it: behind.
    const to: [number, number] = [2 * cx - x, 2 * cy - y];
    await commands.mouse('move', x, y);
    await commands.mouse('down', x, y);
    const headings: number[] = [];
    for (let i = 1; i <= 12; i += 1) {
      await commands.mouse('move', x + ((to[0] - x) * i) / 12, y + ((to[1] - y) * i) / 12);
      await nextFrame();
      // The panorama shows the preview as the drag goes: every view reads the presented scene.
      headings.push(headingOf(centreOf(model, id, true)));
    }
    expect(a.workspace.history()).toHaveLength(history);
    await commands.mouse('up', to[0], to[1]);
    await settle();
    const after = centreOf(model, id);
    expect(Math.abs(turn(headingOf(before), headingOf(after)))).toBeGreaterThan(150);
    expect(Math.abs(headingOf(after))).toBeGreaterThan(90);
    expect(headings.at(-1)).toBeCloseTo(headingOf(after), 6);
    expect(a.workspace.history()).toHaveLength(history + 1);
    // The panorama draws the window where it now stands: its chrome is over its new place.
    await nextFrame();
    const chrome = chromeOf(root, id);
    const at = panoramaPoint(model, after);
    expect(chrome).not.toBeNull();
    expect(at).not.toBeNull();
    const frame = there(chrome, 'its chrome').getBoundingClientRect();
    expect(Math.abs(frame.left + frame.width / 2 - there(at, 'its place').x)).toBeLessThan(
      frame.width,
    );
    // One undo puts it back.
    await model.run('reference.history.undo', {});
    expect(centreOf(model, id)[0]).toBeCloseTo(before[0], 9);
  });
});

describe('the view’s controls', () => {
  it('sets the field of view, which the panorama re-projects at once and every panoramic view keeps', async () => {
    const { model, root, driver, settle } = await visit();
    const width = () => chromeOf(root, 'window-01')?.getBoundingClientRect().width ?? 0;
    const wide = width();
    driver.act('page.view.fov', 'key', 'Home');
    await settle();
    expect(fieldOfView(model)).toBe(FIELD_OF_VIEW.min);
    await nextFrame();
    expect(width()).toBeGreaterThan(wide * 3);
    driver.act('page.view.fov', 'key', 'ArrowRight');
    await settle();
    expect(fieldOfView(model)).toBe(FIELD_OF_VIEW.min + 1);
    await model.run('reference.mode.switch', { mode: MAP.id });
    await settle();
    expect(fieldOfView(model)).toBe(FIELD_OF_VIEW.min + 1);
    await model.run('reference.mode.switch', { mode: 'panorama' });
    await model.run('reference.focus.enter', { id: 'window-01' });
    await settle();
    // Focus frames its window: the control says so and sets nothing.
    expect(
      root.querySelector('[data-wsb="page.view.fov"]')?.getAttribute('aria-disabled') === 'true' ||
        root.querySelector<HTMLElement>('[data-wsb="page.view.fov"]')?.hasAttribute('disabled'),
    ).toBe(true);
    expect(root.textContent).toContain(ENGLISH['view.fov.focus']);
    await model.run('reference.focus.exit', {});
    await settle();
    expect(fieldOfView(model)).toBe(FIELD_OF_VIEW.min + 1);
  });

  it('turns the camera by its heading, and the workspace by its own, as one undoable change', async () => {
    const { model, driver, settle } = await visit();
    const a = app(model);
    driver.act('page.view.heading', 'key', 'ArrowRight');
    driver.act('page.view.heading', 'key', 'ArrowRight');
    await settle();
    expect(cameraDegrees(model)).toBeCloseTo(2, 6);
    driver.act('page.view.heading', 'key', 'End');
    await settle();
    expect(Math.abs(cameraDegrees(model))).toBeCloseTo(180, 6);
    const history = a.workspace.history().length;
    const before = centreOf(model, 'window-02');
    driver.act('page.view.workspace', 'key', 'PageUp');
    await settle();
    const turned = (orbitHeading(a.workspace.getState()) ?? Number.NaN) * DEGREES;
    expect(turned).toBeGreaterThan(0);
    expect(turn(headingOf(before), headingOf(centreOf(model, 'window-02')))).toBeCloseTo(turned, 6);
    expect(a.workspace.history()).toHaveLength(history + 1);
    await model.run('reference.history.undo', {});
    expect(centreOf(model, 'window-02')[0]).toBeCloseTo(before[0], 9);
  });

  it('switching what drags turn, camera or workspace, leaves every scene coordinate as it was', async () => {
    const { model, driver, settle } = await visit();
    driver.act('page.view.heading', 'key', 'PageUp');
    await settle();
    const before = layout(model);
    for (const target of ['orbit', 'camera', 'orbit', 'camera']) {
      driver.act(`editor.actions.navigation#${target}`, 'press');
      await settle();
      expect(model.policies?.orbit.navigation).toBe(target);
      expect(layout(model)).toEqual(before);
    }
  });
});

describe('the seam', () => {
  it('turns the camera across it with every window moving on steadily, never jumping', async () => {
    const { model, root, settle } = await visit();
    await model.run('reference.view.heading', { degrees: 170 });
    await settle();
    const a = app(model);
    const width = a.root.getBoundingClientRect().width;
    // Where each window's centre is drawn, as the camera turns a degree at a time past 180.
    const xs = (): number[] =>
      [...a.workspace.getState().nodes.values()]
        .filter((n) => n.kind === 'window')
        .map((n) => panoramaPoint(model, centreOf(model, n.id))?.x ?? Number.NaN);
    let last = xs();
    const step = width / 360;
    for (let degrees = 171; degrees <= 190; degrees += 1) {
      await model.run('reference.view.heading', {
        degrees: degrees > 180 ? degrees - 360 : degrees,
      });
      await settle();
      const now = xs();
      now.forEach((x, i) => {
        // Each moves left by one degree's width, or wraps round the seam by the whole view less it.
        const moved = x - (last[i] ?? Number.NaN);
        const wrapped = ((moved % width) + width) % width;
        expect(Math.min(Math.abs(wrapped - (width - step)), Math.abs(wrapped + step))).toBeLessThan(
          0.5,
        );
      });
      last = now;
    }
    // The guides mark the seam at both edges while the whole circle is shown.
    const guides = root.querySelector<HTMLCanvasElement>(
      '[data-swf-layer="reference-guides"] canvas',
    );
    expect(guides).not.toBeNull();
  });

  it('carries a window dragged past one edge in at the other, its heading moving on without a jump', async () => {
    const { model, settle } = await visit('?preset=seam');
    const a = app(model);
    a.policies.configure({ enabled: { snap: false } });
    await settle();
    const box = a.root.getBoundingClientRect();
    // window-01 straddles the seam behind the camera: pressed left of its centre, at the right edge.
    const grab = panoramaPoint(model, centreOf(model, 'window-01'), box.width);
    const pick = a.router.pick(
      VIEWPORT_ID,
      Math.round(box.width - 20),
      Math.round(there(grab, 'its place').y - box.top),
    );
    expect(pick.kind === 'hit' ? pick.target.nodeId : null).toBe('window-01');
    const x = Math.round(box.left + box.width - 20);
    const y = Math.round(there(grab, 'its place').y);
    const headings = [headingOf(centreOf(model, 'window-01'))];
    await commands.mouse('move', x, y);
    await commands.mouse('down', x, y, ['Alt']);
    for (let px = x + 4; px <= x + 80; px += 4) {
      await commands.mouse('move', px, y);
      await nextFrame();
      headings.push(headingOf(centreOf(model, 'window-01', true)));
    }
    await commands.mouse('up', x + 80, y);
    await settle();
    // Each step moved it on by about the pointer's four pixels' worth of heading, through ±180°.
    const perStep = (4 * 360) / box.width;
    for (let i = 1; i < headings.length; i += 1) {
      expect(Math.abs(turn(headings[i - 1] ?? 0, headings[i] ?? 0))).toBeLessThan(perStep * 2.5);
    }
    expect(Math.abs(turn(headings[0] ?? 0, headings.at(-1) ?? 0))).toBeGreaterThan(perStep * 10);
  });
});

describe('how windows look', () => {
  it('marks the selected and the focused window apart, and shades what lies behind the camera', async () => {
    const { model, root, settle } = await visit('?preset=seam');
    const a = app(model);
    await model.run('reference.window.inspect', { id: 'window-07' });
    a.workspace.dispatch({ type: 'focus.set', id: 'window-04' }, { source: 'user' });
    await settle();
    await nextFrame();
    await nextFrame();
    const outline = (id: string) =>
      chromeOf(root, id)?.firstElementChild instanceof HTMLElement
        ? getComputedStyle(there(chromeOf(root, id), id).firstElementChild as HTMLElement)
        : null;
    const selected = outline('window-07');
    const focused = outline('window-04');
    const plain = outline('window-02');
    expect(chromeOf(root, 'window-07')?.hasAttribute('data-swf-selected')).toBe(true);
    expect(chromeOf(root, 'window-04')?.hasAttribute('data-swf-focused')).toBe(true);
    expect(selected?.borderTopColor).not.toBe(focused?.borderTopColor);
    expect(selected?.borderTopColor).not.toBe(plain?.borderTopColor);
    expect(selected?.borderTopWidth).toBe('3px');
    expect(plain?.borderTopWidth).toBe('1px');
    // Behind the camera, the panorama is shaded: window-04 is there, window-07 straight ahead.
    const guides = root.querySelector<HTMLCanvasElement>(
      '[data-swf-layer="reference-guides"] canvas',
    );
    expect(guides).not.toBeNull();
    const behindInk = rgbOf('input.background');
    const atBehind = panoramaPoint(model, centreOf(model, 'window-04'));
    const atFront = panoramaPoint(model, centreOf(model, 'window-07'));
    const box = a.root.getBoundingClientRect();
    // Sampled above each window, where nothing but the guides is drawn.
    expect(
      near(
        pixel(there(guides, 'the guides'), there(atBehind, 'window-04').x, box.top + 4),
        behindInk,
        20,
      ),
    ).toBe(true);
    expect(pixel(there(guides, 'the guides'), there(atFront, 'window-07').x, box.top + 4)[3]).toBe(
      0,
    );
    // Out of view at a narrow field of view, a window is not drawn in the panorama at all.
    await model.run('reference.view.fov', { degrees: 120 });
    await settle();
    await nextFrame();
    expect(chromeOf(root, 'window-04')).toBeNull();
    expect(chromeOf(root, 'window-07')).not.toBeNull();
  });
});

describe('quick actions on a window', () => {
  it('brings it in front of the camera, sends it behind, centres the view on it and focuses it', async () => {
    const { model, driver, settle } = await visit();
    const a = app(model);
    await model.run('reference.view.heading', { degrees: 30 });
    await model.run('reference.window.inspect', { id: 'window-03' });
    await settle();
    const distance = Math.hypot(centreOf(model, 'window-03')[0], centreOf(model, 'window-03')[2]);
    driver.act('page.inspector.window.front#window-03', 'press');
    await settle();
    expect(turn(30, headingOf(centreOf(model, 'window-03')))).toBeCloseTo(0, 6);
    driver.act('page.inspector.window.behind#window-03', 'press');
    await settle();
    expect(turn(-150, headingOf(centreOf(model, 'window-03')))).toBeCloseTo(0, 6);
    const at = centreOf(model, 'window-03');
    expect(Math.hypot(at[0], at[2])).toBeCloseTo(distance, 9);
    driver.act('page.inspector.window.reveal#window-03', 'press');
    await settle();
    expect(turn(cameraDegrees(model), headingOf(at))).toBeCloseTo(0, 6);
    driver.act('page.inspector.window.focus#window-03', 'press');
    await settle();
    expect(model.status?.mode).toBe(FOCUS_ID);
    expect(a.workspace.getState().focusedId).toBe('window-03');
    // The same actions are on each row of the windows list.
    driver.act('workshop.view#windows', 'press');
    await settle();
    expect(driver.has('page.windows.row.front#window-02')).toBe(true);
    expect(driver.has('page.windows.row.behind#window-02')).toBe(true);
  });

  it('arranges the windows round the camera and centres on the selected from the radar', async () => {
    const { model, driver, settle } = await visit();
    const history = app(model).workspace.history().length;
    driver.act('page.radar.arrange', 'press');
    await settle();
    expect(app(model).workspace.history()).toHaveLength(history + 1);
    const headings = ['window-01', 'window-02', 'window-03', 'window-04', 'window-05', 'window-06']
      .map((id) => headingOf(centreOf(model, id)))
      .sort((p, q) => p - q);
    headings.forEach((h, i) => {
      if (i > 0) {
        expect(h - (headings[i - 1] ?? 0)).toBeCloseTo(60, 6);
      }
    });
    await model.run('reference.window.inspect', { id: 'window-05' });
    await settle();
    driver.act('page.radar.locate', 'press');
    await settle();
    expect(turn(cameraDegrees(model), headingOf(centreOf(model, 'window-05')))).toBeCloseTo(0, 6);
  });
});

describe('the panorama’s keys for its views', () => {
  it('turns the camera with A and D, shows the views with 1 to 4 and M, and goes back with Escape', async () => {
    const { model, driver, settle } = await visit();
    const panorama = app(model).root;
    panorama.focus();
    const press = async (key: string) => {
      panorama.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
      );
      panorama.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
      await settle();
    };
    await press('d');
    expect(cameraDegrees(model)).toBeCloseTo(5, 6);
    await press('a');
    await press('a');
    expect(cameraDegrees(model)).toBeCloseTo(-5, 6);
    await press('m');
    expect(model.status?.mode).toBe(MAP.id);
    panorama.focus();
    await press('Escape');
    expect(model.status?.mode).toBe('panorama');
    const listed = app(model)
      .modes.list()
      .map((m) => m.id);
    const overview = listed.indexOf(OVERVIEW.id) + 1;
    panorama.focus();
    await press(String(overview));
    expect(model.status?.mode).toBe(OVERVIEW.id);
    panorama.focus();
    await press('1');
    expect(model.status?.mode).toBe('panorama');
    // A single key acts only while the panorama has the keyboard.
    driver.act('page.radar.toggle', 'focus');
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'm', bubbles: true }),
    );
    await settle();
    expect(model.status?.mode).toBe('panorama');
  });
});
