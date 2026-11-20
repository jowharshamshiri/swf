import type { Id } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type { Fidelity, InteractionSupport, SurfaceCapabilities } from '@swf/surfaces';
import type {
  CompositorCapabilities,
  LayerCategory,
  ProjectionProfile,
  RendererCapabilities,
} from './capabilities.js';
import { clipRank, fidelityRank, transformRank } from './capabilities.js';

/**
 * How a surface is presented in one viewport, best first:
 * - `exact`: drawn content following the projection exactly, interior included;
 * - `native`: the live element, placed exactly, interaction native;
 * - `approximated`: live content whose anchor is placed exactly but whose shape only approximates
 *   the projection (a planar element in a panorama);
 * - `proxy`: a representation of the surface instead of its live content;
 * - `placeholder`: the surface's identity and geometry only.
 */
export type PresentationMode = 'exact' | 'native' | 'approximated' | 'proxy' | 'placeholder';

export const PRESENTATION_MODES: readonly PresentationMode[] = Object.freeze([
  'exact',
  'native',
  'approximated',
  'proxy',
  'placeholder',
]);

/**
 * The modes negotiation may choose, in the order it tries them. It must end with `placeholder`,
 * which is always possible.
 */
export interface FallbackPolicy {
  readonly order: readonly PresentationMode[];
}

export const DEFAULT_FALLBACK_POLICY: FallbackPolicy = Object.freeze({
  order: PRESENTATION_MODES,
});

/** Validates a policy. Throws {@link SwfFailure} (`INVALID_INPUT`) naming the problem. */
export function fallbackPolicy(order: readonly PresentationMode[]): FallbackPolicy {
  const fail = (message: string): never => {
    throw new SwfFailure(
      makeError('INVALID_INPUT', `fallback policy ${message}`, { path: 'order' }),
    );
  };
  if (!Array.isArray(order) || order.length === 0) {
    fail('must list at least one mode');
  }
  const seen = new Set<string>();
  for (const mode of order) {
    if (!(PRESENTATION_MODES as readonly string[]).includes(mode)) {
      fail(
        `names ${JSON.stringify(mode)}, not a presentation mode (${PRESENTATION_MODES.join(', ')})`,
      );
    }
    if (seen.has(mode)) {
      fail(`repeats ${mode}`);
    }
    seen.add(mode);
  }
  if (order.at(-1) !== 'placeholder') {
    fail('must end with placeholder, the mode that is always possible');
  }
  return Object.freeze({ order: Object.freeze([...order]) });
}

/** What negotiation weighs for one surface in one viewport. */
export interface NegotiationInput {
  readonly surfaceId: Id;
  readonly viewportId: Id;
  /** The bound handle's capabilities, or null when the surface has no bound handle. */
  readonly surface: SurfaceCapabilities | null;
  readonly renderer: { readonly id: string; readonly capabilities: RendererCapabilities };
  readonly compositor: { readonly id: string; readonly capabilities: CompositorCapabilities };
  readonly projection: ProjectionProfile;
  /** The surface geometry: its kind, whether its provider is registered, and its fidelity. */
  readonly geometry: {
    readonly kind: string;
    readonly supported: boolean;
    readonly fidelity: 'exact' | 'approximate';
  };
  /** Whether the projected anchor (the fragment's placement) is exact. */
  readonly anchor: 'exact' | 'approximate';
  /**
   * Whether this fragment may hold the live handle. False for a secondary seam fragment, or when a
   * single-owner handle is presented in another viewport.
   */
  readonly owner: boolean;
}

/** Which party's capabilities rule a mode out. */
export type Requirement =
  'surface' | 'renderer' | 'compositor' | 'projection' | 'geometry' | 'ownership';

export interface CapabilityGap {
  readonly mode: PresentationMode;
  readonly requirement: Requirement;
  readonly detail: string;
}

/**
 * Why a surface is presented below the policy's preferred mode: each better mode and what ruled it
 * out. Identical fallbacks share a `groupKey`, so a log can show them once with a count.
 */
