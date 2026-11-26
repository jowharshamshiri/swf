import { aabbExpand, aabbIntersects, aabbOfBox, distance, mat4Decompose, mat4FromTransform, mat4InvertAffine, mat4Multiply, mat4TransformPoint, quatInvert, quatLookRotation, quatMultiply, quatNormalize, quatSameRotation, sub, transformApproxEquals, transformIssue, } from '@swf/math';
import { thrownText } from './errors.js';
import { describeAnswer } from './json.js';
import { isSelfOrAncestor, worldMatrix } from './query.js';
function base(options) {
    return {
        id: options.id,
        order: options.order ?? 0,
        required: options.required ?? true,
        ...(options.appliesTo === undefined ? {} : { appliesTo: options.appliesTo }),
    };
}
const accept = (transform) => ({ kind: 'accept', transform });
const reject = (reason) => ({ kind: 'reject', reason });
/** The node's world origin under the proposed transform. */
export function proposedWorldPosition(input) {
    return mat4TransformPoint(input.parentWorld, input.transform.position);
}
/** The proposed transform with its origin moved to `world` (a world-space point). */
export function withWorldPosition(input, world) {
    const inverse = mat4InvertAffine(input.parentWorld);
    if (inverse === null) {
        return reject('the parent placement is singular');
    }
    return accept({ ...input.transform, position: mat4TransformPoint(inverse, world) });
}
const AXIS_INDEX = { x: 0, y: 1, z: 2 };
/**
 * Keeps the node's world origin inside the box `min`..`max` (world coordinates, `min` not above
 * `max` on any axis), clamping it there.
 */
