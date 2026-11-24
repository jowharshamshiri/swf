import type { Id, SceneState } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type { ViewGeometry } from './fragments.js';
import type { FallbackPolicy, PresentationMode } from './negotiation.js';

/**
 * How much of a surface a viewport shows, as a representation policy chooses it (semantic depth,
 * for one): its content (`full`), a compact preview standing for it (`compact`), or its label
 * alone (`label`). A representation is a derivative of presentation only: choosing one never
 * detaches, pauses or reconfigures the surface's endpoint, which stays bound and the host's.
 */
export type Representation = 'full' | 'compact' | 'label';

export const REPRESENTATIONS: readonly Representation[] = Object.freeze([
  'full',
  'compact',
  'label',
]);

/** What a representation policy weighs for one surface in one viewport. */
export interface RepresentationContext {
  /** The presented scene of the frame being planned. */
  readonly scene: SceneState;
  readonly view: ViewGeometry;
  readonly surfaceId: Id;
  /** The node that owns the surface. */
  readonly nodeId: Id;
}

/**
 * Chooses how each surface of a viewport is represented. It is consulted while a frame is
 * planned, for every fragment, and must answer from what it is given alone (the same context, the
 * same answer), so a frame is planned the same way every time.
 */
export interface RepresentationPolicy {
  /** A versioned ID, `<name>/<version>`. */
  readonly id: string;
  representationOf(context: RepresentationContext): Representation;
}

const VERSIONED_ID = /^[a-z0-9][a-z0-9.-]*\/[1-9][0-9]*$/;

/** Why a value is not a representation policy, or null when it is. */
export function representationPolicyIssue(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return 'a representation policy must be an object';
  }
  const policy = value as Partial<RepresentationPolicy>;
  if (typeof policy.id !== 'string' || !VERSIONED_ID.test(policy.id)) {
    return `a representation policy's ID must look like "name/1" (got ${JSON.stringify(policy.id)})`;
  }
  if (typeof policy.representationOf !== 'function') {
    return `representation policy "${policy.id}" must implement representationOf()`;
  }
  return null;
}

/**
 * Asks a policy how a surface is represented, holding it to its contract. Throws
 * {@link SwfFailure} (`INVALID_INPUT`) when it answers something that is not a representation.
 */
export function representationFor(
  policy: RepresentationPolicy,
  context: RepresentationContext,
): Representation {
  const answer: unknown = policy.representationOf(context);
  if (!(REPRESENTATIONS as readonly unknown[]).includes(answer)) {
    throw new SwfFailure(
      makeError(
        'INVALID_INPUT',
        `representation policy "${policy.id}" answered ${JSON.stringify(answer)} for surface "${context.surfaceId}"; a representation is one of ${REPRESENTATIONS.join(', ')}`,
        { entityId: context.surfaceId },
      ),
    );
  }
  return answer as Representation;
}

/** The modes that stand for a surface without its live content. */
const REPRESENTED: readonly PresentationMode[] = Object.freeze(['proxy', 'placeholder']);

/**
 * The fallback order negotiation follows for a surface represented as `representation`: the
 * policy's own for `full`; for `compact` and `label`, only the modes that stand for the surface
 * without showing its content, in the policy's order. What negotiation then reports as a fallback
 * is only what capabilities ruled out, never the representation chosen.
 */
export function representedOrder(
  policy: FallbackPolicy,
  representation: Representation,
): FallbackPolicy {
  if (representation === 'full') {
    return policy;
  }
  return Object.freeze({
    order: Object.freeze(policy.order.filter((mode) => REPRESENTED.includes(mode))),
  });
}
