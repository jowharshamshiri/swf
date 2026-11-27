import { VERSIONED_ID } from '@swf/core';
import type { AttachStrategy, Fidelity } from '@swf/surfaces';
import { ATTACH_STRATEGIES, FIDELITY_ORDER } from '@swf/surfaces';

/** How far a backend can clip: not at all, to rectangles, or to arbitrary paths. */
export type ClipSupport = 'none' | 'rect' | 'path';

/**
 * The most general transform a renderer can apply to presented content: translation only, 2D
 * affine, 3D perspective (planar content), or arbitrary mesh warps (nonlinear deformation). A
 * window's card is scaled, so presenting content exactly or natively takes `affine-2d` or more.
 */
export type TransformMode = 'translate' | 'affine-2d' | 'perspective-3d' | 'mesh';

/** Where a renderer puts what it realizes: in the DOM, in raster (canvas) surfaces, or both. */
export type Layering = 'dom' | 'raster' | 'dom-and-raster';

/**
 * What a renderer advertises: the handle kinds it can present (with the best transform fidelity
 * it achieves for each), its transform and clipping limits, whether it maps hits through what it
 * realized, how it layers, who owns the resources it creates, and how it recovers from losing its
 * graphics context.
 */
export interface RendererCapabilities {
  /**
   * Each handle kind (attach strategy) the renderer presents, with the best transform fidelity it
   * achieves for it; a kind left out is not presented, and at least one must be named. A
   * `native-dom` kind needs a DOM layer; a `drawable` kind needs a raster layer; a kind is `exact`
   * only with transforms that scale a card (`affine-2d` or more); only `native-dom` content can be
   * `native`, and `proxy-only` content is at best `proxy`.
   */
  readonly handleKinds: Readonly<Partial<Record<AttachStrategy, Fidelity>>>;
  /** The most general transform it applies to presented content. */
  readonly transformMode: TransformMode;
  /** How far it clips presented content. */
  readonly clipping: ClipSupport;
  /**
   * Whether it maps a hit on what it realized back to a point on the surface. Advertised for
   * hosts; negotiation does not weigh it.
   */
  readonly hitMapping: boolean;
  /**
   * Where it puts what it realizes; it bounds which handle kinds it can present (see
   * `handleKinds`).
   */
  readonly layering: Layering;
  /** `renderer`: it creates and releases its resources; `host`: the host supplies them. */
  readonly resourceOwnership: 'renderer' | 'host';
  /** After a lost graphics context: restores in place, rebuilds from the scene, or cannot. */
  readonly recovery: 'restore' | 'rebuild' | 'none';
}

/**
 * The kinds of layer a compositor assembles. Opaque content (`content-native` live elements,
 * `content-raster` drawn content) is kept apart from `chrome` (frames, handles) and `overlay`
 * layers, so chrome never intercepts content input by accident.
 */
export type LayerCategory =
  'content-native' | 'content-raster' | 'proxy' | 'placeholder' | 'chrome' | 'overlay';

/**
 * What a compositor advertises: its layer categories, how it orders them (explicitly, or by DOM
 * order when it declares so), masking, transparency, clipping, overlays, interpolation, whether
 * it presents native layers directly, whether one instance assembles several viewports, and how
 * overlapping layers occlude each other.
 */
export interface CompositorCapabilities {
  /**
   * The layer categories it assembles, each at most once. `placeholder` and `chrome` are
   * required; `content-native` is listed exactly when `directNative` holds, and `overlay` exactly
   * when `overlays` does.
   */
  readonly layerCategories: readonly LayerCategory[];
  /**
   * `explicit`: it stacks layers in the order the renderer gives; `dom-order`: their order is the
   * DOM's, as it declares.
   */
  readonly ordering: 'explicit' | 'dom-order';
  /** Whether it can mask layers. Advertised for hosts; negotiation does not weigh it. */
  readonly masking: boolean;
  /**
   * Whether it blends translucent layers over what lies behind them; content that declares
   * transparency needs it to be shown live.
   */
  readonly transparency: boolean;
  /** How far it clips layers. */
  readonly clipping: ClipSupport;
  /** Whether it assembles overlay layers; goes with an `overlay` category. */
  readonly overlays: boolean;
  /** Whether it interpolates layer content. Advertised for hosts; negotiation does not weigh it. */
  readonly interpolation: boolean;
  /** Whether it presents live native layers directly; goes with a `content-native` category. */
  readonly directNative: boolean;
  /**
   * Whether one instance assembles several viewports. Advertised for hosts; negotiation does not
   * weigh it.
   */
  readonly multiViewport: boolean;
  /**
   * How overlapping layers occlude each other: `depth`, by a per-pixel depth test across layers
   * (so interpenetrating surfaces cross correctly), or `layer-order`, whole layers stacked in
   * order (each layer entirely in front of or behind another), the fallback where per-pixel
   * interplay between live and drawn layers is not available.
   */
  readonly occlusion: Occlusion;
}

