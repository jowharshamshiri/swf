import type { Transform3D, Vec3 } from '@swf/math';
import type { GeometryDescriptor } from './geometry.js';
import type { JsonValue, Metadata } from './json.js';
import type { EntityFlags, Id, InteractionRegion } from './model.js';

/** Who originated an operation. Operator (`user`) changes respect locks. */
export type EventSource = 'user' | 'host' | 'policy' | 'restore' | 'system';

/** Describes a node to create. Omitted fields take the documented defaults. */
export interface NodeSpec {
  /** Omitted: the workspace's ID generator supplies one. */
  readonly id?: Id;
  /** Free-form kind, such as `window` or `group`. */
  readonly kind: string;
  /** Omitted or null: a root node. */
  readonly parentId?: Id | null;
  /** Position among the parent's children. Omitted: last (frontmost). */
  readonly index?: number;
  /** Omitted: identity. */
  readonly transform?: Transform3D;
  readonly bounds: Vec3;
  readonly label?: string | null;
  readonly tags?: readonly string[];
  readonly flags?: Partial<EntityFlags>;
  readonly metadata?: Metadata;
}

/** Describes a surface to attach to a node. Omitted fields take the documented defaults. */
export interface SurfaceSpec {
  /** Omitted: the workspace's ID generator supplies one. */
  readonly id?: Id;
  /** The node that holds the surface; any node can. */
  readonly ownerNodeId: Id;
  /** The host's opaque key for the endpoint, or null when none is assigned yet. */
  readonly bindingKey: string | null;
  /** The adapter type that resolves the key, as `<name>/<version>`, such as `host.video/1`. */
  readonly adapterTypeId: string;
  /** Position among the owner's surfaces. Omitted: last (frontmost). */
  readonly index?: number;
  /** Placement relative to the owner node. Omitted: identity. */
  readonly transform?: Transform3D;
  /** Width, height and depth in the surface's local frame. */
  readonly bounds: Vec3;
  /** Omitted: a rectangle filling the bounds. */
  readonly geometry?: GeometryDescriptor;
  /** Omitted: `content`. */
  readonly interaction?: InteractionRegion;
  readonly flags?: Partial<EntityFlags>;
  readonly label?: string | null;
  readonly metadata?: Metadata;
}

/** Keys to add or replace and keys to remove in a metadata map. */
export interface MetadataPatch {
  readonly set?: Readonly<Record<string, JsonValue>>;
  readonly remove?: readonly string[];
}

/** How a node's children are handled when it is deleted. There is no implicit default. */
export type DeleteMode =
  /** Remove the node and all of its descendants. */
  | 'subtree'
  /** Move the children to the node's parent, keeping their world placement, then remove it. */
  | 'detachChildren'
  /** Reject the deletion while the node has children. */
  | 'rejectIfChildren';

/**
 * Which placement a moved node or surface keeps. Omitted: `world` for operator (`user`) changes
 * and `local` for every other source.
 */
export type KeepMode = 'world' | 'local';

export interface CreateNodeCommand {
  readonly type: 'node.create';
  readonly node: NodeSpec;
}

export interface PatchNodeCommand {
  readonly type: 'node.patch';
  readonly id: Id;
  readonly transform?: Transform3D;
  readonly bounds?: Vec3;
  readonly label?: string | null;
  readonly tags?: readonly string[];
  readonly flags?: Partial<EntityFlags>;
  readonly metadata?: MetadataPatch;
}

export interface ReparentNodeCommand {
  readonly type: 'node.reparent';
  readonly id: Id;
  /** Null makes the node a root. */
  readonly parentId: Id | null;
  readonly keep?: KeepMode;
  /** Position among the new parent's children. Omitted: last. */
  readonly index?: number;
}

export interface ReorderNodeCommand {
  readonly type: 'node.reorder';
  readonly id: Id;
  /** New position among its siblings, 0 being the back. */
  readonly index: number;
}

export interface DuplicateNodeCommand {
  readonly type: 'node.duplicate';
  /** The active node whose subtree is copied. Archived descendants are not copied. */
  readonly id: Id;
  /** IDs for the copies, keyed by source node or surface ID. Unlisted copies get generated IDs. */
  readonly ids?: Readonly<Record<Id, Id>>;
  /** Parent of the copy. Omitted: the source's parent. */
  readonly parentId?: Id | null;
  /** Local transform of the copy. Omitted: the source's local transform. */
  readonly transform?: Transform3D;
  /**
   * Whether copied surfaces keep their binding keys. Default false: copies are layout only, with
   * no key, because the same endpoint must not gain a second owner unasked.
   */
  readonly reuseBindingKeys?: boolean;
}

