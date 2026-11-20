import type { Transform3D, Vec3 } from '@swf/math';
import type { GeometryDescriptor } from './geometry.js';
import type { Metadata } from './json.js';
import type { Table } from './table.js';

/** An entity identifier, unique within one workspace across nodes and surfaces (archived included). */
export type Id = string;

/**
 * Orthogonal flags of a node or a surface. `locked` blocks operator-originated (`user`) spatial
 * changes only; host transactions still apply.
 */
export interface EntityFlags {
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

export const DEFAULT_FLAGS: EntityFlags = Object.freeze({
  visible: true,
  selectable: true,
  draggable: true,
  resizable: true,
  rotatable: true,
  pointerEnabled: true,
  locked: false,
  presentationPriority: 0,
});

export const FLAG_NAMES = Object.freeze(Object.keys(DEFAULT_FLAGS) as (keyof EntityFlags)[]);

/** `archived` records keep their ID and layout but take no part in the active scene. */
export type NodeStatus = 'active' | 'archived';

/**
 * A spatial node: a generic hierarchical 3D entity. A window is a node of kind `window`; a group
 * created by `node.group` is a node of kind `group`. Any node can hold surfaces.
 */
export interface NodeRecord {
  readonly id: Id;
  readonly kind: string;
  readonly parentId: Id | null;
  /** Children in presentation order (later children are in front among equals). */
  readonly childIds: readonly Id[];
  /** The node's surface slots in presentation order (later surfaces are in front). */
  readonly surfaceIds: readonly Id[];
  /** Placement relative to the parent (or the world, for a root). */
  readonly transform: Transform3D;
  /** Extent of the node's local box, centred on its local origin, before scale. */
  readonly bounds: Vec3;
  readonly flags: EntityFlags;
  readonly label: string | null;
  readonly tags: readonly string[];
  readonly metadata: Metadata;
  readonly status: NodeStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Whether input over a surface is meant for its content (`content`) or the surface only shows
 * something (`none`). An adapter may narrow it further through its capabilities.
 */
export type InteractionRegion = 'content' | 'none';

/**
 * A surface: the association of an externally owned presentation endpoint with a place on a node.
 * It is presentation metadata only; the live handle it resolves to is never part of the scene.
 */
export interface SurfaceRecord {
  readonly id: Id;
  readonly ownerNodeId: Id;
  /**
   * The host's opaque key for the presentation endpoint, resolved only by the adapter. Null means
   * no endpoint is assigned yet (for example, a duplicated layout).
   */
  readonly bindingKey: string | null;
  /** The adapter type that resolves the key, as `<name>/<version>`. */
  readonly adapterTypeId: string;
  /** Placement relative to the owner node, independent of the owner's own transform. */
  readonly transform: Transform3D;
  /** Extent of the surface in its local frame: width (+X), height (+Y) and depth (+Z). */
  readonly bounds: Vec3;
  readonly geometry: GeometryDescriptor;
  readonly interaction: InteractionRegion;
  readonly flags: EntityFlags;
  readonly label: string | null;
  readonly metadata: Metadata;
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
  readonly surfaces: Table<SurfaceRecord>;
  /** Selected nodes in selection order. Only active, selectable nodes can be selected. */
  readonly selection: readonly Id[];
  readonly focusedId: Id | null;
}