export function worldBoundsConstraint(options) {
    const { min, max } = options;
    return {
        ...base(options),
        resolve(input) {
            const p = proposedWorldPosition(input);
            const clamped = [
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
export function axisLockConstraint(options) {
    return {
        ...base(options),
        resolve(input) {
            const committed = worldMatrix(input.committedNodes, input.node.id);
            if (committed === undefined) {
                return accept(input.transform);
            }
            const origin = mat4TransformPoint(committed, [0, 0, 0]);
            const p = [...proposedWorldPosition(input)];
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
export function distanceConstraint(options) {
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
export function gridSnapConstraint(options) {
    const { step } = options;
    const origin = options.origin ?? [0, 0, 0];
    const snap = (v, o) => o + Math.round((v - o) / step) * step;
    return {
        ...base(options),
        resolve(input) {
            const p = proposedWorldPosition(input);
            const snapped = [snap(p[0], origin[0]), snap(p[1], origin[1]), snap(p[2], origin[2])];
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
export function facePointConstraint(options) {
    const up = options.up ?? [0, 1, 0];
    return {
        ...base(options),
        resolve(input) {
            const p = proposedWorldPosition(input);
            let worldRotation;
            try {
                worldRotation = quatLookRotation(sub(options.point, p), up);
            }
            catch {
                return reject('the facing direction is undefined at this position');
            }
            const parent = mat4Decompose(input.parentWorld);
            if (!parent.ok) {
                return reject(`the parent placement cannot be decomposed (${parent.reason})`);
            }
            const rotation = quatNormalize(quatMultiply(quatInvert(parent.transform.rotation), worldRotation));
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
export function collisionSpacingConstraint(options) {
    return {
        ...base(options),
        resolve(input) {
            const world = mat4Multiply(input.parentWorld, mat4FromTransform(input.transform));
            const box = aabbExpand(aabbOfBox(world, input.node.bounds), options.padding);
            for (const other of input.nodes.values()) {
                if (other.status !== 'active' ||
                    isSelfOrAncestor(input.nodes, other.id, input.node.id) ||
                    isSelfOrAncestor(input.nodes, input.node.id, other.id) ||
                    (options.appliesTo !== undefined && !options.appliesTo(other))) {
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
export function sortConstraints(constraints) {
    return [...constraints].sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
/** Why `outcome` is not an outcome `resolve` may return, or null when it is one. */
function outcomeIssue(outcome) {
    if (typeof outcome !== 'object' || outcome === null) {
        return `returned ${describeAnswer(outcome)}, not an outcome`;
    }
    const { kind } = outcome;
    if (kind === 'reject') {
        const { reason } = outcome;
        return typeof reason === 'string'
            ? null
            : `returned a rejection whose reason is ${describeAnswer(reason)}, not text`;
    }
    if (kind !== 'accept') {
        return `returned an outcome of kind ${describeAnswer(kind)}, not "accept" or "reject"`;
    }
    const { transform } = outcome;
    if (typeof transform !== 'object' || transform === null) {
        return `accepted ${describeAnswer(transform)}, not a transform`;
    }
    for (const [field, length] of [
        ['position', 3],
        ['rotation', 4],
        ['scale', 3],
    ]) {
        const value = transform[field];
        if (!Array.isArray(value) || value.length !== length) {
            return `produced an invalid transform: ${field} must be an array of ${String(length)} numbers`;
        }
    }
    const issue = transformIssue(transform);
    return issue === null ? null : `produced an invalid transform: ${issue}`;
}
/** Runs `constraint.resolve`, reporting a throw or a malformed answer as the constraint's defect. */
function attempt(constraint, input) {
    let outcome;
    try {
        outcome = constraint.resolve(input);
    }
    catch (error) {
        return { ok: false, reason: `its resolve threw: ${thrownText(error)}` };
    }
    const issue = outcomeIssue(outcome);
    if (issue !== null) {
        return { ok: false, reason: `its resolve ${issue}` };
    }
    return { ok: true, outcome: outcome };
}
/**
 * Whether `constraint` governs `node`: true when it has no `appliesTo`. An `appliesTo` that throws
 * or answers anything but a boolean is the constraint's defect, with the reason.
 */
export function constraintApplies(constraint, node) {
    if (constraint.appliesTo === undefined) {
        return { ok: true, applies: true };
    }
    let applies;
    try {
        applies = constraint.appliesTo(node);
    }
    catch (error) {
        return { ok: false, reason: `its appliesTo threw: ${thrownText(error)}` };
    }
    if (typeof applies !== 'boolean') {
        return {
            ok: false,
            reason: `its appliesTo returned ${describeAnswer(applies)}, not a boolean`,
        };
    }
    return { ok: true, applies };
}
/**
 * Resolves one node's proposed transform through `constraints` (already sorted and filtered to the
 * node). Required constraints adjust or reject; optional ones apply only when the required ones
 * still accept the result unchanged. Finally every required constraint must accept the outcome
 * unchanged, or the placement is rejected as unsatisfiable. A constraint whose `resolve` throws
 * or answers what it may not rejects the placement, naming it, whenever it is called.
 */
export function resolveConstraints(constraints, input, proposal) {
    const required = constraints.filter((c) => c.required);
    /** The first required constraint that does not accept `transform` unchanged, and why. */
    const firstBroken = (transform) => {
        for (const constraint of required) {
            const result = attempt(constraint, { ...input, transform });
            if (!result.ok) {
                return { constraint, defect: result.reason };
            }
            if (result.outcome.kind !== 'accept' ||
                !transformApproxEquals(result.outcome.transform, transform)) {
                return { constraint, defect: null };
            }
        }
        return null;
    };
    let transform = proposal;
    for (const constraint of constraints) {
        const result = attempt(constraint, { ...input, transform });
        if (!result.ok) {
            // A constraint that throws or answers what it may not is defective, whether it is required
            // or optional; the placement is rejected rather than resolved without it.
            return { ok: false, constraintId: constraint.id, reason: result.reason };
        }
        if (result.outcome.kind === 'reject') {
            if (constraint.required) {
                return { ok: false, constraintId: constraint.id, reason: result.outcome.reason };
            }
            continue;
        }
        const candidate = result.outcome.transform;
        if (constraint.required) {
            transform = candidate;
            continue;
        }
        const broken = firstBroken(candidate);
        if (broken !== null && broken.defect !== null) {
            return { ok: false, constraintId: broken.constraint.id, reason: broken.defect };
        }
        if (broken === null) {
            transform = candidate;
        }
    }
    const broken = firstBroken(transform);
    if (broken !== null) {
        return {
            ok: false,
            constraintId: broken.constraint.id,
            reason: broken.defect ?? 'the required constraints cannot all be satisfied together',
        };
    }
    return { ok: true, transform };
}
//# sourceMappingURL=constraints.js.map