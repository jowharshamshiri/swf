import type { Id } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type {
  Fidelity as LeanFidelity,
  Interaction as LeanInteraction,
  LayerCategory as LeanLayerCategory,
  Mode as LeanMode,
  Negotiated,
  Strategy,
  TransformMode as LeanTransformMode,
} from '@swf/models';
import { models } from '@swf/models';
import type {
  AttachStrategy,
  Fidelity,
  InteractionSupport,
  SurfaceCapabilities,
} from '@swf/surfaces';
import type {
  CompositorCapabilities,
  LayerCategory,
  ProjectionProfile,
  RendererCapabilities,
  TransformMode,
} from './capabilities.js';

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
  const given: unknown = order;
  if (!Array.isArray(given)) {
    return fail('must list at least one mode');
  }
  const names = given as readonly unknown[];
  const modes = names.filter((mode): mode is string => typeof mode === 'string');
  const stranger = names.find((mode) => typeof mode !== 'string');
  if (modes.length !== names.length) {
    fail(
      `names ${JSON.stringify(stranger)}, not a presentation mode (${PRESENTATION_MODES.join(', ')})`,
    );
  }
  const issue = models.policyIssue(modes);
  if (issue !== null) {
    switch (issue.kind) {
      case 'empty':
        return fail('must list at least one mode');
      case 'unknown':
        return fail(
          `names ${JSON.stringify(issue.name)}, not a presentation mode (${PRESENTATION_MODES.join(', ')})`,
        );
      case 'repeats':
        return fail(`repeats ${issue.m.kind}`);
      case 'notEndingWithPlaceholder':
        return fail('must end with placeholder, the mode that is always possible');
    }
  }
  // The model found every entry a mode.
  return Object.freeze({ order: Object.freeze(modes as PresentationMode[]) });
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
 * ruled out is reported with the requirement that ruled it out. The fallback model
 * (`Swf.Fallback`) decides.
 */
export function negotiate(
  input: NegotiationInput,
  policy: FallbackPolicy = DEFAULT_FALLBACK_POLICY,
): Negotiation {
  const [only] = negotiateFragments(
    input,
    [{ ...input, nativeOwner: true, represented: false }],
    policy,
  );
  if (only === undefined) {
    throw new Error('the fallback model answered no fragment');
  }
  return only;
}

/** What a frame's fragments share: the viewport and its backends. */
export interface FrameBackends {
  readonly viewportId: Id;
  readonly renderer: NegotiationInput['renderer'];
  readonly compositor: NegotiationInput['compositor'];
  readonly projection: ProjectionProfile;
}

/**
 * One fragment to negotiate: `owner` says whether its viewport may hold the live handle,
 * `nativeOwner` whether it is the surface's native-owner fragment there, and `represented` whether
 * the viewport represents the surface instead of showing it.
 */
export type FragmentInput = Omit<NegotiationInput, keyof FrameBackends> & {
  readonly nativeOwner: boolean;
  readonly represented: boolean;
};

/** Negotiates every fragment of a frame at once, in order: one decision of the fallback model. */
export function negotiateFragments(
  backends: FrameBackends,
  fragments: readonly FragmentInput[],
  policy: FallbackPolicy = DEFAULT_FALLBACK_POLICY,
): Negotiation[] {
  if (fragments.length === 0) {
    return [];
  }
  const order = policy.order.map((mode): LeanMode => ({ kind: mode }));
  const answers = models.negotiateFrame(
    {
      renderer: {
        handleKinds: Object.entries(backends.renderer.capabilities.handleKinds).map(
          ([strategy, fidelity]): [Strategy, LeanFidelity] => [
            leanStrategy(strategy as AttachStrategy),
            { kind: fidelity },
          ],
        ),
        transformMode: { kind: TRANSFORM_MODES[backends.renderer.capabilities.transformMode] },
        clipping: { kind: backends.renderer.capabilities.clipping },
      },
      compositor: {
        layerCategories: backends.compositor.capabilities.layerCategories.map(
          (category): LeanLayerCategory => ({ kind: LEAN_LAYERS[category] }),
        ),
        directNative: backends.compositor.capabilities.directNative,
        clipping: { kind: backends.compositor.capabilities.clipping },
        transparency: backends.compositor.capabilities.transparency,
      },
      nonlinear: backends.projection.mapping === 'nonlinear',
    },
    fragments.map((fragment) => ({
      handle:
        fragment.surface === null
          ? null
          : {
              strategy: leanStrategy(fragment.surface.attachStrategy),
              nativeInteraction: { kind: LEAN_INTERACTIONS[fragment.surface.nativeInteraction] },
              transformFidelity: { kind: fragment.surface.transformFidelity },
              transparency: fragment.surface.transparency,
              shared: fragment.surface.viewportSharing === 'shared',
            },
      geometryKind: fragment.geometry.kind,
      geometrySupported: fragment.geometry.supported,
      geometryExact: fragment.geometry.fidelity === 'exact',
      anchorExact: fragment.anchor === 'exact',
      viewportOwns: fragment.owner,
      nativeOwner: fragment.nativeOwner,
      order,
      represented: fragment.represented,
    })),
  );
  return fragments.map((fragment, i) => {
    const answer = answers[i];
    if (answer === undefined || answer === null) {
      throw new Error(
        `the fallback policy left surface "${fragment.surfaceId}" with no mode: it must end with placeholder`,
      );
    }
    return result({ ...fragment, ...backends }, answer, fragment.represented, policy);
  });
}

