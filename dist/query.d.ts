import type { Aabb, DecomposeResult, Mat4, Ray } from '@swf/math';
import type { ResolvedGeometry } from './geometry.js';
import { GeometryRegistry } from './geometry.js';
import type { Id, NodeRecord, SceneState } from './model.js';
import type { RecordLookup } from './table.js';
/**
 * Read access to nodes by ID: a scene's `nodes` table, or a constraint's view of the nodes as
 * they stand in a transaction.
 */
export type NodeLookup = RecordLookup<NodeRecord>;
/**
 * The surface's local-to-world matrix: its owner's world matrix times its own transform.
 * Undefined for an unknown surface.
 */
export declare function surfaceWorldMatrix(state: SceneState, surfaceId: Id): Mat4 | undefined;
/**
 * A surface's status and flags after inheriting from its owner node: it is active and visible
 * only when its owner is, and selectable only when it and its owner are.
 */
export declare function surfaceEffectiveState(state: SceneState, surfaceId: Id): EffectiveState | undefined;
/**
 * The surface's presentation geometry placed in the world, as rendering and picking must both use
 * it, with its fidelity. Undefined for an unknown surface.
 */
export declare function surfaceGeometry(state: SceneState, surfaceId: Id, registry: GeometryRegistry): ResolvedGeometry | undefined;
/**
 * A node's frame placed in the world: its bounds rectangle in its local z = 0 plane, as picking
 * of window frames and rendering of window chrome both use it. The result's `surfaceId` field
 * holds the node's ID. Undefined for an unknown node.
 */
export declare function nodeFrameGeometry(state: SceneState, nodeId: Id): ResolvedGeometry | undefined;
/**
 * The node's local-to-world matrix: the product of its ancestors' transforms and its own. Results
 * on committed (immutable) tables are cached, so the matrix returned may be shared and must not be
 * changed. Returns undefined for an unknown node, or one with an unknown ancestor.
 */
export declare function worldMatrix(nodes: NodeLookup, id: Id): Mat4 | undefined;
/** The world matrix of the node's parent: identity for a root, undefined for an unknown parent. */
export declare function parentWorldMatrix(nodes: NodeLookup, parentId: Id | null): Mat4 | undefined;
/**
 * The node's world placement as position, rotation and scale. Fails with `shear` when a rotated
 * ancestor with non-uniform scale makes the world placement inexpressible that way; the world
 * matrix is always available.
 */
export declare function worldTransform(nodes: NodeLookup, id: Id): DecomposeResult | undefined;
/**
 * The world-aligned box enclosing the node's bounds placed in the world. Undefined for an unknown
 * node.
 */
export declare function worldBounds(nodes: NodeLookup, id: Id): Aabb | undefined;
/**
 * The node's ancestors, nearest first; empty for a root or an unknown node. The array is new on
 * every call and the caller's. Throws an `Error` if the hierarchy contains a cycle, which
 * committed state never does: it means a defect, not an input to tolerate.
 */
export declare function ancestorIds(nodes: NodeLookup, id: Id): Id[];
/** True when `ancestorId` is `id` itself or one of its ancestors. */
export declare function isSelfOrAncestor(nodes: NodeLookup, ancestorId: Id, id: Id): boolean;
/**
 * The node's descendants in depth-first pre-order (children in presentation order), archived ones
 * included; empty for a leaf or an unknown node. The array is new on every call and the caller's.
 * Throws an `Error` if the hierarchy contains a cycle.
 */
export declare function descendantIds(nodes: NodeLookup, id: Id): Id[];
/** A node's status and flags after inheriting from its ancestors. */
export interface EffectiveState {
    /** The node and every ancestor are active (not archived). */
    readonly active: boolean;
    /** Active, and the node and every ancestor are visible. */
    readonly visible: boolean;
    /** Visible, and the node and every ancestor are selectable. */
    readonly selectable: boolean;
}
/**
 * The node's status and flags after inheriting from its ancestors: it is active only when it and
 * every ancestor are, visible only when also it and every ancestor are visible, and selectable
 * only when also visible and it and every ancestor are selectable. Undefined for an unknown node.
 * Throws an `Error` if the hierarchy contains a cycle, which committed state never does.
 */
export declare function effectiveState(nodes: NodeLookup, id: Id): EffectiveState | undefined;
/** Options of the spatial queries {@link nodesInBox} and {@link raycastBounds}. */
export interface SpatialQueryOptions {
    /** Include nodes that are not effectively visible (hidden or archived). Default false. */
    readonly includeHidden?: boolean;
}
/**
 * Nodes whose world bounds overlap `box` (world coordinates; boxes that only touch do not
 * overlap), in the order they were added to the scene. Only effectively visible nodes count unless
 * `includeHidden` is set.
 */
export declare function nodesInBox(state: SceneState, box: Aabb, options?: SpatialQueryOptions): Id[];
/** A node whose world bounds a ray passes through. */
export interface CoarseHit {
    /** The node hit. */
    readonly nodeId: Id;
    /**
     * Distance along the ray to where it enters the node's world bounds: the ray parameter, 0 when
     * the ray starts inside them.
     */
    readonly distance: number;
}
/**
 * Nodes whose world bounds the ray passes through: nearest first, then higher presentation
 * priority, then ID. This is a coarse, renderer-independent test; exact surface picking refines it.
 * Only hits in front of the ray's origin count, and only effectively visible nodes unless
 * `includeHidden` is set.
 */
export declare function raycastBounds(state: SceneState, r: Ray, options?: SpatialQueryOptions): CoarseHit[];
/**
 * What {@link findNodes} looks for. Every criterion given must hold; an empty query matches every
 * active node.
 */
export interface NodeQuery {
    /**
     * Case-insensitive, Unicode-normalized (NFKC) substring of the ID, the label, a tag, a value at
     * one of `metadataKeys`, or (with `groupPath`) an ancestor's label or ID.
     */
    readonly text?: string;
    /**
     * The host-exposed descriptive metadata the text also matches: keys namespaced as metadata keys
     * are (`host.<name>`, `ext.<id>.<name>`). Only string and number values are text; any other
     * metadata is never searched.
     */
    readonly metadataKeys?: readonly string[];
    /** The text also matches the labels and IDs of the node's ancestors: the groups it is in. */
    readonly groupPath?: boolean;
    /** Every listed tag must be present. */
    readonly tags?: readonly string[];
    /** The node's kind must be one of these. */
    readonly kinds?: readonly string[];
    /** Only nodes inside this node's subtree (not the node itself). */
    readonly within?: Id;
    /** Only nodes whose effective visibility, inherited from their ancestors, is this. */
    readonly visible?: boolean;
    /** Only nodes whose own lock flag is this. */
    readonly locked?: boolean;
    /** Include archived nodes. Default false. */
    readonly includeArchived?: boolean;
}
/**
 * Nodes matching descriptive metadata only, in scene order. Surface content is never consulted,
 * nor any metadata the query does not expose. Throws {@link SwfFailure} (`INVALID_INPUT`) for a
 * metadata key that is not namespaced, and (`UNKNOWN_ENTITY`) for a `within` node that does not
 * exist.
 */
export declare function findNodes(state: SceneState, query: NodeQuery): Id[];
/**
 * Unicode compatibility normalisation (NFKC) plus locale-independent lower-casing: how
 * {@link findNodes} compares text.
 */
export declare function fold(text: string): string;
//# sourceMappingURL=query.d.ts.map