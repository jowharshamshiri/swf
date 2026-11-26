import type { Quat, Transform3D, Vec3 } from '@swf/math';
import type { GeometryDescriptor } from './geometry.js';
import type { JsonValue, Metadata } from './json.js';
import type {
  EntityFlags,
  Id,
  InteractionRegion,
  NavigationTarget,
  ProjectionSetting,
  ViewportRecord,
} from './model.js';

/** Who originated an operation. Operator (`user`) changes respect locks. */
export type EventSource =
  /** The operator, through interaction. Refused with `LOCKED` on locked entities. */
  | 'user'
  /** The host application's own code; the default for transactions. */
  | 'host'
  /** A policy acting for the host, such as an automatic layout. */
  | 'policy'
  /** Persistence restoring a saved scene; the default for a restore. */
  | 'restore'
  /** The workspace itself, such as the events it sends while it is disposed. */
  | 'system';

/**
 * Describes a node to create. Omitted fields take the documented defaults; a field the spec does
 * not define is rejected with `INVALID_INPUT` naming it.
 */
export interface NodeSpec {
  /**
   * A non-blank ID not yet used by any node, surface, camera or viewport of the workspace;
   * otherwise the transaction is rejected with `INVALID_INPUT`. Omitted: the workspace's ID
   * generator supplies one.
   */
  readonly id?: Id;
  /** Free-form, non-blank kind, such as `window` or `group`. */
  readonly kind: string;
  /** An existing node (`UNKNOWN_ENTITY` otherwise). Omitted or null: a root node. */
  readonly parentId?: Id | null;
  /**
   * Position among the parent's children: an integer from 0 to their count. Omitted: last
   * (frontmost).
   */
  readonly index?: number;
  /**
   * Placement relative to the parent: a finite position, a unit rotation quaternion (within 1e-6
   * of unit length, stored renormalised) and a positive, finite scale. Omitted: identity.
   */
  readonly transform?: Transform3D;
  /** Extent of the node's local box, centred on its origin: three positive, finite numbers. */
  readonly bounds: Vec3;
  /** A display name. Omitted: null, none. */
  readonly label?: string | null;
  /** Distinct, non-blank tags; a repeated tag is rejected. Omitted: none. */
  readonly tags?: readonly string[];
  /**
   * Flags to change from {@link DEFAULT_FLAGS}: booleans, and a finite `presentationPriority`.
   * An unknown flag is rejected.
   */
  readonly flags?: Partial<EntityFlags>;
  /** Namespaced descriptive data, copied and frozen. Omitted: empty. */
  readonly metadata?: Metadata;
}

/**
 * Describes a surface to attach to a node. Omitted fields take the documented defaults; a field
 * the spec does not define is rejected with `INVALID_INPUT` naming it.
 */
export interface SurfaceSpec {
  /**
   * A non-blank ID not yet used by any entity of the workspace. Omitted: the workspace's ID
   * generator supplies one.
   */
  readonly id?: Id;
  /** The node that holds the surface; any node can. It must exist (`UNKNOWN_ENTITY`). */
  readonly ownerNodeId: Id;
  /**
   * The host's opaque key for the endpoint (any non-blank string, never interpreted), or null
   * when none is assigned yet. Required.
   */
  readonly bindingKey: string | null;
  /** The adapter type that resolves the key, as `<name>/<version>`, such as `host.video/1`. */
  readonly adapterTypeId: string;
  /**
   * Position among the owner's surfaces: an integer from 0 to their count. Omitted: last
   * (frontmost).
   */
  readonly index?: number;
  /** Placement relative to the owner node, validated like a node's. Omitted: identity. */
  readonly transform?: Transform3D;
  /** Width, height and depth in the surface's local frame: positive, finite numbers. */
  readonly bounds: Vec3;
  /**
   * A registered geometry kind with `params` (null when it takes none) that are JSON within the
   * size limit and accepted by the kind's provider for `bounds`. Omitted: a rectangle filling the
   * bounds.
   */
  readonly geometry?: GeometryDescriptor;
  /** Omitted: `content`. */
  readonly interaction?: InteractionRegion;
  /** Flags to change from {@link DEFAULT_FLAGS}, validated like a node's. */
  readonly flags?: Partial<EntityFlags>;
  /** A display name. Omitted: null, none. */
  readonly label?: string | null;
  /** Namespaced descriptive data, copied and frozen. Omitted: empty. */
  readonly metadata?: Metadata;
}

