import type { Id, JsonValue, NodeRecord, SceneCommand, SceneState, SurfaceRecord } from '@swf/core';
import { worldMatrix } from '@swf/core';
import type { Transform3D, Vec3 } from '@swf/math';
import {
  IDENTITY_MAT4,
  mat4Decompose,
  mat4FromTransform,
  mat4InvertAffine,
  mat4Multiply,
  transformPoint,
} from '@swf/math';
import type * as Lean from '@swf/models';
import { models } from '@swf/models';

/**
 * Multi-surface composition (FR-126, WF-06, AC-016): the surfaces a host supplied, rearranged
 * among windows. A surface can be detached into a window of its own, moved into another window,
 * or a window's surfaces merged into another's; a window can be moved into another group, or a
 * new one, and several windows gathered into a new group together. A window can be broken into
 * parts, each of its surfaces but the first in a window of its own, and parts put back together.
 * A window made from another's surface keeps a link to the window it came from
 * ({@link partOf}), so its parts can be shown linked and recombined. Each step is decided from the committed scene alone by the Lean model
 * `Swf.AppComposition` (models/Swf/AppComposition.lean), where it is proved that no surface is
 * lost and that a new node's ID is free; this module lays the windows out round their surfaces
 * and turns the decision into the scene commands of one undoable transaction. Only associations
 * and placements change: a surface is never split, its content is never looked at, and a window
 * with one surface has nothing to detach.
 */

/**
 * A window's frame around its surfaces, in world units: room for the title above, a margin at
 * the sides and below, and a gap between surfaces side by side.
 */
export const WINDOW_FRAME: {
  /** The margin at each side. */
  readonly side: number;
  /** The room above, for the title. */
  readonly top: number;
  /** The margin below. */
  readonly bottom: number;
  /** The gap between surfaces side by side. */
  readonly gap: number;
} = Object.freeze({ side: 0.08, top: 0.2, bottom: 0.08, gap: 0.06 });

/**
 * The window a window is a part of, or null for one that is no part: the ID a window made from
 * another window's surface keeps under the host's part key (`partKey`, a `host.` or `ext.` metadata
 * key the host names in {@link WindowTraits.partOfKey}), the first window when parts are broken
 * again.
 */
export function partOf(
  node: { readonly metadata: Readonly<Record<string, unknown>> },
  partKey: string,
): Id | null {
  const origin = node.metadata[partKey];
  return typeof origin === 'string' ? origin : null;
}

/** Where a window's surfaces go, side by side in their order, and the window's size round them. */
export interface SurfaceLayout {
  /** The window's size round its surfaces, in world units. */
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
      /** It can be done. */
      readonly kind: 'plan';
      /** The commands of the one transaction that does it. */
      readonly commands: readonly SceneCommand[];
      /** The window the step created, if it created one. */
      readonly createdWindowId: Id | null;
    }
  | {
      /** It cannot be done. */
      readonly kind: 'refused';
      /** The field at fault. */
      readonly field: string;
      /** Why. */
      readonly reason: string;
    };

/** What a window made for a detached surface is given besides its place: the host's say. */
export interface NewWindow {
  /** Its tags. */
  readonly tags: readonly string[];
  /** Its metadata, under keys namespaced as the host's. */
  readonly metadata: Readonly<Record<string, JsonValue>>;
}

/** Where a window is moved: into a group that exists, or into a new group of its own. */
export type GroupTarget =
  | {
      /** A group that exists. */
      readonly kind: 'group';
      /** The group's ID. */
      readonly id: Id;
    }
  | {
      /** A new group. */
      readonly kind: 'new';
      /** The new group's ID, one no node or surface holds. */
      readonly id: Id;
      /** The new group's name. */
      readonly label: string;
    };

const planned = (commands: SceneCommand[], createdWindowId: Id | null = null): CompositionPlan =>
  Object.freeze({ kind: 'plan', commands: Object.freeze(commands), createdWindowId });

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

/** The scene's node of an ID the plan names. */
function nodeOf(state: SceneState, id: Id): NodeRecord {
  const node = state.nodes.get(id);
  if (node === undefined) {
    throw new Error(`the plan names node "${id}", which the scene lacks`);
  }
  return node;
}

/** The surfaces of the IDs a window holds, in their order. */
function surfacesOf(state: SceneState, window: Id, ids: readonly Id[]): SurfaceRecord[] {
  return ids.map((surfaceId) => {
    const surface = state.surfaces.get(surfaceId);
    if (surface === undefined) {
      throw new Error(`window "${window}" names surface "${surfaceId}", which the scene lacks`);
    }
    return surface;
  });
}

