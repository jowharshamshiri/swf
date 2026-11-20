import type { Id, ResolvedGeometry } from '@swf/core';
import { VERSIONED_ID } from '@swf/core';
import type { Vec3 } from '@swf/math';
import type { SurfaceCapabilities } from './capabilities.js';
import { capabilitiesIssue } from './capabilities.js';

/** The version of the adapter contract this package implements. */
export const ADAPTER_API_VERSION = 1;

/**
 * Where a surface is presented in one viewport. `container` is the backend's own opaque handle
 * (such as a layer element); `geometry` is the surface's geometry placed in the world.
 */
export interface PresentationTarget {
  readonly surfaceId: Id;
  readonly viewportId: Id;
  readonly container: unknown;
  readonly geometry: ResolvedGeometry;
}

/** Whether an occlusion estimate is exact, estimated, or unknown. */
export type OcclusionConfidence = 'exact' | 'estimated' | 'unknown';

/**
 * Advisory presentation state for one surface in one viewport. It never mandates anything of the
 * endpoint's producer: an adapter may ignore what it does not support. The three sizes are kept
 * apart: the surface's spatial bounds, its projected size in the viewport, and an optional
 * requested intrinsic presentation size.
 */
export interface PresentationHint {
  readonly surfaceId: Id;
  readonly viewportId: Id;
  readonly sceneRevision: number;
  readonly visible: boolean;
  /** Share of the surface inside the viewport, 0 to 1. */
  readonly intersectionRatio: number;
  readonly occlusion: { readonly value: number | null; readonly confidence: OcclusionConfidence };
  /** [x, y, width, height] in viewport pixels, or null when not projected. */
  readonly projectedBounds: readonly [number, number, number, number] | null;
  readonly tier: 'full' | 'compact' | 'proxy' | 'hidden';
  readonly attention: 'active' | 'context' | 'background';
  /** The surface's bounds in its local frame, as the scene holds them. */
  readonly spatialBounds: Vec3;
  /** A presentation size the framework would like, or null; the adapter may ignore it. */
  readonly requestedIntrinsicSize: readonly [number, number] | null;
}

/**
 * What a binding attempt can report back while it is current. Calls made after the attempt was
 * superseded (the surface removed, rebound or unbound) are ignored.
 */
export interface BindingContext {
  readonly surfaceId: Id;
  /** Increases with every binding attempt of this surface. */
  readonly generation: number;
  /** The endpoint's capabilities changed (for example, detachment became unavailable). */
  announceCapabilities(capabilities: SurfaceCapabilities): void;
  /** The endpoint's presentation resource is no longer available; the surface shows an error. */
  reportUnavailable(reason: string): void;
}

/**
 * Binds already existing, externally owned presentation endpoints. The framework never opens,
 * decodes, inspects or executes an endpoint: it asks the adapter to resolve a host key to a
 * handle, to attach the handle to a presentation target, to take hints, and to release the
 * attachment. Releasing an attachment never means stopping or destroying the endpoint.
 */
export interface SurfaceAdapter<THandle = unknown> {
  /** A globally unique, versioned type ID, `<name>/<version>`, such as `host.video/1`. */
  readonly id: string;
  /** The adapter contract version it implements; must be {@link ADAPTER_API_VERSION}. */
  readonly apiVersion: number;
  /** The most this adapter can offer; each handle's own capabilities must stay within it. */
  readonly declaredCapabilities: SurfaceCapabilities;
  /**
   * True when binding may take longer than the runtime's timeout (an explicitly long setup). The
   * adapter must still honour the abort signal.
   */
  readonly untimedBinding?: boolean;
  /**
   * Resolves a binding key to a handle, or to null when the key is unknown. Must stop work when
   * `signal` aborts.
   */
  resolve(
    bindingKey: string,
    signal: AbortSignal,
    context: BindingContext,
  ): Promise<THandle | null>;
  /** The handle's capabilities, at most the declared ones. */
  capabilities(handle: THandle): SurfaceCapabilities;
  /** Attaches the handle to a presentation target. A throw or rejection reports a failed mount. */
  attach(handle: THandle, target: PresentationTarget): Promise<void> | void;
  /** Receives an advisory hint; it may ignore any of it. */
  update(handle: THandle, hint: PresentationHint): void;
  /** Releases the attachment only; the endpoint and its producer are left as they are. */
  detach(handle: THandle, target: PresentationTarget): Promise<void> | void;
}

/**
 * Why an adapter cannot be registered, or null when it can: `INVALID_INPUT` for a malformed
 * adapter, `UNSUPPORTED_CAPABILITY` for an incompatible contract version or contradictory
 * capability declarations.
 */
export function adapterIssue(
  adapter: unknown,
): { readonly code: 'INVALID_INPUT' | 'UNSUPPORTED_CAPABILITY'; readonly message: string } | null {
  const malformed = (message: string) => ({ code: 'INVALID_INPUT' as const, message });
  const incompatible = (message: string) => ({ code: 'UNSUPPORTED_CAPABILITY' as const, message });
  if (typeof adapter !== 'object' || adapter === null) {
    return malformed('adapter must be an object');
  }
  const a = adapter as Record<string, unknown>;
  const id = a['id'];
  if (typeof id !== 'string' || !VERSIONED_ID.test(id)) {
    return malformed(
      `adapter id ${JSON.stringify(id)} must be a versioned type ID "<name>/<version>", such as "host.video/1"`,
    );
  }
  for (const method of ['resolve', 'capabilities', 'attach', 'update', 'detach']) {
    if (typeof a[method] !== 'function') {
      return malformed(`adapter "${id}" must implement ${method}()`);
    }
  }
  if (a['untimedBinding'] !== undefined && typeof a['untimedBinding'] !== 'boolean') {
    return malformed(`adapter "${id}" untimedBinding must be a boolean`);
  }
  if (a['apiVersion'] !== ADAPTER_API_VERSION) {
    return incompatible(
      `adapter "${id}" implements contract version ${JSON.stringify(a['apiVersion'])}, not ${ADAPTER_API_VERSION}`,
    );
  }
  const issue = capabilitiesIssue(a['declaredCapabilities']);
  if (issue !== null) {
    return incompatible(`adapter "${id}" declares invalid capabilities: ${issue}`);
  }
  return null;
}
