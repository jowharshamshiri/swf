import { descendantIds, worldBounds } from '@swf/core';
import { BoundingVolumeTree } from './bvh.js';
/** The index key of the node `id`'s frame: `node:<id>`. */
export const nodeKey = (id) => `node:${id}`;
/** The index key of the surface `id`: `surface:<id>`. */
export const surfaceKey = (id) => `surface:${id}`;
/**
 * The world boxes of a scene's nodes and surfaces in a bounding-volume tree, kept in step with the
 * scene by comparing records: only nodes that changed, their descendants, and the surfaces on them
 * are re-placed, so a single-window move costs one subtree, not the scene. The index is in world
 * space, where a panorama seam does not exist: a ray from any viewport finds the same entries.
 *
 * A node's entry is its world bounds; a surface's is the world box of its resolved geometry. The
 * index reads the states it is given and never changes them.
 */
export class SceneIndex {
    #tree = new BoundingVolumeTree();
    #nodes = new Map();
    #surfaces = new Map();
    #state = null;
    /** The scene state the index was last brought up to date with. */
    get state() {
        return this.#state;
    }
    /** How many entries the index holds: nodes and surfaces together. */
    get size() {
        return this.#tree.size;
    }
    /**
     * Brings the index up to date with `state`, using `geometry` to place surfaces. Returns the
     * number of entries re-placed (0 when the state is the one already indexed). Records are
     * compared by identity, as a workspace shares unchanged records between revisions. Throws an
     * Error when `geometry` has nothing for a surface of the scene.
     */
    sync(state, geometry) {
        if (state === this.#state) {
            return 0;
        }
        const dirty = new Set();
        for (const [id, previous] of this.#nodes) {
            const node = state.nodes.get(id);
            if (node === undefined) {
                this.#nodes.delete(id);
                this.#tree.delete(nodeKey(id));
            }
            else if (node !== previous) {
                dirty.add(id);
            }
        }
        for (const node of state.nodes.values()) {
            if (!this.#nodes.has(node.id)) {
                dirty.add(node.id);
            }
        }
        // A moved node moves everything under it.
        const moved = new Set();
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
    /**
     * The entries whose boxes the ray enters within `maxDistance` (default unbounded), in no
     * particular order: candidates for an exact hit test, not hits.
     */
    raycast(ray, maxDistance = Infinity) {
        return this.#tree.raycast(ray, maxDistance);
    }
    /** The tree's height, for checking that it stays balanced. */
    height() {
        return this.#tree.height();
    }
}
//# sourceMappingURL=scene-index.js.map