/** How overlapping layers occlude each other; see {@link CompositorCapabilities.occlusion}. */
export type Occlusion = 'depth' | 'layer-order';

/**
 * What presentation needs to know of a projection: whether it wraps at a seam, and whether its
 * inverse is exact. A projection only places each window's card, a flat, upright rectangle it never
 * bends, so how it maps the sphere to the screen is its own.
 */
export interface ProjectionProfile {
  /** A versioned ID, `<name>/<version>`. */
  readonly id: string;
  /** Whether the image's edges meet at a seam, so a surface can show as several fragments. */
  readonly seamWrapping: boolean;
  /** Whether every screen point maps back to its exact ray. */
  readonly exactInverse: boolean;
}

const STRATEGIES = ATTACH_STRATEGIES;
const FIDELITIES = FIDELITY_ORDER;
/** Every {@link LayerCategory}, in the order the type lists them. */
export const LAYER_CATEGORIES: readonly LayerCategory[] = [
  'content-native',
  'content-raster',
  'proxy',
  'placeholder',
  'chrome',
  'overlay',
];
const CLIPS: readonly ClipSupport[] = ['none', 'rect', 'path'];
const TRANSFORMS: readonly TransformMode[] = ['translate', 'affine-2d', 'perspective-3d', 'mesh'];
const LAYERINGS: readonly Layering[] = ['dom', 'raster', 'dom-and-raster'];

export const clipRank = (c: ClipSupport): number => CLIPS.indexOf(c);
export const transformRank = (t: TransformMode): number => TRANSFORMS.indexOf(t);
export const fidelityRank = (f: Fidelity): number => FIDELITIES.indexOf(f);

function fields(
  value: unknown,
  allowed: readonly string[],
  what: string,
): Record<string, unknown> | string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `${what} must be an object`;
  }
  const unknownKey = Object.keys(value).find((k) => !allowed.includes(k));
  return unknownKey === undefined
    ? (value as Record<string, unknown>)
    : `${what}.${unknownKey} is not a known capability`;
}

function oneOf(
  record: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
  what: string,
): string | null {
  const value = record[key];
  return typeof value === 'string' && allowed.includes(value)
    ? null
    : `${what}.${key} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`;
}

function bools(
  record: Record<string, unknown>,
  keys: readonly string[],
  what: string,
): string | null {
  const bad = keys.find((k) => typeof record[k] !== 'boolean');
  return bad === undefined ? null : `${what}.${bad} must be a boolean`;
}

/**
 * Why a renderer's capabilities are malformed or self-contradictory, or null when valid: the
 * first problem, in words naming the field (`renderer capabilities.<field>`). It accepts any value
 * and never throws; an unknown field is a problem too. Registration refuses capabilities it
 * faults.
 */
