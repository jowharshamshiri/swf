import type { Id, SceneState } from '@swf/core';
import type { ViewGeometry } from './fragments.js';
import type { FallbackPolicy } from './negotiation.js';
/**
 * How much of a surface a viewport shows, as a representation policy chooses it (semantic depth,
 * for one): its content (`full`), a compact preview standing for it (`compact`), or its label
 * alone (`label`). A representation is a derivative of presentation only: choosing one never
 * detaches, pauses or reconfigures the surface's endpoint, which stays bound and the host's.
 */
export type Representation = 'full' | 'compact' | 'label';
/** Every {@link Representation}, from the most shown to the least; frozen. */
export declare const REPRESENTATIONS: readonly Representation[];
/** What a representation policy weighs for one surface in one viewport. */
export interface RepresentationContext {
    /** The presented scene of the frame being planned. */
    readonly scene: SceneState;
    /** The view the frame is planned for. */
    readonly view: ViewGeometry;
    /** The surface asked about; it is in `scene`. */
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
    /** A versioned ID, `<name>/<version>`, as core's {@link VERSIONED_ID} defines it. */
    readonly id: string;
    /**
     * How the surface is represented. Asked once per surface and frame, whatever its number of
     * fragments; an answer that is not a {@link Representation} fails the frame with
     * `INVALID_INPUT`, and what it throws propagates.
     */
    representationOf(context: RepresentationContext): Representation;
}
/**
 * Why a value is not a representation policy, or null when it is: not an object, an `id` that is
 * not a versioned ID (`<name>/<version>`, as core's {@link VERSIONED_ID} defines it), or no
 * `representationOf` function. It never throws.
 */
export declare function representationPolicyIssue(value: unknown): string | null;
/**
 * Asks a policy how a surface is represented, holding it to its contract. Throws
 * {@link SwfFailure} (`INVALID_INPUT`, naming the surface) when it answers something that is not a
 * representation; what the policy itself throws propagates unchanged.
 */
export declare function representationFor(policy: RepresentationPolicy, context: RepresentationContext): Representation;
/**
 * The fallback order negotiation follows for a surface represented as `representation`: the
 * policy's own for `full`; for `compact` and `label`, only the modes that stand for the surface
 * without showing its content, in the policy's order. What negotiation then reports as a fallback
 * is only what capabilities ruled out, never the representation chosen.
 *
 * @returns `policy` itself for `full`; otherwise a new frozen policy holding only `proxy` and
 *   `placeholder` (those the policy lists).
 */
export declare function representedOrder(policy: FallbackPolicy, representation: Representation): FallbackPolicy;
//# sourceMappingURL=representation.d.ts.map