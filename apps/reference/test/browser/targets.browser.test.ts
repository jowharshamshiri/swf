import { createMemoryStore } from '@swf/persistence';
import { viewGeometryOf } from '@swf/presentation';
import { equirectangular, projectorOf } from '@swf/projections';
import { describe, expect, it } from 'vitest';
import { commands, page, userEvent } from 'vitest/browser';
import type { ReferenceApp } from '../../src/app.js';
import type { Mounted } from './shell-harness.js';
import { start } from './shell-harness.js';

declare module 'vitest/browser' {
  interface BrowserCommands {
    wheel: (
      x: number,
      y: number,
      deltaX: number,
      deltaY: number,
      modifiers?: readonly string[],
    ) => Promise<void>;
    mouse: (
      action: 'move' | 'down' | 'up' | 'double' | 'release',
      x: number,
      y: number,
      modifiers?: readonly string[],
    ) => Promise<void>;
  }
}

/**
 * Every window's hit targets, pressed, dragged and double pressed with the real mouse at their
 * edges in the studio scene as it first opens, on a 1512 by 949 page: each target is at least the
 * size its rule gives (WCAG 2.5.8's 24 CSS pixels for a mouse), and does what it says wherever on
 * it the pointer lands.
 */

/** The title bar's height a mouse press counts in, the least WCAG 2.5.8 allows. */
const BAR = 24;

type Rect = readonly [number, number, number, number];

async function visit(backend: 'geometry' | 'dom' = 'geometry') {
  // The test's frame is the page: every target on it, the radar at its right included, is in it.
  await page.viewport(1512, 949);
  const m = await start(
    `?preset=studio&backend=${backend}`,
    { store: createMemoryStore() },
    {
      size: { width: 1512, height: 949 },
    },
  );
  const app = m.model.app;
  if (app === null) {
    throw new Error('no application');
  }
  // Each move exactly as the pointer takes it, with no snap when it is let go.
  app.policies.configure({ enabled: { snap: false } });
  await m.settle();
  return { ...m, app };
}

/**
 * A window's card at every place the view draws it, its own place first, in the view's pixels,
 * and how it is represented.
 */
function cardsOf(app: ReferenceApp, id: string): { cards: Rect[]; representation: string } {
  const state = app.workspace.getState();
  const view = viewGeometryOf(state, app.viewport.viewportId);
  const fragments = projectorOf(equirectangular)
    .project(
      state,
      view,
      (surfaceId) => app.workspace.surfaceGeometry(surfaceId),
      app.viewport.representation(),
    )
    .filter((f) => state.surfaces.get(f.surfaceId)?.ownerNodeId === id);
  const first = fragments[0];
  if (first === undefined) {
    throw new Error(`${id} has no card in view`);
  }
  const byCopy = new Map(fragments.map((f) => [f.ordinal, f.card] as const));
  return {
    cards: [...byCopy.entries()].sort(([a], [b]) => a - b).map(([, card]) => card),
    representation: first.representation,
  };
}

/**
 * A window's title bar as the rule places it, at its own place: across the top of its card, 24
 * pixels high, or the whole card of a window shown by its label alone.
 */
function barOf(app: ReferenceApp, id: string, copy = 0): Rect {
  const { cards, representation } = cardsOf(app, id);
  const card = cards[copy];
  if (card === undefined) {
    throw new Error(`${id} has no copy ${String(copy)}`);
  }
  const [x, y, w] = card;
  return representation === 'label' ? card : [x, y - BAR, w, BAR];
}

/** The points of a bar a press must count on: its middle, and 2 px in from each edge. */
function edgesOf([x, y, w, h]: Rect): [string, number, number][] {
  return [
    ['middle', x + w / 2, y + h / 2],
    ['top', x + w / 2, y + 2],
    ['bottom', x + w / 2, y + h - 2],
    // Clear of the corners, whose zones resize.
    ['left', x + 22, y + h / 2],
    ['right', x + w - 22, y + h / 2],
  ];
}

/** On the page, a point of the view. */
function onPage(app: ReferenceApp, x: number, y: number): [number, number] {
  const box = app.root.getBoundingClientRect();
  return [Math.round(box.left + x), Math.round(box.top + y)];
}

