import type { SwfError } from '@swf/core';
import type { SurfaceCapabilities, SurfacePresentation } from '@swf/surfaces';
import type { PlannedFragment } from './contracts.js';

/**
 * Where a surface's binding stands, as a frame is planned: what a renderer needs to say why it
 * shows a placeholder rather than the content, so an operator never meets a blank window.
 * - `bound`: its endpoint is bound, with the capabilities it declares; `presentedElsewhere` when
 *   its handle is single-owner and is presented in another viewport.
 * - `pending`: a binding (or a release) is under way, or the runtime has not taken it up yet.
 * - `unbound`: it names no endpoint, the adapter does not know its key, or it was released.
 * - `unsupported`: no adapter is registered for its adapter type.
 * - `failed`: binding or attaching failed, with the typed error.
 */
export type SurfaceCondition =
  | {
      /** Its endpoint is bound. */
      readonly kind: 'bound';
      /** What the bound endpoint declares: the same object the runtime holds, not a copy. */
      readonly capabilities: SurfaceCapabilities;
      /**
       * Its handle is single-owner and presented in another viewport, so this one shows a stand-in;
       * always false for a handle that can be shared.
       */
      readonly presentedElsewhere: boolean;
    }
  | {
      /** A binding or release is under way, or the runtime has not taken the surface up. */
      readonly kind: 'pending';
    }
  | {
      /** No endpoint is bound. */
      readonly kind: 'unbound';
      /**
       * `no-binding-key`: the surface names no endpoint; `unknown-binding-key`: its adapter does
       * not know the key it names; `released`: its endpoint was released.
       */
      readonly reason: 'no-binding-key' | 'unknown-binding-key' | 'released';
    }
  | {
      /** No adapter is registered for the surface's adapter type. */
      readonly kind: 'unsupported';
    }
  | {
      /** Binding or attaching failed. */
      readonly kind: 'failed';
      /** The typed error; its `retryable` tells a passing failure from a lasting one. */
      readonly error: SwfError;
    };

const PENDING: SurfaceCondition = Object.freeze({ kind: 'pending' });
const UNSUPPORTED: SurfaceCondition = Object.freeze({ kind: 'unsupported' });

/**
 * A surface's condition from its presentation in the runtime (undefined while the runtime has not
 * taken the surface up). `presentedElsewhere` is the caller's: whether a single-owner handle is
 * presented in a viewport other than the one being planned; it is ignored for a shared handle.
 * The condition returned is frozen.
 *
 * @throws Error when the presentation contradicts itself: bound without capabilities, or in error
 *   without an error.
 */
export function surfaceCondition(
  presentation: SurfacePresentation | undefined,
  presentedElsewhere: boolean,
): SurfaceCondition {
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

/**
 * Why a fragment is not the surface's own content, in the categories an operator is told:
 * - `pending`: still binding;
 * - `unbound`: no content is bound to it;
 * - `unsupported`: no adapter can present it, or this backend cannot present what it is;
 * - `unavailable`: binding or attaching failed in a way that may pass (it can be retried);
 * - `failed`: binding or attaching failed for good;
 * - `elsewhere`: its content can be shown in one view at a time and is shown in another.
 */
export type StandInReason =
  'pending' | 'unbound' | 'unsupported' | 'unavailable' | 'failed' | 'elsewhere';

/** Every {@link StandInReason}, frozen, in the order the type lists them. */
export const STAND_IN_REASONS: readonly StandInReason[] = Object.freeze([
  'pending',
  'unbound',
  'unsupported',
  'unavailable',
  'failed',
  'elsewhere',
]);

/** The words renderers use for each reason by default, in English; frozen. */
export const STAND_IN_TEXT: Readonly<Record<StandInReason, string>> = Object.freeze({
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
export function standInReason(planned: PlannedFragment): StandInReason | null {
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
      // A surface represented by choice (compact, a label) stands in for the representation.
      if (planned.representation !== 'full') {
        return null;
      }
      if (condition.presentedElsewhere) {
        return 'elsewhere';
      }
      return negotiation.mode === 'placeholder' ? 'unsupported' : null;
  }
}

/**
 * The condition of a surface bound with these capabilities, or, for null, of one that names no
 * endpoint: for hosts and tests that plan frames without a runtime. `presentedElsewhere` (default
 * false) counts only for a single-owner handle. The condition returned is frozen.
 */
export function conditionFor(
  capabilities: SurfaceCapabilities | null,
  presentedElsewhere = false,
): SurfaceCondition {
  return capabilities === null
    ? Object.freeze({ kind: 'unbound', reason: 'no-binding-key' })
    : Object.freeze({
        kind: 'bound',
        capabilities,
        presentedElsewhere: presentedElsewhere && capabilities.viewportSharing === 'single-owner',
      });
}
