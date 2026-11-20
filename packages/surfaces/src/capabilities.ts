/** How faithfully a surface's placement follows its projected geometry, best first. */
export type Fidelity = 'native' | 'exact' | 'approximate' | 'proxy' | 'unsupported';

/**
 * How an adapter's endpoint is attached: as a live browser element in a native layer, as a
 * drawable resource a geometry backend can render, or only as a representational proxy.
 */
export type AttachStrategy = 'native-dom' | 'drawable' | 'proxy-only';

/** How much of the endpoint's own interaction stays native: all of it, some of it, or none. */
export type InteractionSupport = 'full' | 'partial' | 'none';

/**
 * What resizing the adapter handles: none, spatial bounds only, or also a requested intrinsic
 * presentation size.
 */
export type ResizeHandling = 'none' | 'spatial' | 'intrinsic';

/** Whether one handle may be shown in several viewports at once, or has a single owner. */
export type ViewportSharing = 'shared' | 'single-owner';

/**
 * What an adapter can do with an endpoint, each capability advertised independently. An adapter
 * declares the most it offers at registration; each resolved handle reports its own, which must
 * not exceed the declaration.
 */
export interface SurfaceCapabilities {
  readonly attachStrategy: AttachStrategy;
  readonly nativeInteraction: InteractionSupport;
  /** Pointer positions can be addressed as surface UV coordinates. */
  readonly uvAddressing: boolean;
  readonly transformFidelity: Fidelity;
  readonly transparency: boolean;
  readonly clipping: boolean;
  /** The adapter maps the cursor's position and shape onto the endpoint. */
  readonly cursorMapping: boolean;
  readonly resize: ResizeHandling;
  readonly viewportSharing: ViewportSharing;
  /** The presentation attachment can be released while hidden without harming the endpoint. */
  readonly safeDetach: boolean;
  /** A released attachment can be attached again later. */
  readonly rebinding: boolean;
  /** The adapter can supply its own placeholder while unbound. */
  readonly placeholder: boolean;
  /** The adapter takes part in workspace snapshots through extension hooks. */
  readonly snapshotHooks: boolean;
}

/** Fidelity levels, worst first. */
export const FIDELITY_ORDER: readonly Fidelity[] = Object.freeze([
  'unsupported',
  'proxy',
  'approximate',
  'exact',
  'native',
]);
/** Interaction support levels, least first. */
export const INTERACTION_ORDER: readonly InteractionSupport[] = Object.freeze([
  'none',
  'partial',
  'full',
]);
const RESIZE_ORDER: readonly ResizeHandling[] = ['none', 'spatial', 'intrinsic'];
const SHARING_ORDER: readonly ViewportSharing[] = ['single-owner', 'shared'];
export const ATTACH_STRATEGIES: readonly AttachStrategy[] = Object.freeze([
  'native-dom',
  'drawable',
  'proxy-only',
]);
const STRATEGIES = ATTACH_STRATEGIES;

const BOOLEAN_FIELDS = [
  'uvAddressing',
  'transparency',
  'clipping',
  'cursorMapping',
  'safeDetach',
  'rebinding',
  'placeholder',
  'snapshotHooks',
] as const;

const FIELDS = [
  'attachStrategy',
  'nativeInteraction',
  'transformFidelity',
  'resize',
  'viewportSharing',
  ...BOOLEAN_FIELDS,
] as const;

function oneOf(value: unknown, allowed: readonly string[], name: string): string | null {
  return typeof value === 'string' && allowed.includes(value)
    ? null
    : `${name} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`;
}

/**
 * Why a capability descriptor is malformed or self-contradictory, or null when it is valid.
 * Every field is required; unknown fields are rejected.
 */