/** The window's heading, in degrees right of straight ahead. */
function headingOf(app: ReferenceApp, id: string): number {
  const p = app.workspace.getState().nodes.get(id)?.transform.position;
  if (p === undefined) {
    throw new Error(`no ${id}`);
  }
  return (Math.atan2(p[0], -p[2]) * 180) / Math.PI;
}

/**
 * Presses at a point of the view, drags 40 px left in steps (every window tried stands well clear
 * of the view's left edge), and lets go.
 */
async function dragAt(m: Mounted & { app: ReferenceApp }, x: number, y: number): Promise<void> {
  const [px, py] = onPage(m.app, x, y);
  await commands.mouse('move', px, py);
  await commands.mouse('down', px, py);
  for (let step = 1; step <= 8; step += 1) {
    await commands.mouse('move', px - step * 5, py);
  }
  await commands.mouse('up', px - 40, py);
  await m.settle();
}

/** Each kind of window there is: live content, several windows' parts, a drawn card, a label. */
const KINDS = [
  ['a live note', 'desk'],
  ['a window of several parts', 'board'],
  ['a compact drawn card', 'reading'],
  ['a window shown by its label alone', 'archive'],
] as const;

describe('title bars', () => {
  it('gives every window drawn with a card a title bar at least 24 px high across its card', async () => {
    const m = await visit('dom');
    const bars = [...m.app.root.querySelectorAll<HTMLElement>('[data-swf-title-bar]')];
    const framed = [...m.app.workspace.getState().nodes.values()].filter(
      (n) => n.kind === 'window' && cardsOf(m.app, n.id).representation !== 'label',
    );
    expect(framed.length).toBeGreaterThan(6);
    for (const node of framed) {
      const own = bars.find((b) => b.getAttribute('data-swf-title-bar') === node.id);
      const box = own?.getBoundingClientRect();
      const [, , cardWidth] = cardsOf(m.app, node.id).cards[0] ?? [0, 0, 0];
      expect(box?.height, node.id).toBeGreaterThanOrEqual(BAR);
      expect(box?.width, node.id).toBeCloseTo(cardWidth, 0);
      expect(own?.textContent, node.id).toBe(node.label);
    }
  });

  for (const [kind, id] of KINDS) {
    it(`moves ${kind} round the room dragged by its title bar from its middle or any edge`, async () => {
      const m = await visit();
      const view = viewGeometryOf(m.app.workspace.getState(), m.app.viewport.viewportId);
      // 40 px to the left in a view showing 360° across its width.
      const turned = (-40 * 360) / view.width;
      for (const [where, x, y] of edgesOf(barOf(m.app, id))) {
        const before = headingOf(m.app, id);
        await dragAt(m, x, y);
        expect(m.app.workspace.getState().selection, `${id} ${where}`).toEqual([id]);
        expect(headingOf(m.app, id) - before, `${id} ${where}`).toBeCloseTo(turned, 0);
        expect(m.app.workspace.undo().status).toBe('committed');
        await m.settle();
      }
    });
  }

  it('reaches a window behind a nearer one’s card by its title bar, which is drawn over the card', async () => {
    const m = await visit();
    // Code Review stands behind Calendar: its bar's left end lies over Calendar's content.
    const [cx, cy, cw, ch] = cardsOf(m.app, 'calendar').cards[0] ?? [0, 0, 0, 0];
    const [bx, by, bw, bh] = barOf(m.app, 'review');
    const x = Math.max(bx, cx) + 30;
    const y = by + bh / 2;
    expect(x > cx && x < cx + cw && y > cy && y < cy + ch && x < bx + bw).toBe(true);
    const before = headingOf(m.app, 'review');
    await dragAt(m, x, y);
    expect(m.app.workspace.getState().selection).toEqual(['review']);
    expect(headingOf(m.app, 'review')).not.toBeCloseTo(before, 1);
  });

  it('moves a live window by the copy of its card across the seam, a picture of its content', async () => {
    const m = await visit();
    // Messages straddles the seam: its live content at one edge, a picture of it at the other.
    const { cards } = cardsOf(m.app, 'messages');
    const view = viewGeometryOf(m.app.workspace.getState(), m.app.viewport.viewportId);
    const copy = cards[1];
    expect(copy).toBeDefined();
    const [x, y, w, h] = copy ?? [0, 0, 0, 0];
    // The middle of the part of the copy inside the view.
    const left = Math.max(x, 0);
    const px = left + (Math.min(x + w, view.width) - left) / 2;
    // Above the label of Sketches, which stands there behind it.
    const py = y + h * 0.35;
    const before = headingOf(m.app, 'messages');
    await dragAt(m, px, py);
    expect(m.app.workspace.getState().selection).toEqual(['messages']);
    expect(headingOf(m.app, 'messages')).not.toBeCloseTo(before, 1);
  });
});

