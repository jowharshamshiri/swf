import type { Id, JsonValue, NodeRecord, SceneCommand, SceneState, SurfaceRecord } from '@swf/core';
import type { Transform3D, Vec3 } from '@swf/math';
import { transformPoint } from '@swf/math';

/**
 * Multi-surface composition (FR-126, WF-06, AC-016): the surfaces a host supplied, rearranged
 * among windows. A surface can be detached into a window of its own, moved into another window,
 * or a window's surfaces merged into another's; a window can be moved into another group, or a
 * new one. Each is planned here as the scene commands of one undoable transaction, from the
 * committed scene alone. Only associations and placements change: a surface is never split, its
 * content is never looked at, and a window with one surface has nothing to detach.
 */

/**
 * A window's frame around its surfaces, in world units: room for the title above, a margin at
 * the sides and below, and a gap between surfaces side by side.
 */
export const WINDOW_FRAME = Object.freeze({ side: 0.08, top: 0.2, bottom: 0.08, gap: 0.06 });

/** Where a window's surfaces go, side by side in their order, and the window's size round them. */
export interface SurfaceLayout {
  readonly bounds: Vec3;
  /** Each surface's place in the window, in the order given. */
  readonly offsets: readonly Vec3[];
}

/** The layout of surfaces of the given sizes (width, height), side by side in a window. */
export function layoutSurfaces(sizes: readonly (readonly [number, number])[]): SurfaceLayout {
  if (sizes.length === 0) {
    throw new RangeError('a window is laid out round at least one surface');
  }
  const { side, top, bottom, gap } = WINDOW_FRAME;
  const row = sizes.reduce((sum, [w]) => sum + w, 0) + gap * (sizes.length - 1);
  const tallest = Math.max(...sizes.map(([, h]) => h));
  const y = (bottom - top) / 2;
  let x = -row / 2;
  const offsets = sizes.map(([w]): Vec3 => {
    const centre = x + w / 2;
    x += w + gap;
    return [centre, y, 0];
  });
  return { bounds: [row + 2 * side, tallest + top + bottom, 0.01], offsets };
}

/** What a composition step plans, or why it cannot be done, naming the field at fault. */
export type CompositionPlan =
  | {
      readonly kind: 'plan';
      readonly commands: readonly SceneCommand[];
      /** The window the step created, if it created one. */
      readonly createdWindowId: Id | null;
    }
  | { readonly kind: 'refused'; readonly field: string; readonly reason: string };

