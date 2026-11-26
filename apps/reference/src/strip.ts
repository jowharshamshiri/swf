import type { Id, SceneState } from '@swf/core';
import { effectiveState, worldTransform } from '@swf/core';
import type { Vec3 } from '@swf/math';

/**
 * The focus strip's layout: under a focused window, a card for each window, focused one in the
 * middle, the others left and right of it in the order they lie round the camera, each as far
 * from the middle as it lies round where it can be, and never over another. Cards are as wide as
 * one row of them allows; when one row would make them too narrow for their names, they lie in
 * two rows, one card in each in turn, so each may be twice as wide; when even two rows cannot
 * hold them all, the nearest each way are shown and the rest counted.
 */

/** A window as the strip shows it. */
export interface StripWindow {
  readonly id: Id;
  readonly label: string;
  /** Degrees it lies to the right of the focused window round the camera, in (-180, 180]. */
  readonly bearing: number;
  /** Its width over its height. */
  readonly aspect: number;
  /** It is the focused window. */
  readonly focused: boolean;
  /** Its surfaces' binding keys, left to right, each with its share of the window's width. */
  readonly surfaces: readonly { readonly key: string; readonly share: number }[];
}

/** How large a strip's cards may be, in CSS pixels. */
export interface StripMetrics {
  /** The narrowest a card may be: its name still fits, two words to a line. */
  readonly least: number;
  /** The widest a card is. */
  readonly most: number;
  /** Between two cards, and between the strip's edge and a card. */
  readonly gap: number;
}

/** Where a card lies in the strip, in CSS pixels from its top-left. */
export interface StripCard {
  readonly window: StripWindow;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly row: 0 | 1;
}

export interface StripLayout {
  readonly cards: readonly StripCard[];
  /** The windows not shown, to the left and to the right, in order. */
  readonly hidden: {
    readonly left: readonly StripWindow[];
    readonly right: readonly StripWindow[];
  };
}

const DEGREES = 180 / Math.PI;

/**
 * Every active window round the camera's eye as the strip shows it, the focused one included,
 * ordered by bearing (then ID). Throws for a focused window that is not an active, placed window.
 */