/** Presses at a point of the view, drags by (dx, dy) in steps, and lets go. */
async function dragBy(
  m: Mounted & { app: ReferenceApp },
  x: number,
  y: number,
  dx: number,
  dy: number,
): Promise<void> {
  const [px, py] = onPage(m.app, x, y);
  await commands.mouse('move', px, py);
  await commands.mouse('down', px, py);
  for (let step = 1; step <= 6; step += 1) {
    await commands.mouse(
      'move',
      Math.round(px + (dx * step) / 6),
      Math.round(py + (dy * step) / 6),
    );
  }
  await commands.mouse('up', px + dx, py + dy);
  await m.settle();
}

describe('resize bands round the outline', () => {
  it('resizes a live window from each edge and corner pressed just outside its outline', async () => {
    const m = await visit();
    // Build Status: a live note with nothing else round it.
    const id = 'builds';
    const [x, y, w, h] = cardsOf(m.app, id).cards[0] ?? [0, 0, 0, 0];
    const top = y - BAR;
    // 4 px outside the outline (the card with its title bar), dragged 30 px outward.
    for (const [edge, px, py, dx, dy, grows] of [
      ['e', x + w + 4, y + h / 2, 30, 0, 'width'],
      ['w', x - 4, y + h / 2, -30, 0, 'width'],
      ['s', x + w / 2, y + h + 4, 0, 30, 'height'],
      ['n', x + w / 2, top - 4, 0, -30, 'height'],
      ['se', x + w + 4, y + h + 4, 30, 30, 'both'],
      ['nw', x - 4, top - 4, -30, -30, 'both'],
    ] as const) {
      const before = m.app.workspace.getState().nodes.get(id)?.bounds ?? [0, 0, 0];
      await dragBy(m, px, py, dx, dy);
      const after = m.app.workspace.getState().nodes.get(id)?.bounds ?? [0, 0, 0];
      if (grows !== 'height') {
        expect(after[0], `${edge} width`).toBeGreaterThan(before[0] + 0.1);
      }
      if (grows !== 'width') {
        expect(after[1], `${edge} height`).toBeGreaterThan(before[1] + 0.1);
      }
      expect(m.app.workspace.undo().status).toBe('committed');
      await m.settle();
    }
  });

  it('leaves a press 6 px inside a live window’s edge to its content', async () => {
    const m = await visit();
    // The Project Board: three live notes, the first reaching the card's left edge.
    const id = 'board';
    const [x, y, , h] = cardsOf(m.app, id).cards[0] ?? [0, 0, 0, 0];
    let started = 0;
    m.app.router.subscribe((event) => {
      if (event.type === 'gesture.started') started += 1;
    });
    const before = m.app.workspace.getState().nodes.get(id)?.bounds;
    // The note's own element hears the press, as the browser delivers it to the content.
    const slot = m.app.root.querySelector('[data-swf-slot="plan-surface"]');
    let heard = 0;
    slot?.addEventListener('pointerdown', () => {
      heard += 1;
    });
    // 6 px inside its left edge, clear of the corners' zones: past the 4 px of its band.
    await dragBy(m, x + 6, y + h * 0.6, 20, 0);
    expect(started).toBe(0);
    expect(m.app.workspace.getState().nodes.get(id)?.bounds).toEqual(before);
    expect(heard).toBe(1);
  });
});

