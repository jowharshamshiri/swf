import type { Id, NodeRecord, SceneState } from '@swf/core';
import { ancestorIds, effectiveState } from '@swf/core';
import { models } from '@swf/models';
import { headingPitchOf } from '@swf/projections';
import { poseOf, wrapDegrees } from './pose.js';

/**
 * The spatial overview: every window of the scene as a card on a board that is the whole sphere
 * round the camera unrolled, as the panorama unrolls it: straight ahead in the middle, behind at
 * both edges, overhead at the top and underfoot at the bottom. It is read from the scene each time
 * it is drawn and keeps nothing of its own: a card is a window's ID, its label, where the window
 * stands and the groups it is in, and where the card stands follows from where the window stands.
 * Where each card stands is the Lean model `Swf.AppOverview` (models/Swf/AppOverview.lean): across
 * the board exactly at the window's heading, down it as near the window's elevation as the cards
 * beside it allow, the higher window's card above, at the largest card size that holds them all.
 */

/** A group a window is in, as the overview names it. */
export interface OverviewGroup {
  /** The group's ID. */
  readonly id: Id;
  /** Its name: its label, or its ID. */
  readonly label: string;
}

/** A window as the overview shows it. */
export interface OverviewEntry {
  /** The window's ID. */
  readonly id: Id;
  /** Its name: its label, or its ID. */
  readonly label: string;
  /** Degrees right of where the camera faces, from −180 to 180. */
  readonly heading: number;
  /** Degrees above the horizon, seen from the camera. */
  readonly elevation: number;
  /** World units from the camera. */
  readonly distance: number;
  /** More than a quarter turn from where the camera faces. */
  readonly behind: boolean;
  /** Shown, as the groups it is in leave it. */
  readonly visible: boolean;
  /** Selected. */
  readonly selected: boolean;
  /** Focused. */
  readonly focused: boolean;
  /**
   * The innermost group it is in below the scene's top group (the whole workspace), or null when
   * it is in no group of its own.
   */
  readonly group: OverviewGroup | null;
  /** What the host says its content is, where it says. */
  readonly category: string | null;
  /** How many surfaces it presents: more than one for a window composed of parts. */
  readonly parts: number;
}

/** The scene as the overview shows it: its windows and their groups. */
export interface OverviewScene {
  /** Every active window, in scene order. */
  readonly entries: readonly OverviewEntry[];
  /** The groups the windows are in, by label then ID: the order their colours are given in. */
  readonly groups: readonly OverviewGroup[];
}

/**
 * The scene as the overview shows it, seen from the viewport's camera, each window in the category
 * the host gives it (`category`), or in none.
 */