/**
 * Keys to add or replace and keys to remove in a metadata map. `set` applies first, then
 * `remove`; keys not named are kept.
 */
export interface MetadataPatch {
  /** Namespaced keys and the JSON values they take, added or replacing the current ones. */
  readonly set?: Readonly<Record<string, JsonValue>>;
  /** Namespaced keys to remove; a key that is not present is ignored. */
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

/** Creates a node. Its ID is reported in the result's `createdIds`. */
export interface CreateNodeCommand {
  /** The discriminant that selects this command. */
  readonly type: 'node.create';
  /** The node to create. */
  readonly node: NodeSpec;
}

/**
 * Changes fields of an existing node (`UNKNOWN_ENTITY` otherwise); omitted fields are kept. A
 * locked node refuses a `user` change of its transform or bounds with `LOCKED`; flags, including
 * `locked` itself, can always be changed.
 */
export interface PatchNodeCommand {
  /** The discriminant that selects this command. */
  readonly type: 'node.patch';
  /** The node to change. */
  readonly id: Id;
  /** The new local transform, validated like a spec's and resolved through the constraints. */
  readonly transform?: Transform3D;
  /** The new extent: three positive, finite numbers. */
  readonly bounds?: Vec3;
  /** The new display name, or null for none. */
  readonly label?: string | null;
  /** The full new tag list, replacing the current one. */
  readonly tags?: readonly string[];
  /** Flags to change; the others keep their current values. */
  readonly flags?: Partial<EntityFlags>;
  /** Changes to the node's metadata. */
  readonly metadata?: MetadataPatch;
}

/**
 * Moves a node to another parent, or makes it a root. Rejected with `INVALID_INPUT` when the new
 * parent is the node or one of its descendants, or when the kept world placement cannot be
 * expressed under the new parent; with `LOCKED` for a `user` change of a locked node.
 */
export interface ReparentNodeCommand {
  /** The discriminant that selects this command. */
  readonly type: 'node.reparent';
  /** The node to move. */
  readonly id: Id;
  /** Null makes the node a root. */
  readonly parentId: Id | null;
  /** Which placement the node keeps. */
  readonly keep?: KeepMode;
  /** Position among the new parent's children. Omitted: last. */
  readonly index?: number;
}

/** Moves a node among its siblings. It changes presentation order only, so locks do not apply. */
export interface ReorderNodeCommand {
  /** The discriminant that selects this command. */
  readonly type: 'node.reorder';
  /** The node to move. */
  readonly id: Id;
  /** New position among its siblings, 0 being the back: an integer up to the number of others. */
  readonly index: number;
}

/**
 * Copies a node and its active descendants, with their surfaces, as a new subtree placed last
 * among its parent's children. Copies are active and keep every other field of their originals;
 * their IDs are reported in the result's `createdIds`.
 */
export interface DuplicateNodeCommand {
  /** The discriminant that selects this command. */
  readonly type: 'node.duplicate';
  /** The active node whose subtree is copied. Archived descendants are not copied. */
  readonly id: Id;
  /**
   * IDs for the copies, keyed by source node or surface ID. Unlisted copies get generated IDs.
   * A key outside the copied subtree, an ID already in use or the same ID twice is rejected
   * with `INVALID_INPUT`.
   */
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

/**
 * Archives an active node: it keeps its ID and layout, but it and its subtree leave the active
 * scene, the selection and the focus. Rejected with `INVALID_INPUT` when the node is already
 * archived, and with `LOCKED` for a `user` change of a locked node.
 */
export interface ArchiveNodeCommand {
  /** The discriminant that selects this command. */
  readonly type: 'node.archive';
  /** The node to archive. */
  readonly id: Id;
}

/**
 * Returns an archived node to the active scene. Rejected with `INVALID_INPUT` when the node is
 * active, and with `LOCKED` for a `user` change of a locked node.
 */
export interface RestoreArchivedNodeCommand {
  /** The discriminant that selects this command. */
  readonly type: 'node.restoreArchived';
  /** The archived node to restore. */
  readonly id: Id;
}

/**
 * Removes the node (and, by mode, its descendants) with all of their surface associations. A
 * `user` deletion is refused with `LOCKED` when the node, or in `subtree` mode any descendant, is
 * locked. Removed nodes leave the selection and focus; a removed orbit root leaves none.
 */
export interface DeleteNodeCommand {
  /** The discriminant that selects this command. */
  readonly type: 'node.delete';
  /** The node to delete. */
  readonly id: Id;
  /** How its children are handled; required. */
  readonly mode: DeleteMode;
}

/**
 * Gathers nodes under a new group node, which takes the place of the backmost member among the
 * shared parent's children (or goes last). At least one member is needed; members must be
 * distinct, and unlocked for a `user` change. The group has the default flags, no tags and no
 * metadata.
 */
export interface GroupNodesCommand {
  /** The discriminant that selects this command. */
  readonly type: 'node.group';
  /** Nodes to gather; none may contain another. They keep their world placement. */
  readonly nodeIds: readonly Id[];
  /** How to make the group node. Omitted: every field takes its default. */
  readonly group?: {
    /** An unused ID for the group. Omitted: generated. */
    readonly id?: Id;
    /** Omitted: `group`. */
    readonly kind?: string;
    /** The group's display name. Omitted: null, none. */
    readonly label?: string | null;
    /**
     * Omitted: the members' common parent, which they must then share. Given: a node that is not
     * inside any member, or null for a root group.
     */
    readonly parentId?: Id | null;
    /**
     * Omitted together with `bounds`: the group sits at the centre of its members' combined box,
     * axis-aligned with its parent, and its bounds are that box.
     */
    readonly transform?: Transform3D;
    /** Omitted: the smallest bounds centred on the group's origin that contain every member. */
    readonly bounds?: Vec3;
  };
}

/**
 * Dissolves a node. Its children move to its parent at its position, keeping world placement;
 * the node and its own surface associations are removed. Any node can be ungrouped, whatever its
 * kind.
 */
export interface UngroupNodeCommand {
  /** The discriminant that selects this command. */
  readonly type: 'node.ungroup';
  /** The node to dissolve: its children move to its parent, keeping world placement. */
  readonly id: Id;
}

/**
 * Replaces the selection. Every ID must name a distinct, existing node that is active, visible and
 * selectable with its ancestors; otherwise `INVALID_INPUT` (or `UNKNOWN_ENTITY`) names it.
 */
export interface SetSelectionCommand {
  /** The discriminant that selects this command. */
  readonly type: 'selection.set';
  /** The new selection in selection order; empty clears it. */
  readonly ids: readonly Id[];
}

/** Sets or clears the focused node, which must be active, visible and selectable. */
export interface SetFocusCommand {
  /** The discriminant that selects this command. */
  readonly type: 'focus.set';
  /** The node to focus, or null for none. */
  readonly id: Id | null;
}

/** Associates a host presentation endpoint with a place on a node. */
export interface AttachSurfaceCommand {
  /** The discriminant that selects this command. */
  readonly type: 'surface.attach';
  /** The surface to attach. */
  readonly surface: SurfaceSpec;
}

/**
 * Changes fields of an existing surface; omitted fields are kept. A locked surface refuses a
 * `user` change of its transform or bounds with `LOCKED`. New bounds must still fit its geometry,
 * which is checked again (`INVALID_INPUT` under `bounds`).
 */
export interface PatchSurfaceCommand {
  /** The discriminant that selects this command. */
  readonly type: 'surface.patch';
  /** The surface to change. */
  readonly id: Id;
  /** The new placement relative to the owner node. */
  readonly transform?: Transform3D;
  /** The new extent: three positive, finite numbers. */
  readonly bounds?: Vec3;
  /** The new geometry, checked against the bounds the surface has after this command. */
  readonly geometry?: GeometryDescriptor;
  /** Whether input over the surface is meant for its content. */
  readonly interaction?: InteractionRegion;
  /** Flags to change; the others keep their current values. */
  readonly flags?: Partial<EntityFlags>;
  /** The new display name, or null for none. */
  readonly label?: string | null;
  /** Changes to the surface's metadata. */
  readonly metadata?: MetadataPatch;
}

/**
 * Moves a surface to another node, last among its surfaces unless `index` says otherwise. A
 * locked surface refuses a `user` move with `LOCKED`.
 */
export interface MoveSurfaceCommand {
  /** The discriminant that selects this command. */
  readonly type: 'surface.move';
  /** The surface to move. */
  readonly id: Id;
  /** The node to move it to; it must exist. */
  readonly ownerNodeId: Id;
  /**
   * Which placement the surface keeps. Keeping `world` is rejected with `INVALID_INPUT` when the
   * new owner's placement cannot express it.
   */
  readonly keep?: KeepMode;
  /** Position among the new owner's surfaces. Omitted: last. */
  readonly index?: number;
}

/** Moves a surface among its owner's surfaces. It changes presentation order only. */
export interface ReorderSurfaceCommand {
  /** The discriminant that selects this command. */
  readonly type: 'surface.reorder';
  /** The surface to move. */
  readonly id: Id;
  /**
   * New position among its owner's surfaces, 0 being the back: an integer up to the number of
   * others.
   */
  readonly index: number;
}

/** Points the surface at another endpoint, keeping its ID, placement and order. */
export interface RebindSurfaceCommand {
  /** The discriminant that selects this command. */
  readonly type: 'surface.rebind';
  /** The surface to rebind. */
  readonly id: Id;
  /** The new key, a non-blank string, or null for none. Required, even when null. */
  readonly bindingKey: string | null;
  /** Omitted: the surface's current adapter type. */
  readonly adapterTypeId?: string;
}

/**
 * Removes the association. The endpoint itself is the host's and is left as it is. A locked
 * surface refuses a `user` detach with `LOCKED`.
 */
export interface DetachSurfaceCommand {
  /** The discriminant that selects this command. */
  readonly type: 'surface.detach';
  /** The surface to detach. */
  readonly id: Id;
}

/**
 * Describes a camera to create. Omitted fields take the documented defaults; a field the spec
 * does not define is rejected with `INVALID_INPUT` naming it.
 */
export interface CameraSpec {
  /** Omitted: the workspace's ID generator supplies one. */
  readonly id?: Id;
  /** Where the camera is, in world coordinates; finite. Omitted: the world origin. */
  readonly position?: Vec3;
  /**
   * A unit quaternion within 1e-6 of unit length, stored renormalised. Omitted: identity, looking
   * along -Z with +Y up.
   */
  readonly rotation?: Quat;
  /** Nearest distance shown, in world units; positive and finite. Omitted: 0.05. */
  readonly near?: number;
  /** Farthest distance shown, greater than `near`. Omitted: null, no limit. */
  readonly far?: number | null;
  /** A display name. Omitted: null, none. */
  readonly label?: string | null;
  /** Namespaced descriptive data, copied and frozen. Omitted: empty. */
  readonly metadata?: Metadata;
}

/** Creates a camera. Cameras are view state: undo and redo leave them as they are. */
export interface CreateCameraCommand {
  /** The discriminant that selects this command. */
  readonly type: 'camera.create';
  /** The camera to create. */
  readonly camera: CameraSpec;
}

/**
 * Changes fields of an existing camera; omitted fields are kept. `far` must stay greater than
 * `near`: a `near` that reaches the kept `far` is rejected at `near`.
 */
export interface PatchCameraCommand {
  /** The discriminant that selects this command. */
  readonly type: 'camera.patch';
  /** The camera to change. */
  readonly id: Id;
  /** The new position, in world coordinates. */
  readonly position?: Vec3;
  /** The new rotation: a unit quaternion within 1e-6 of unit length, stored renormalised. */
  readonly rotation?: Quat;
  /** The new near distance: positive and finite. */
  readonly near?: number;
  /** The new far distance, greater than `near`, or null for no limit. */
  readonly far?: number | null;
  /** The new display name, or null for none. */
  readonly label?: string | null;
  /** Changes to the camera's metadata. */
  readonly metadata?: MetadataPatch;
}

/** Removes a camera no viewport uses. */
export interface DeleteCameraCommand {
  /** The discriminant that selects this command. */
  readonly type: 'camera.delete';
  /** The camera to delete; one a viewport still uses is rejected with `INVALID_INPUT`. */
  readonly id: Id;
}

/**
 * Describes a viewport to create. Omitted fields take the documented defaults; a field the spec
 * does not define is rejected with `INVALID_INPUT` naming it.
 */
export interface ViewportSpec {
  /** Omitted: the workspace's ID generator supplies one. */
  readonly id?: Id;
  /** The camera to look through; it must exist (`UNKNOWN_ENTITY`). */
  readonly cameraId: Id;
  /** A registered projection kind and a configuration it accepts. */
  readonly projection: ProjectionSetting;
  /** Omitted: `panorama`. */
  readonly mode?: string;
  /** Width and height in CSS pixels and device pixels per CSS pixel, all positive and finite. */
  readonly size: ViewportRecord['size'];
  /** Omitted: `camera`. */
  readonly navigation?: NavigationTarget;
  /** A preferred renderer, as a versioned ID. Omitted or null: the host's default. */
  readonly renderer?: string | null;
  /** A preferred compositor, as a versioned ID. Omitted or null: the host's default. */
  readonly compositor?: string | null;
  /** A display name. Omitted: null, none. */
  readonly label?: string | null;
  /** Namespaced descriptive data, copied and frozen. Omitted: empty. */
  readonly metadata?: Metadata;
}

/** Creates a viewport. Viewports are view state: undo and redo leave them as they are. */
export interface CreateViewportCommand {
  /** The discriminant that selects this command. */
  readonly type: 'viewport.create';
  /** The viewport to create. */
  readonly viewport: ViewportSpec;
}

/** Changes fields of an existing viewport, validated as in a spec; omitted fields are kept. */
export interface PatchViewportCommand {
  /** The discriminant that selects this command. */
  readonly type: 'viewport.patch';
  /** The viewport to change. */
  readonly id: Id;
  /** Another existing camera to look through. */
  readonly cameraId?: Id;
  /** The new projection: a registered kind and a configuration it accepts. */
  readonly projection?: ProjectionSetting;
  /** The new presentation mode: a non-blank string. */
  readonly mode?: string;
  /** The new size, all three fields given. */
  readonly size?: ViewportRecord['size'];
  /** What a drag on the background turns. */
  readonly navigation?: NavigationTarget;
  /** The preferred renderer, as a versioned ID, or null for the host's default. */
  readonly renderer?: string | null;
  /** The preferred compositor, as a versioned ID, or null for the host's default. */
  readonly compositor?: string | null;
  /** The new display name, or null for none. */
  readonly label?: string | null;
  /** Changes to the viewport's metadata. */
  readonly metadata?: MetadataPatch;
}

/** Removes a viewport. Its camera is kept. */
export interface DeleteViewportCommand {
  /** The discriminant that selects this command. */
  readonly type: 'viewport.delete';
  /** The viewport to delete. */
  readonly id: Id;
}

/** Designates the node that workspace orbit rotates, or none. */
export interface SetOrbitRootCommand {
  /** The discriminant that selects this command. */
  readonly type: 'orbitRoot.set';
  /** An existing node, archived or not, or null for none. */
  readonly nodeId: Id | null;
}

/**
 * A scene command. A transaction applies a list of them atomically, each against the scene as the
 * earlier ones left it; constraints then resolve the placements they proposed. Commands are
 * checked at run time as well as by type: a malformed field fails the transaction with
 * `INVALID_INPUT` and a path such as `commands[1].node.bounds`. Only changes to nodes, surfaces
 * and the root order are recorded for undo; camera, viewport, selection, focus and orbit-root
 * changes are view state and are not.
 */
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
  | DetachSurfaceCommand
  | CreateCameraCommand
  | PatchCameraCommand
  | DeleteCameraCommand
  | CreateViewportCommand
  | PatchViewportCommand
  | DeleteViewportCommand
  | SetOrbitRootCommand;

/** The `type` of a scene command, such as `node.create`. */
export type SceneCommandType = SceneCommand['type'];

/** What a committed revision did: the scene commands it applied, or a restore of a snapshot. */
export type OperationType = SceneCommandType | 'scene.restore';

/** Every scene command type, in a fixed order. The array is frozen. */
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
  'camera.create',
  'camera.patch',
  'camera.delete',
  'viewport.create',
  'viewport.patch',
  'viewport.delete',
  'orbitRoot.set',
]);