function result(
  input: NegotiationInput,
  answer: Negotiated,
  represented: boolean,
  policy: FallbackPolicy,
): Negotiation {
  const mode = answer.mode.kind;
  const gaps: CapabilityGap[] = answer.gaps.map((gap) =>
    Object.freeze({ mode: gap.mode.kind, requirement: gap.requirement.kind, detail: gap.detail }),
  );
  const tried = standInModes(represented, policy);
  const preferred = tried[0] ?? mode;
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
          gaps: Object.freeze(gaps),
          groupKey: [
            input.renderer.id,
            input.compositor.id,
            input.projection.id,
            input.surface?.attachStrategy ?? 'unbound',
            mode,
            ...gaps.map((g) => `${g.mode}:${g.requirement}:${g.detail}`),
          ].join('|'),
          message: `surface "${input.surfaceId}" is presented as ${mode} in viewport "${input.viewportId}" instead of ${preferred}: ${gaps
            .map((g) => `${g.mode} needs ${g.requirement} (${g.detail})`)
            .join('; ')}`,
        });
  return Object.freeze({
    surfaceId: input.surfaceId,
    viewportId: input.viewportId,
    mode,
    anchorFidelity: input.anchor,
    shapeFidelity: answer.shape.kind,
    contentFidelity: answer.content.kind,
    interaction: INTERACTIONS[answer.interaction.kind],
    layer: LAYERS[answer.layer.kind],
    fallback,
  });
}

/**
 * The modes negotiation tries, in the policy's order: for a surface the viewport represents (a
 * compact preview or its label), only the stand-ins, proxy and placeholder.
 */
export function standInModes(
  represented: boolean,
  policy: FallbackPolicy,
): readonly PresentationMode[] {
  return Object.freeze(
    models
      .representedModes(
        represented,
        policy.order.map((mode): LeanMode => ({ kind: mode })),
      )
      .map((mode) => mode.kind),
  );
}

const STRATEGIES: Readonly<Record<AttachStrategy, Strategy['kind']>> = Object.freeze({
  'native-dom': 'nativeDom',
  drawable: 'drawable',
  'proxy-only': 'proxyOnly',
});

function leanStrategy(strategy: AttachStrategy): Strategy {
  return { kind: STRATEGIES[strategy] };
}

const TRANSFORM_MODES: Readonly<Record<TransformMode, LeanTransformMode['kind']>> = Object.freeze({
  translate: 'translate',
  'affine-2d': 'affine2d',
  'perspective-3d': 'perspective3d',
  mesh: 'mesh',
});

const LEAN_INTERACTIONS: Readonly<Record<InteractionSupport, LeanInteraction['kind']>> =
  Object.freeze({ full: 'full', partial: 'partly', none: 'none' });

const INTERACTIONS: Readonly<Record<LeanInteraction['kind'], InteractionSupport>> = Object.freeze({
  full: 'full',
  partly: 'partial',
  none: 'none',
});

const LEAN_LAYERS: Readonly<Record<LayerCategory, LeanLayerCategory['kind']>> = Object.freeze({
  'content-native': 'contentNative',
  'content-raster': 'contentRaster',
  proxy: 'proxy',
  placeholder: 'placeholder',
  chrome: 'chrome',
  overlay: 'overlay',
});

const LAYERS: Readonly<Record<LeanLayerCategory['kind'], LayerCategory>> = Object.freeze({
  contentNative: 'content-native',
  contentRaster: 'content-raster',
  proxy: 'proxy',
  placeholder: 'placeholder',
  chrome: 'chrome',
  overlay: 'overlay',
});
