import type { Id, ResolvedGeometry } from '@swf/core';
import { VERSIONED_ID } from '@swf/core';
import type { Vec3 } from '@swf/math';
import type { SurfaceCapabilities } from './capabilities.js';
import { capabilitiesIssue } from './capabilities.js';

/**
 * The version of the adapter contract this package implements. An adapter states it as its
 * {@link SurfaceAdapter.apiVersion}; any other value is refused at registration with
 * `UNSUPPORTED_CAPABILITY`.
 */
export const ADAPTER_API_VERSION = 1;

/**
 * Where a surface is presented in one viewport, as the runtime hands it to
 * {@link SurfaceAdapter.attach} and {@link SurfaceAdapter.detach}. The target is frozen; `detach`
 * receives the same target object its `attach` did.
 */
export interface PresentationTarget {
  /** The surface presented. */
  readonly surfaceId: Id;
  /** The viewport it is presented in. */
  readonly viewportId: Id;
  /**
   * The presentation backend's own opaque handle for where the endpoint goes, such as a layer
   * element. The runtime passes it through without reading it; the backend owns it.
   */
  readonly container: unknown;
  /**
   * The surface's geometry placed in the world when the attachment was made. It is not updated
   * afterwards: later placement changes reach the adapter as hints.
   */
  readonly geometry: ResolvedGeometry;
}

/**
 * How sure an occlusion estimate is: `exact` when computed exactly (nothing drawn in front
 * overlaps the surface), `estimated` when approximated from the bounds of what is drawn in front,
 * `unknown` when there is no estimate (the surface is not shown).
 */
export type OcclusionConfidence = 'exact' | 'estimated' | 'unknown';

/**
 * Advisory presentation state for one surface in one viewport. It never mandates anything of the
 * endpoint's producer: an adapter may ignore what it does not support. Conditions that one
 * boolean would conflate are kept apart: whether the surface is shown in the view at all
 * (`visible`), whether its own content is attached and shown there (`mounted`), whether the
 * scene marks it visible (`sceneVisible`), how much of it lies inside the viewport, how much is
 * occluded and how sure that estimate is, and how much attention it has. So are the three sizes:
 * the surface's spatial bounds, its projected size in the viewport, and an optional requested
 * intrinsic presentation size.
 */
export interface PresentationHint {
  /** The surface the hint is about. */
  readonly surfaceId: Id;
  /** The viewport the hint is about; the surface must be attached there for it to be delivered. */
  readonly viewportId: Id;
  /** The revision of the scene the hint was computed from. */
  readonly sceneRevision: number;
  /** Shown in this view this frame, as its own content or as a proxy or placeholder. */
  readonly visible: boolean;
  /** Its own content is attached and shown in this view (not hidden, not represented). */
  readonly mounted: boolean;
  /** The scene marks it (and every ancestor) visible. */
  readonly sceneVisible: boolean;
  /** Share of the surface inside the viewport, 0 to 1. */
  readonly intersectionRatio: number;
  /** How much of the surface is covered by what is drawn in front of it. */
  readonly occlusion: {
    /** The covered share of what is shown, 0 to 1, or null when unknown. */
    readonly value: number | null;
    /** How sure `value` is; `unknown` exactly when `value` is null. */
    readonly confidence: OcclusionConfidence;
  };
  /**
   * `[x, y, width, height]` in CSS pixels of the viewport, from its top-left corner, or null when
   * not projected.
   */
  readonly projectedBounds: readonly [number, number, number, number] | null;
  /**
   * How the surface is represented here: `full` as its own content, `compact` or `proxy` as a
   * representation, `hidden` not at all.
   */
  readonly tier: 'full' | 'compact' | 'proxy' | 'hidden';
  /**
   * How much attention the surface has: `active` when its owner node has focus, `context` when it
   * is shown but not focused, `background` when it is not shown.
   */
  readonly attention: 'active' | 'context' | 'background';
  /**
   * The surface's extent in its local frame as the scene holds it: width (+X), height (+Y) and
   * depth (+Z), in world units.
   */
  readonly spatialBounds: Vec3;
  /** A presentation size the framework would like, or null; the adapter may ignore it. */
  readonly requestedIntrinsicSize: readonly [number, number] | null;
}

/**
 * The abort signal of one binding attempt, as {@link SurfaceAdapter.resolve} receives it: the part
 * of the platform's `AbortSignal` that browsers, workers and Node.js all provide, and all an
 * adapter may rely on. The runtime passes a real `AbortSignal`, which satisfies this, so an
 * adapter typed against the platform may declare the parameter as `AbortSignal` and pass it on.
 *
 * It aborts with the reason `'timeout'` when resolving outlasts the runtime's binding timeout, and
 * with `'released'` when the attempt is superseded or the binding it made ends: the surface
 * removed, unbound, rebound or failed, a replacement abandoned, the adapter unregistered or the
 * runtime disposed. A signal whose attempt found no handle (an unknown key, a failure) is not
 * aborted later.
 */