/** What a window made for a detached surface is given besides its place: the host's say. */
export interface NewWindow {
  readonly tags: readonly string[];
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

const refused = (field: string, reason: string): CompositionPlan =>
  Object.freeze({ kind: 'refused', field, reason });

const planned = (commands: SceneCommand[], createdWindowId: Id | null = null): CompositionPlan =>
  Object.freeze({ kind: 'plan', commands: Object.freeze(commands), createdWindowId });

const nameOf = (record: { readonly id: Id; readonly label: string | null }) =>
  `“${record.label ?? record.id}”`;

/** A surface's size in its window: its bounds as its own scale makes them. */
const sizeOf = (surface: SurfaceRecord): readonly [number, number] => [
  surface.bounds[0] * surface.transform.scale[0],
  surface.bounds[1] * surface.transform.scale[1],
];

/** The commands that lay a window's surfaces out side by side, in the order given. */
function relayout(window: NodeRecord, surfaces: readonly SurfaceRecord[]): SceneCommand[] {
  const layout = layoutSurfaces(surfaces.map(sizeOf));
  return [
    { type: 'node.patch', id: window.id, bounds: layout.bounds },
    ...surfaces.map((surface, i): SceneCommand => ({
      type: 'surface.patch',
      id: surface.id,
      transform: { ...surface.transform, position: offsetAt(layout, i) },
    })),
  ];
}

function offsetAt(layout: SurfaceLayout, index: number): Vec3 {
  const offset = layout.offsets[index];
  if (offset === undefined) {
    throw new RangeError(`the layout has no place ${String(index)}`);
  }
  return offset;
}

/** A window and its surfaces, in order, or why it is not a window. */
function windowOf(
  state: SceneState,
  id: unknown,
  field: string,
):
  | { readonly window: NodeRecord; readonly surfaces: readonly SurfaceRecord[] }
  | { readonly field: string; readonly reason: string } {
  const node = typeof id === 'string' ? state.nodes.get(id) : undefined;
  if (node?.kind !== 'window' || node.status !== 'active') {
    return { field, reason: `no window "${String(id)}"` };
  }
  const surfaces = node.surfaceIds.map((surfaceId) => {
    const surface = state.surfaces.get(surfaceId);
    if (surface === undefined) {
      throw new Error(`window "${node.id}" names surface "${surfaceId}", which the scene lacks`);
    }
    return surface;
  });
  return { window: node, surfaces };
}

/** An ID for a new node made from `stem`: the stem, or the stem numbered, whichever is free. */
export function freeId(state: SceneState, stem: string): Id {
  const taken = (id: Id) => state.nodes.has(id) || state.surfaces.has(id);
  if (!taken(stem)) {
    return stem;
  }
  for (let n = 2; ; n += 1) {
    const id = `${stem}-${String(n)}`;
    if (!taken(id)) {
      return id;
    }
  }
}

/** The window a detached surface gets: named after it (`note-1-surface` gives `note-1`). */
function windowIdFor(state: SceneState, surfaceId: Id): Id {
  const stem = surfaceId.endsWith('-surface') ? surfaceId.slice(0, -'-surface'.length) : '';
  return freeId(state, stem === '' ? `${surfaceId}-window` : stem);
}

/**
 * Takes a surface out of its window into a new window of its own, in the same group: the window
 * it left closes up round the rest, and the new one stands beside it, to its right, turned as it
 * is, so neither covers the other. A window's only surface cannot be detached: there is nothing
 * to split it from, and a surface's own content is never split.
 */
export function detachSurface(
  state: SceneState,
  surfaceId: unknown,
  window: NewWindow,
): CompositionPlan {
  const surface = typeof surfaceId === 'string' ? state.surfaces.get(surfaceId) : undefined;
  if (surface === undefined) {
    return refused('surfaceId', `no surface "${String(surfaceId)}"`);
  }
  const owner = windowOf(state, surface.ownerNodeId, 'surfaceId');
  if ('reason' in owner) {
    return refused('surfaceId', `surface ${nameOf(surface)} is not in a window`);
  }
  if (owner.surfaces.length < 2) {
    return refused(
      'surfaceId',
      `${nameOf(surface)} is the only surface of ${nameOf(owner.window)}: there is nothing to detach it from, and a surface’s own content is never split`,
    );
  }
  const id = windowIdFor(state, surface.id);
  const local: Transform3D = {
    ...surface.transform,
    position: offsetAt(layoutSurfaces([sizeOf(surface)]), 0),
  };
  const kept = owner.surfaces.filter((s) => s.id !== surface.id);
  const [left] = layoutSurfaces(kept.map(sizeOf)).bounds;
  const [width] = layoutSurfaces([sizeOf(surface)]).bounds;
  // Beside the window it left, edge to edge with a gap, along that window's own right.
  const from = owner.window.transform;
  const placed: Transform3D = {
    position: transformPoint(from, [(left + width) / 2 + WINDOW_FRAME.gap, 0, 0]),
    rotation: from.rotation,
    scale: from.scale,
  };
  return planned(
    [
      {
        type: 'node.create',
        node: {
          id,
          kind: 'window',
          parentId: owner.window.parentId,
          label: surface.label ?? id,
          tags: [...window.tags],
          metadata: window.metadata,
          bounds: layoutSurfaces([sizeOf(surface)]).bounds,
          transform: placed,
        },
      },
      { type: 'surface.move', id: surface.id, ownerNodeId: id, keep: 'local' },
      { type: 'surface.patch', id: surface.id, transform: local },
      ...relayout(owner.window, kept),
    ],
    id,
  );
}

/**
 * Moves a surface into another window, after its surfaces; both windows are laid out again round
 * what they hold. A window left with no surface is removed from the workspace (undo brings it
 * back), so recombining a detached surface leaves nothing behind.
 */
export function moveSurface(
  state: SceneState,
  surfaceId: unknown,
  targetWindowId: unknown,
): CompositionPlan {
  const surface = typeof surfaceId === 'string' ? state.surfaces.get(surfaceId) : undefined;
  if (surface === undefined) {
    return refused('surfaceId', `no surface "${String(surfaceId)}"`);
  }
  const target = windowOf(state, targetWindowId, 'windowId');
  if ('reason' in target) {
    return refused(target.field, target.reason);
  }
  if (target.window.id === surface.ownerNodeId) {
    return refused('windowId', `${nameOf(surface)} is already in ${nameOf(target.window)}`);
  }
  const source = windowOf(state, surface.ownerNodeId, 'surfaceId');
  if ('reason' in source) {
    return refused('surfaceId', `surface ${nameOf(surface)} is not in a window`);
  }
  const left = source.surfaces.filter((s) => s.id !== surface.id);
  return planned([
    { type: 'surface.move', id: surface.id, ownerNodeId: target.window.id, keep: 'local' },
    ...relayout(target.window, [...target.surfaces, surface]),
    ...(left.length === 0
      ? [{ type: 'node.delete', id: source.window.id, mode: 'rejectIfChildren' } as const]
      : relayout(source.window, left)),
  ]);
}

/**
 * Moves every surface of a window into another, after its own, and removes the emptied window
 * from the workspace: one window holding both windows' surfaces, side by side.
 */
export function mergeWindow(
  state: SceneState,
  windowId: unknown,
  targetWindowId: unknown,
): CompositionPlan {
  const source = windowOf(state, windowId, 'windowId');
  if ('reason' in source) {
    return refused(source.field, source.reason);
  }
  const target = windowOf(state, targetWindowId, 'targetId');
  if ('reason' in target) {
    return refused(target.field, target.reason);
  }
  if (target.window.id === source.window.id) {
    return refused('targetId', 'a window cannot be merged into itself');
  }
  if (source.window.childIds.length > 0) {
    return refused('windowId', `${nameOf(source.window)} holds other nodes and cannot be emptied`);
  }
  return planned([
    ...source.surfaces.map((surface): SceneCommand => ({
      type: 'surface.move',
      id: surface.id,
      ownerNodeId: target.window.id,
      keep: 'local',
    })),
    ...relayout(target.window, [...target.surfaces, ...source.surfaces]),
    { type: 'node.delete', id: source.window.id, mode: 'rejectIfChildren' },
  ]);
}

/** Where a window is moved: into a group that exists, or into a new group of its own. */
export type GroupTarget =
  | { readonly kind: 'group'; readonly id: Id }
  | { readonly kind: 'new'; readonly id: Id; readonly label: string };

/**
 * Moves a window into another group, keeping its place in the world. A group it leaves empty is
 * removed with it, unless it is the group workspace orbit turns.
 */
export function regroupWindow(
  state: SceneState,
  windowId: unknown,
  target: GroupTarget,
): CompositionPlan {
  const found = windowOf(state, windowId, 'windowId');
  if ('reason' in found) {
    return refused(found.field, found.reason);
  }
  const window = found.window;
  let move: SceneCommand[];
  if (target.kind === 'new') {
    if (state.nodes.has(target.id) || state.surfaces.has(target.id)) {
      return refused('groupId', `the ID "${target.id}" is taken`);
    }
    move = [
      {
        type: 'node.group',
        nodeIds: [window.id],
        group: { id: target.id, label: target.label, parentId: window.parentId },
      },
    ];
  } else {
    const group = state.nodes.get(target.id);
    if (group?.kind !== 'group' || group.status !== 'active') {
      return refused('groupId', `no group "${target.id}"`);
    }
    if (window.parentId === group.id) {
      return refused('groupId', `${nameOf(window)} is already in ${nameOf(group)}`);
    }
    move = [{ type: 'node.reparent', id: window.id, parentId: group.id, keep: 'world' }];
  }
  const left = window.parentId === null ? undefined : state.nodes.get(window.parentId);
  const emptied =
    left?.kind === 'group' &&
    left.id !== state.orbitRootId &&
    left.childIds.length === 1 &&
    left.surfaceIds.length === 0 &&
    // A new group is made inside the old one: it is not emptied.
    target.kind === 'group';
  return planned([
    ...move,
    ...(emptied ? [{ type: 'node.delete', id: left.id, mode: 'rejectIfChildren' } as const] : []),
  ]);
}

/** A composition step that cannot be done, naming the field at fault. */
export class CompositionRefusal extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'CompositionRefusal';
  }
}
