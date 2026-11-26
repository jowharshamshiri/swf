import type { Id } from '@swf/core';
import { nodeFrameGeometry } from '@swf/core';
import type { Vec2 } from '@swf/math';
import type { RenderFrame, ScreenRect } from '@swf/presentation';
import type { Projection } from '@swf/projections';
import { planeOutline } from './sampling.js';

/**
 * How a window's frame is drawn, in CSS pixels: its stroke, wider for the selected or focused
 * window, and the side of the square resize handle centred on each corner of a selected window.
 */
export const FRAME_STROKE = Object.freeze({ plain: 1.5, emphasised: 3, handle: 8 });

/** Points along each edge of a frame's outline. */
const PER_EDGE = 12;

/** A window's frame as the geometry renderer draws it. */
export interface WindowFrame {
  /**
   * Points along the frame, clockwise from its top-left corner, `PER_EDGE` to an edge, in view
   * CSS pixels; points the view does not show are left out.
   */
  readonly outline: readonly Vec2[];
  /** The corners among them, where a resize handle goes. */
  readonly corners: readonly Vec2[];
  /** The window is selected. */
  readonly selected: boolean;
  /** The window is focused. */
  readonly focused: boolean;
  /** Resize handles are drawn at its corners: it is selected, resizable and not locked. */
  readonly handles: boolean;
  /** The box the frame is drawn in, its stroke and handles included. */
  readonly box: ScreenRect;
}

/**
 * Each window's frame as the geometry renderer draws it in `frame` through `projection`: a window
 * with a fragment shown other than by its label alone, along its frame projected continuously
 * from the fragment holding its live handle. A host drawing over the view (guides, say) keeps
 * clear of the boxes.
 */
export function windowFrames(frame: RenderFrame, projection: Projection): Map<Id, WindowFrame> {
  const { scene } = frame;
  const owners = new Map<Id, { owner: ScreenRect | null; framed: boolean }>();
  for (const p of frame.planned) {
    const nodeId = scene.surfaces.get(p.fragment.surfaceId)?.ownerNodeId;
    if (nodeId === undefined) {
      continue;
    }
    const entry = owners.get(nodeId) ?? { owner: null, framed: false };
    owners.set(nodeId, {
      owner: entry.owner ?? (p.fragment.nativeOwner ? p.fragment.bounds : null),
      framed: entry.framed || p.representation !== 'label',
    });
  }
  const frames = new Map<Id, WindowFrame>();
  for (const [nodeId, { owner, framed }] of owners) {
    const node = scene.nodes.get(nodeId);
    const geometry = nodeFrameGeometry(scene, nodeId);
    // A window whose every surface is represented by its label alone has no frame.
    if (node === undefined || geometry === undefined || owner === null || !framed) {
      continue;
    }
    const [w, h] = node.bounds;
    const [ox, oy, ow, oh] = owner;
    const outline = planeOutline(
      projection,
      frame.view,
      geometry.world,
      { x0: -w / 2, x1: w / 2, y0: -h / 2, y1: h / 2 },
      PER_EDGE,
      [ox + ow / 2, oy + oh / 2],
    );
    if (outline.length < 2) {
      continue;
    }
    const selected = scene.selection.includes(nodeId);
    const focused = scene.focusedId === nodeId;
    const handles = selected && node.flags.resizable && !node.flags.locked;
    const corners = [0, PER_EDGE, 2 * PER_EDGE, 3 * PER_EDGE].flatMap((i) => {
      const point = outline[i];
      return point === undefined ? [] : [point];
    });
    const reach = Math.max(
      (selected || focused ? FRAME_STROKE.emphasised : FRAME_STROKE.plain) / 2,
      handles ? FRAME_STROKE.handle / 2 : 0,
    );
    const xs = outline.map(([x]) => x);
    const ys = outline.map(([, y]) => y);
    const left = Math.min(...xs) - reach;
    const top = Math.min(...ys) - reach;
    frames.set(nodeId, {
      outline,
      corners,
      selected,
      focused,
      handles,
      box: [left, top, Math.max(...xs) + reach - left, Math.max(...ys) + reach - top],
    });
  }
  return frames;
}
