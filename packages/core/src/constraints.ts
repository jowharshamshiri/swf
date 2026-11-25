import type { Mat4, Transform3D, Vec3 } from '@swf/math';
import {
  aabbExpand,
  aabbIntersects,
  aabbOfBox,
  distance,
  mat4Decompose,
  mat4FromTransform,
  mat4InvertAffine,
  mat4Multiply,
  mat4TransformPoint,
  quatInvert,
  quatLookRotation,
  quatMultiply,
  quatNormalize,
  quatSameRotation,
  sub,
  transformApproxEquals,
  transformIssue,
} from '@swf/math';
import type { NodeRecord } from './model.js';
import { isSelfOrAncestor, worldMatrix } from './query.js';
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
export type ConstraintOutcome =
  | {
      /** The placement is allowed, as given or adjusted. */
      readonly kind: 'accept';
      /**
       * The local transform the constraint allows: the proposal itself, or an adjusted one. It
       * must be a valid transform (finite, unit rotation, positive scale).
       */
      readonly transform: Transform3D;
    }
  | {
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
  /** Which nodes the constraint governs. Omitted: every node. */
  appliesTo?(node: NodeRecord): boolean;
  /**
   * Decides one node's proposed placement. It runs synchronously inside the transaction and must
   * not change anything. A constraint that throws or accepts an invalid transform is treated as
   * defective, required or not: the transaction is rejected with `CONSTRAINT_REJECTED`.
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

function base(options: ConstraintOptions): Pick<Constraint, 'id' | 'order' | 'required'> & {
  appliesTo?: (node: NodeRecord) => boolean;
} {
  return {
    id: options.id,
    order: options.order ?? 0,
    required: options.required ?? true,
    ...(options.appliesTo === undefined ? {} : { appliesTo: options.appliesTo }),
  };
}

const accept = (transform: Transform3D): ConstraintOutcome => ({ kind: 'accept', transform });
const reject = (reason: string): ConstraintOutcome => ({ kind: 'reject', reason });

/** The node's world origin under the proposed transform. */
export function proposedWorldPosition(input: ConstraintInput): Vec3 {
  return mat4TransformPoint(input.parentWorld, input.transform.position);
}

/** The proposed transform with its origin moved to `world` (a world-space point). */
export function withWorldPosition(input: ConstraintInput, world: Vec3): ConstraintOutcome {
  const inverse = mat4InvertAffine(input.parentWorld);
  if (inverse === null) {
    return reject('the parent placement is singular');
  }
  return accept({ ...input.transform, position: mat4TransformPoint(inverse, world) });
}

/** A world axis, for {@link axisLockConstraint}. */
export type Axis = 'x' | 'y' | 'z';

const AXIS_INDEX: Readonly<Record<Axis, 0 | 1 | 2>> = { x: 0, y: 1, z: 2 };

/**
 * Keeps the node's world origin inside the box `min`..`max` (world coordinates, `min` not above
 * `max` on any axis), clamping it there.
 */
export function worldBoundsConstraint(
  options: ConstraintOptions & { readonly min: Vec3; readonly max: Vec3 },
): Constraint {
  const { min, max } = options;
  return {
    ...base(options),
    resolve(input) {
      const p = proposedWorldPosition(input);
      const clamped: Vec3 = [
        Math.min(Math.max(p[0], min[0]), max[0]),
        Math.min(Math.max(p[1], min[1]), max[1]),
        Math.min(Math.max(p[2], min[2]), max[2]),
      ];
      return clamped.every((v, i) => v === p[i])
        ? accept(input.transform)
        : withWorldPosition(input, clamped);
    },
  };
}

/**
 * Prevents movement of the node's world origin along the given world axes: an existing node keeps
 * its committed coordinate on each; a node being created is placed freely.
 */
export function axisLockConstraint(
  options: ConstraintOptions & { readonly axes: readonly Axis[] },
): Constraint {
  return {
    ...base(options),
    resolve(input) {
      const committed = worldMatrix(input.committedNodes, input.node.id);
      if (committed === undefined) {
        return accept(input.transform);
      }
      const origin = mat4TransformPoint(committed, [0, 0, 0]);
      const p: [number, number, number] = [...proposedWorldPosition(input)];
      let changed = false;
      for (const axis of options.axes) {
        const i = AXIS_INDEX[axis];
        if (p[i] !== origin[i]) {
          p[i] = origin[i];
          changed = true;
        }
      }
      return changed ? withWorldPosition(input, p) : accept(input.transform);
    },
  };
}

/**
 * Keeps the node's world origin between `min` and `max` world units from `center`, moving it
 * radially. Rejects a placement exactly at the centre when `min` is above 0, since no direction
 * leads out of it.
 */
export function distanceConstraint(
  options: ConstraintOptions & {
    readonly center: Vec3;
    readonly min: number;
    readonly max: number;
  },
): Constraint {
  const { center, min, max } = options;
  return {
    ...base(options),
    resolve(input) {
      const p = proposedWorldPosition(input);
      const d = distance(p, center);
      if (d >= min && d <= max) {
        return accept(input.transform);
      }
      if (d === 0) {
        return reject(`the origin is at the centre, so no direction reaches distance ${min}`);
      }
      const target = d < min ? min : max;
      const offset = sub(p, center);
      const k = target / d;
      return withWorldPosition(input, [
        center[0] + offset[0] * k,
        center[1] + offset[1] * k,
        center[2] + offset[2] * k,
      ]);
    },
  };
}

/**
 * Snaps the node's world origin to a grid of spacing `step` (world units, non-zero) through
 * `origin` (default the world origin).
 */
export function gridSnapConstraint(
  options: ConstraintOptions & { readonly step: number; readonly origin?: Vec3 },
): Constraint {
  const { step } = options;
  const origin = options.origin ?? [0, 0, 0];
  const snap = (v: number, o: number) => o + Math.round((v - o) / step) * step;
  return {
    ...base(options),
    resolve(input) {
      const p = proposedWorldPosition(input);
      const snapped: Vec3 = [snap(p[0], origin[0]), snap(p[1], origin[1]), snap(p[2], origin[2])];
      return snapped.every((v, i) => Math.abs(v - (p[i] ?? NaN)) <= 1e-12)
        ? accept(input.transform)
        : withWorldPosition(input, snapped);
    },
  };
}

/**
 * Turns the node so its front (local +Z) faces `point`, upright against `up` (default +Y). Rejects
 * when the node sits on the point or straight above or below it, or when its parent's placement
 * cannot express the required world rotation.
 */
export function facePointConstraint(
  options: ConstraintOptions & { readonly point: Vec3; readonly up?: Vec3 },
): Constraint {
  const up = options.up ?? [0, 1, 0];
  return {
    ...base(options),
    resolve(input) {
      const p = proposedWorldPosition(input);
      let worldRotation;
      try {
        worldRotation = quatLookRotation(sub(options.point, p), up);
      } catch {
        return reject('the facing direction is undefined at this position');
      }
      const parent = mat4Decompose(input.parentWorld);
      if (!parent.ok) {
        return reject(`the parent placement cannot be decomposed (${parent.reason})`);
      }
      const rotation = quatNormalize(
        quatMultiply(quatInvert(parent.transform.rotation), worldRotation),
      );
      const proposal = { ...input.transform, rotation };
      const world = mat4Decompose(mat4Multiply(input.parentWorld, mat4FromTransform(proposal)));
      if (!world.ok || !quatSameRotation(world.transform.rotation, worldRotation, 1e-9)) {
        return reject('the parent scale distorts the facing rotation');
      }
      return quatSameRotation(rotation, input.transform.rotation, 1e-12)
        ? accept(input.transform)
        : accept(proposal);
    },
  };
}

/**
 * Keeps at least `padding` world units between the node's world box and the boxes of the other
 * active nodes it applies to (its ancestors and descendants excepted). It only validates: an
 * overlapping placement is rejected, not moved.
 */
export function collisionSpacingConstraint(
  options: ConstraintOptions & { readonly padding: number },
): Constraint {
  return {
    ...base(options),
    resolve(input) {
      const world = mat4Multiply(input.parentWorld, mat4FromTransform(input.transform));
      const box = aabbExpand(aabbOfBox(world, input.node.bounds), options.padding);
      for (const other of input.nodes.values()) {
        if (
          other.status !== 'active' ||
          isSelfOrAncestor(input.nodes, other.id, input.node.id) ||
          isSelfOrAncestor(input.nodes, input.node.id, other.id) ||
          (options.appliesTo !== undefined && !options.appliesTo(other))
        ) {
          continue;
        }
        const otherWorld = worldMatrix(input.nodes, other.id);
        if (otherWorld !== undefined && aabbIntersects(box, aabbOfBox(otherWorld, other.bounds))) {
          return reject(`it would come within ${options.padding} of node "${other.id}"`);
        }
      }
      return accept(input.transform);
    },
  };
}

/** Orders constraints by `order`, then ID. */
export function sortConstraints(constraints: Iterable<Constraint>): Constraint[] {
  return [...constraints].sort(
    (a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export type ResolveResult =
  | { readonly ok: true; readonly transform: Transform3D }
  | { readonly ok: false; readonly constraintId: string; readonly reason: string };

type Attempt = { ok: true; outcome: ConstraintOutcome } | { ok: false; reason: string };

function attempt(constraint: Constraint, input: ConstraintInput): Attempt {
  let outcome: ConstraintOutcome;
  try {
    outcome = constraint.resolve(input);
  } catch (error) {
    return {
      ok: false,
      reason: `it threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (outcome.kind === 'accept') {
    const issue = transformIssue(outcome.transform);
    if (issue !== null) {
      return { ok: false, reason: `it produced an invalid transform: ${issue}` };
    }
  }
  return { ok: true, outcome };
}

/**
 * Resolves one node's proposed transform through `constraints` (already sorted and filtered to the
 * node). Required constraints adjust or reject; optional ones apply only when the required ones
 * still accept the result unchanged. Finally every required constraint must accept the outcome
 * unchanged, or the placement is rejected as unsatisfiable.
 */
export function resolveConstraints(
  constraints: readonly Constraint[],
  input: Omit<ConstraintInput, 'transform'>,
  proposal: Transform3D,
): ResolveResult {
  const required = constraints.filter((c) => c.required);
  const holds = (c: Constraint, transform: Transform3D): boolean => {
    const result = attempt(c, { ...input, transform });
    return (
      result.ok &&
      result.outcome.kind === 'accept' &&
      transformApproxEquals(result.outcome.transform, transform)
    );
  };
  let transform = proposal;
  for (const constraint of constraints) {
    const result = attempt(constraint, { ...input, transform });
    if (!result.ok) {
      // A constraint that throws or returns an invalid transform is defective, whether it is
      // required or optional; the placement is rejected rather than resolved without it.
      return { ok: false, constraintId: constraint.id, reason: result.reason };
    }
    if (result.outcome.kind === 'reject') {
      if (constraint.required) {
        return { ok: false, constraintId: constraint.id, reason: result.outcome.reason };
      }
      continue;
    }
    const candidate = result.outcome.transform;
    if (constraint.required || required.every((c) => holds(c, candidate))) {
      transform = candidate;
    }
  }
  const broken = required.find((c) => !holds(c, transform));
  if (broken !== undefined) {
    return {
      ok: false,
      constraintId: broken.id,
      reason: 'the required constraints cannot all be satisfied together',
    };
  }
  return { ok: true, transform };
}
