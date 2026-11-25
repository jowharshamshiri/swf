import type { Quat, Transform3D, Vec3 } from '@swf/math';
import type { GeometryDescriptor } from './geometry.js';
import type { JsonValue, Metadata } from './json.js';
import type { Table } from './table.js';

/**
 * An entity identifier, unique within one workspace across nodes, surfaces, cameras and viewports
 * (archived records included).
 */
export type Id = string;

/**
 * Orthogonal flags of a node or a surface. `locked` blocks operator-originated (`user`) spatial
 * changes only; host transactions still apply.
 */
export interface EntityFlags {
  /**
   * Whether it is shown. A hidden node hides its descendants and surfaces, and cannot be
   * selected.
   */
  readonly visible: boolean;
  /** Whether it can be selected or focused; a node is selectable only when its ancestors are. */
  readonly selectable: boolean;
  /** Whether interaction may move it by dragging. The scene itself does not enforce it. */
  readonly draggable: boolean;
  /** Whether interaction may resize it. The scene itself does not enforce it. */
  readonly resizable: boolean;
  /** Whether interaction may rotate it. The scene itself does not enforce it. */
  readonly rotatable: boolean;
  /** Whether it receives pointer input. The scene itself does not enforce it. */
  readonly pointerEnabled: boolean;
  /**
   * Whether operator (`user`) transactions are refused with `LOCKED` when they would move,
   * resize, reparent, group, ungroup, archive, restore or delete it (or, for a surface, move,
   * resize or detach it). Other sources are not held back.
   */
  readonly locked: boolean;
  /** Higher values present and pick first among otherwise equal candidates. */
  readonly presentationPriority: number;
}

/**
 * The flags an entity has unless its spec says otherwise: everything enabled, unlocked, priority
 * 0. The object is frozen.
 */
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
 * created by `node.group` is a node of kind `group`. Any node can hold surfaces. Records are
 * frozen; a change produces a new record.
 */