export interface FallbackDiagnostic {
  readonly code: 'PRESENTATION_FALLBACK';
  readonly surfaceId: Id;
  readonly viewportId: Id;
  readonly rendererId: string;
  readonly compositorId: string;
  readonly projectionId: string;
  readonly preferred: PresentationMode;
  readonly chosen: PresentationMode;
  readonly gaps: readonly CapabilityGap[];
  readonly groupKey: string;
  readonly message: string;
}

/**
 * The outcome of negotiation. Geometric fidelity is reported in two parts, the anchor (where the
 * surface is placed) and the shape (whether its interior follows the projection), separately from
 * content fidelity: a live element can be placed exactly while its shape is approximated, and the
 * result says so.
 */
export interface Negotiation {
  readonly surfaceId: Id;
  readonly viewportId: Id;
  readonly mode: PresentationMode;
  readonly anchorFidelity: 'exact' | 'approximate';
  readonly shapeFidelity: 'exact' | 'approximate' | 'none';
  readonly contentFidelity: Fidelity;
  /** How much of the content's own interaction stays native in this presentation. */
  readonly interaction: InteractionSupport;
  /** The compositor layer category the presentation goes in. */
  readonly layer: LayerCategory;
  /** Null when the policy's preferred mode was chosen. */
  readonly fallback: FallbackDiagnostic | null;
}

/**
 * Chooses how to present a surface in a viewport: the first mode of the policy that the surface,
 * renderer, compositor, projection, geometry and ownership all allow. Every better mode that was
 * ruled out is reported with the requirement that ruled it out.
 */
export function negotiate(
  input: NegotiationInput,
  policy: FallbackPolicy = DEFAULT_FALLBACK_POLICY,
): Negotiation {
  const gaps: CapabilityGap[] = [];
  for (const mode of policy.order) {
    const ruledOut = gapsFor(mode, input);
    if (ruledOut.length === 0) {
      return result(mode, input, policy, gaps);
    }
    gaps.push(...ruledOut);
  }
  // Unreachable with a validated policy: placeholder is last and never ruled out.
  throw new Error('fallback policy did not end with placeholder');
}

function result(
  mode: PresentationMode,
  input: NegotiationInput,
  policy: FallbackPolicy,
  gaps: readonly CapabilityGap[],
): Negotiation {
  const surface = input.surface;
  const preferred = policy.order[0] ?? mode;
  const fallback =
    mode === preferred
      ? null
      : Object.freeze<FallbackDiagnostic>({
          code: 'PRESENTATION_FALLBACK',
          surfaceId: input.surfaceId,
          viewportId: input.viewportId,
          rendererId: input.renderer.id,
          compositorId: input.compositor.id,
          projectionId: input.projection.id,
          preferred,
          chosen: mode,
          gaps: Object.freeze(gaps.map((g) => Object.freeze(g))),
          groupKey: [
            input.renderer.id,
            input.compositor.id,
            input.projection.id,
            surface?.attachStrategy ?? 'unbound',
            mode,
            ...gaps.map((g) => `${g.mode}:${g.requirement}:${g.detail}`),
          ].join('|'),
          message: `surface "${input.surfaceId}" is presented as ${mode} in viewport "${input.viewportId}" instead of ${preferred}: ${gaps
            .map((g) => `${g.mode} needs ${g.requirement} (${g.detail})`)
            .join('; ')}`,
        });
  const base = {
    surfaceId: input.surfaceId,
    viewportId: input.viewportId,
    mode,
    anchorFidelity: input.anchor,
    fallback,
  };
  const native = surface?.attachStrategy === 'native-dom';
  switch (mode) {
    case 'exact':
      return Object.freeze({
        ...base,
        shapeFidelity: 'exact',
        contentFidelity: 'exact',
        interaction: 'none',
        layer: 'content-raster',
      });
    case 'native':
      return Object.freeze({
        ...base,
        shapeFidelity: 'exact',
        contentFidelity: 'native',
        interaction: surface?.nativeInteraction ?? 'none',
        layer: 'content-native',
      });
    case 'approximated':
      return Object.freeze({
        ...base,
        shapeFidelity: 'approximate',
        // A live element's pixels are its own; drawn content is redrawn approximately.
        contentFidelity: native ? 'native' : 'approximate',
        interaction: native ? surface.nativeInteraction : 'none',
        layer: native ? 'content-native' : 'content-raster',
      });
    case 'proxy':
      return Object.freeze({
        ...base,
        shapeFidelity: 'approximate',
        contentFidelity: 'proxy',
        interaction: 'none',
        layer: 'proxy',
      });
    case 'placeholder':
      return Object.freeze({
        ...base,
        shapeFidelity: 'none',
        contentFidelity: 'unsupported',
        interaction: 'none',
        layer: 'placeholder',
      });
  }
}

