import type { Transform3D, Vec3 } from '@swf/math';
import type { JsonValue, Metadata } from './json.js';
import type { Id, NodeFlags } from './model.js';

/** Who originated an operation. Operator (`user`) changes respect node locks. */
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
  readonly flags?: Partial<NodeFlags>;
  readonly metadata?: Metadata;
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
 * Which placement a reparented node keeps. Omitted: `world` for operator (`user`) changes and
 * `local` for every other source.
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
  readonly flags?: Partial<NodeFlags>;
  readonly metadata?: {
    /** Keys to add or replace. */
    readonly set?: Readonly<Record<string, JsonValue>>;
    /** Keys to remove. */
    readonly remove?: readonly string[];
  };
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
  /** IDs for the copies, keyed by source ID. Unlisted copies get generated IDs. */
  readonly ids?: Readonly<Record<Id, Id>>;
  /** Parent of the copy. Omitted: the source's parent. */
  readonly parentId?: Id | null;
  /** Local transform of the copy. Omitted: the source's local transform. */
  readonly transform?: Transform3D;
}

export interface ArchiveNodeCommand {
  readonly type: 'node.archive';
  readonly id: Id;
}

export interface RestoreArchivedNodeCommand {
  readonly type: 'node.restoreArchived';
  readonly id: Id;
}

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
  | SetFocusCommand;

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
]);
