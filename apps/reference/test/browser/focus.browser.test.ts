import { createMemoryStore } from '@swf/persistence';
import type { ViewportFrame } from '@swf/presentation';
import { TITLE_BAR_HEIGHT } from '@swf/presentation';
import { headingPitchOf } from '@swf/projections';
import { describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import type { ReferenceApp } from '../../src/app.js';
import type { NoteTexts } from '../../src/content.js';
import { CAMERA_ID, FOCUS_ID, PANORAMA, VIEWPORT_ID, stripWindows } from '@swf/navigation';
import type { ShellModel } from '../../src/shell/model.svelte.js';
import { endVisits, layout, start } from './shell-harness.js';

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

const DEGREES = 180 / Math.PI;

/** Note texts kept in memory, as the host's store keeps them on the page. */
function memoryTexts(): NoteTexts & { readonly kept: Map<string, string> } {
  const kept = new Map<string, string>();
  return {
    kept,
    get: (key) => kept.get(key) ?? null,
    set: (key, text) => {
      kept.set(key, text);
    },
  };
}

type Visit = Awaited<ReturnType<typeof start>>;

/** The studio on the default backend, in a page of the harness's size or another. */
const visit = (texts: NoteTexts = memoryTexts(), size?: { width: number; height: number }) =>
  start(
    '?preset=studio',
    { store: createMemoryStore(), noteTexts: texts },
    size === undefined ? {} : { size },
  );

/** The size the evidence's page is: the studio's thirteen all fit in the strip. */
const EVIDENCE = Object.freeze({ width: 1440, height: 900 });

function app(model: ShellModel): ReferenceApp {
  const a = model.app;
  if (a === null) throw new Error('the application has not started');
  return a;
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

/** Waits for the view to stop moving, every surface to settle and the strip to be drawn. */
async function settled(m: Visit): Promise<void> {
  await expect.poll(() => app(m.model).transitions.running(), { timeout: 5000 }).toBe(false);
  await expect
    .poll(
      () =>
        app(m.model)
          .runtime.list()
          .every((s) => s.state !== 'binding'),
      {
        timeout: 5000,
      },
    )
    .toBe(true);
  await m.settle();
  await nextFrame();
  await nextFrame();
}

/** Focuses a window as the reader does: its row's focus action in the Windows view. */
async function focusFromList(m: Visit, id: string): Promise<void> {
  m.driver.act('workshop.view#windows', 'press');
  await m.settle();
  m.driver.act(`page.windows.window#${id}`, 'press');
  await m.settle();
  m.driver.act('editor.actions.mode#focus', 'press');
  await m.settle();
  await settled(m);
}

/** A frame of the panorama, presented now. */
async function frameOf(a: ReferenceApp): Promise<ViewportFrame> {
  const update = await a.viewport.update();
  if (update.status !== 'presented') throw new Error(update.error.message);
  return update;
}

/** The view's own records, but for when each was last written. */
function viewRecords(a: ReferenceApp): string {
  const s = a.workspace.serialize();
  const fields = (record: { readonly updatedAt: number }) => ({ ...record, updatedAt: 0 });
  return JSON.stringify([s.cameras.map(fields), s.viewports.map(fields)]);
}

const shownHeading = (a: ReferenceApp) => {
  const rotation = a.workspace.getPresented().cameras.get(CAMERA_ID)?.rotation;
  if (rotation === undefined) throw new Error('no camera');
  return headingPitchOf(rotation).heading * DEGREES;
};

/** The centre of a surface's widest piece in a frame, in the viewport's pixels. */
function centreIn(f: ViewportFrame, surfaceId: string): readonly [number, number] | null {
  const pieces = f.frame.planned.filter((p) => p.fragment.surfaceId === surfaceId);
  const widest = pieces.sort((a, b) => b.fragment.bounds[2] - a.fragment.bounds[2])[0];
  if (widest === undefined) return null;
  const [x, y, w, h] = widest.fragment.bounds;
  return [x + w / 2, y + h / 2];
}

/** The strip as the page shows it: its keyboard stop, its drawing, and each window's card. */
function strip(root: HTMLElement) {
  const viewport = root.querySelector<HTMLElement>(
    '[data-wsb="page.focus.strip"] .wsb-stage__viewport',
  );
  const canvas = root.querySelector<HTMLCanvasElement>('[data-wsb="page.focus.strip.surface"]');
  if (viewport === null || canvas === null) throw new Error('the focus strip is not shown');
  const cards = [...root.querySelectorAll<HTMLElement>('[data-wsb^="page.focus.strip.unit#"]')].map(
    (unit) => {
      const id = unit.getAttribute('data-wsb')?.slice('page.focus.strip.unit#'.length) ?? '';
      const title = unit.querySelector<HTMLElement>('.wsb-stage__unit-title');
      if (title === null) throw new Error(`card ${id} has no name`);
      return { id, title, box: unit.getBoundingClientRect() };
    },
  );
  return { viewport, canvas, cards, box: viewport.getBoundingClientRect() };
}

const middleOf = (box: DOMRect) => box.left + box.width / 2;

/** The colour the strip's drawing has at a page point, as [r, g, b, a]. */
function pixelAt(canvas: HTMLCanvasElement, x: number, y: number): number[] {
  const box = canvas.getBoundingClientRect();
  const ratio = canvas.width / box.width;
  const g = canvas.getContext('2d');
  if (g === null) throw new Error('no drawing');
  const at = g.getImageData(
    Math.round((x - box.left) * ratio),
    Math.round((y - box.top) * ratio),
    1,
    1,
  );
  return [...at.data];
}

const intersects = (a: DOMRect, b: DOMRect) =>
  a.left < b.right - 0.5 &&
  b.left < a.right - 0.5 &&
  a.top < b.bottom - 0.5 &&
  b.top < a.bottom - 0.5;

describe('focus with the strip of every window (section 3)', () => {
  it('makes the selected window readable, over a strip of every window’s picture and name in their order round the camera, none over another', async () => {
    const m = await visit(memoryTexts(), EVIDENCE);
    const a = app(m.model);
    await focusFromList(m, 'desk');
    expect(a.status().mode).toBe(FOCUS_ID);
    expect(m.root.textContent).toContain('Focus: Writing Desk');
    // The focused window fills most of the view, live: its own content, to read and edit.
    const main = await frameOf(a);
    const size = a.workspace.getState().viewports.get(VIEWPORT_ID)?.size;
    const piece = main.frame.planned.find((p) => p.fragment.surfaceId === 'desk-surface');
    if (piece === undefined || size === undefined) {
      throw new Error('the focused window is not shown');
    }
    // Its outline, the card with its title bar, three-quarters of the view by its binding side.
    const [, , w, h] = piece.fragment.card;
    expect(Math.max(w / size.width, (h + TITLE_BAR_HEIGHT) / size.height)).toBeCloseTo(0.75, 2);
    expect(a.viewport.presentation('desk-surface')).toBe('live');
    // The strip: a card for every window, in the order they lie round the camera.
    const state = a.workspace.getState();
    const order = stripWindows(state, 'desk', [0, 0, 0]);
    const shown = strip(m.root);
    expect(shown.cards.map((c) => c.id).sort()).toEqual(order.map((o) => o.id).sort());
    const centre = (id: string) => {
      const box = shown.cards.find((c) => c.id === id)?.box;
      if (box === undefined) throw new Error(`no card for ${id}`);
      return middleOf(box);
    };
    const centres = order.map((o) => centre(o.id));
    expect(centres).toEqual([...centres].sort((p, q) => p - q));
    expect(Math.abs(centre('desk') - middleOf(shown.box))).toBeLessThan(1);
    for (const [i, card] of shown.cards.entries()) {
      // Inside the strip, over no other card, its name whole and on show.
      expect(card.box.left, card.id).toBeGreaterThanOrEqual(shown.box.left - 0.5);
      expect(card.box.right, card.id).toBeLessThanOrEqual(shown.box.right + 0.5);
      expect(card.box.top, card.id).toBeGreaterThanOrEqual(shown.box.top - 0.5);
      expect(card.box.bottom, card.id).toBeLessThanOrEqual(shown.box.bottom + 0.5);
      for (const other of shown.cards.slice(i + 1)) {
        expect(intersects(card.box, other.box), `${card.id} over ${other.id}`).toBe(false);
      }
      expect(getComputedStyle(card.title).visibility, card.id).toBe('visible');
      expect(card.title.textContent, card.id).toBe(state.nodes.get(card.id)?.label);
      expect(card.title.scrollWidth, card.id).toBeLessThanOrEqual(card.title.clientWidth);
      expect(card.title.scrollHeight, card.id).toBeLessThanOrEqual(card.title.clientHeight);
      // Under its name, a picture of what it holds: something drawn, not the strip's ground.
      const title = card.title.getBoundingClientRect();
      const picture = pixelAt(
        shown.canvas,
        middleOf(card.box),
        (title.bottom + card.box.bottom) / 2,
      );
      expect(picture[3], card.id).toBe(255);
    }
    // A tile's picture is the host's own drawing, the one the panorama draws.
    const signals = state.surfaces.get('signals-surface')?.bindingKey ?? '';
    expect(a.content.preview(signals)).toBe(a.runtime.handleOf('signals-surface'));
    // The named neighbours above the strip read in the same order, left to right.
    const named = [...m.root.querySelectorAll('[data-wsb^="page.focus.context#"]')].map((e) =>
      e.getAttribute('data-wsb')?.slice('page.focus.context#'.length),
    );
    const at = order.findIndex((o) => o.id === 'desk');
    expect(named).toEqual([
      ...order.slice(Math.max(0, at - 2), at).map((o) => o.id),
      ...order.slice(at + 1, at + 3).map((o) => o.id),
    ]);
    // The status bar's hint for focus is whole.
    const hint = m.root.querySelector<HTMLElement>('[data-wsb="application.panel.focus"]');
    if (hint === null) throw new Error('no focus hint');
    for (const element of [hint, ...hint.querySelectorAll<HTMLElement>('*')]) {
      expect(element.scrollWidth, element.className).toBeLessThanOrEqual(
        Math.max(element.clientWidth, element.getBoundingClientRect().width) + 0.5,
      );
    }
  });

  it('names the windows a narrower strip has no room for, the rest laid out apart, nearest kept', async () => {
    const m = await visit();
    const a = app(m.model);
    await focusFromList(m, 'desk');
    const order = stripWindows(a.workspace.getState(), 'desk', [0, 0, 0]);
    const shown = strip(m.root);
    const ids = new Set(shown.cards.map((c) => c.id));
    const missing = order.filter((o) => !ids.has(o.id));
    for (const [i, card] of shown.cards.entries()) {
      for (const other of shown.cards.slice(i + 1)) {
        expect(intersects(card.box, other.box), `${card.id} over ${other.id}`).toBe(false);
      }
      expect(card.title.scrollWidth, card.id).toBeLessThanOrEqual(card.title.clientWidth);
      expect(card.title.scrollHeight, card.id).toBeLessThanOrEqual(card.title.clientHeight);
    }
    // What is left out lies farther round than anything shown.
    if (missing.length > 0) {
      const nearestLeftOut = Math.min(...missing.map((o) => Math.abs(o.bearing)));
      const farthestShown = Math.max(
        ...order.filter((o) => ids.has(o.id)).map((o) => Math.abs(o.bearing)),
      );
      expect(nearestLeftOut).toBeGreaterThanOrEqual(farthestShown - 1e-9);
    }
    if (missing.length > 0) {
      expect(m.root.textContent).toContain(
        `Not in the strip: ${[...missing]
          .sort((p, q) => Math.abs(p.bearing) - Math.abs(q.bearing))
          .map((o) => o.label)
          .join(', ')}`,
      );
    }
  });

  it('shows a drawn tile readably in focus on the default backend', async () => {
    const m = await visit();
    const a = app(m.model);
    expect(a.status().backend).toBe('geometry');
    await focusFromList(m, 'signals');
    const main = await frameOf(a);
    const size = a.workspace.getState().viewports.get(VIEWPORT_ID)?.size;
    const pieces = main.frame.planned.filter((p) => p.fragment.surfaceId === 'signals-surface');
    expect(pieces.length).toBeGreaterThan(0);
    expect(pieces.every((p) => p.negotiation.layer === 'content-raster')).toBe(true);
    // Its outline, the card with its title bar, three-quarters of the view by its binding side.
    const [, , w, h] = pieces[0]?.fragment.card ?? [0, 0, 0, 0];
    expect(
      Math.max(w / (size?.width ?? 1), (h + TITLE_BAR_HEIGHT) / (size?.height ?? 1)),
    ).toBeCloseTo(0.75, 2);
    // The inspector says so.
    await expect.poll(() => m.model.selected?.presentation, { timeout: 5000 }).toBe('drawn');
  });

  it('focuses a window pressed in the strip directly, and steps from the strip and the bar', async () => {
    const m = await visit();
    const a = app(m.model);
    await focusFromList(m, 'desk');
    const card = strip(m.root).cards.find((c) => c.id === 'signals');
    if (card === undefined) throw new Error('Signal Monitor is not in the strip');
    const x = middleOf(card.box);
    const y = card.box.top + card.box.height / 2;
    await commands.mouse('down', x, y);
    await commands.mouse('up', x, y);
    await expect.poll(() => a.workspace.getState().focusedId).toBe('signals');
    await settled(m);
    expect(a.status().mode).toBe(FOCUS_ID);
    // The strip turns to the window focused: it is in the middle now.
    const turned = strip(m.root);
    const middle = turned.cards.find((c) => c.id === 'signals')?.box;
    if (middle === undefined) throw new Error('Signal Monitor left the strip');
    expect(Math.abs(middleOf(middle) - middleOf(turned.box))).toBeLessThan(1);
    // From the strip's keyboard stop, the arrows step to the next window that way.
    const order = stripWindows(a.workspace.getState(), 'signals', [0, 0, 0]);
    const left = order[order.findIndex((o) => o.id === 'signals') - 1];
    turned.viewport.focus();
    turned.viewport.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }),
    );
    await expect.poll(() => a.workspace.getState().focusedId).toBe(left?.id);
    await settled(m);
    // Next window, in the focus's bar, steps to the right.
    const now = a.workspace.getState().focusedId ?? '';
    const after = stripWindows(a.workspace.getState(), now, [0, 0, 0]);
    const right = after[after.findIndex((o) => o.id === now) + 1];
    m.driver.act('page.focus.next', 'press');
    await expect.poll(() => a.workspace.getState().focusedId).toBe(right?.id);
    expect(a.status().mode).toBe(FOCUS_ID);
  });

  it('moves into and out of focus over several frames, and leaving puts the previous view back exactly', async () => {
    const m = await visit();
    const a = app(m.model);
    // A view of the reader's own: turned, and zoomed in.
    expect(a.turnCamera(40).status).toBe('committed');
    expect(a.modes.fieldOfView(200).status).toBe('committed');
    await m.settle();
    const before = { view: viewRecords(a), layout: layout(m.model) };
    const start = shownHeading(a);
    m.driver.act('workshop.view#windows', 'press');
    await m.settle();
    m.driver.act('page.windows.window#builds', 'press');
    await m.settle();
    m.driver.act('editor.actions.mode#focus', 'press');
    // The focus is committed at once, and shown arriving over frames.
    const target = headingPitchOf(
      a.workspace.getState().cameras.get(CAMERA_ID)?.rotation ?? [0, 0, 0, 1],
    ).heading;
    expect(a.transitions.running()).toBe(true);
    const seen: number[] = [];
    while (a.transitions.running()) {
      seen.push(shownHeading(a));
      await nextFrame();
    }
    const between = seen.filter(
      (d) => Math.abs(d - start) > 0.5 && Math.abs(d - target * DEGREES) > 0.5,
    );
    expect(between.length).toBeGreaterThan(2);
    await settled(m);
    // Leaving moves back the same way, and the view is the reader's own again, exactly.
    m.driver.act('page.focus.close', 'press');
    expect(a.transitions.running()).toBe(true);
    await settled(m);
    expect(a.status().mode).toBe(PANORAMA.id);
    expect(viewRecords(a)).toBe(before.view);
    expect(layout(m.model)).toEqual(before.layout);
    expect(a.workspace.getPresented()).toBe(a.workspace.getState());
    expect(m.root.querySelector('[data-wsb="page.focus.strip"]')).toBeNull();
  });

  it('keeps host content live and the same in and out of focus, and what is written in a note', async () => {
    const texts = memoryTexts();
    const m = await visit(texts);
    const a = app(m.model);
    const key = a.workspace.getState().surfaces.get('desk-surface')?.bindingKey ?? '';
    const note = () => {
      const found = m.root.querySelectorAll<HTMLElement>(`[data-reference-content="${key}"]`);
      expect(found).toHaveLength(1);
      const [element] = found;
      if (element === undefined) throw new Error('the note is not on the page');
      return element;
    };
    const element = note();
    const body = element.querySelector<HTMLElement>('[contenteditable]');
    if (body === null) throw new Error('the note has nothing to write in');
    body.focus();
    body.textContent = 'Written before focus';
    body.dispatchEvent(new InputEvent('input', { bubbles: true }));
    const tile = a.runtime.handleOf('signals-surface');
    await focusFromList(m, 'desk');
    // In focus: the very element, in the panorama's own surface, live, with what was written.
    expect(note()).toBe(element);
    expect(element.closest('[data-wsb="page.panorama.surface"]')).not.toBeNull();
    expect(a.viewport.presentation('desk-surface')).toBe('live');
    expect(a.runtime.get('desk-surface')?.state).toBe('presented');
    expect(element.textContent).toContain('Written before focus');
    expect(a.runtime.handleOf('signals-surface')).toBe(tile);
    // The strip's picture of the note follows what is written in it.
    const drawn = a.content.preview(key)?.revision ?? 0;
    body.textContent = 'Written in focus';
    body.dispatchEvent(new InputEvent('input', { bubbles: true }));
    expect(a.content.preview(key)?.revision).toBeGreaterThan(drawn);
    m.driver.act('page.focus.close', 'press');
    await settled(m);
    expect(note()).toBe(element);
    expect(element.textContent).toContain('Written in focus');
    expect(a.runtime.handleOf('signals-surface')).toBe(tile);
    // What was written is the host's: the note shows it when it is bound again, next visit too.
    expect(texts.kept.get(key)).toBe('Written in focus');
    await endVisits();
    const again = await visit(texts);
    const shownAgain = again.root.querySelector(`[data-reference-content="${key}"]`);
    expect(shownAgain?.textContent).toContain('Written in focus');
  });

  it('focuses a window double-pressed on its frame in the panorama', async () => {
    const m = await visit();
    const a = app(m.model);
    const main = await frameOf(a);
    // A window the panorama stands in for at its distance, a compact preview or its label, whose
    // card is uncovered at its centre: its whole card takes the press.
    const standIn = main.frame.planned.find((p) => {
      const at = centreIn(main, p.fragment.surfaceId);
      const id = a.workspace.getState().surfaces.get(p.fragment.surfaceId)?.ownerNodeId;
      return p.representation !== 'full' && at !== null && a.windowAt(at[0], at[1]) === id;
    });
    const id = a.workspace.getState().surfaces.get(standIn?.fragment.surfaceId ?? '')?.ownerNodeId;
    const at = centreIn(main, standIn?.fragment.surfaceId ?? '');
    if (id === undefined || at === null) throw new Error('no window stood in for in the panorama');
    const surface = m.root.querySelector('[data-wsb="page.panorama.surface"]');
    if (surface === null) throw new Error('no panorama');
    const box = surface.getBoundingClientRect();
    await commands.mouse('double', box.left + at[0], box.top + at[1]);
    await expect.poll(() => a.status().mode).toBe(FOCUS_ID);
    expect(a.workspace.getState().focusedId).toBe(id);
  });
});