describe('a press in live content', () => {
  /** The middle of a window's live content, where a press is its content's. */
  function contentOf(m: Mounted & { app: ReferenceApp }, surfaceId: string): [number, number] {
    const slot = m.app.root.querySelector(`[data-swf-slot="${surfaceId}"]`);
    const box = slot?.getBoundingClientRect();
    const root = m.app.root.getBoundingClientRect();
    if (box === undefined) {
      throw new Error(`no live slot for ${surfaceId}`);
    }
    return [box.left - root.left + box.width / 2, box.top - root.top + box.height * 0.75];
  }

  it('selects its window and leaves the whole press to the content', async () => {
    const m = await visit();
    expect(m.app.workspace.getState().selection).toEqual([]);
    const slot = m.app.root.querySelector('[data-swf-slot="desk-surface"]');
    let heard = 0;
    slot?.addEventListener('pointerdown', () => {
      heard += 1;
    });
    const [x, y] = contentOf(m, 'desk-surface');
    const [px, py] = onPage(m.app, x, y);
    await commands.mouse('move', px, py);
    await commands.mouse('down', px, py);
    await commands.mouse('up', px, py);
    await m.settle();
    expect(heard).toBe(1);
    expect(m.app.workspace.getState().selection).toEqual(['desk']);
    // The inspector follows it.
    expect(m.driver.has('page.inspector.window.focus#desk')).toBe(true);
  });

  it('keeps a selection that holds the window pressed, and moves one that does not to it', async () => {
    const m = await visit();
    m.app.workspace.transaction([{ type: 'selection.set', ids: ['desk', 'builds'] }]);
    await m.settle();
    const press = async (surfaceId: string) => {
      const [px, py] = onPage(m.app, ...contentOf(m, surfaceId));
      await commands.mouse('move', px, py);
      await commands.mouse('down', px, py);
      await commands.mouse('up', px, py);
      await m.settle();
    };
    await press('desk-surface');
    expect(m.app.workspace.getState().selection).toEqual(['desk', 'builds']);
    await press('calendar-surface');
    expect(m.app.workspace.getState().selection).toEqual(['calendar']);
  });
});

describe('a double press focuses', () => {
  /** Double presses at a point of the view and lets any move into or out of focus finish. */
  async function doubleAt(m: Mounted & { app: ReferenceApp }, x: number, y: number): Promise<void> {
    const [px, py] = onPage(m.app, x, y);
    await commands.mouse('move', px, py);
    await commands.mouse('double', px, py);
    await m.settle();
    await new Promise((resolve) => setTimeout(resolve, 900));
    await m.settle();
  }

  for (const [kind, id] of KINDS) {
    it(`focuses ${kind} double-pressed on its title bar, and closes the focus double-pressed there again`, async () => {
      const m = await visit();
      const [bx, by, bw, bh] = barOf(m.app, id);
      await doubleAt(m, bx + bw / 2, by + bh / 2);
      expect(m.app.modes.current()).toBe('focus');
      expect(m.app.workspace.getState().focusedId).toBe(id);
      // In focus the window is shown large: its bar is where the focus draws it.
      const [fx, fy, fw, fh] = barOf(m.app, id);
      await doubleAt(m, fx + fw / 2, fy + fh / 2);
      expect(m.app.modes.current()).toBe('panorama');
    });
  }

  it('focuses a window double-pressed on its radar dot', async () => {
    const m = await visit();
    const radar = m.app.root.ownerDocument.querySelector<HTMLElement>(
      '[data-wsb="page.radar"] canvas',
    );
    if (radar === null) {
      throw new Error('no radar');
    }
    const box = radar.getBoundingClientRect();
    // The radar centres the camera and brings 14 units out to its rim, 24 px inside its smaller
    // side; ahead is up.
    const scale = (Math.min(box.width, box.height) / 2 - 24) / 14;
    const p = m.app.workspace.getState().nodes.get('builds')?.transform.position ?? [0, 0, 0];
    const x = Math.round(box.left + box.width / 2 + p[0] * scale);
    const y = Math.round(box.top + box.height / 2 + p[2] * scale);
    await commands.mouse('move', x, y);
    await commands.mouse('double', x, y);
    await m.settle();
    expect(m.app.modes.current()).toBe('focus');
    expect(m.app.workspace.getState().focusedId).toBe('builds');
  });
});

describe('a double press on a window’s row', () => {
  it('focuses the window of a row in the Windows view double-pressed, and closes its focus again', async () => {
    const m = await visit();
    if (!m.driver.has('page.windows')) {
      m.driver.act('workshop.view#windows', 'press');
      await m.settle();
    }
    const row = m.app.root.ownerDocument.querySelector<HTMLElement>(
      '[data-wsb="page.windows.window#builds"]',
    );
    if (row === null) {
      throw new Error('no row for Build Status');
    }
    // On its title, at its left: the row's actions show at its right while it is hovered.
    const open = async () => {
      const box = row.getBoundingClientRect();
      const [x, y] = [Math.round(box.left + 50), Math.round(box.top + box.height / 2)];
      await commands.mouse('move', x, y);
      await m.settle();
      expect(
        m.app.root.ownerDocument
          .elementFromPoint(x, y)
          ?.closest('[data-wsb]')
          ?.getAttribute('data-wsb'),
      ).toBe('page.windows.window#builds');
      await commands.mouse('double', x, y);
      await m.settle();
    };
    await open();
    expect(m.app.modes.current()).toBe('focus');
    expect(m.app.workspace.getState().focusedId).toBe('builds');
    await open();
    expect(m.app.modes.current()).toBe('panorama');
  });
});

