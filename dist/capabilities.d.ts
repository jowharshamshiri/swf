import type { AttachStrategy, Fidelity } from '@swf/surfaces';
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
    /**
     * Each handle kind (attach strategy) the renderer presents, with the best transform fidelity it
     * achieves for it; a kind left out is not presented, and at least one must be named. A
     * `native-dom` kind needs a DOM layer and is `exact` only with `mesh` transforms; a `drawable`
     * kind needs a raster layer; only `native-dom` content can be `native`, and `proxy-only` content
     * is at best `proxy`.
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
export type LayerCategory = 'content-native' | 'content-raster' | 'proxy' | 'placeholder' | 'chrome' | 'overlay';
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
 * What negotiation needs to know of a projection: whether it maps planar geometry to the screen
 * affinely (a perspective camera) or nonlinearly (a panorama bends straight edges), whether it
 * wraps at a seam, and whether its inverse is exact.
 */
export interface ProjectionProfile {
    /** A versioned ID, `<name>/<version>`. */
    readonly id: string;
    /**
     * `affine`: planar geometry stays planar on screen (a perspective camera); `nonlinear`: straight
     * edges bend (a panorama), so live planar content can only approximate its shape.
     */
    readonly mapping: 'affine' | 'nonlinear';
    /** Whether the image's edges meet at a seam, so a surface can show as several fragments. */
    readonly seamWrapping: boolean;
    /** Whether every screen point maps back to its exact ray. */
    readonly exactInverse: boolean;
}
/** Every {@link LayerCategory}, in the order the type lists them. */
export declare const LAYER_CATEGORIES: readonly LayerCategory[];
export declare const clipRank: (c: ClipSupport) => number;
export declare const transformRank: (t: TransformMode) => number;
export declare const fidelityRank: (f: Fidelity) => number;
/**
 * Why a renderer's capabilities are malformed or self-contradictory, or null when valid: the
 * first problem, in words naming the field (`renderer capabilities.<field>`). It accepts any value
 * and never throws; an unknown field is a problem too. Registration refuses capabilities it
 * faults.
 */
export declare function rendererCapabilitiesIssue(value: unknown): string | null;
/**
 * Why a compositor's capabilities are malformed or self-contradictory, or null when valid: the
 * first problem, in words naming the field (`compositor capabilities.<field>`). It accepts any
 * value and never throws; an unknown field is a problem too. Registration refuses capabilities it
 * faults.
 */
export declare function compositorCapabilitiesIssue(value: unknown): string | null;
/**
 * Why a projection profile is malformed, or null when valid: the first problem, in words naming
 * the field (`projection profile.<field>`). It accepts any value and never throws; an unknown
 * field is a problem too.
 */
export declare function projectionProfileIssue(value: unknown): string | null;
export declare function isVersionedId(value: unknown): value is string;
//# sourceMappingURL=capabilities.d.ts.map