export function overviewScene(
  state: SceneState,
  viewportId: Id,
  category: (node: NodeRecord) => string | null,
): OverviewScene {
  const viewport = state.viewports.get(viewportId);
  const camera = viewport === undefined ? undefined : state.cameras.get(viewport.cameraId);
  if (camera === undefined) {
    throw new Error(`viewport "${viewportId}" has no camera`);
  }
  const facing = (headingPitchOf(camera.rotation).heading * 180) / Math.PI;
  const parts = new Map<Id, number>();
  for (const surface of state.surfaces.values()) {
    parts.set(surface.ownerNodeId, (parts.get(surface.ownerNodeId) ?? 0) + 1);
  }
  const groups = new Map<Id, OverviewGroup>();
  const entries: OverviewEntry[] = [];
  for (const node of state.nodes.values()) {
    const effective = effectiveState(state.nodes, node.id);
    if (node.kind !== 'window' || effective?.active !== true) {
      continue;
    }
    const pose = poseOf(state, node.id, camera.position);
    if (pose === null) {
      throw new Error(`window "${node.id}" has no placement`);
    }
    // The innermost group with a group above it: the top group holds the whole workspace.
    const inner = ancestorIds(state.nodes, node.id).find(
      (id) => (state.nodes.get(id)?.parentId ?? null) !== null,
    );
    const groupNode = inner === undefined ? undefined : state.nodes.get(inner);
    const group =
      groupNode === undefined ? null : { id: groupNode.id, label: groupNode.label ?? groupNode.id };
    if (group !== null) {
      groups.set(group.id, group);
    }
    const heading = wrapDegrees(pose.heading - facing);
    entries.push({
      id: node.id,
      label: node.label ?? node.id,
      heading,
      elevation: pose.elevation,
      distance: pose.distance,
      behind: Math.abs(heading) > 90,
      visible: effective.visible,
      selected: state.selection.includes(node.id),
      focused: state.focusedId === node.id,
      group,
      category: category(node),
      parts: parts.get(node.id) ?? 0,
    });
  }
  const ordered = [...groups.values()].sort(
    (a, b) => a.label.localeCompare(b.label) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return { entries, groups: ordered };
}

/** A card's own size, in CSS pixels, before it is drawn at the board's scale, and the room between. */
export const CARD: {
  /** A card's width, in CSS pixels. */
  readonly width: number;
  /** A card's height, in CSS pixels. */
  readonly height: number;
  /** The gap between cards, in CSS pixels. */
  readonly gap: number;
} = Object.freeze({ width: 176, height: 76, gap: 8 });

/** The scales a card is tried at, largest first: the board takes the first that holds every card. */
export const CARD_SCALES: readonly number[] = Object.freeze([
  1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.42, 0.35, 0.3, 0.25, 0.2, 0.16, 0.13, 0.1,
]);

/** Where a window's card stands on the board, in CSS pixels from the board's top-left corner. */
export interface OverviewCard {
  /** The window's ID. */
  readonly id: Id;
  /** Its left edge. */
  readonly x: number;
  /** Its top edge. */
  readonly y: number;
}

/** The board laid out, or too crowded to lay out as cards. */
export type OverviewLayout =
  | {
      /** Every card fits. */
      readonly kind: 'laid';
      /** The scale every card is drawn at. */
      readonly scale: number;
      /** A card's width on the board, in CSS pixels. */
      readonly width: number;
      /** A card's height on the board, in CSS pixels. */
      readonly height: number;
      /** Highest window first. */
      readonly cards: readonly OverviewCard[];
    }
  | {
      /** Too many windows for cards even at the smallest scale. */
      readonly kind: 'crowded';
    };

/** Tenths of a degree, as the model takes a place round the camera. */
const tenths = (degrees: number, most: number): bigint =>
  BigInt(Math.min(most, Math.max(0, Math.round(degrees * 10))));

/** Where each window's card stands on a board of this size (CSS pixels). */
export function layOverview(
  entries: readonly OverviewEntry[],
  width: number,
  height: number,
): OverviewLayout {
  const board = {
    width: BigInt(Math.max(0, Math.floor(width))),
    height: BigInt(Math.max(0, Math.floor(height))),
  };
  const sizes = CARD_SCALES.map((scale) => ({
    width: BigInt(Math.max(1, Math.round(CARD.width * scale))),
    height: BigInt(Math.max(1, Math.round(CARD.height * scale))),
    gap: BigInt(Math.max(1, Math.round(CARD.gap * scale))),
  }));
  const windows = entries.map((entry) => ({
    along: tenths(entry.heading + 180, 3600),
    down: tenths(90 - entry.elevation, 1800),
  }));
  const answer = models.overviewLayout(board, windows, sizes);
  switch (answer.kind) {
    case 'invalid':
      throw new Error(`the overview cannot be laid out: ${answer.field} is out of range`);
    case 'crowded':
      return { kind: 'crowded' };
    case 'laid': {
      const size = sizes[Number(answer.size)];
      if (size === undefined) {
        throw new Error(
          `the overview was laid at a size it was not offered (${String(answer.size)})`,
        );
      }
      return {
        kind: 'laid',
        scale: Number(size.width) / CARD.width,
        width: Number(size.width),
        height: Number(size.height),
        cards: answer.cards.map((card) => {
          const entry = entries[Number(card.index)];
          if (entry === undefined) {
            throw new Error(`the overview placed a card for no window (${String(card.index)})`);
          }
          return { id: entry.id, x: Number(card.x), y: Number(card.y) };
        }),
      };
    }
  }
}