describe('cursors and hover', () => {
  /** The cursor the page shows at a point of the view, as the element under it computes it. */
  function cursorAt(m: Mounted & { app: ReferenceApp }, x: number, y: number): string {
    const [px, py] = onPage(m.app, x, y);
    const under = m.app.root.ownerDocument.elementFromPoint(px, py);
    if (under === null) {
      throw new Error(`nothing at ${String(px)}, ${String(py)}`);
    }
    return getComputedStyle(under).cursor;
  }
  async function hoverAt(m: Mounted & { app: ReferenceApp }, x: number, y: number) {
    const [px, py] = onPage(m.app, x, y);
    await commands.mouse('move', px, py);
    await m.settle();
  }

  for (const backend of ['geometry', 'dom'] as const) {
    it(`says what a press would do by the cursor, on the ${backend} backend`, async () => {
      const m = await visit(backend);
      // Build Status: a live note with nothing else round it.
      const [x, y, w, h] = cardsOf(m.app, 'builds').cards[0] ?? [0, 0, 0, 0];
      for (const [where, px, py, cursor] of [
        ['its title bar', x + w / 2, y - BAR / 2, 'grab'],
        ['its band’s east edge', x + w + 4, y + h / 2, 'ew-resize'],
        ['its band’s north-west corner', x - 4, y - BAR - 4, 'nwse-resize'],
        ['the background', x + w / 2, y + h + 60, 'grab'],
      ] as const) {
        await hoverAt(m, px, py);
        expect(cursorAt(m, px, py), where).toBe(cursor);
      }
      // Over its content, the content's own cursor; with Alt held, the window would be moved.
      const slot = m.app.root.querySelector('[data-swf-slot="builds-surface"]');
      const box = slot?.getBoundingClientRect();
      const root = m.app.root.getBoundingClientRect();
      const [kx, ky] = [
        (box?.left ?? 0) - root.left + (box?.width ?? 0) / 2,
        (box?.top ?? 0) - root.top + (box?.height ?? 0) * 0.8,
      ];
      await hoverAt(m, kx, ky);
      expect(['auto', 'text']).toContain(cursorAt(m, kx, ky));
      await userEvent.keyboard('{Alt>}');
      await m.settle();
      expect(cursorAt(m, kx, ky)).toBe('move');
      await userEvent.keyboard('{/Alt}');
      await m.settle();
      expect(['auto', 'text']).toContain(cursorAt(m, kx, ky));
      // Dragging a window by its title bar, it is grabbed.
      const [bx, by] = onPage(m.app, x + w / 2, y - BAR / 2);
      await commands.mouse('move', bx, by);
      await commands.mouse('down', bx, by);
      await commands.mouse('move', bx - 20, by);
      await m.settle();
      expect(
        getComputedStyle(m.app.root.ownerDocument.elementFromPoint(bx - 20, by) ?? m.app.root)
          .cursor,
      ).toBe('grabbing');
      await commands.mouse('up', bx - 20, by);
      await m.settle();
      expect(cursorAt(m, x + w / 2 - 20, y - BAR / 2)).toBe('grab');
    });
  }

  it('edges the title bar of the window a press would take in the selection’s colour', async () => {
    const m = await visit('dom');
    const bar = m.app.root.querySelector<HTMLElement>('[data-swf-title-bar="builds"]');
    const [x, y, w] = cardsOf(m.app, 'builds').cards[0] ?? [0, 0, 0];
    expect(bar?.style.boxShadow).toBe('none');
    await hoverAt(m, x + w / 2, y - BAR / 2);
    await expect.poll(() => bar?.style.boxShadow).toMatch(/^inset 0 0 0 2px /);
    await hoverAt(m, x + w / 2, y + 400);
    await expect.poll(() => bar?.style.boxShadow).toBe('none');
  });
});

