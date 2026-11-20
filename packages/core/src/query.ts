import type { Aabb, DecomposeResult, Mat4, Ray } from '@swf/math';
import {
  aabbIntersects,
  aabbOfBox,
  IDENTITY_MAT4,
  mat4Decompose,
  mat4FromTransform,
  mat4Multiply,
  rayIntersectAabb,
} from '@swf/math';
import type { Id, NodeRecord, SceneState } from './model.js';
import type { RecordLookup } from './table.js';
import { Table } from './table.js';

type NodeLookup = RecordLookup<NodeRecord>;

const worldCache = new WeakMap<NodeLookup, Map<Id, Mat4>>();

/**
 * The node's local-to-world matrix: the product of its ancestors' transforms and its own. Results
 * on committed (immutable) tables are cached. Returns undefined for an unknown node.
 */
export function worldMatrix(nodes: NodeLookup, id: Id): Mat4 | undefined {
  const cache = nodes instanceof Table ? cacheFor(nodes) : undefined;
  const cached = cache?.get(id);
  if (cached !== undefined) {
    return cached;
  }
  const node = nodes.get(id);
  if (node === undefined) {
    return undefined;
  }
  const parent = node.parentId === null ? IDENTITY_MAT4 : worldMatrix(nodes, node.parentId);
  if (parent === undefined) {
    return undefined;
  }
  const world = mat4Multiply(parent, mat4FromTransform(node.transform));
  cache?.set(id, world);
  return world;
}

/** The world matrix of the node's parent: identity for a root, undefined for an unknown parent. */
export function parentWorldMatrix(nodes: NodeLookup, parentId: Id | null): Mat4 | undefined {
  return parentId === null ? IDENTITY_MAT4 : worldMatrix(nodes, parentId);
}

function cacheFor(nodes: NodeLookup): Map<Id, Mat4> {
  let cache = worldCache.get(nodes);
  if (cache === undefined) {
    cache = new Map();
    worldCache.set(nodes, cache);
  }
  return cache;
}

/**
 * The node's world placement as position, rotation and scale. Fails with `shear` when a rotated
 * ancestor with non-uniform scale makes the world placement inexpressible that way; the world
 * matrix is always available.
 */
export function worldTransform(nodes: NodeLookup, id: Id): DecomposeResult | undefined {
  const m = worldMatrix(nodes, id);
  return m === undefined ? undefined : mat4Decompose(m);
}

/** The world-aligned box enclosing the node's bounds. */
export function worldBounds(nodes: NodeLookup, id: Id): Aabb | undefined {
  const node = nodes.get(id);
  const m = worldMatrix(nodes, id);
  return node === undefined || m === undefined ? undefined : aabbOfBox(m, node.bounds);
}

/** The node's ancestors, nearest first. */
export function ancestorIds(nodes: NodeLookup, id: Id): Id[] {
  const out: Id[] = [];
  let current = nodes.get(id)?.parentId ?? null;
  while (current !== null) {
    out.push(current);
    current = nodes.get(current)?.parentId ?? null;
  }
  return out;
}

/** True when `ancestorId` is `id` itself or one of its ancestors. */
export function isSelfOrAncestor(nodes: NodeLookup, ancestorId: Id, id: Id): boolean {
  return id === ancestorId || ancestorIds(nodes, id).includes(ancestorId);
}

/** The node's descendants in depth-first pre-order (children in presentation order). */
export function descendantIds(nodes: NodeLookup, id: Id): Id[] {
  const out: Id[] = [];
  const visit = (current: Id): void => {
    for (const child of nodes.get(current)?.childIds ?? []) {
      out.push(child);
      visit(child);
    }
  };
  visit(id);
  return out;
}

/** A node's status and flags after inheriting from its ancestors. */
export interface EffectiveState {
  /** The node and every ancestor are active (not archived). */
  readonly active: boolean;
  /** Active, and the node and every ancestor are visible. */
  readonly visible: boolean;
  /** Visible, and the node and every ancestor are selectable. */
  readonly selectable: boolean;
}