/** Every requirement that rules `mode` out for this input; empty when the mode is possible. */
function gapsFor(mode: PresentationMode, input: NegotiationInput): CapabilityGap[] {
  const gaps: CapabilityGap[] = [];
  const gap = (requirement: Requirement, detail: string) => {
    gaps.push({ mode, requirement, detail });
  };
  const { surface, projection, geometry } = input;
  const renderer = input.renderer.capabilities;
  const compositor = input.compositor.capabilities;
  if (mode === 'placeholder') {
    return gaps;
  }
  if (surface === null) {
    gap('surface', 'no bound handle');
    return gaps;
  }
  if (mode === 'proxy') {
    if (!compositor.layerCategories.includes('proxy')) {
      gap('compositor', 'no proxy layer');
    }
    return gaps;
  }
  // The live modes: exact, native, approximated.
  if (!input.owner) {
    gap('ownership', 'another fragment or viewport holds the live handle');
  }
  const strategy = surface.attachStrategy;
  if (strategy === 'proxy-only') {
    gap('surface', 'the endpoint can only be shown as a proxy');
    return gaps;
  }
  const kind = renderer.handleKinds[strategy];
  if (kind === undefined || fidelityRank(kind) < fidelityRank('approximate')) {
    gap('renderer', `cannot present ${strategy} handles`);
  }
  if (strategy === 'native-dom' && !compositor.directNative) {
    gap('compositor', 'cannot present native layers');
  }
  if (strategy === 'drawable' && !compositor.layerCategories.includes('content-raster')) {
    gap('compositor', 'no content-raster layer');
  }
  if (mode === 'approximated') {
    return gaps;
  }
  // exact and native follow the projection exactly.
  if (mode === 'exact') {
    if (strategy !== 'drawable') {
      gap(
        'surface',
        'only drawable content can be warped exactly; live elements are never claimed exact',
      );
    } else {
      if (fidelityRank(surface.transformFidelity) < fidelityRank('exact')) {
        gap('surface', `the endpoint's transform fidelity is ${surface.transformFidelity}`);
      }
      if (kind !== undefined && fidelityRank(kind) < fidelityRank('exact')) {
        gap('renderer', `draws ${strategy} content at ${kind} fidelity`);
      }
    }
  }
  if (mode === 'native' && strategy !== 'native-dom') {
    gap('surface', 'native presentation needs a native-dom endpoint');
  }
  if (projection.mapping === 'nonlinear') {
    if (mode === 'native') {
      gap(
        'projection',
        'a nonlinear projection bends a planar element, which can only approximate it',
      );
    } else if (renderer.transformMode !== 'mesh') {
      gap('renderer', 'a nonlinear projection needs mesh warping');
    }
  } else if (transformRank(renderer.transformMode) < transformRank('perspective-3d')) {
    gap(
      'renderer',
      `its ${renderer.transformMode} transforms cannot follow a perspective projection`,
    );
  }
  if (input.anchor === 'approximate') {
    gap('projection', 'the projected placement is approximate');
  }
  if (!geometry.supported) {
    gap('geometry', `geometry kind "${geometry.kind}" has no provider`);
  } else if (geometry.fidelity === 'approximate') {
    gap('geometry', `geometry kind "${geometry.kind}" is approximate`);
  }
  if (geometry.kind === 'polygon') {
    const clip = Math.min(clipRank(renderer.clipping), clipRank(compositor.clipping));
    if (clip < clipRank('path')) {
      gap(
        clipRank(renderer.clipping) < clipRank('path') ? 'renderer' : 'compositor',
        'a polygon needs path clipping',
      );
    }
  }
  if (surface.transparency && !compositor.transparency) {
    gap('compositor', 'the endpoint is transparent but the compositor is not');
  }
  return gaps;
}
