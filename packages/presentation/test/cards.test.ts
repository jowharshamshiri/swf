import { describe, expect, it } from 'vitest';
import {
  CARD_PIXELS_PER_UNIT,
  cardScale,
  COMPACT_CARD,
  LABEL_CARD,
  windowCard,
} from '../src/index.js';

describe('the cards windows are drawn on', () => {
  it('keeps a card near one size by semantic depth, distance changing what it shows', () => {
    // In full: 0.91 + (6 − r) × 0.012, kept within 0.75 to 1.08.
    expect(cardScale('full', 6, 360, true)).toBeCloseTo(0.91, 12);
    expect(cardScale('full', 2, 360, true)).toBeCloseTo(0.958, 12);
    expect(cardScale('full', 40, 360, true)).toBe(0.75);
    // At the centre, read as 0.01 units out, the largest a card in full grows.
    expect(cardScale('full', 0, 360, true)).toBeCloseTo(0.91 + (6 - 0.01) * 0.012, 12);
    expect(cardScale('compact', 8, 85, true)).toBe(0.9);
    expect(cardScale('label', 12, 85, true)).toBe(1);
  });

  it('scales a card by its distance and the field of view when every window is shown in full', () => {
    // 7.1 / r × 200 / (fov + 50), kept within 0.36 to 1.5.
    expect(cardScale('full', 5, 150, false)).toBeCloseTo((7.1 / 5) * (200 / 200), 12);
    expect(cardScale('full', 2, 85, false)).toBe(1.5);
    expect(cardScale('full', 13.5, 360, false)).toBe(0.36);
  });

  it('draws a window its own size at 80 pixels a unit, a compact preview and a label smaller', () => {
    expect(CARD_PIXELS_PER_UNIT).toBe(80);
    const full = windowCard({
      bounds: [2.2, 1.575],
      worldScale: [1, 1],
      floor: 6,
      representation: 'full',
      fieldOfView: 360,
      semantic: true,
    });
    expect(full.width).toBeCloseTo(2.2 * 80 * 0.91, 9);
    expect(full.height).toBeCloseTo(1.575 * 80 * 0.91, 9);
    expect(full.perUnit[0]).toBeCloseTo(80 * 0.91, 9);
    const compact = windowCard({
      bounds: [2.2, 1.575],
      worldScale: [2, 1],
      floor: 8,
      representation: 'compact',
      fieldOfView: 360,
      semantic: true,
    });
    expect(compact.width).toBeCloseTo(2.2 * 2 * 80 * 0.9 * COMPACT_CARD.width, 9);
    expect(compact.height).toBeCloseTo(1.575 * 80 * 0.9 * COMPACT_CARD.height, 9);
    const label = windowCard({
      bounds: [3, 2],
      worldScale: [1, 1],
      floor: 12,
      representation: 'label',
      fieldOfView: 360,
      semantic: true,
    });
    expect([label.width, label.height]).toEqual([LABEL_CARD.width, LABEL_CARD.height]);
  });

  it('takes a scale given in place of the rules', () => {
    const card = windowCard({
      bounds: [2, 1],
      worldScale: [1, 1],
      floor: 6,
      representation: 'full',
      fieldOfView: 360,
      semantic: true,
      scale: 2.5,
    });
    expect([card.scale, card.width, card.height]).toEqual([2.5, 400, 200]);
  });
});
