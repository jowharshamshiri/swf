import type { Id, ResolvedGeometry, SceneState } from '@swf/core';
import type { Ray } from '@swf/math';
/** An entry of the index: a node's frame or a surface, by its ID. */
export type IndexKey = `node:${string}` | `surface:${string}`;
/** The index key of the node `id`'s frame: `node:<id>`. */
export declare const nodeKey: (id: Id) => IndexKey;
/** The index key of the surface `id`: `surface:<id>`. */
export declare const surfaceKey: (id: Id) => IndexKey;
/**
 * The world boxes of a scene's nodes and surfaces in a bounding-volume tree, kept in step with the
 * scene by comparing records: only nodes that changed, their descendants, and the surfaces on them
 * are re-placed, so a single-window move costs one subtree, not the scene. The index is in world
 * space, where a panorama seam does not exist: a ray from any viewport finds the same entries.
 *
 * A node's entry is its world bounds; a surface's is the world box of its resolved geometry. The
 * index reads the states it is given and never changes them.
 */
export declare class SceneIndex {
    #private;
    /** The scene state the index was last brought up to date with. */
    get state(): SceneState | null;
    /** How many entries the index holds: nodes and surfaces together. */
    get size(): number;
    /**
     * Brings the index up to date with `state`, using `geometry` to place surfaces. Returns the
     * number of entries re-placed (0 when the state is the one already indexed). Records are
     * compared by identity, as a workspace shares unchanged records between revisions. Throws an
     * Error when `geometry` has nothing for a surface of the scene.
     */
    sync(state: SceneState, geometry: (surfaceId: Id) => ResolvedGeometry | undefined): number;
    /**
     * The entries whose boxes the ray enters within `maxDistance` (default unbounded), in no
     * particular order: candidates for an exact hit test, not hits.
     */
    raycast(ray: Ray, maxDistance?: number): IndexKey[];
    /** The tree's height, for checking that it stays balanced. */
    height(): number;
}
//# sourceMappingURL=scene-index.d.ts.map