/** The scene as composition weighs it. */
function sceneOf(state: SceneState): Lean.CompScene {
  return {
    nodes: [...state.nodes.values()].map((node) => ({
      id: node.id,
      kind: node.kind,
      active: node.status === 'active',
      label: node.label,
      parentId: node.parentId,
      childIds: [...node.childIds],
      surfaceIds: [...node.surfaceIds],
    })),
    surfaces: [...state.surfaces.values()].map((surface) => ({
      id: surface.id,
      label: surface.label,
      owner: surface.ownerNodeId,
    })),
    orbitRootId: state.orbitRootId,
  };
}

/** An ID as a host gave it, untyped. */
const refOf = (id: unknown): Lean.CompRef => ({
  id: typeof id === 'string' ? id : null,
  shown: String(id),
});

/**
 * Where a group composition makes stands, under `parentId`: at the camera (`eye`), as the
 * workspace's own group does, its box a cube round the camera holding every member wherever it is
 * turned. A group frames no window of its own, so its rectangle lies in a plane through the eye and
 * takes no press meant for the windows in it.
 */
function groupAtEye(
  state: SceneState,
  parentId: Id | null,
  memberIds: readonly Id[],
  eye: Vec3,
): { readonly transform: Transform3D; readonly bounds: Vec3 } {
  const parentWorld = parentId === null ? IDENTITY_MAT4 : worldMatrix(state.nodes, parentId);
  const toParent = parentWorld === undefined ? null : mat4InvertAffine(parentWorld);
  const local =
    toParent === null
      ? null
      : mat4Decompose(
          mat4Multiply(
            toParent,
            mat4FromTransform({ position: eye, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }),
          ),
        );
  if (!local?.ok) {
    throw new Error(
      `a group cannot be made under "${String(parentId)}": its placement is singular`,
    );
  }
  const reach = memberIds.reduce((most, id) => {
    const node = nodeOf(state, id);
    const world = worldMatrix(state.nodes, id);
    if (world === undefined) {
      throw new Error(`the plan names node "${id}", which has no placement`);
    }
    const scale = Math.max(
      Math.hypot(world[0], world[1], world[2]),
      Math.hypot(world[4], world[5], world[6]),
      Math.hypot(world[8], world[9], world[10]),
    );
    const centre = Math.hypot(world[12] - eye[0], world[13] - eye[1], world[14] - eye[2]);
    return Math.max(most, centre + (scale * Math.hypot(...node.bounds)) / 2);
  }, 1);
  return { transform: local.transform, bounds: [2 * reach, 2 * reach, 2 * reach] };
}

