import type { Mat4, Transform3D, Vec3 } from '@swf/math';
import type { NodeRecord } from './model.js';
import type { RecordLookup } from './table.js';
/** What a constraint sees when it resolves one node's proposed placement. */
export interface ConstraintInput {
    /** The node as it stands in the transaction, before this constraint. */
    readonly node: NodeRecord;
    /** The node as last committed, or undefined when the transaction creates it. */
    readonly previous: NodeRecord | undefined;
    /** The proposed local transform. */
    readonly transform: Transform3D;
    /** The world matrix of the node's parent in the transaction (identity for a root). */
    readonly parentWorld: Mat4;
    /** Every node as it stands in the transaction. */
    readonly nodes: RecordLookup<NodeRecord>;
    /** Every node as last committed. */
    readonly committedNodes: RecordLookup<NodeRecord>;
}
/** What a constraint decides about a proposed placement. */
export type ConstraintOutcome = {
    /** The placement is allowed, as given or adjusted. */
    readonly kind: 'accept';
    /**
     * The local transform the constraint allows: the proposal itself, or an adjusted one. It
     * must be a valid transform (finite, unit rotation, positive scale).
     */
    readonly transform: Transform3D;
} | {
    /** The placement is refused. */
    readonly kind: 'reject';
    /** Why, for the rejection's message. */
    readonly reason: string;
};
/**
 * A deterministic rule over proposed placements. `resolve` returns the placement it allows (the
 * same, or adjusted) or rejects it. It must be idempotent: resolving its own output accepts it
 * unchanged. A required constraint always holds after a commit; an optional one is a preference
 * applied only when every applicable required constraint still holds afterwards.
 */
export interface Constraint {
    /** A non-blank ID, unique among the workspace's constraints; rejections name it. */
    readonly id: string;
    /** Constraints resolve in ascending order, ties broken by ID. A finite number. */
    readonly order: number;
    /** Whether the constraint must hold after every commit, rather than being a preference. */
    readonly required: boolean;
    /**
     * Which nodes the constraint governs. Omitted: every node. It runs synchronously inside the
     * transaction and must not change anything. One that throws or answers anything but a boolean
     * makes the constraint defective, as `resolve` does.
     */
    appliesTo?(node: NodeRecord): boolean;
    /**
     * Decides one node's proposed placement. It runs synchronously inside the transaction, possibly
     * more than once for one placement, and must not change anything. A constraint whose `resolve`
     * or `appliesTo` throws, or answers what it may not (anything but an outcome, or an accepted
     * transform that is invalid), is treated as defective, required or not: the transaction is
     * rejected with `CONSTRAINT_REJECTED`, its message naming the constraint, the callback and what
     * it threw or answered, and the scene is left unchanged.
     */
    resolve(input: ConstraintInput): ConstraintOutcome;
}
/** Common settings of the built-in constraints. */
export interface ConstraintOptions {
    /** The constraint's ID: non-blank and unique among the workspace's constraints. */
    readonly id: string;
    /** Default 0. */
    readonly order?: number;
    /** Default true. */
    readonly required?: boolean;
    /**
     * Which nodes the constraint governs. Omitted: every node. {@link collisionSpacingConstraint}
     * also uses it to choose which other nodes to keep clear of.
     */
    readonly appliesTo?: (node: NodeRecord) => boolean;
}
/** The node's world origin under the proposed transform. */
export declare function proposedWorldPosition(input: ConstraintInput): Vec3;
/** The proposed transform with its origin moved to `world` (a world-space point). */
export declare function withWorldPosition(input: ConstraintInput, world: Vec3): ConstraintOutcome;
/** A world axis, for {@link axisLockConstraint}. */
export type Axis = 'x' | 'y' | 'z';
/**
 * Keeps the node's world origin inside the box `min`..`max` (world coordinates, `min` not above
 * `max` on any axis), clamping it there.
 */
export declare function worldBoundsConstraint(options: ConstraintOptions & {
    readonly min: Vec3;
    readonly max: Vec3;
}): Constraint;
/**
 * Prevents movement of the node's world origin along the given world axes: an existing node keeps
 * its committed coordinate on each; a node being created is placed freely.
 */
export declare function axisLockConstraint(options: ConstraintOptions & {
    readonly axes: readonly Axis[];
}): Constraint;
/**
 * Keeps the node's world origin between `min` and `max` world units from `center`, moving it
 * radially. Rejects a placement exactly at the centre when `min` is above 0, since no direction
 * leads out of it.
 */
export declare function distanceConstraint(options: ConstraintOptions & {
    readonly center: Vec3;
    readonly min: number;
    readonly max: number;
}): Constraint;
/**
 * Snaps the node's world origin to a grid of spacing `step` (world units, non-zero) through
 * `origin` (default the world origin).
 */
export declare function gridSnapConstraint(options: ConstraintOptions & {
    readonly step: number;
    readonly origin?: Vec3;
}): Constraint;
/**
 * Turns the node so its front (local +Z) faces `point`, upright against `up` (default +Y). Rejects
 * when the node sits on the point or straight above or below it, or when its parent's placement
 * cannot express the required world rotation.
 */
export declare function facePointConstraint(options: ConstraintOptions & {
    readonly point: Vec3;
    readonly up?: Vec3;
}): Constraint;
/**
 * Keeps at least `padding` world units between the node's world box and the boxes of the other
 * active nodes it applies to (its ancestors and descendants excepted). It only validates: an
 * overlapping placement is rejected, not moved.
 */
export declare function collisionSpacingConstraint(options: ConstraintOptions & {
    readonly padding: number;
}): Constraint;
/** Orders constraints by `order`, then ID. */
export declare function sortConstraints(constraints: Iterable<Constraint>): Constraint[];
export type ResolveResult = {
    readonly ok: true;
    readonly transform: Transform3D;
} | {
    readonly ok: false;
    readonly constraintId: string;
    readonly reason: string;
};
/** A constraint's callback that threw or answered what it may not: why, for the rejection. */
interface Defect {
    readonly ok: false;
    readonly reason: string;
}
/**
 * Whether `constraint` governs `node`: true when it has no `appliesTo`. An `appliesTo` that throws
 * or answers anything but a boolean is the constraint's defect, with the reason.
 */
export declare function constraintApplies(constraint: Constraint, node: NodeRecord): {
    readonly ok: true;
    readonly applies: boolean;
} | Defect;
/**
 * Resolves one node's proposed transform through `constraints` (already sorted and filtered to the
 * node). Required constraints adjust or reject; optional ones apply only when the required ones
 * still accept the result unchanged. Finally every required constraint must accept the outcome
 * unchanged, or the placement is rejected as unsatisfiable. A constraint whose `resolve` throws
 * or answers what it may not rejects the placement, naming it, whenever it is called.
 */
export declare function resolveConstraints(constraints: readonly Constraint[], input: Omit<ConstraintInput, 'transform'>, proposal: Transform3D): ResolveResult;
export {};
//# sourceMappingURL=constraints.d.ts.map