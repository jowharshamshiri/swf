import type { AttachStrategy, Fidelity } from '@swf/surfaces';
import { ATTACH_STRATEGIES, FIDELITY_ORDER } from '@swf/surfaces';

/** How far a backend can clip: not at all, to rectangles, or to arbitrary paths. */
export type ClipSupport = 'none' | 'rect' | 'path';

/**
 * The most general transform a renderer can apply to presented content: translation only, 2D
 * affine, 3D perspective (planar content), or arbitrary mesh warps (nonlinear deformation).
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
  readonly handleKinds: Readonly<Partial<Record<AttachStrategy, Fidelity>>>;
  readonly transformMode: TransformMode;
  readonly clipping: ClipSupport;
  readonly hitMapping: boolean;
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
 * it presents native layers directly, and whether one instance assembles several viewports.
 */
export interface CompositorCapabilities {
  readonly layerCategories: readonly LayerCategory[];
  readonly ordering: 'explicit' | 'dom-order';
  readonly masking: boolean;
  readonly transparency: boolean;
  readonly clipping: ClipSupport;
  readonly overlays: boolean;
  readonly interpolation: boolean;
  readonly directNative: boolean;
  readonly multiViewport: boolean;
}

/**
 * What negotiation needs to know of a projection: whether it maps planar geometry to the screen
 * affinely (a perspective camera) or nonlinearly (a panorama bends straight edges), whether it
 * wraps at a seam, and whether its inverse is exact.
 */
export interface ProjectionProfile {
  /** A versioned ID, `<name>/<version>`. */
  readonly id: string;
  readonly mapping: 'affine' | 'nonlinear';
  readonly seamWrapping: boolean;
  readonly exactInverse: boolean;
}

const STRATEGIES = ATTACH_STRATEGIES;
const FIDELITIES = FIDELITY_ORDER;
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
const VERSIONED_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[1-9][0-9]*$/;

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

/** Why a renderer's capabilities are malformed or self-contradictory, or null when valid. */
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
  if (c.handleKinds['native-dom'] === 'exact' && c.transformMode !== 'mesh') {
    return `${what}: native-dom content cannot be exact without mesh warping`;
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

/** Why a compositor's capabilities are malformed or self-contradictory, or null when valid. */
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
    ],
    what,
  );
  if (typeof record === 'string') {
    return record;
  }
  const shape =
    oneOf(record, 'ordering', ['explicit', 'dom-order'], what) ??
    oneOf(record, 'clipping', CLIPS, what) ??
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

/** Why a projection profile is malformed, or null when valid. */
export function projectionProfileIssue(value: unknown): string | null {
  const what = 'projection profile';
  const record = fields(value, ['id', 'mapping', 'seamWrapping', 'exactInverse'], what);
  if (typeof record === 'string') {
    return record;
  }
  if (typeof record['id'] !== 'string' || !VERSIONED_ID.test(record['id'])) {
    return `${what}.id must be a versioned ID "<name>/<version>" (got ${JSON.stringify(record['id'])})`;
  }
  return (
    oneOf(record, 'mapping', ['affine', 'nonlinear'], what) ??
    bools(record, ['seamWrapping', 'exactInverse'], what)
  );
}

export function isVersionedId(value: unknown): value is string {
  return typeof value === 'string' && VERSIONED_ID.test(value);
}
