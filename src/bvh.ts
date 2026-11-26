import type { Aabb, Ray } from '@swf/math';
import { aabbIntersects, aabbUnion, rayIntersectAabb } from '@swf/math';

interface TreeNode<K> {
  box: Aabb;
  parent: TreeNode<K> | null;
  /** Null for a leaf. */
  children: [TreeNode<K>, TreeNode<K>] | null;
  /** The leaf's key; null for an inner node. */
  key: K | null;
}

/** A leaf's key. */
function keyOf<K>(node: TreeNode<K>): K {
  if (node.key === null) {
    throw new Error('a bounding-volume tree inner node was treated as a leaf');
  }
  return node.key;
}

/** An inner node's two children. */
function pair<K>(node: TreeNode<K>): [TreeNode<K>, TreeNode<K>] {
  if (node.children === null) {
    throw new Error('a bounding-volume tree leaf was treated as an inner node');
  }
  return node.children;
}

/** Half the surface area of a box: the cost a bounding-volume tree minimizes. */
function cost(box: Aabb): number {
  const dx = box.max[0] - box.min[0];
  const dy = box.max[1] - box.min[1];
  const dz = box.max[2] - box.min[2];
  return dx * dy + dy * dz + dz * dx;
}

/**
 * A dynamic bounding-volume hierarchy over keyed world boxes: insert, update and remove in
 * logarithmic time on a balanced tree, and ray and box queries that visit only the branches a
 * query can reach. Keys are unique, compared as a `Map` compares them; boxes must be finite. The
 * tree keeps each box it is given, not a copy. Query results come in no particular order.
 */
export class BoundingVolumeTree<K> {
  #root: TreeNode<K> | null = null;
  readonly #leaves = new Map<K, TreeNode<K>>();

  /** How many keys the tree holds. */
  get size(): number {
    return this.#leaves.size;
  }

  /** True when the tree holds `key`. */
  has(key: K): boolean {
    return this.#leaves.has(key);
  }

  /**
   * Adds `key` with `box`, or moves it there when it is already present. Throws a RangeError,
   * leaving the tree unchanged, when a corner of the box is not finite.
   */
  set(key: K, box: Aabb): void {
    if (![...box.min, ...box.max].every(Number.isFinite)) {
      throw new RangeError(`the box of ${String(key)} is not finite`);
    }
    const existing = this.#leaves.get(key);
    if (existing !== undefined) {
      this.#detach(existing);
    }
    const leaf: TreeNode<K> = { box, parent: null, children: null, key };
    this.#leaves.set(key, leaf);
    this.#attach(leaf);
  }

  /** Removes `key`; returns false when it was not present. */
  delete(key: K): boolean {
    const leaf = this.#leaves.get(key);
    if (leaf === undefined) {
      return false;
    }
    this.#leaves.delete(key);
    this.#detach(leaf);
    return true;
  }