export function capabilitiesIssue(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'capabilities must be an object';
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(FIELDS as readonly string[]).includes(key)) {
      return `capabilities.${key} is not a known capability`;
    }
  }
  const shape =
    oneOf(record['attachStrategy'], STRATEGIES, 'attachStrategy') ??
    oneOf(record['nativeInteraction'], INTERACTION_ORDER, 'nativeInteraction') ??
    oneOf(record['transformFidelity'], FIDELITY_ORDER, 'transformFidelity') ??
    oneOf(record['resize'], RESIZE_ORDER, 'resize') ??
    oneOf(record['viewportSharing'], SHARING_ORDER, 'viewportSharing') ??
    BOOLEAN_FIELDS.map((key) =>
      typeof record[key] === 'boolean' ? null : `${key} must be a boolean`,
    ).find((issue) => issue !== null) ??
    null;
  if (shape !== null) {
    return `capabilities.${shape}`;
  }
  return contradiction(value as SurfaceCapabilities);
}

/** The rules that keep a descriptor honest: no claim that its attach strategy cannot back. */
function contradiction(c: SurfaceCapabilities): string | null {
  if (c.nativeInteraction !== 'none' && c.attachStrategy !== 'native-dom') {
    return 'native interaction requires the native-dom attach strategy';
  }
  if (c.transformFidelity === 'native' && c.attachStrategy !== 'native-dom') {
    return 'native transform fidelity requires the native-dom attach strategy';
  }
  if (c.attachStrategy === 'proxy-only') {
    if (c.transformFidelity !== 'proxy' && c.transformFidelity !== 'unsupported') {
      return 'a proxy-only endpoint cannot claim better than proxy fidelity';
    }
    if (c.uvAddressing) {
      return 'a proxy-only endpoint cannot offer UV addressing';
    }
  }
  if (c.cursorMapping && !c.uvAddressing) {
    return 'cursor mapping requires UV addressing';
  }
  if (c.rebinding && !c.safeDetach) {
    return 'rebinding requires safe detachment';
  }
  return null;
}

const rank = <T>(order: readonly T[], value: T): number => order.indexOf(value);

/**
 * The capabilities in `actual` that exceed `declared`, by name. Empty when `actual` stays within
 * the declaration (same attach strategy, nothing better than declared).
 */
export function exceededCapabilities(
  declared: SurfaceCapabilities,
  actual: SurfaceCapabilities,
): string[] {
  const out: string[] = [];
  if (actual.attachStrategy !== declared.attachStrategy) {
    out.push('attachStrategy');
  }
  if (
    rank(INTERACTION_ORDER, actual.nativeInteraction) >
    rank(INTERACTION_ORDER, declared.nativeInteraction)
  ) {
    out.push('nativeInteraction');
  }
  if (
    rank(FIDELITY_ORDER, actual.transformFidelity) >
    rank(FIDELITY_ORDER, declared.transformFidelity)
  ) {
    out.push('transformFidelity');
  }
  if (rank(RESIZE_ORDER, actual.resize) > rank(RESIZE_ORDER, declared.resize)) {
    out.push('resize');
  }
  if (rank(SHARING_ORDER, actual.viewportSharing) > rank(SHARING_ORDER, declared.viewportSharing)) {
    out.push('viewportSharing');
  }
  for (const key of BOOLEAN_FIELDS) {
    if (actual[key] && !declared[key]) {
      out.push(key);
    }
  }
  return out;
}

/** A frozen copy of a valid descriptor, so later mutation by its author cannot change it. */
export function freezeCapabilities(c: SurfaceCapabilities): SurfaceCapabilities {
  return Object.freeze({
    attachStrategy: c.attachStrategy,
    nativeInteraction: c.nativeInteraction,
    uvAddressing: c.uvAddressing,
    transformFidelity: c.transformFidelity,
    transparency: c.transparency,
    clipping: c.clipping,
    cursorMapping: c.cursorMapping,
    resize: c.resize,
    viewportSharing: c.viewportSharing,
    safeDetach: c.safeDetach,
    rebinding: c.rebinding,
    placeholder: c.placeholder,
    snapshotHooks: c.snapshotHooks,
  });
}