export interface BindingSignal {
  /** True once the attempt is aborted. */
  readonly aborted: boolean;
  /** Why the attempt was aborted (`'timeout'` or `'released'`), or undefined while it is not. */
  readonly reason: unknown;
  /**
   * Calls `listener` when the attempt aborts. A listener added after it aborted is never called:
   * check {@link BindingSignal.aborted} first.
   */
  addEventListener(
    type: 'abort',
    listener: () => void,
    options?: {
      /** Remove the listener after its first call; a signal aborts at most once either way. */
      once?: boolean;
    },
  ): void;
}

/**
 * What a binding attempt can report back while it is current. Calls made after the attempt was
 * superseded (the surface removed, rebound, unbound or failed) are ignored, as are calls made
 * before the attempt has bound its handle. The context is frozen.
 */
export interface BindingContext {
  /** The surface being bound. */
  readonly surfaceId: Id;
  /**
   * The generation the surface has once this binding holds, as
   * {@link SurfacePresentation.generation} counts it: for a replacement, the one its handoff
   * commits as.
   */
  readonly generation: number;
  /**
   * The endpoint's capabilities changed (for example, detachment became unavailable). The new
   * descriptor is checked as at binding: one that is malformed or exceeds the adapter's declared
   * capabilities puts the surface in error with `UNSUPPORTED_CAPABILITY`. A valid one replaces the
   * capabilities, is announced as `presentation.capabilitiesChanged`, and a handle that became
   * `single-owner` keeps only its first attachment.
   */
  announceCapabilities(capabilities: SurfaceCapabilities): void;
  /**
   * The endpoint's presentation resource is no longer available: the surface releases its
   * attachments and goes to `error` with `BIND_FAILED` (retryable, `details.phase`
   * `presentation`, `details.reason` the given reason).
   */
  reportUnavailable(reason: string): void;
}

/**
 * Binds already existing, externally owned presentation endpoints. The framework never opens,
 * decodes, inspects or executes an endpoint: it asks the adapter to resolve a host key to a
 * handle, to attach the handle to a presentation target, to take hints, and to release the
 * attachment. Releasing an attachment never means stopping or destroying the endpoint.
 *
 * The adapter and its endpoints stay the host's. At registration the runtime keeps a frozen copy
 * of the adapter's `id`, `apiVersion`, `declaredCapabilities` and `untimedBinding`, so changing
 * them later has no effect; its methods are called on the adapter object itself. Handles are
 * opaque to the runtime, which never copies, inspects or disposes them.
 */
export interface SurfaceAdapter<THandle = unknown> {
  /**
   * A versioned type ID, `<name>/<version>` with a positive integer version, such as
   * `host.video/1`; unique among the adapters registered with one runtime. Surfaces name it as
   * their adapter type.
   */
  readonly id: string;
  /** The adapter contract version it implements; must be {@link ADAPTER_API_VERSION}. */
  readonly apiVersion: number;
  /**
   * The most this adapter can offer, valid by {@link capabilitiesIssue}; each handle's own
   * capabilities must stay within it.
   */
  readonly declaredCapabilities: SurfaceCapabilities;
  /**
   * True when binding may take longer than the runtime's timeout (an explicitly long setup): its
   * attempts are then never timed out. The adapter must still honour the abort signal. Default
   * false.
   */
  readonly untimedBinding?: boolean;
  /**
   * Resolves a binding key to a handle, or to null when the key is unknown (the surface then
   * shows `unknown-binding-key`). Must stop work when `signal` aborts; a handle it still returns
   * after that is discarded without `detach`, since it was never attached, so the adapter releases
   * whatever it acquired for it. A throw or rejection fails the binding with `BIND_FAILED`
   * (retryable, `details.phase` `resolve`), as does a timeout.
   */
  resolve(
    bindingKey: string,
    signal: BindingSignal,
    context: BindingContext,
  ): Promise<THandle | null>;
  /**
   * The handle's capabilities, at most the declared ones: called once per resolved handle. A
   * throw fails the binding with `BIND_FAILED` (`details.phase` `capabilities`); a descriptor that
   * is malformed or exceeds the declaration fails it with `UNSUPPORTED_CAPABILITY`. The runtime
   * keeps a frozen copy.
   */
  capabilities(handle: THandle): SurfaceCapabilities;
  /**
   * Attaches the handle to a presentation target. A throw or rejection reports a failed mount,
   * `BIND_FAILED`: when presenting, the surface goes to `error`; when moving or replacing a
   * binding, the previous attachment is kept. An attachment that completes after the surface
   * changed is detached again at once.
   */
  attach(handle: THandle, target: PresentationTarget): Promise<void> | void;
  /**
   * Receives an advisory hint; it may ignore any of it. A throw is recorded as a `HINT_IGNORED`
   * diagnostic and changes nothing.
   */
  update(handle: THandle, hint: PresentationHint): void;
  /**
   * Releases the attachment to `target` only; the endpoint and its producer are left as they
   * are. A throw or rejection is recorded as an `ADAPTER_THREW` diagnostic, and the attachment
   * counts as released.
   */
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
