import type { Id } from '@swf/core';
import type { Fidelity, InteractionSupport, SurfaceCapabilities } from '@swf/surfaces';
import type { CompositorCapabilities, LayerCategory, ProjectionProfile, RendererCapabilities } from './capabilities.js';
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
/** Every {@link PresentationMode}, best first; frozen. */
export declare const PRESENTATION_MODES: readonly PresentationMode[];
/**
 * The modes negotiation may choose, in the order it tries them. It must end with `placeholder`,
 * which is always possible.
 */
export interface FallbackPolicy {
    /** The modes to try, each at most once and ending with `placeholder`; the first is preferred. */
    readonly order: readonly PresentationMode[];
}
/** The policy used when none is given: every mode, best first ({@link PRESENTATION_MODES}). */
export declare const DEFAULT_FALLBACK_POLICY: FallbackPolicy;
/**
 * Validates a fallback order and makes it a policy. Throws {@link SwfFailure} (`INVALID_INPUT`,
 * with path `order`) naming the problem: an order that is not an array or is empty, an entry
 * that is not a presentation mode, a mode listed twice, or a last mode other than `placeholder`.
 * The policy returned is frozen and holds its own frozen copy of the order.
 */
export declare function fallbackPolicy(order: readonly PresentationMode[]): FallbackPolicy;
/** What negotiation weighs for one surface in one viewport. */
export interface NegotiationInput {
    /** The surface negotiated for. */
    readonly surfaceId: Id;
    /** The viewport it is presented in. */
    readonly viewportId: Id;
    /** The bound handle's capabilities, or null when the surface has no bound handle. */
    readonly surface: SurfaceCapabilities | null;
    /** The viewport's renderer. */
    readonly renderer: {
        /** Its versioned ID, carried into diagnostics. */
        readonly id: string;
        /** What it declared, as registration validated it. */
        readonly capabilities: RendererCapabilities;
    };
    /** The viewport's compositor. */
    readonly compositor: {
        /** Its versioned ID, carried into diagnostics. */
        readonly id: string;
        /** What it declared, as registration validated it. */
        readonly capabilities: CompositorCapabilities;
    };
    /**
     * The profile of the viewport's projection: a `nonlinear` mapping rules out `native`, and
     * `exact` without a renderer's `mesh` transforms.
     */
    readonly projection: ProjectionProfile;
    /** The surface geometry: its kind, whether its provider is registered, and its fidelity. */
    readonly geometry: {
        /**
         * The geometry kind, such as `rect` or `polygon`; a polygon is presented `exact` or `native`
         * only with path clipping.
         */
        readonly kind: string;
        /**
         * Whether a provider for the kind is registered; without one, neither `exact` nor `native` is
         * possible.
         */
        readonly supported: boolean;
        /**
         * Whether the provider places the geometry exactly; `approximate` rules out `exact` and
         * `native`.
         */
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
export type Requirement = 'surface' | 'renderer' | 'compositor' | 'projection' | 'geometry' | 'ownership';
/** One reason a mode was ruled out. A mode may have several. */
export interface CapabilityGap {
    /** The mode ruled out. */
    readonly mode: PresentationMode;
    /** Whose capabilities ruled it out. */
    readonly requirement: Requirement;
    /** What was missing, in words, such as `a polygon needs path clipping`. */
    readonly detail: string;
}
/**
 * Why a surface is presented below the policy's preferred mode: each better mode and what ruled it
 * out. Identical fallbacks share a `groupKey`, so a log can show them once with a count.
 */
export interface FallbackDiagnostic {
    /** Always `PRESENTATION_FALLBACK`. */
    readonly code: 'PRESENTATION_FALLBACK';
    /** The surface presented below the preferred mode. */
    readonly surfaceId: Id;
    /** The viewport it is presented in. */
    readonly viewportId: Id;
    /** The viewport's renderer. */
    readonly rendererId: string;
    /** The viewport's compositor. */
    readonly compositorId: string;
    /** The viewport's projection. */
    readonly projectionId: string;
    /**
     * The first mode tried: the policy's first, or for a surface represented compactly or by its
     * label, the first stand-in mode.
     */
    readonly preferred: PresentationMode;
    /** The mode presented instead. */
    readonly chosen: PresentationMode;
    /** Every reason each better mode was ruled out, best mode first; frozen. */
    readonly gaps: readonly CapabilityGap[];
    /**
     * The same for every fallback with the same backends, projection, attach strategy, outcome and
     * reasons, whatever the surface or viewport.
     */
    readonly groupKey: string;
    /** The fallback in words, naming the surface, viewport, both modes and every reason. */
    readonly message: string;
}
/**
 * The outcome of negotiation. Geometric fidelity is reported in two parts, the anchor (where the
 * surface is placed) and the shape (whether its interior follows the projection), separately from
 * content fidelity: a live element can be placed exactly while its shape is approximated, and the
 * result says so.
 */
export interface Negotiation {
    /** The surface negotiated for. */
    readonly surfaceId: Id;
    /** The viewport it is presented in. */
    readonly viewportId: Id;
    /** The mode chosen: the first of the tried modes that nothing ruled out. */
    readonly mode: PresentationMode;
    /** Whether the surface's placement is exact: the projected anchor's fidelity, as given. */
    readonly anchorFidelity: 'exact' | 'approximate';
    /**
     * Whether the presented interior follows the projection: `exact` for `exact` and `native`,
     * `approximate` for `approximated` and `proxy`, `none` for a placeholder.
     */
    readonly shapeFidelity: 'exact' | 'approximate' | 'none';
    /**
     * How faithful the content is: `native` for a live element, `exact` or `approximate` for drawn
     * content, `proxy` for a proxy and `unsupported` for a placeholder.
     */
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
 * (`Swf.Fallback`) decides. The surface is taken as its own native-owner fragment, shown in full;
 * {@link planFrame} negotiates a whole frame's fragments. The result is frozen.
 *
 * @param policy - Default {@link DEFAULT_FALLBACK_POLICY}; one made by {@link fallbackPolicy}
 *   always ends with `placeholder`.
 * @throws Error when no mode of the policy is possible, which only a policy not ending with
 *   `placeholder` allows.
 */
export declare function negotiate(input: NegotiationInput, policy?: FallbackPolicy): Negotiation;
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
export declare function negotiateFragments(backends: FrameBackends, fragments: readonly FragmentInput[], policy?: FallbackPolicy): Negotiation[];
/**
 * The modes negotiation tries, in the policy's order: for a surface the viewport represents (a
 * compact preview or its label), only the stand-ins, proxy and placeholder.
 */
export declare function standInModes(represented: boolean, policy: FallbackPolicy): readonly PresentationMode[];
//# sourceMappingURL=negotiation.d.ts.map