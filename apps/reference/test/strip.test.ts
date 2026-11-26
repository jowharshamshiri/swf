import { createWorkspace } from '@swf/core';
import { describe, expect, it } from 'vitest';
import { CAMERA_ID, planPreset, presetCommands } from '../src/presets.js';
import type { StripCard, StripLayout, StripWindow } from '../src/strip.js';
import { stripLayout, stripWindows } from '../src/strip.js';

const METRICS = Object.freeze({ least: 96, most: 160, gap: 6 });

function studio() {
  const ws = createWorkspace({ id: 'test' });
  const result = ws.transaction([
    { type: 'camera.create', camera: { id: CAMERA_ID } },
    ...presetCommands(planPreset('studio', 1)),
  ]);
  expect(result.status).toBe('committed');
  return ws.getState();
}

function windows(count: number): StripWindow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `w${String(i).padStart(2, '0')}`,
    label: `Window ${String(i)}`,
    bearing: i === 0 ? 0 : -180 + (360 * i) / count,
    aspect: 1.5,
    focused: i === 0,
    surfaces: [{ key: `k${String(i)}`, share: 1 }],
  })).sort((a, b) => a.bearing - b.bearing);
}

function overlaps(a: StripCard, b: StripCard): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Every card apart from every other, inside the strip, in the order of their bearings. */
function wellLaid(layout: StripLayout, size: { width: number; height: number }) {
  const { cards } = layout;
  for (const [i, a] of cards.entries()) {
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.y).toBeGreaterThanOrEqual(0);
    expect(a.x + a.width).toBeLessThanOrEqual(size.width + 1e-9);
    expect(a.y + a.height).toBeLessThanOrEqual(size.height + 1e-9);
    expect(a.width).toBeGreaterThanOrEqual(METRICS.least - 1e-9);
    for (const b of cards.slice(i + 1)) {
      expect(overlaps(a, b), `${a.window.id} over ${b.window.id}`).toBe(false);
    }
  }
  const centres = cards.map((c) => c.x + c.width / 2);
  for (let i = 1; i < centres.length; i++) {
    expect(centres[i]).toBeGreaterThan(centres[i - 1] ?? 0);
    expect(cards[i]?.window.bearing).toBeGreaterThanOrEqual(cards[i - 1]?.window.bearing ?? 0);
  }
}

describe('the focus strip’s layout', () => {
  it('orders every window round the focused one by bearing, the focused one at zero', () => {
    const state = studio();
    const all = stripWindows(state, 'desk', [0, 0, 0]);
    expect(all).toHaveLength(13);
    expect(all.find((w) => w.focused)?.id).toBe('desk');
    expect(all.find((w) => w.focused)?.bearing).toBe(0);
    const bearings = all.map((w) => w.bearing);
    expect(bearings).toEqual([...bearings].sort((a, b) => a - b));
    expect(bearings.every((b) => b > -180 && b <= 180)).toBe(true);
    // The board's three surfaces share its card, left to right.
    const board = all.find((w) => w.id === 'board');
    expect(board?.surfaces.map((s) => s.key)).toHaveLength(3);
    expect(board?.surfaces.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 12);
  });

  it('keeps a few windows in one row, each where its bearing puts it', () => {
    const few = windows(5);
    const size = { width: 1200, height: 160 };
    const layout = stripLayout(few, size, METRICS);
    wellLaid(layout, size);
    expect(layout.cards.every((c) => c.row === 0)).toBe(true);
    const inner = size.width - 2 * METRICS.gap;
    for (const card of layout.cards) {
      const wish = size.width / 2 + (card.window.bearing / 360) * inner;
      expect(Math.abs(card.x + card.width / 2 - wish)).toBeLessThan(card.width);
    }
    const focused = layout.cards.find((c) => c.window.focused);
    expect((focused?.x ?? 0) + (focused?.width ?? 0) / 2).toBeCloseTo(size.width / 2, 6);
  });

  it('lays the studio’s thirteen out in two rows at the panorama’s width, none over another', () => {
    const state = studio();
    const size = { width: 782, height: 170 };
    const layout = stripLayout(stripWindows(state, 'desk', [0, 0, 0]), size, METRICS);
    wellLaid(layout, size);
    expect(layout.cards).toHaveLength(13);
    expect(new Set(layout.cards.map((c) => c.row))).toEqual(new Set([0, 1]));
    // Neighbours in the order lie in the other row, so each may be as wide as two steps.
    for (let i = 1; i < layout.cards.length; i++) {
      expect(layout.cards[i]?.row).not.toBe(layout.cards[i - 1]?.row);
    }
    expect(layout.hidden).toEqual({ left: [], right: [] });
  });

  it('shows the nearest each way when even two rows cannot hold them, and counts the rest', () => {
    const many = windows(40);
    const size = { width: 782, height: 170 };
    const layout = stripLayout(many, size, METRICS);
    wellLaid(layout, size);
    const shown = new Set(layout.cards.map((c) => c.window.id));
    expect(shown.has('w00')).toBe(true);
    const farthestShown = Math.max(...layout.cards.map((c) => Math.abs(c.window.bearing)));
    for (const w of many.filter((w) => !shown.has(w.id))) {
      expect(Math.abs(w.bearing)).toBeGreaterThanOrEqual(farthestShown);
    }
    const hidden = [...layout.hidden.left, ...layout.hidden.right];
    expect(hidden).toHaveLength(many.length - layout.cards.length);
    expect(layout.hidden.left.every((w) => w.bearing < 0)).toBe(true);
    expect(layout.hidden.right.every((w) => w.bearing > 0)).toBe(true);
  });

  it('refuses a strip too small for a card', () => {
    expect(() => stripLayout(windows(3), { width: 50, height: 160 }, METRICS)).toThrow(
      'too small for a card',
    );
  });
});
