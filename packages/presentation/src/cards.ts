import type { Id } from '@swf/core';
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

/**
 * How precisely a pointer points: `fine` for a mouse or a trackpad, `coarse` for a finger or a pen
 * without hover. Coarse pointers get larger handles.
 */
export type PointerPrecision = 'fine' | 'coarse';

/** The sizes of a window's handles for one pointer precision, in CSS pixels. */
export interface HandleSizes {
  /** The title bar's height a press counts in, from the card's top edge up. */
  readonly titleBar: number;
  /** How far outside the window's outline its resize band reaches. */
  readonly outside: number;
  /** How far inside the window's outline its resize band reaches, at its sides and bottom. */
  readonly inside: number;
  /** How far a corner's resize zone reaches along each edge from the band's outer edge. */
  readonly corner: number;
}

/**
 * A window's handles: the title bar across the top of its card, drawn {@link TITLE_BAR_HEIGHT}
 * pixels high whatever the card's scale, where a press selects the window, a drag moves it and a
 * double press focuses it; and the resize band round its outline (its card with its title bar),
 * reaching `outside` beyond it and `inside` within it at the sides and bottom, never into the title
 * bar, with larger zones at the corners. A press counts on the title bar over `titleBar` pixels,
 * more than it is drawn for a coarse pointer, reaching up into the space above it. Sizes follow
 * WCAG 2.5.8's 24 CSS pixels for a fine pointer, and the 44 pixels of touch norms for a coarse one.
 */
export const WINDOW_HANDLES: Readonly<Record<PointerPrecision, HandleSizes>> = Object.freeze({
  fine: Object.freeze({ titleBar: 24, outside: 8, inside: 4, corner: 20 }),
  coarse: Object.freeze({ titleBar: 44, outside: 16, inside: 6, corner: 34 }),
});

/** The height a window's title bar is drawn at, in CSS pixels, whatever the card's scale. */
export const TITLE_BAR_HEIGHT = 24;

/** A rectangle in CSS pixels: left, top, width, height. */
type Rect = readonly [number, number, number, number];

/**
 * A window's title bar on a view, for a card drawn at `card` as `representation`: the bar across
 * the top of the card, `height` pixels high above it (by default as drawn); a window shown by its
 * label alone has the label's card as its title bar.
 */
export function titleBarOf(
  card: Rect,
  representation: Representation,
  height: number = TITLE_BAR_HEIGHT,
): Rect {
  const [x, y, w] = card;
  return representation === 'label' ? card : [x, y - height, w, height];
}

/** A window's outline on a view: its card with its title bar as drawn. */
export function outlineOf(card: Rect, representation: Representation): Rect {
  const [x, y, w, h] = card;
  return representation === 'label' ? card : [x, y - TITLE_BAR_HEIGHT, w, h + TITLE_BAR_HEIGHT];
}

/** The edge or corner of a window's resize band, by compass point: `n` its top, `e` its right. */
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * The edge or corner of a window's resize band a point lies in, or null when it lies in none. The
 * band is the ring round the window's outline (its card with its title bar, as a press counts it
 * for this precision) reaching `outside` beyond it and `inside` within it at the sides and bottom;
 * at the top, which is the title bar's, only beyond it; and all round only beyond it for a window
 * shown by its label alone, whose whole card is its title bar. Each corner of the ring's outer edge
 * has a square zone `corner` pixels on a side, which is that corner's wherever the point lies in it.
 */
export function bandEdgeAt(
  card: Rect,
  representation: Representation,
  precision: PointerPrecision,
  px: number,
  py: number,
): ResizeEdge | null {
  const { outside, inside, corner } = bandSizes(representation, precision);
  const [left, top, right, bottom] = outerBox(card, representation, precision);
  if (px < left || px > right || py < top || py > bottom) {
    return null;
  }
  const west = px < left + corner;
  const east = px > right - corner;
  const north = py < top + corner;
  const south = py > bottom - corner;
  if (north && west) return 'nw';
  if (north && east) return 'ne';
  if (south && west) return 'sw';
  if (south && east) return 'se';
  if (py < top + outside) return 'n';
  if (py > bottom - outside - inside) return 's';
  if (px < left + outside + inside) return 'w';
  if (px > right - outside - inside) return 'e';
  return null;
}

/**
 * A window's handle sizes as its resize band takes them: a window shown by its label alone, whose
 * whole card is its title bar, has its band outside the card only, so the bar keeps its height.
 */
function bandSizes(representation: Representation, precision: PointerPrecision): HandleSizes {
  const sizes = WINDOW_HANDLES[precision];
  return representation === 'label' ? { ...sizes, inside: 0 } : sizes;
}

/**
 * The outer edge of a window's resize band, as left, top, right and bottom: its outline (its card
 * with its title bar, as a press counts it for this precision) grown by the band's `outside`.
 */
function outerBox(
  card: Rect,
  representation: Representation,
  precision: PointerPrecision,
): readonly [number, number, number, number] {
  const { outside, titleBar } = WINDOW_HANDLES[precision];
  const bar = titleBarOf(card, representation, titleBar);
  return [
    card[0] - outside,
    Math.min(bar[1], card[1]) - outside,
    card[0] + card[2] + outside,
    card[1] + card[3] + outside,
  ];
}

/**
 * Where each zone of a window's resize band lies, for a pointer of `precision`, relative to the
 * card's top-left corner: the rectangle `bandEdgeAt` gives that edge or corner in. A renderer lays
 * its handles out by it.
 */
export function bandZones(
  card: Rect,
  representation: Representation,
  precision: PointerPrecision,
): Readonly<Record<ResizeEdge, Rect>> {
  const { outside, inside, corner } = bandSizes(representation, precision);
  const [l, t, r, b] = outerBox(card, representation, precision);
  const [x, y] = card;
  const at = (left: number, top: number, width: number, height: number): Rect => [
    left - x,
    top - y,
    width,
    height,
  ];
  const across = r - l - 2 * corner;
  const down = b - t - 2 * corner;
  const side = outside + inside;
  return {
    nw: at(l, t, corner, corner),
    ne: at(r - corner, t, corner, corner),
    sw: at(l, b - corner, corner, corner),
    se: at(r - corner, b - corner, corner, corner),
    n: at(l + corner, t, across, outside),
    s: at(l + corner, b - side, across, side),
    w: at(l, t + corner, side, down),
    e: at(r - side, t + corner, side, down),
  };
}

/**
 * The colours a window's title bar is drawn in, as CSS colours: its fill, and its name's text, which
 * should stand out from the fill by 4.5:1 (WCAG 1.4.3).
 */
export interface TitleBarColours {
  /** The bar's fill: a non-blank CSS colour. */
  readonly fill: string;
  /** The name written on it: a non-blank CSS colour. */
  readonly text: string;
}

/**
 * The colours of a window's title bar, by its node ID, as a host gives them (the colour of what
 * the window holds, say); null for a window the host gives none, whose bar a renderer draws in
 * its own inks.
 */
export type TitleBarColouring = (nodeId: Id) => TitleBarColours | null;
