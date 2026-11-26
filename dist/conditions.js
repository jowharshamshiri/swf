const PENDING = Object.freeze({ kind: 'pending' });
const UNSUPPORTED = Object.freeze({ kind: 'unsupported' });
/**
 * A surface's condition from its presentation in the runtime (undefined while the runtime has not
 * taken the surface up). `presentedElsewhere` is the caller's: whether a single-owner handle is
 * presented in a viewport other than the one being planned; it is ignored for a shared handle.
 * The condition returned is frozen.
 *
 * @throws Error when the presentation contradicts itself: bound without capabilities, or in error
 *   without an error.
 */
export function surfaceCondition(presentation, presentedElsewhere) {
    if (presentation === undefined) {
        return PENDING;
    }
    switch (presentation.state) {
        case 'ready':
        case 'presented':
        case 'hidden': {
            const capabilities = presentation.capabilities;
            if (capabilities === null) {
                throw new Error(`surface "${presentation.surfaceId}" is bound without capabilities`);
            }
            return Object.freeze({
                kind: 'bound',
                capabilities,
                presentedElsewhere: presentedElsewhere && capabilities.viewportSharing === 'single-owner',
            });
        }
        case 'binding':
        case 'detaching':
            return PENDING;
        case 'error': {
            const error = presentation.error;
            if (error === null) {
                throw new Error(`surface "${presentation.surfaceId}" is in error without an error`);
            }
            return Object.freeze({ kind: 'failed', error });
        }
        case 'detached':
            return Object.freeze({ kind: 'unbound', reason: 'released' });
        case 'unbound': {
            const reason = presentation.unboundReason ?? 'released';
            return reason === 'adapter-unavailable'
                ? UNSUPPORTED
                : Object.freeze({ kind: 'unbound', reason });
        }
    }
}
/** Every {@link StandInReason}, frozen, in the order the type lists them. */
export const STAND_IN_REASONS = Object.freeze([
    'pending',
    'unbound',
    'unsupported',
    'unavailable',
    'failed',
    'elsewhere',
]);
/** The words renderers use for each reason by default, in English; frozen. */
export const STAND_IN_TEXT = Object.freeze({
    pending: 'Binding…',
    unbound: 'Unbound: no content is bound',
    unsupported: 'Unsupported: this content cannot be presented here',
    unavailable: 'Temporarily unavailable',
    failed: 'Presentation failed',
    elsewhere: 'Shown in another view',
});
/**
 * Why a planned fragment stands in for its surface's content, or null when it needs no reason:
 * it is the content, or a proxy chosen for a reason the view shows already (a representation, or
 * a seam's secondary fragment). A placeholder always has a reason.
 */
export function standInReason(planned) {
    const { condition, negotiation } = planned;
    switch (condition.kind) {
        case 'pending':
            return 'pending';
        case 'unbound':
            return 'unbound';
        case 'unsupported':
            return 'unsupported';
        case 'failed':
            return condition.error.retryable ? 'unavailable' : 'failed';
        case 'bound':
            if (condition.presentedElsewhere) {
                return 'elsewhere';
            }
            return negotiation.mode === 'placeholder' && planned.representation === 'full'
                ? 'unsupported'
                : null;
    }
}
/**
 * The condition of a surface bound with these capabilities, or, for null, of one that names no
 * endpoint: for hosts and tests that plan frames without a runtime. `presentedElsewhere` (default
 * false) counts only for a single-owner handle. The condition returned is frozen.
 */
export function conditionFor(capabilities, presentedElsewhere = false) {
    return capabilities === null
        ? Object.freeze({ kind: 'unbound', reason: 'no-binding-key' })
        : Object.freeze({
            kind: 'bound',
            capabilities,
            presentedElsewhere: presentedElsewhere && capabilities.viewportSharing === 'single-owner',
        });
}
//# sourceMappingURL=conditions.js.map