export function stripWindows(state: SceneState, focusedId: Id, eye: Vec3): StripWindow[] {
  const placedAt = (id: Id) => {
    const world = worldTransform(state.nodes, id);
    return world?.ok === true ? world.transform : null;
  };
  const focused = placedAt(focusedId);
  if (focused === null || state.nodes.get(focusedId)?.kind !== 'window') {
    throw new Error(`no placed window "${focusedId}" to lay the strip out round`);
  }
  const headingOf = ([x, , z]: Vec3) => Math.atan2(x - eye[0], -(z - eye[2])) * DEGREES;
  const centre = headingOf(focused.position);
  const windows: StripWindow[] = [];
  for (const node of state.nodes.values()) {
    if (node.kind !== 'window' || effectiveState(state.nodes, node.id)?.active !== true) {
      continue;
    }
    const at = placedAt(node.id);
    if (at === null) {
      continue;
    }
    let bearing = headingOf(at.position) - centre;
    bearing -= 360 * Math.ceil((bearing - 180) / 360);
    const surfaces = node.surfaceIds
      .flatMap((id) => {
        const surface = state.surfaces.get(id);
        return surface?.bindingKey == null
          ? []
          : [
              {
                key: surface.bindingKey,
                x: surface.transform.position[0],
                width: surface.bounds[0],
              },
            ];
      })
      .sort((a, b) => a.x - b.x);
    const total = surfaces.reduce((sum, s) => sum + s.width, 0);
    windows.push({
      id: node.id,
      label: node.label ?? node.id,
      bearing: node.id === focusedId ? 0 : bearing,
      aspect: node.bounds[0] / node.bounds[1],
      focused: node.id === focusedId,
      surfaces: surfaces.map((s) => ({ key: s.key, share: total > 0 ? s.width / total : 0 })),
    });
  }
  return windows.sort((a, b) => a.bearing - b.bearing || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Spreads centres in order along a line: each as near its wish as it can be, no nearer the one
 * before than `step`, all within [low, high]. The room is assumed to hold them all at `step`.
 */
function spread(wishes: readonly number[], step: number, low: number, high: number): number[] {
  const at = wishes.map((w) => Math.min(high, Math.max(low, w)));
  for (let i = 1; i < at.length; i++) {
    at[i] = Math.max(at[i] ?? 0, (at[i - 1] ?? 0) + step);
  }
  const last = at.length - 1;
  if (last >= 0) {
    at[last] = Math.min(at[last] ?? 0, high);
  }
  for (let i = last - 1; i >= 0; i--) {
    at[i] = Math.min(at[i] ?? 0, (at[i + 1] ?? 0) - step);
  }
  if (at.length > 0) {
    at[0] = Math.max(at[0] ?? 0, low);
  }
  for (let i = 1; i < at.length; i++) {
    at[i] = Math.max(at[i] ?? 0, (at[i - 1] ?? 0) + step);
  }
  return at;
}

/**
 * Lays the strip out in a box of a size: the windows (as {@link stripWindows} orders them) as
 * cards, centred where their bearing puts them across the strip (the focused one in its middle,
 * straight behind the camera at its edges), moved apart only as far as keeping them apart needs,
 * in order. Throws for a size that holds no card.
 */
export function stripLayout(
  windows: readonly StripWindow[],
  size: { readonly width: number; readonly height: number },
  metrics: StripMetrics,
): StripLayout {
  const { least, most, gap } = metrics;
  const inner = size.width - 2 * gap;
  if (!(inner >= least) || !(size.height > 2 * gap)) {
    throw new RangeError(
      `the strip is too small for a card (${String(size.width)} × ${String(size.height)})`,
    );
  }
  // How many fit in one row, and in two staggered rows, at their narrowest.
  const oneRow = Math.floor((inner + gap) / (least + gap));
  const twoRows = Math.floor((inner - least) / ((least + gap) / 2)) + 1;
  const rows: 1 | 2 = windows.length <= oneRow ? 1 : 2;
  const capacity = rows === 1 ? oneRow : twoRows;
  // The nearest each way when not all fit: the focused one and those least far round.
  let shown = [...windows];
  if (shown.length > capacity) {
    const nearest = [...windows]
      .sort((a, b) => Math.abs(a.bearing) - Math.abs(b.bearing) || (a.id < b.id ? -1 : 1))
      .slice(0, capacity);
    shown = windows.filter((w) => nearest.includes(w));
  }
  const n = shown.length;
  const width =
    n === 0
      ? least
      : rows === 1
        ? Math.min(most, (inner - (n - 1) * gap) / n)
        : Math.min(most, (2 * inner - (n - 1) * gap) / (n + 1));
  const step = rows === 1 ? width + gap : (width + gap) / 2;
  const wishes = shown.map((w) => size.width / 2 + (w.bearing / 360) * inner);
  const low = gap + width / 2;
  const high = size.width - gap - width / 2;
  // The focused card in the middle, as the panorama has it, when each side has room for its own;
  // else all of them spread across the strip.
  const at = shown.findIndex((w) => w.focused);
  const middle = size.width / 2;
  const left = at < 0 ? 0 : at;
  const right = at < 0 ? 0 : shown.length - at - 1;
  const centres =
    at >= 0 && left * step <= middle - low + 1e-9 && right * step <= high - middle + 1e-9
      ? [
          // The left side mirrored, nearest the middle first, then put back.
          ...spread(
            wishes
              .slice(0, at)
              .reverse()
              .map((w) => -w),
            step,
            step - middle,
            -low,
          )
            .map((c) => -c)
            .reverse(),
          middle,
          ...spread(wishes.slice(at + 1), step, middle + step, high),
        ]
      : spread(wishes, step, low, high);
  const height = rows === 1 ? size.height - 2 * gap : (size.height - 3 * gap) / 2;
  // The focused card is in the first row, and its neighbours in the order alternate from it.
  const cards = shown.map((window, i) => {
    const row = (rows === 1 ? 0 : Math.abs(i - Math.max(0, at)) % 2) as 0 | 1;
    return {
      window,
      x: (centres[i] ?? 0) - width / 2,
      y: gap + row * (height + gap),
      width,
      height,
      row,
    };
  });
  const hiddenOf = (side: (w: StripWindow) => boolean) =>
    windows.filter((w) => side(w) && !shown.includes(w));
  return {
    cards,
    hidden: { left: hiddenOf((w) => w.bearing < 0), right: hiddenOf((w) => w.bearing > 0) },
  };
}