export interface ArchiveNodeCommand {
  readonly type: 'node.archive';
  readonly id: Id;
}

export interface RestoreArchivedNodeCommand {
  readonly type: 'node.restoreArchived';
  readonly id: Id;
}

/** Removes the node (and, by mode, its descendants) with all of their surface associations. */
export interface DeleteNodeCommand {
  readonly type: 'node.delete';
  readonly id: Id;
  readonly mode: DeleteMode;
}

export interface GroupNodesCommand {
  readonly type: 'node.group';
  /** Nodes to gather; none may contain another. They keep their world placement. */
  readonly nodeIds: readonly Id[];
  readonly group?: {
    readonly id?: Id;
    /** Omitted: `group`. */
    readonly kind?: string;
    readonly label?: string | null;
    /** Omitted: the members' common parent, which they must then share. */
    readonly parentId?: Id | null;
    /**
     * Omitted together with `bounds`: the group sits at the centre of its members' combined box,
     * axis-aligned with its parent, and its bounds are that box.
     */
    readonly transform?: Transform3D;
    readonly bounds?: Vec3;
  };
}

export interface UngroupNodeCommand {
  readonly type: 'node.ungroup';
  /** The node to dissolve: its children move to its parent, keeping world placement. */
  readonly id: Id;
}

export interface SetSelectionCommand {
  readonly type: 'selection.set';
  readonly ids: readonly Id[];
}

export interface SetFocusCommand {
  readonly type: 'focus.set';
  readonly id: Id | null;
}

/** Associates a host presentation endpoint with a place on a node. */
export interface AttachSurfaceCommand {
  readonly type: 'surface.attach';
  readonly surface: SurfaceSpec;
}

export interface PatchSurfaceCommand {
  readonly type: 'surface.patch';
  readonly id: Id;
  readonly transform?: Transform3D;
  readonly bounds?: Vec3;
  readonly geometry?: GeometryDescriptor;
  readonly interaction?: InteractionRegion;
  readonly flags?: Partial<EntityFlags>;
  readonly label?: string | null;
  readonly metadata?: MetadataPatch;
}

/** Moves a surface to another node. */
export interface MoveSurfaceCommand {
  readonly type: 'surface.move';
  readonly id: Id;
  readonly ownerNodeId: Id;
  readonly keep?: KeepMode;
  /** Position among the new owner's surfaces. Omitted: last. */
  readonly index?: number;
}

export interface ReorderSurfaceCommand {
  readonly type: 'surface.reorder';
  readonly id: Id;
  /** New position among its owner's surfaces, 0 being the back. */
  readonly index: number;
}

/** Points the surface at another endpoint, keeping its ID, placement and order. */
export interface RebindSurfaceCommand {
  readonly type: 'surface.rebind';
  readonly id: Id;
  readonly bindingKey: string | null;
  /** Omitted: the surface's current adapter type. */
  readonly adapterTypeId?: string;
}

/** Removes the association. The endpoint itself is the host's and is left as it is. */
export interface DetachSurfaceCommand {
  readonly type: 'surface.detach';
  readonly id: Id;
}

/** A scene command. A transaction applies a list of them atomically. */
export type SceneCommand =
  | CreateNodeCommand
  | PatchNodeCommand
  | ReparentNodeCommand
  | ReorderNodeCommand
  | DuplicateNodeCommand
  | ArchiveNodeCommand
  | RestoreArchivedNodeCommand
  | DeleteNodeCommand
  | GroupNodesCommand
  | UngroupNodeCommand
  | SetSelectionCommand
  | SetFocusCommand
  | AttachSurfaceCommand
  | PatchSurfaceCommand
  | MoveSurfaceCommand
  | ReorderSurfaceCommand
  | RebindSurfaceCommand
  | DetachSurfaceCommand;

export type SceneCommandType = SceneCommand['type'];

export const SCENE_COMMAND_TYPES: readonly SceneCommandType[] = Object.freeze([
  'node.create',
  'node.patch',
  'node.reparent',
  'node.reorder',
  'node.duplicate',
  'node.archive',
  'node.restoreArchived',
  'node.delete',
  'node.group',
  'node.ungroup',
  'selection.set',
  'focus.set',
  'surface.attach',
  'surface.patch',
  'surface.move',
  'surface.reorder',
  'surface.rebind',
  'surface.detach',
]);
