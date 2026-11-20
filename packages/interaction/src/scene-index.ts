import type { Id, NodeRecord, ResolvedGeometry, SceneState, SurfaceRecord } from '@swf/core';
import { descendantIds, worldBounds } from '@swf/core';
import type { Ray } from '@swf/math';
import { BoundingVolumeTree } from './bvh.js';

/** An entry of the index: a node's frame or a surface. */
export type IndexKey = `node:${string}` | `surface:${string}`;

export const nodeKey = (id: Id): IndexKey => `node:${id}`;
export const surfaceKey = (id: Id): IndexKey => `surface:${id}`;

/**
 * The world boxes of a scene's nodes and surfaces in a bounding-volume tree, kept in step with the
 * scene by comparing records: only nodes that changed, their descendants, and the surfaces on them
 * are re-placed, so a single-window move costs one subtree, not the scene. The index is in world
 * space, where a panorama seam does not exist: a ray from any viewport finds the same entries.
 */
export class SceneIndex {
  readonly #tree = new BoundingVolumeTree<IndexKey>();
  readonly #nodes = new Map<Id, NodeRecord>();
  readonly #surfaces = new Map<Id, SurfaceRecord>();
  #state: SceneState | null = null;

  /** The scene state the index was last brought up to date with. */
  get state(): SceneState | null {
    return this.#state;
  }

  get size(): number {
    return this.#tree.size;
  }

  /**
   * Brings the index up to date with `state`, using `geometry` to place surfaces. Returns the
   * number of entries re-placed (0 when the state is the one already indexed).
   */
  sync(state: SceneState, geometry: (surfaceId: Id) => ResolvedGeometry | undefined): number {
    if (state === this.#state) {
      return 0;
    }
    const dirty = new Set<Id>();
    for (const [id, previous] of this.#nodes) {
      const node = state.nodes.get(id);
      if (node === undefined) {
        this.#nodes.delete(id);
        this.#tree.delete(nodeKey(id));
      } else if (node !== previous) {
        dirty.add(id);
      }
    }
    for (const node of state.nodes.values()) {
      if (!this.#nodes.has(node.id)) {
        dirty.add(node.id);
      }
    }
    // A moved node moves everything under it.
    const moved = new Set<Id>();
    for (const id of dirty) {
      if (!moved.has(id)) {
        moved.add(id);
        for (const descendant of descendantIds(state.nodes, id)) {
          moved.add(descendant);
        }
      }
    }
    let placed = 0;
    for (const id of moved) {
      const node = state.nodes.get(id);
      const box = worldBounds(state.nodes, id);
      if (node === undefined || box === undefined) {
        continue;
      }
      this.#nodes.set(id, node);
      this.#tree.set(nodeKey(id), box);
      placed += 1;
    }
    for (const id of this.#surfaces.keys()) {
      if (!state.surfaces.has(id)) {
        this.#surfaces.delete(id);
        this.#tree.delete(surfaceKey(id));
      }
    }
    // A surface is re-placed when its own record changed or its owner (or an ancestor) moved.
    for (const surface of state.surfaces.values()) {
      if (this.#surfaces.get(surface.id) === surface && !moved.has(surface.ownerNodeId)) {
        continue;
      }
      const g = geometry(surface.id);
      if (g === undefined) {
        throw new Error(`surface "${surface.id}" is in the scene but has no resolved geometry`);
      }
      this.#surfaces.set(surface.id, surface);
      this.#tree.set(surfaceKey(surface.id), g.worldBounds);
      placed += 1;
    }
    this.#state = state;
    return placed;
  }

  /** The entries whose boxes the ray enters within `maxDistance`. */
  raycast(ray: Ray, maxDistance = Infinity): IndexKey[] {
    return this.#tree.raycast(ray, maxDistance);
  }

  /** The tree's height, for checking that it stays balanced. */
  height(): number {
    return this.#tree.height();
  }
}