describe('the wheel and the trackpad', () => {
  const floorOf = (m: Mounted & { app: ReferenceApp }, id: string) => {
    const p = m.app.workspace.getState().nodes.get(id)?.transform.position ?? [0, 0, 0];
    return Math.hypot(p[0], p[2]);
  };
  /** Turns the wheel at a point of the view, and lets a burst rest so it commits. */
  async function wheelAt(
    m: Mounted & { app: ReferenceApp },
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
    modifiers: readonly string[] = [],
  ) {
    const [px, py] = onPage(m.app, x, y);
    await commands.wheel(px, py, deltaX, deltaY, modifiers);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await m.settle();
  }

  it('moves a window along the floor by the plain wheel over its title bar or its picture, as one change', async () => {
    const m = await visit();
    for (const id of ['builds', 'reading'] as const) {
      const { cards, representation } = cardsOf(m.app, id);
      const [x, y, w, h] = cards[0] ?? [0, 0, 0, 0];
      const [px, py] =
        representation === 'full' ? [x + w / 2, y - BAR / 2] : [x + w / 2, y + h / 2];
      const before = floorOf(m, id);
      const history = m.app.workspace.history().length;
      await wheelAt(m, px, py, 0, 120);
      expect(floorOf(m, id), id).toBeGreaterThan(before + 0.1);
      expect(m.app.workspace.history(), id).toHaveLength(history + 1);
    }
  });

  it('leaves every wheel over live content to it, Shift and Ctrl included', async () => {
    const m = await visit();
    const slot = m.app.root.querySelector('[data-swf-slot="builds-surface"]');
    let heard = 0;
    slot?.addEventListener('wheel', () => {
      heard += 1;
    });
    const box = slot?.getBoundingClientRect();
    const root = m.app.root.getBoundingClientRect();
    const [x, y] = [
      (box?.left ?? 0) - root.left + (box?.width ?? 0) / 2,
      (box?.top ?? 0) - root.top + (box?.height ?? 0) * 0.8,
    ];
    const before = m.app.workspace.getState().nodes.get('builds');
    for (const modifiers of [[], ['Shift'], ['Alt']] as const) {
      await wheelAt(m, x, y, 0, 120, modifiers);
    }
    expect(heard).toBe(3);
    expect(m.app.workspace.getState().nodes.get('builds')).toBe(before);
  });

  it('turns the view by a scroll sideways over the background and zooms its field of view by Ctrl and the wheel', async () => {
    const m = await visit();
    // High in the sky above every window: the background.
    const [gx, gy] = [m.app.root.getBoundingClientRect().width / 2, 40];
    const field = (handle: string) =>
      Number(
        m.app.root.ownerDocument.querySelector<HTMLInputElement>(`[data-wsb="${handle}"]`)?.value,
      );
    const heading = () => field('page.view.heading.number');
    const fov = () => field('page.view.fov.number');
    expect(heading()).toBe(0);
    await wheelAt(m, gx, gy, 60, 0);
    expect(heading()).toBeGreaterThan(10);
    expect(fov()).toBe(360);
    await wheelAt(m, gx, gy, 0, -120, ['Control']);
    expect(fov()).toBeLessThan(300);
    // The panorama is ground no scroll carries past: a swipe never goes back a page from it.
    expect(getComputedStyle(m.app.root).overscrollBehaviorX).toBe('none');
  });

  it('turns the workspace by a scroll sideways over the background while that is what a drag turns, as one change', async () => {
    const m = await visit();
    expect(await m.model.run('swf.navigation.set', { target: 'orbit' })).toBe(true);
    await m.settle();
    const history = m.app.workspace.history().length;
    const before = m.app.workspace.getState().nodes.get('workspace')?.transform.rotation;
    for (let i = 0; i < 4; i += 1) {
      // High in the sky above every window: the background.
      const [px, py] = onPage(m.app, m.app.root.getBoundingClientRect().width / 2, 40);
      await commands.wheel(px, py, 20, 0);
    }
    await new Promise((resolve) => setTimeout(resolve, 450));
    await m.settle();
    expect(m.app.workspace.getState().nodes.get('workspace')?.transform.rotation).not.toEqual(
      before,
    );
    expect(m.app.workspace.history()).toHaveLength(history + 1);
  });
});