export function rendererCapabilitiesIssue(value: unknown): string | null {
  const what = 'renderer capabilities';
  const record = fields(
    value,
    [
      'handleKinds',
      'transformMode',
      'clipping',
      'hitMapping',
      'layering',
      'resourceOwnership',
      'recovery',
    ],
    what,
  );
  if (typeof record === 'string') {
    return record;
  }
  const shape =
    oneOf(record, 'transformMode', TRANSFORMS, what) ??
    oneOf(record, 'clipping', CLIPS, what) ??
    oneOf(record, 'layering', LAYERINGS, what) ??
    oneOf(record, 'resourceOwnership', ['renderer', 'host'], what) ??
    oneOf(record, 'recovery', ['restore', 'rebuild', 'none'], what) ??
    bools(record, ['hitMapping'], what);
  if (shape !== null) {
    return shape;
  }
  const kinds = record['handleKinds'];
  if (typeof kinds !== 'object' || kinds === null || Array.isArray(kinds)) {
    return `${what}.handleKinds must map handle kinds to fidelity`;
  }
  const entries = Object.entries(kinds);
  if (entries.length === 0) {
    return `${what}.handleKinds must name at least one handle kind`;
  }
  for (const [kind, fidelity] of entries) {
    if (!(STRATEGIES as readonly string[]).includes(kind)) {
      return `${what}.handleKinds.${kind} is not a handle kind (${STRATEGIES.join(', ')})`;
    }
    if (typeof fidelity !== 'string' || !(FIDELITIES as readonly string[]).includes(fidelity)) {
      return `${what}.handleKinds.${kind} must be a fidelity (${FIDELITIES.join(', ')})`;
    }
  }
  const c = value as RendererCapabilities;
  if (c.handleKinds['native-dom'] !== undefined && c.layering === 'raster') {
    return `${what}: native-dom handles need a DOM layer, but layering is raster`;
  }
  if (c.handleKinds.drawable !== undefined && c.layering === 'dom') {
    return `${what}: drawable handles need a raster layer, but layering is dom`;
  }
  const exact = Object.entries(c.handleKinds).find(([, fidelity]) => fidelity === 'exact');
  if (exact !== undefined && c.transformMode === 'translate') {
    return `${what}: ${exact[0]} content cannot be exact with translate transforms, which cannot scale a card`;
  }
  if (c.handleKinds.drawable === 'native' || c.handleKinds['proxy-only'] === 'native') {
    return `${what}: only native-dom content can have native fidelity`;
  }
  const proxy = c.handleKinds['proxy-only'];
  if (proxy !== undefined && proxy !== 'proxy' && proxy !== 'unsupported') {
    return `${what}: proxy-only handles cannot be presented better than as proxies`;
  }
  return null;
}

/**
 * Why a compositor's capabilities are malformed or self-contradictory, or null when valid: the
 * first problem, in words naming the field (`compositor capabilities.<field>`). It accepts any
 * value and never throws; an unknown field is a problem too. Registration refuses capabilities it
 * faults.
 */
export function compositorCapabilitiesIssue(value: unknown): string | null {
  const what = 'compositor capabilities';
  const record = fields(
    value,
    [
      'layerCategories',
      'ordering',
      'masking',
      'transparency',
      'clipping',
      'overlays',
      'interpolation',
      'directNative',
      'multiViewport',
      'occlusion',
    ],
    what,
  );
  if (typeof record === 'string') {
    return record;
  }
  const shape =
    oneOf(record, 'ordering', ['explicit', 'dom-order'], what) ??
    oneOf(record, 'clipping', CLIPS, what) ??
    oneOf(record, 'occlusion', ['depth', 'layer-order'], what) ??
    bools(
      record,
      ['masking', 'transparency', 'overlays', 'interpolation', 'directNative', 'multiViewport'],
      what,
    );
  if (shape !== null) {
    return shape;
  }
  const categories = record['layerCategories'];
  if (!Array.isArray(categories)) {
    return `${what}.layerCategories must be an array`;
  }
  const seen = new Set<string>();
  for (const category of categories as unknown[]) {
    if (
      typeof category !== 'string' ||
      !(LAYER_CATEGORIES as readonly string[]).includes(category)
    ) {
      return `${what}.layerCategories has ${JSON.stringify(category)}, not a layer category`;
    }
    if (seen.has(category)) {
      return `${what}.layerCategories repeats ${category}`;
    }
    seen.add(category);
  }
  // Every compositor must be able to show an honest placeholder and keep chrome apart.
  for (const required of ['placeholder', 'chrome'] as const) {
    if (!seen.has(required)) {
      return `${what}.layerCategories must include ${required}`;
    }
  }
  const c = value as CompositorCapabilities;
  if (seen.has('content-native') !== c.directNative) {
    return `${what}: a content-native layer and direct native presentation go together`;
  }
  if (seen.has('overlay') !== c.overlays) {
    return `${what}: an overlay layer and overlay support go together`;
  }
  return null;
}

/**
 * Why a projection profile is malformed, or null when valid: the first problem, in words naming
 * the field (`projection profile.<field>`). It accepts any value and never throws; an unknown
 * field is a problem too.
 */
export function projectionProfileIssue(value: unknown): string | null {
  const what = 'projection profile';
  const record = fields(value, ['id', 'seamWrapping', 'exactInverse'], what);
  if (typeof record === 'string') {
    return record;
  }
  if (typeof record['id'] !== 'string' || !VERSIONED_ID.test(record['id'])) {
    return `${what}.id must be a versioned ID "<name>/<version>" (got ${JSON.stringify(record['id'])})`;
  }
  return bools(record, ['seamWrapping', 'exactInverse'], what);
}

export function isVersionedId(value: unknown): value is string {
  return typeof value === 'string' && VERSIONED_ID.test(value);
}
