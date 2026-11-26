import type { Aabb, Ray } from '@swf/math';
/**
 * A dynamic bounding-volume hierarchy over keyed world boxes: insert, update and remove in
 * logarithmic time on a balanced tree, and ray and box queries that visit only the branches a
 * query can reach. Keys are unique, compared as a `Map` compares them; boxes must be finite. The
 * tree keeps each box it is given, not a copy. Query results come in no particular order.
 */
export declare class BoundingVolumeTree<K> {
    #private;
    /** How many keys the tree holds. */
    get size(): number;
    /** True when the tree holds `key`. */
    has(key: K): boolean;
    /**
     * Adds `key` with `box`, or moves it there when it is already present. Throws a RangeError,
     * leaving the tree unchanged, when a corner of the box is not finite.
     */
    set(key: K, box: Aabb): void;
    /** Removes `key`; returns false when it was not present. */
    delete(key: K): boolean;
    /**
     * Every key whose box the ray enters at a distance in [0, maxDistance] (default unbounded),
     * counting a ray that starts inside a box as entering it at 0. Distances are ray parameters,
     * world units for a ray with a unit direction. Returns a fresh array.
     */
    raycast(ray: Ray, maxDistance?: number): K[];
    /**
     * Every key whose box overlaps `box` with positive volume, as {@link aabbIntersects} decides;
     * boxes that only touch are not returned. Returns a fresh array.
     */
    query(box: Aabb): K[];
    /** The tree's height (0 when empty): a measure of its balance. */
    height(): number;
}
//# sourceMappingURL=bvh.d.ts.map