/** The plan the model decided for a step, as scene commands. */
function commandsOf(
  state: SceneState,
  plan: Lean.CompPlan,
  window?: (surfaceId: Id) => NewWindow,
  eye?: Vec3,
): CompositionPlan {
  /** Where a new group stands: at the camera, which a step making one is given. */
  const atEye = (parentId: Id | null, members: readonly Id[]) => {
    if (eye === undefined) {
      throw new Error('a step making a group needs where the camera stands');
    }
    return groupAtEye(state, parentId, members, eye);
  };
  switch (plan.kind) {
    case 'refused':
      return Object.freeze({ kind: 'refused', field: plan.field, reason: plan.reason });
    case 'detach': {
      if (window === undefined) {
        throw new Error('a detached surface needs what its new window is given');
      }
      const given = window(plan.surface);
      const [surface] = surfacesOf(state, plan.window, [plan.surface]);
      if (surface === undefined) {
        throw new Error(`no surface "${plan.surface}"`);
      }
      const owner = nodeOf(state, plan.window);
      const kept = surfacesOf(state, owner.id, plan.kept);
      const alone = layoutSurfaces([sizeOf(surface)]);
      const local: Transform3D = { ...surface.transform, position: offsetAt(alone, 0) };
      const [left] = layoutSurfaces(kept.map(sizeOf)).bounds;
      const [width] = alone.bounds;
      // Beside the window it left, edge to edge with a gap, along that window's own right.
      const from = owner.transform;
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
              id: plan.created,
              kind: 'window',
              parentId: plan.parentId,
              label: plan.label,
              tags: [...given.tags],
              metadata: given.metadata,
              bounds: alone.bounds,
              transform: placed,
            },
          },
          { type: 'surface.move', id: surface.id, ownerNodeId: plan.created, keep: 'local' },
          { type: 'surface.patch', id: surface.id, transform: local },
          ...relayout(owner, kept),
        ],
        plan.created,
      );
    }
    case 'move':
      return planned([
        { type: 'surface.move', id: plan.surface, ownerNodeId: plan.target, keep: 'local' },
        ...relayout(nodeOf(state, plan.target), surfacesOf(state, plan.target, plan.laidOut)),
        ...(plan.left.length === 0
          ? [{ type: 'node.delete', id: plan.source, mode: 'rejectIfChildren' } as const]
          : relayout(nodeOf(state, plan.source), surfacesOf(state, plan.source, plan.left))),
      ]);
    case 'merge':
      return planned([
        ...plan.moved.map((surfaceId): SceneCommand => ({
          type: 'surface.move',
          id: surfaceId,
          ownerNodeId: plan.target,
          keep: 'local',
        })),
        ...relayout(nodeOf(state, plan.target), surfacesOf(state, plan.target, plan.laidOut)),
        { type: 'node.delete', id: plan.source, mode: 'rejectIfChildren' },
      ]);
    case 'regroup': {
      const into = plan.into;
      const move: SceneCommand =
        into.kind === 'group'
          ? { type: 'node.reparent', id: plan.window, parentId: into.id, keep: 'world' }
          : {
              type: 'node.group',
              nodeIds: [plan.window],
              group: {
                id: into.id,
                label: into.label,
                parentId: into.parentId,
                ...atEye(into.parentId, [plan.window]),
              },
            };
      return planned([
        move,
        ...(plan.removed === null
          ? []
          : [{ type: 'node.delete', id: plan.removed, mode: 'rejectIfChildren' } as const]),
      ]);
    }
    case 'split': {
      if (window === undefined) {
        throw new Error('a window broken into parts needs what each part is given');
      }
      const owner = nodeOf(state, plan.window);
      const kept = surfacesOf(state, owner.id, [plan.kept]);
      const commands: SceneCommand[] = [];
      // Side by side to the owner's right, along its own right, edge to edge with a gap.
      let x = layoutSurfaces(kept.map(sizeOf)).bounds[0] / 2 + WINDOW_FRAME.gap;
      for (const [surfaceId, [created, label]] of plan.parts) {
        const [surface] = surfacesOf(state, owner.id, [surfaceId]);
        if (surface === undefined) {
          throw new Error(`no surface "${surfaceId}"`);
        }
        const alone = layoutSurfaces([sizeOf(surface)]);
        const [width] = alone.bounds;
        const from = owner.transform;
        const given = window(surfaceId);
        commands.push(
          {
            type: 'node.create',
            node: {
              id: created,
              kind: 'window',
              parentId: plan.parentId,
              label,
              tags: [...given.tags],
              metadata: given.metadata,
              bounds: alone.bounds,
              transform: {
                position: transformPoint(from, [x + width / 2, 0, 0]),
                rotation: from.rotation,
                scale: from.scale,
              },
            },
          },
          { type: 'surface.move', id: surfaceId, ownerNodeId: created, keep: 'local' },
          {
            type: 'surface.patch',
            id: surfaceId,
            transform: { ...surface.transform, position: offsetAt(alone, 0) },
          },
        );
        x += width + WINDOW_FRAME.gap;
      }
      return planned([...commands, ...relayout(owner, kept)]);
    }
    case 'recombine':
      return planned([
        ...plan.moved.map((surfaceId): SceneCommand => ({
          type: 'surface.move',
          id: surfaceId,
          ownerNodeId: plan.window,
          keep: 'local',
        })),
        ...relayout(nodeOf(state, plan.window), surfacesOf(state, plan.window, plan.laidOut)),
        ...plan.removed.map((id): SceneCommand => ({
          type: 'node.delete',
          id,
          mode: 'rejectIfChildren',
        })),
      ]);
    case 'group':
      return planned([
        {
          type: 'node.group',
          nodeIds: [...plan.windows],
          group: {
            id: plan.id,
            label: plan.label,
            parentId: plan.parentId,
            ...atEye(plan.parentId, plan.windows),
          },
        },
        ...plan.removed.map((id): SceneCommand => ({
          type: 'node.delete',
          id,
          mode: 'rejectIfChildren',
        })),
      ]);
  }
}

/** An ID for a new node made from `stem`: the stem, or the stem numbered, whichever is free. */
export function freeId(state: SceneState, stem: string): Id {
  return models.compositionFreeId([...state.nodes.ids(), ...state.surfaces.ids()], stem);
}