export function effectiveState(nodes: NodeLookup, id: Id): EffectiveState | undefined {
  const node = nodes.get(id);
  if (node === undefined) {
    return undefined;
  }
  let active = node.status === 'active';
  let visible = node.flags.visible;
  let selectable = node.flags.selectable;
  for (const ancestorId of ancestorIds(nodes, id)) {
    const ancestor = nodes.get(ancestorId);
    if (ancestor === undefined) {
      break;
    }
    active &&= ancestor.status === 'active';
    visible &&= ancestor.flags.visible;
    selectable &&= ancestor.flags.selectable;
  }
  visible &&= active;
  selectable &&= visible;
  return { active, visible, selectable };
}

export interface SpatialQueryOptions {
  /** Include nodes that are not effectively visible (hidden or archived). Default false. */
  readonly includeHidden?: boolean;
}

/** Nodes whose world bounds overlap `box`, in scene order. */
export function nodesInBox(state: SceneState, box: Aabb, options: SpatialQueryOptions = {}): Id[] {
  const out: Id[] = [];
  for (const node of state.nodes) {
    if (!included(state, node.id, options)) {
      continue;
    }
    const bounds = worldBounds(state.nodes, node.id);
    if (bounds !== undefined && aabbIntersects(bounds, box)) {
      out.push(node.id);
    }
  }
  return out;
}

export interface CoarseHit {
  readonly nodeId: Id;
  /** Distance along the ray to where it enters the node's world bounds. */
  readonly distance: number;
}

/**
 * Nodes whose world bounds the ray passes through: nearest first, then higher presentation
 * priority, then ID. This is a coarse, renderer-independent test; exact surface picking refines it.
 */
export function raycastBounds(
  state: SceneState,
  r: Ray,
  options: SpatialQueryOptions = {},
): CoarseHit[] {
  const hits: (CoarseHit & { priority: number })[] = [];
  for (const node of state.nodes) {
    if (!included(state, node.id, options)) {
      continue;
    }
    const bounds = worldBounds(state.nodes, node.id);
    const span = bounds === undefined ? null : rayIntersectAabb(r, bounds);
    if (span !== null) {
      hits.push({
        nodeId: node.id,
        distance: span.near,
        priority: node.flags.presentationPriority,
      });
    }
  }
  hits.sort(
    (a, b) =>
      a.distance - b.distance ||
      b.priority - a.priority ||
      (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0),
  );
  return hits.map(({ nodeId, distance }) => ({ nodeId, distance }));
}

function included(state: SceneState, id: Id, options: SpatialQueryOptions): boolean {
  return options.includeHidden === true || effectiveState(state.nodes, id)?.visible === true;
}

export interface NodeQuery {
  /** Case-insensitive, Unicode-normalized (NFKC) substring of the label, ID or a tag. */
  readonly text?: string;
  /** Every listed tag must be present. */
  readonly tags?: readonly string[];
  readonly kinds?: readonly string[];
  /** Include archived nodes. Default false. */
  readonly includeArchived?: boolean;
}

/** Nodes matching descriptive metadata only, in scene order. Surface content is never consulted. */
export function findNodes(state: SceneState, query: NodeQuery): Id[] {
  const needle = query.text === undefined ? null : fold(query.text);
  const out: Id[] = [];
  for (const node of state.nodes) {
    if (query.includeArchived !== true && effectiveState(state.nodes, node.id)?.active !== true) {
      continue;
    }
    if (query.kinds !== undefined && !query.kinds.includes(node.kind)) {
      continue;
    }
    if (query.tags !== undefined && !query.tags.every((tag) => node.tags.includes(tag))) {
      continue;
    }
    if (needle !== null && !matchesText(node, needle)) {
      continue;
    }
    out.push(node.id);
  }
  return out;
}

function matchesText(node: NodeRecord, needle: string): boolean {
  const haystacks = [node.id, ...node.tags];
  if (node.label !== null) {
    haystacks.push(node.label);
  }
  return haystacks.some((text) => fold(text).includes(needle));
}

/** Unicode compatibility normalization plus locale-independent lower-casing. */
export function fold(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}
