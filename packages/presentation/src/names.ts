import type { Id } from '@swf/core';
import { models } from '@swf/models';
import type { RenderFrame } from './contracts.js';
import type { ScreenPoint, ScreenRect } from './fragments.js';

/**
 * Where a renderer writes the names over a view, so that every name it writes can be read: wholly
 * inside the view, over nothing of another window's, and over no other name. Which places are
 * taken is decided by the Lean model `Swf.Names` (models/Swf/Names.lean), where it is proved that a
 * name written overlaps no box of another owner written before it and is written once.
 */

/** A name to write: what it names, its text and size, and the places offered for it, best first. */
export interface NameRequest {
  /** What it names (a window's node ID, say): the name may lie over that owner's boxes only. */
  readonly owner: Id;
  /** Its text. */
  readonly text: string;
  /** Its width and height as written, in CSS pixels. */
  readonly size: readonly [number, number];
  /** The top-left corner of each place it may be written at, best first, in view CSS pixels. */
  readonly places: readonly ScreenPoint[];
}

/** Something drawn that names of other owners keep clear of: a window's frame, a mark. */
export interface NameObstacle {
  /** What it belongs to: that owner's names may lie over it. */
  readonly owner: Id;
  /** Where it is drawn, in view CSS pixels. */
  readonly box: ScreenRect;
}

/** How a window that stands for itself by its label alone is marked: a dot this wide, centred. */
export const NAME_MARK = 6;
/** The gap between a name and the frame or mark it names, in CSS pixels. */
const GAP = 3;
/** The side of the grid's cells obstacles are filed by, in CSS pixels. */
const CELL = 64;

/**
 * The place each name is written at, in the order asked, or null for a name with no free place.
 * Each place offered is first moved inside the view, as little as it must be; a name larger than
 * the view has no place. The obstacles are taken as drawn; then each name in turn is written at the
 * first place offered that overlaps no obstacle or name of another owner written before it.
 */
