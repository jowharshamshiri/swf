import type { Transform3D, Vec3 } from '@swf/math';
import type { Metadata } from './json.js';
import type { Table } from './table.js';

/** An entity identifier, unique within one workspace (archived records included). */
export type Id = string;

/**
 * Orthogonal per-node flags. `locked` blocks operator-originated (`user`) spatial changes only;
 * host transactions still apply.
 */
export interface NodeFlags {
  readonly visible: boolean;
  readonly selectable: boolean;
  readonly draggable: boolean;
  readonly resizable: boolean;
  readonly rotatable: boolean;
  readonly pointerEnabled: boolean;
  readonly locked: boolean;
  /** Higher values present and pick first among otherwise equal candidates. */
  readonly presentationPriority: number;
}

export const DEFAULT_NODE_FLAGS: NodeFlags = Object.freeze({
  visible: true,
  selectable: true,
  draggable: true,
  resizable: true,
  rotatable: true,
  pointerEnabled: true,
  locked: false,
  presentationPriority: 0,
});

export const NODE_FLAG_NAMES = Object.freeze(
  Object.keys(DEFAULT_NODE_FLAGS) as (keyof NodeFlags)[],
);

/** `archived` records keep their ID and layout but take no part in the active scene. */
export type NodeStatus = 'active' | 'archived';

/**
 * A spatial node: a generic hierarchical 3D entity. A window is a node of kind `window`; a group
 * created by `node.group` is a node of kind `group`.
 */
export interface NodeRecord {
  readonly id: Id;
  readonly kind: string;
  readonly parentId: Id | null;
  /** Children in presentation order (later children are in front among equals). */
  readonly childIds: readonly Id[];
  /** Placement relative to the parent (or the world, for a root). */
  readonly transform: Transform3D;
  /** Extent of the node's local box, centred on its local origin, before scale. */
  readonly bounds: Vec3;
  readonly flags: NodeFlags;
  readonly label: string | null;
  readonly tags: readonly string[];
  readonly metadata: Metadata;
  readonly status: NodeStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** One immutable state of a workspace's scene. A new object is produced by every commit. */
export interface SceneState {
  readonly workspaceId: Id;
  /** Increments by one on every commit; the authority for conflict detection. */
  readonly revision: number;
  /** Root nodes in presentation order. */
  readonly rootIds: readonly Id[];
  readonly nodes: Table<NodeRecord>;
  /** Selected nodes in selection order. Only active, selectable nodes can be selected. */
  readonly selection: readonly Id[];
  readonly focusedId: Id | null;
}