  /**
   * Every key whose box the ray enters at a distance in [0, maxDistance] (default unbounded),
   * counting a ray that starts inside a box as entering it at 0. Distances are ray parameters,
   * world units for a ray with a unit direction. Returns a fresh array.
   */
  raycast(ray: Ray, maxDistance = Infinity): K[] {
    const found: K[] = [];
    const stack: TreeNode<K>[] = this.#root === null ? [] : [this.#root];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      const span = rayIntersectAabb(ray, node.box);
      if (span === null || span.near > maxDistance) {
        continue;
      }
      if (node.children === null) {
        found.push(keyOf(node));
      } else {
        stack.push(node.children[0], node.children[1]);
      }
    }
    return found;
  }

  /**
   * Every key whose box overlaps `box` with positive volume, as {@link aabbIntersects} decides;
   * boxes that only touch are not returned. Returns a fresh array.
   */
  query(box: Aabb): K[] {
    const found: K[] = [];
    const stack: TreeNode<K>[] = this.#root === null ? [] : [this.#root];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      if (!aabbIntersects(node.box, box)) {
        continue;
      }
      if (node.children === null) {
        found.push(keyOf(node));
      } else {
        stack.push(node.children[0], node.children[1]);
      }
    }
    return found;
  }

  /** The tree's height (0 when empty): a measure of its balance. */
  height(): number {
    const depth = (node: TreeNode<K> | null): number =>
      node === null
        ? 0
        : node.children === null
          ? 1
          : 1 + Math.max(depth(node.children[0]), depth(node.children[1]));
    return depth(this.#root);
  }

  #attach(leaf: TreeNode<K>): void {
    if (this.#root === null) {
      this.#root = leaf;
      return;
    }
    // Descend towards the sibling whose enlargement costs least (the surface-area heuristic).
    let sibling = this.#root;
    while (sibling.children !== null) {
      const [a, b] = sibling.children;
      const combined = cost(aabbUnion(sibling.box, leaf.box));
      const here = 2 * combined;
      const inherited = 2 * (combined - cost(sibling.box));
      const descend = (child: TreeNode<K>) => {
        const union = cost(aabbUnion(child.box, leaf.box));
        return child.children === null ? union + inherited : union - cost(child.box) + inherited;
      };
      const costA = descend(a);
      const costB = descend(b);
      if (here < costA && here < costB) {
        break;
      }
      sibling = costA <= costB ? a : b;
    }
    const oldParent = sibling.parent;
    const parent: TreeNode<K> = {
      box: aabbUnion(sibling.box, leaf.box),
      parent: oldParent,
      children: [sibling, leaf],
      key: null,
    };
    sibling.parent = parent;
    leaf.parent = parent;
    if (oldParent === null) {
      this.#root = parent;
    } else {
      const children = pair(oldParent);
      children[children[0] === sibling ? 0 : 1] = parent;
    }
    this.#refit(parent.parent);
  }

  #detach(leaf: TreeNode<K>): void {
    const parent = leaf.parent;
    if (parent === null) {
      this.#root = null;
      return;
    }
    const children = pair(parent);
    const sibling = children[0] === leaf ? children[1] : children[0];
    const grandparent = parent.parent;
    sibling.parent = grandparent;
    if (grandparent === null) {
      this.#root = sibling;
    } else {
      const siblings = pair(grandparent);
      siblings[siblings[0] === parent ? 0 : 1] = sibling;
      this.#refit(grandparent);
    }
    leaf.parent = null;
  }

  /** Recomputes boxes from `node` up to the root, rotating where it lowers the cost. */
  #refit(start: TreeNode<K> | null): void {
    for (let node = start; node !== null; node = node.parent) {
      this.#rotate(node);
      const [a, b] = pair(node);
      node.box = aabbUnion(a.box, b.box);
    }
  }

  /**
   * Swaps a child with a grandchild on the other side when that shrinks the other side's box,
   * which keeps the tree balanced under updates in arbitrary order.
   */
  #rotate(node: TreeNode<K>): void {
    const [a, b] = pair(node);
    const tryRotate = (keep: TreeNode<K>, inner: TreeNode<K>, side: 0 | 1): boolean => {
      if (inner.children === null) {
        return false;
      }
      const [g0, g1] = inner.children;
      const current = cost(inner.box);
      const with0 = cost(aabbUnion(keep.box, g1.box));
      const with1 = cost(aabbUnion(keep.box, g0.box));
      if (with0 >= current && with1 >= current) {
        return false;
      }
      // Swap `keep` with the grandchild whose removal leaves the smaller box.
      const swapIndex: 0 | 1 = with0 <= with1 ? 0 : 1;
      const grandchild = inner.children[swapIndex];
      inner.children[swapIndex] = keep;
      keep.parent = inner;
      pair(node)[side] = grandchild;
      grandchild.parent = node;
      const [c0, c1] = inner.children;
      inner.box = aabbUnion(c0.box, c1.box);
      return true;
    };
    if (!tryRotate(a, b, 0)) {
      tryRotate(b, a, 1);
    }
  }
}