export function placeNames(
  view: { readonly width: number; readonly height: number },
  obstacles: readonly NameObstacle[],
  requests: readonly NameRequest[],
): readonly (ScreenPoint | null)[] {
  const owners = new Map<Id, number>();
  const ownerOf = (id: Id): bigint => {
    let n = owners.get(id);
    if (n === undefined) {
      n = owners.size;
      owners.set(id, n);
    }
    return BigInt(n);
  };
  const boxes: {
    name: bigint;
    owner: bigint;
    x: bigint;
    y: bigint;
    width: bigint;
    height: bigint;
    kept: boolean;
  }[] = [];
  /** Each box asked about that is a place for a name: its request and its point. */
  const offered: { request: number; at: ScreenPoint }[] = [];
  requests.forEach((request, i) => {
    const [w, h] = request.size;
    if (!(w > 0 && h > 0 && w <= view.width && h <= view.height)) {
      return;
    }
    const seen = new Set<string>();
    for (const [px, py] of request.places) {
      // On whole pixels, wholly inside the view.
      const at: ScreenPoint = [
        Math.min(Math.floor(view.width - w), Math.max(0, Math.round(px))),
        Math.min(Math.floor(view.height - h), Math.max(0, Math.round(py))),
      ];
      const key = `${String(at[0])},${String(at[1])}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      offered.push({ request: i, at });
    }
  });
  // Each obstacle as the whole pixels it covers, filed by the cells of a coarse grid it covers.
  const covered = obstacles.map(({ owner, box: [x, y, w, h] }) => {
    const left = Math.floor(x);
    const top = Math.floor(y);
    return {
      owner,
      left,
      top,
      right: Math.max(left, Math.ceil(x + w)),
      bottom: Math.max(top, Math.ceil(y + h)),
    };
  });
  const cells = new Map<string, number[]>();
  const cellsOf = (left: number, top: number, right: number, bottom: number): string[] => {
    const keys: string[] = [];
    for (let i = Math.floor(left / CELL); i <= Math.floor((right - 1) / CELL); i += 1) {
      for (let j = Math.floor(top / CELL); j <= Math.floor((bottom - 1) / CELL); j += 1) {
        keys.push(`${String(i)},${String(j)}`);
      }
    }
    return keys;
  };
  covered.forEach((o, index) => {
    if (o.right > o.left && o.bottom > o.top) {
      for (const key of cellsOf(o.left, o.top, o.right, o.bottom)) {
        const filed = cells.get(key);
        if (filed === undefined) {
          cells.set(key, [index]);
        } else {
          filed.push(index);
        }
      }
    }
  });
  // Asked as the model has it, every obstacle first and then every place, a place overlapping an
  // obstacle of another owner is never written (`Swf.Names.kept_keeps_out`), so it is left out
  // (`answers_skip_unwritten`); every obstacle then keeps no place left from being written, so
  // each is left out too, the last first (`answers_skip_harmless`): which places are written is
  // the model's answer for the places that remain, none of which overlaps another owner's
  // obstacle.
  const remaining = offered.filter(({ request, at: [px, py] }) => {
    const r = requests[request];
    if (r === undefined) {
      return false;
    }
    const right = px + Math.ceil(r.size[0]);
    const bottom = py + Math.ceil(r.size[1]);
    for (const key of cellsOf(px, py, right, bottom)) {
      for (const index of cells.get(key) ?? []) {
        const o = covered[index];
        if (
          o !== undefined &&
          o.owner !== r.owner &&
          o.left < right &&
          px < o.right &&
          o.top < bottom &&
          py < o.bottom
        ) {
          return false;
        }
      }
    }
    return true;
  });
  for (const { request, at } of remaining) {
    const [w, h] = requests[request]?.size ?? [0, 0];
    boxes.push({
      name: BigInt(request),
      owner: ownerOf(requests[request]?.owner ?? ''),
      x: BigInt(at[0]),
      y: BigInt(at[1]),
      width: BigInt(Math.ceil(w)),
      height: BigInt(Math.ceil(h)),
      kept: false,
    });
  }
  const shown = models.labelsShown(boxes);
  if (shown.length !== boxes.length) {
    throw new Error('the names model answered for some of the boxes only');
  }
  const placed: (ScreenPoint | null)[] = requests.map(() => null);
  remaining.forEach(({ request, at }, i) => {
    if (shown[i] === true) {
      placed[request] = at;
    }
  });
  return placed;
}

/** A window's name as a frame shows it: its text, and whether it is selected or focused. */
export interface WindowName extends NameRequest {
  /** The window is selected. */
  readonly selected: boolean;
  /** The window is focused. */
  readonly focused: boolean;
  /** The window is shown by its label alone, marked where it is: farther, its name is quieter. */
  readonly marked: boolean;
}

/** The names of the windows a frame shows, and what they keep clear of. */
export interface WindowNames {
  /** Each window's frame pieces, and the mark of each window shown by its label alone. */
  readonly obstacles: readonly NameObstacle[];
  /**
   * The name of each window shown by its label alone, the selected and focused windows' first,
   * then the nearer windows' before the farther, beside its mark, else above or below it. A window
   * drawn with a card is named on its title bar, which the renderer writes, not here.
   */
  readonly names: readonly WindowName[];
  /** The centre of each mark of a window shown by its label alone, by the window's node ID. */
  readonly marks: ReadonlyMap<Id, readonly ScreenPoint[]>;
}

/**
 * The names of a frame's windows shown by their label alone, with the places offered for each and
 * what they keep clear of; `measure` gives a text's width and height as the renderer writes it,
 * and `frames` the box each window's outline is drawn in (its card with its title bar, stroke and
 * handles included), for the windows drawn with one. Other names keep clear of all of a window's
 * outline, or of its fragments where it has none drawn. A window drawn with a card is named on its
 * title bar, so it asks for no place here. A window is named as {@link windowTitle} names it; a
 * window with no name is not named.
 */
export function windowNames(
  frame: RenderFrame,
  measure: (text: string) => readonly [number, number],
  frames: ReadonlyMap<Id, ScreenRect>,
): WindowNames {
  const { scene } = frame;
  const byNode = new Map<
    Id,
    { framed: ScreenRect[]; marks: ScreenPoint[]; label: string | null; nearest: number }
  >();
  frame.planned.forEach((planned, i) => {
    const surface = scene.surfaces.get(planned.fragment.surfaceId);
    if (surface === undefined) {
      return;
    }
    const nodeId = surface.ownerNodeId;
    let entry = byNode.get(nodeId);
    if (entry === undefined) {
      entry = {
        framed: [],
        marks: [],
        label: windowTitle(scene, nodeId),
        nearest: i,
      };
      byNode.set(nodeId, entry);
    }
    // Planned back to front: the later a fragment, the nearer.
    entry.nearest = i;
    const [x, y, w, h] = planned.fragment.bounds;
    if (planned.representation === 'label') {
      entry.marks.push([x + w / 2, y + h / 2]);
    } else {
      entry.framed.push(planned.fragment.bounds);
    }
  });
  const obstacles: NameObstacle[] = [];
  const names: WindowName[] = [];
  const marks = new Map<Id, readonly ScreenPoint[]>();
  for (const [nodeId, entry] of byNode) {
    const drawn = entry.framed.length > 0 ? frames.get(nodeId) : undefined;
    const framed = drawn === undefined ? entry.framed : [drawn];
    for (const box of entry.framed) {
      obstacles.push({ owner: nodeId, box });
    }
    if (drawn !== undefined) {
      obstacles.push({ owner: nodeId, box: drawn });
    }
    // A window drawn with a frame anywhere is named by its frame; else by its mark.
    const marked = entry.framed.length === 0 ? entry.marks : [];
    if (marked.length > 0) {
      marks.set(nodeId, marked);
    }
    for (const [cx, cy] of marked) {
      obstacles.push({
        owner: nodeId,
        box: [cx - NAME_MARK / 2, cy - NAME_MARK / 2, NAME_MARK, NAME_MARK],
      });
    }
    // A window drawn with a card is named on its title bar.
    if (framed.length > 0 || entry.label === null || entry.label === '') {
      continue;
    }
    const size = measure(entry.label);
    const [nw, nh] = size;
    const places: ScreenPoint[] = marked.flatMap(([cx, cy]): ScreenPoint[] => [
      [cx + NAME_MARK / 2 + GAP, cy - nh / 2],
      [cx - NAME_MARK / 2 - GAP - nw, cy - nh / 2],
      [cx - nw / 2, cy - NAME_MARK / 2 - GAP - nh],
      [cx - nw / 2, cy + NAME_MARK / 2 + GAP],
    ]);
    names.push({
      owner: nodeId,
      text: entry.label,
      size,
      places,
      selected: scene.selection.includes(nodeId),
      focused: scene.focusedId === nodeId,
      marked: marked.length > 0,
    });
  }
  const rank = (name: WindowName) => (name.selected ? 0 : name.focused ? 1 : 2);
  const nearest = (name: WindowName) => byNode.get(name.owner)?.nearest ?? 0;
  names.sort((a, b) => rank(a) - rank(b) || nearest(b) - nearest(a));
  return { obstacles, names, marks };
}

/**
 * A window's name as its title bar shows it: its own label, else its first surface's that has one;
 * null when neither has one.
 */
export function windowTitle(scene: RenderFrame['scene'], nodeId: Id): string | null {
  const node = scene.nodes.get(nodeId);
  if (node === undefined) {
    return null;
  }
  if (node.label !== null && node.label !== '') {
    return node.label;
  }
  for (const surfaceId of node.surfaceIds) {
    const label = scene.surfaces.get(surfaceId)?.label ?? null;
    if (label !== null && label !== '') {
      return label;
    }
  }
  return null;
}
