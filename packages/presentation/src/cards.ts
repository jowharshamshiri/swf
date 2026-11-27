import type { Representation } from './representation.js';

/**
 * How windows are drawn: each as a card, a flat, upright rectangle at the window's projected centre,
 * never warped by the projection. A card is the window's own size at
 * {@link CARD_PIXELS_PER_UNIT}, times its scale; its surfaces lie on it where they lie on the
 * window, across and up. How a card's scale follows its distance:
 * - where the viewport chooses how to represent its windows by distance (semantic depth), a card
 *   keeps nearly one size, and distance changes what it shows: a window shown in full is scaled
 *   `0.91 + (6 − r) × 0.012` (r its distance along the floor), kept within 0.75 to 1.08; a compact
 *   preview 0.9, the size {@link COMPACT_CARD} gives; a label alone 1, as {@link LABEL_CARD};
 * - otherwise every window is shown in full, scaled `7.1 / r × 200 / (fov + 50)` (fov the view's
 *   horizontal angle in degrees), kept within 0.36 to 1.5.
 */
export const CARD_PIXELS_PER_UNIT = 80;

/** A compact preview's size, as a share of its window's card across and down. */
export const COMPACT_CARD: Readonly<{
  /** The share of the card's width a compact preview takes. */
  width: number;
  /** The share of the card's height a compact preview takes. */
  height: number;
}> = Object.freeze({
  width: 138 / 176,
  height: 61 / 126,
});

/** A window shown by its label alone: a card this many CSS pixels across and down, before scale. */
export const LABEL_CARD: Readonly<{
  /** Its width, in CSS pixels before the card's scale. */
  width: number;
  /** Its height, in CSS pixels before the card's scale. */
  height: number;
}> = Object.freeze({
  width: 112,
  height: 31,
});

/** The nearest distance along the floor a card's scale reads, so a window at the centre has one. */
const NEAREST = 0.01;

/**
 * A card's scale for a window `floor` units out along the floor, shown as `representation`, in a
 * view `fieldOfView` degrees across; `semantic` when the viewport represents its windows by
 * distance. See {@link CARD_PIXELS_PER_UNIT}.
 */
export function cardScale(
  representation: Representation,
  floor: number,
  fieldOfView: number,
  semantic: boolean,
): number {
  const r = Math.max(NEAREST, floor);
  if (!semantic) {
    return Math.min(1.5, Math.max(0.36, (7.1 / r) * (200 / (fieldOfView + 50))));
  }
  switch (representation) {
    case 'full':
      return Math.min(1.08, Math.max(0.75, 0.91 + (6 - r) * 0.012));
    case 'compact':
      return 0.9;
    case 'label':
      return 1;
  }
}

/** What a window's card is made from. */
export interface CardInput {
  /** The window's own width and height, in its own units. */
  readonly bounds: readonly [number, number];
  /** The window's world scale across and up: its own units to world units. */
  readonly worldScale: readonly [number, number];
  /** Its distance from the camera along the floor, in world units. */
  readonly floor: number;
  /** How it is represented. */
  readonly representation: Representation;
  /** The view's horizontal angle, in degrees. */
  readonly fieldOfView: number;
  /** The viewport represents its windows by distance (semantic depth). */
  readonly semantic: boolean;
  /**
   * The card's scale, when something other than the card rules decides it (a representation
   * policy's `scaleOf`); default the rules' {@link cardScale}.
   */
  readonly scale?: number;
}

/** A window's card as a view draws it. */
export interface WindowCard {
  /** The card's scale, as {@link cardScale} gives it. */
  readonly scale: number;
  /** The card's width, in CSS pixels. */
  readonly width: number;
  /** The card's height, in CSS pixels. */
  readonly height: number;
  /** CSS pixels the card draws for each unit of the window's own size, across and up. */
  readonly perUnit: readonly [number, number];
}

/**
 * A window's card: its own size in world units at {@link CARD_PIXELS_PER_UNIT}, times its scale,
 * shrunk to {@link COMPACT_CARD} for a compact preview, or {@link LABEL_CARD} for a label alone.
 */
export function windowCard(input: CardInput): WindowCard {
  const scale =
    input.scale ?? cardScale(input.representation, input.floor, input.fieldOfView, input.semantic);
  const unit = CARD_PIXELS_PER_UNIT * scale;
  const [w, h] = input.bounds;
  const [across, up] = input.worldScale;
  const full = [w * across * unit, h * up * unit] as const;
  const [width, height] =
    input.representation === 'compact'
      ? [full[0] * COMPACT_CARD.width, full[1] * COMPACT_CARD.height]
      : input.representation === 'label'
        ? [LABEL_CARD.width * scale, LABEL_CARD.height * scale]
        : full;
  return Object.freeze({
    scale,
    width,
    height,
    perUnit: Object.freeze([width / Math.max(1e-9, w), height / Math.max(1e-9, h)] as const),
  });
}
