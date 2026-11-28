import { createMemoryStore } from '@swf/persistence';
import { viewGeometryOf } from '@swf/presentation';
import { equirectangular, projectorOf } from '@swf/projections';
import { describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import type { ReferenceApp } from '../../src/app.js';
import type { Mounted } from './shell-harness.js';
import { start } from './shell-harness.js';

declare module 'vitest/browser' {
  interface BrowserCommands {
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