/**
 * Takes a surface out of its window into a new window of its own, in the same group: the window
 * it left closes up round the rest, and the new one stands beside it, to its right, turned as it
 * is, so neither covers the other. The new window is named after the surface (`note-1-surface`
 * gives `note-1`). A window's only surface cannot be detached: there is nothing to split it from,
 * and a surface's own content is never split.
 */
export function detachSurface(
  state: SceneState,
  surfaceId: unknown,
  window: (surfaceId: Id) => NewWindow,
): CompositionPlan {
  const plan = models.compositionPlan(sceneOf(state), {
    kind: 'detach',
    surface: refOf(surfaceId),
  });
  return commandsOf(state, plan, window);
}

/**
 * Breaks a window into parts: it keeps its first surface, closing up round it, and each other
 * surface goes into a window of its own (`window` says what each is given), named after it, in the
 * same group, side by side to its right, turned as it is. A window with one surface has no parts.
 */
export function splitWindow(
  state: SceneState,
  windowId: unknown,
  window: (surfaceId: Id) => NewWindow,
): CompositionPlan {
  const plan = models.compositionPlan(sceneOf(state), { kind: 'split', window: refOf(windowId) });
  return commandsOf(state, plan, window);
}

/**
 * Puts parts back into the window they came from: every surface of each part goes into it, after
 * its own, laid out side by side again, and the emptied parts are removed. At least one part is
 * named; a part that holds other nodes is not emptied.
 */
export function recombineParts(
  state: SceneState,
  windowId: unknown,
  partIds: readonly unknown[],
): CompositionPlan {
  const plan = models.compositionPlan(sceneOf(state), {
    kind: 'recombine',
    window: refOf(windowId),
    parts: partIds.map(refOf),
  });
  return commandsOf(state, plan);
}

/**
 * Moves a surface into another window, after its surfaces; both windows are laid out again round
 * what they hold. A window left with no surface is removed from the workspace (undo brings it
 * back), so recombining a detached surface leaves nothing behind. The last surface of a window that
 * holds other nodes is not moved: the window cannot be emptied, as it cannot be merged.
 */
export function moveSurface(
  state: SceneState,
  surfaceId: unknown,
  targetWindowId: unknown,
): CompositionPlan {
  const plan = models.compositionPlan(sceneOf(state), {
    kind: 'move',
    surface: refOf(surfaceId),
    window: refOf(targetWindowId),
  });
  return commandsOf(state, plan);
}

/**
 * Moves every surface of a window into another, after its own, and removes the emptied window
 * from the workspace: one window holding both windows' surfaces, side by side. A window that holds
 * other nodes is not merged: it cannot be emptied.
 */
export function mergeWindow(
  state: SceneState,
  windowId: unknown,
  targetWindowId: unknown,
): CompositionPlan {
  const plan = models.compositionPlan(sceneOf(state), {
    kind: 'merge',
    window: refOf(windowId),
    target: refOf(targetWindowId),
  });
  return commandsOf(state, plan);
}

/**
 * Moves a window into another group, keeping its place in the world. A group it leaves empty is
 * removed with it, unless it is the group workspace orbit turns. A new group stands at the camera
 * (`eye`), so it takes no press meant for its window.
 */
export function regroupWindow(
  state: SceneState,
  windowId: unknown,
  target: GroupTarget,
  eye: Vec3,
): CompositionPlan {
  const plan = models.compositionPlan(sceneOf(state), {
    kind: 'regroup',
    window: refOf(windowId),
    target:
      target.kind === 'group'
        ? { kind: 'group', id: target.id }
        : { kind: 'fresh', id: target.id, label: target.label },
  });
  return commandsOf(state, plan, undefined, eye);
}

/**
 * Gathers windows into a new group together, each keeping its place in the world: the group is made
 * in the group they all share, or at the root when they share none, and a group they leave empty is
 * removed with them, unless it is the group workspace orbit turns. The group stands at the camera
 * (`eye`), so it takes no press meant for its windows. At least two windows are named,
 * each once; a window inside another window moves with it and is not grouped on its own.
 */
export function groupWindows(
  state: SceneState,
  windowIds: readonly unknown[],
  group: { readonly id: Id; readonly label: string },
  eye: Vec3,
): CompositionPlan {
  const plan = models.compositionPlan(sceneOf(state), {
    kind: 'group',
    windows: windowIds.map(refOf),
    id: group.id,
    label: group.label,
  });
  return commandsOf(state, plan, undefined, eye);
}

/** A composition step that cannot be done, naming the field at fault. */
export class CompositionRefusal extends Error {
  constructor(
    /** The field at fault. */
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'CompositionRefusal';
  }
}
