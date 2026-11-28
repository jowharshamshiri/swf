import type { Id } from '@swf/core';
import type { RenderFrame, ScreenRect } from '@swf/presentation';
import { outlineOf } from '@swf/presentation';

/**
 * How a window's frame is drawn, in CSS pixels: its stroke, wider for the selected or focused
 * window, and the side of the square resize handle centred on each corner of a selected window.
 */
export const FRAME_STROKE = Object.freeze({ plain: 1.5, emphasised: 3, handle: 8 });

/** A window's frame as the geometry renderer draws it: round its card and its title bar. */
export interface WindowFrame {
  /** The window's card, its own place (not a copy across the seam), in view CSS pixels. */
  readonly card: ScreenRect;
  /**
   * The window's card at every place it is drawn, its own place first, then each copy across the
   * seam, in view CSS pixels.
   */
  readonly cards: readonly ScreenRect[];
  /** The window is selected. */
  readonly selected: boolean;
  /** The window is focused. */
  readonly focused: boolean;
  /** Resize handles are drawn at its corners: it is selected, resizable and not locked. */
  readonly handles: boolean;
  /**
   * The box the frame is drawn in at the window's own place, its title bar, stroke and handles
   * included.
   */
  readonly box: ScreenRect;
}

/**
 * Each window's frame as the geometry renderer draws it in `frame`: round the card and title bar of
 * each window shown other than by its label alone, at every place its card is drawn. A host
 * drawing over the view (guides, say) keeps clear of the boxes.
 */
export function windowFrames(frame: RenderFrame): Map<Id, WindowFrame> {
  const { scene } = frame;
  const owners = new Map<Id, { cards: ScreenRect[]; framed: boolean }>();
  for (const p of frame.planned) {
    const nodeId = scene.surfaces.get(p.fragment.surfaceId)?.ownerNodeId;
    if (nodeId === undefined) {
      continue;
    }
    const entry = owners.get(nodeId) ?? { cards: [], framed: false };
    entry.cards[p.fragment.ordinal] ??= p.fragment.card;
    entry.framed ||= p.representation !== 'label';
    owners.set(nodeId, entry);
  }
  const frames = new Map<Id, WindowFrame>();
  for (const [nodeId, { cards, framed }] of owners) {
    const node = scene.nodes.get(nodeId);
    const card = cards[0];
    // A window whose every surface is represented by its label alone has no frame.
    if (node === undefined || card === undefined || !framed) {
      continue;
    }
    const selected = scene.selection.includes(nodeId);
    const focused = scene.focusedId === nodeId;
    const handles = selected && node.flags.resizable && !node.flags.locked;
    const reach = Math.max(
      (selected || focused ? FRAME_STROKE.emphasised : FRAME_STROKE.plain) / 2,
      handles ? FRAME_STROKE.handle / 2 : 0,
    );
    const [x, y, w, h] = outlineOf(card, 'full');
    frames.set(nodeId, {
      card,
      // Only the places drawn: a window's copies are filed by their ordinal.
      cards: Object.values(cards),
      selected,
      focused,
      handles,
      box: [x - reach, y - reach, w + 2 * reach, h + 2 * reach],
    });
  }
  return frames;
}
