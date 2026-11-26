import { makeError, SwfFailure, VERSIONED_ID } from '@swf/core';
import { standInModes } from './negotiation.js';
/** Every {@link Representation}, from the most shown to the least; frozen. */
export const REPRESENTATIONS = Object.freeze([
    'full',
    'compact',
    'label',
]);
/**
 * Why a value is not a representation policy, or null when it is: not an object, an `id` that is
 * not a versioned ID (`<name>/<version>`, as core's {@link VERSIONED_ID} defines it), or no
 * `representationOf` function. It never throws.
 */
export function representationPolicyIssue(value) {
    if (typeof value !== 'object' || value === null) {
        return 'a representation policy must be an object';
    }
    const policy = value;
    if (typeof policy.id !== 'string' || !VERSIONED_ID.test(policy.id)) {
        return `a representation policy's ID must be a versioned ID "<name>/<version>", such as "host.depth/1" (got ${JSON.stringify(policy.id)})`;
    }
    if (typeof policy.representationOf !== 'function') {
        return `representation policy "${policy.id}" must implement representationOf()`;
    }
    return null;
}
/**
 * Asks a policy how a surface is represented, holding it to its contract. Throws
 * {@link SwfFailure} (`INVALID_INPUT`, naming the surface) when it answers something that is not a
 * representation; what the policy itself throws propagates unchanged.
 */
export function representationFor(policy, context) {
    const answer = policy.representationOf(context);
    if (!REPRESENTATIONS.includes(answer)) {
        throw new SwfFailure(makeError('INVALID_INPUT', `representation policy "${policy.id}" answered ${JSON.stringify(answer)} for surface "${context.surfaceId}"; a representation is one of ${REPRESENTATIONS.join(', ')}`, { entityId: context.surfaceId }));
    }
    return answer;
}
/**
 * The fallback order negotiation follows for a surface represented as `representation`: the
 * policy's own for `full`; for `compact` and `label`, only the modes that stand for the surface
 * without showing its content, in the policy's order. What negotiation then reports as a fallback
 * is only what capabilities ruled out, never the representation chosen.
 *
 * @returns `policy` itself for `full`; otherwise a new frozen policy holding only `proxy` and
 *   `placeholder` (those the policy lists).
 */
export function representedOrder(policy, representation) {
    const represented = representation !== 'full';
    const order = standInModes(represented, policy);
    // The policy itself when the model leaves its order as it is.
    return represented ? Object.freeze({ order }) : policy;
}
//# sourceMappingURL=representation.js.map