export interface NodeRecord {
  /** Unique within the workspace across every kind of entity. */
  readonly id: Id;
  /** Free-form, non-blank kind, such as `window` or `group`; the scene gives it no meaning. */
  readonly kind: string;
  /** The parent node, or null for a root. */
  readonly parentId: Id | null;
  /** Children in presentation order (later children are in front among equals). */
  readonly childIds: readonly Id[];
  /** The node's surface slots in presentation order (later surfaces are in front). */
  readonly surfaceIds: readonly Id[];
  /** Placement relative to the parent (or the world, for a root). */
  readonly transform: Transform3D;
  /** Extent of the node's local box, centred on its local origin, before scale. */
  readonly bounds: Vec3;
  /** The node's own flags; {@link effectiveState} combines them with its ancestors'. */
  readonly flags: EntityFlags;
  /** A display name, or null for none. */
  readonly label: string | null;
  /** Distinct, non-blank tags in the order they were given. */
  readonly tags: readonly string[];
  /** Namespaced descriptive data; never interpreted by the scene. */
  readonly metadata: Metadata;
  /**
   * Whether the node is part of the active scene. Archiving a node also deactivates its
   * subtree.
   */
  readonly status: NodeStatus;
  /** When the node was created, by the workspace's clock, in milliseconds. */
  readonly createdAt: number;
  /**
   * When the record last changed, by the workspace's clock, in milliseconds. Changes to its
   * children or surfaces count.
   */
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
 * Records are frozen; a change produces a new record.
 */
export interface SurfaceRecord {
  /** Unique within the workspace across every kind of entity. */
  readonly id: Id;
  /** The node that holds the surface; it lists the surface in its `surfaceIds`. */
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
  /**
   * The presented shape, accepted by its kind's provider for these bounds whenever either was
   * set. A kind unregistered since resolves to the surface rectangle.
   */
  readonly geometry: GeometryDescriptor;
  /** Whether input over the surface is meant for its content. */
  readonly interaction: InteractionRegion;
  /** The surface's own flags; {@link surfaceEffectiveState} combines them with its owner's. */
  readonly flags: EntityFlags;
  /** A display name, or null for none. */
  readonly label: string | null;
  /** Namespaced descriptive data; never interpreted by the scene. */
  readonly metadata: Metadata;
  /** When the surface was attached, by the workspace's clock, in milliseconds. */
  readonly createdAt: number;
  /** When the record last changed, by the workspace's clock, in milliseconds. */
  readonly updatedAt: number;
}

/**
 * A viewpoint: where a viewport looks from and which way. It is view state, independent of every
 * spatial entity: moving a camera never moves anything in the scene.
 */
export interface CameraRecord {
  /** Unique within the workspace across every kind of entity. */
  readonly id: Id;
  /** Where the camera is, in world coordinates. */
  readonly position: Vec3;
  /** Rotation of the camera; with none, it looks along -Z with +Y up. */
  readonly rotation: Quat;
  /** Nearest distance shown, in world units; positive. */
  readonly near: number;
  /** Farthest distance shown, or null for no limit. */
  readonly far: number | null;
  /** A display name, or null for none. */
  readonly label: string | null;
  /** Namespaced descriptive data; never interpreted by the scene. */
  readonly metadata: Metadata;
  /** When the camera was created, by the workspace's clock, in milliseconds. */
  readonly createdAt: number;
  /** When the record last changed, by the workspace's clock, in milliseconds. */
  readonly updatedAt: number;
}

/** A viewport's projection: a registered projection kind and its JSON configuration. */
export interface ProjectionSetting {
  /** The projection kind's versioned ID, such as `equirectangular/1`. */
  readonly id: string;
  /**
   * The configuration, accepted by the kind's `configIssue` when it was set; null when the kind
   * takes none. A frozen copy.
   */
  readonly config: JsonValue;
}

/** What a drag on a viewport's background turns: its camera, or the workspace orbit root. */
export type NavigationTarget = 'camera' | 'orbit';

/**
 * One view into the scene: a camera, a projection, a presentation mode, preferred backends and a
 * size. Several viewports share one scene; none of their settings is spatial truth.
 */
export interface ViewportRecord {
  /** Unique within the workspace across every kind of entity. */
  readonly id: Id;
  /** The camera the viewport looks through; it exists for as long as the viewport uses it. */
  readonly cameraId: Id;
  /** How the viewport maps the scene onto its area. */
  readonly projection: ProjectionSetting;
  /** The presentation mode, such as `panorama`, `focus`, `map` or `overview`. */
  readonly mode: string;
  /** Size in CSS pixels and device pixels per CSS pixel. */
  readonly size: {
    /** Width in CSS pixels; positive and finite. */
    readonly width: number;
    /** Height in CSS pixels; positive and finite. */
    readonly height: number;
    /** Device pixels per CSS pixel; positive and finite. */
    readonly devicePixelRatio: number;
  };
  /** What a drag on the viewport's background turns. */
  readonly navigation: NavigationTarget;
  /** Preferred renderer and compositor, by versioned ID, or null for the host's default. */
  readonly renderer: string | null;
  /** Preferred compositor, by versioned ID, or null for the host's default. */
  readonly compositor: string | null;
  /** A display name, or null for none. */
  readonly label: string | null;
  /** Namespaced descriptive data; never interpreted by the scene. */
  readonly metadata: Metadata;
  /** When the viewport was created, by the workspace's clock, in milliseconds. */
  readonly createdAt: number;
  /** When the record last changed, by the workspace's clock, in milliseconds. */
  readonly updatedAt: number;
}

/**
 * One immutable state of a workspace's scene. A new object is produced by every commit; holding
 * one keeps that state readable for as long as it is held, and it never changes.
 */
export interface SceneState {
  /** The workspace the state belongs to. */
  readonly workspaceId: Id;
  /** Increments by one on every commit; the authority for conflict detection. */
  readonly revision: number;
  /** Root nodes in presentation order. */
  readonly rootIds: readonly Id[];
  /** Every node, archived ones included, in the order they were added. */
  readonly nodes: Table<NodeRecord>;
  /** Every surface association, in the order they were added. */
  readonly surfaces: Table<SurfaceRecord>;
  /** Every camera, in the order they were added. */
  readonly cameras: Table<CameraRecord>;
  /** Every viewport, in the order they were added. */
  readonly viewports: Table<ViewportRecord>;
  /**
   * The node that workspace orbit rotates, or null. Orbiting changes that node's transform as an
   * ordinary, undoable transaction; it never touches a camera.
   */
  readonly orbitRootId: Id | null;
  /** Selected nodes in selection order. Only active, selectable nodes can be selected. */
  readonly selection: readonly Id[];
  /**
   * The focused node, or null. Only an active, visible, selectable node can be focused; a commit
   * that archives, hides or removes it clears the focus.
   */
  readonly focusedId: Id | null;
}
