import type { Id, SceneState } from '@swf/core';
import type { CompositorCapabilities, LayerCategory, Occlusion, RendererCapabilities } from './capabilities.js';
import type { ProjectedFragment, ViewGeometry, ViewOutput } from './fragments.js';
import type { FallbackDiagnostic, Negotiation } from './negotiation.js';
import type { Representation } from './representation.js';
import type { SurfaceCondition } from './conditions.js';
/** The version of the renderer and compositor contracts this package defines. */
export declare const PRESENTATION_API_VERSION = 1;
/** A fragment with the presentation negotiated for it. */
export interface PlannedFragment {
    /** The fragment as the view output holds it. */
    readonly fragment: ProjectedFragment;
    /** How it is presented: the mode, its fidelities, interaction and layer category. */
    readonly negotiation: Negotiation;
    /**
     * How the viewport's representation policy chose to represent the surface: `full` unless one
     * chose less. A `compact` or `label` fragment is negotiated among the modes that stand for the
     * surface (a proxy, or a placeholder when no proxy is possible); a renderer draws a `label`
     * proxy as the surface's label alone, and leaves out its window's chrome.
     */
    readonly representation: Representation;
    /** Where the surface's binding stands: what a stand-in for its content says (FR-195). */
    readonly condition: SurfaceCondition;
}
/** One frame for one viewport: what to realize, in presentation order (back to front). */
export interface RenderFrame {
    /** The viewport the frame is for. */
    readonly viewportId: Id;
    /** The revision of the presented scene the frame was planned from. */
    readonly sceneRevision: number;
    /** The scene at `sceneRevision`, for what a renderer shows besides content (labels, selection). */
    readonly scene: SceneState;
    /** The view the fragments were projected for. */
    readonly view: ViewGeometry;
    /** The projected fragments, back to front, with their surfaces. */
    readonly output: ViewOutput;
    /** One entry per fragment of `output`, in the same order (back to front); frozen. */
    readonly planned: readonly PlannedFragment[];
    /** Every fallback negotiation chose, for diagnostics. */
    readonly fallbacks: readonly FallbackDiagnostic[];
}
/**
 * One layer a renderer produced. Content, proxy and placeholder layers each realize exactly one
 * fragment; chrome and overlay layers may belong to a surface or to none.
 */
export interface CompositionLayer {
    /** Unique within the frame and stable for the same fragment and category across frames. */
    readonly id: string;
    /**
     * What the layer holds. Only `content-native` layers hold live content: their surfaces are the
     * ones attached in the view.
     */
    readonly category: LayerCategory;
    /** The fragment the layer realizes; null only for a chrome or overlay layer of no fragment. */
    readonly fragmentId: string | null;
    /** The surface the layer belongs to; null only for a chrome or overlay layer of none. */
    readonly surfaceId: Id | null;
    /** The renderer's own resource for the layer, opaque to everyone else. */
    readonly content: unknown;
}
/** The size of a view: CSS pixels across and down, and device pixels per CSS pixel. */
export interface ViewSize {
    /** CSS pixels across, positive. */
    readonly width: number;
    /** CSS pixels down, positive. */
    readonly height: number;
    /** Device pixels per CSS pixel, positive. */
    readonly devicePixelRatio: number;
}
/** What a renderer realized for a frame, in presentation order (back to front). */
export interface RenderedFrame {
    /** The viewport of the frame rendered. */
    readonly viewportId: Id;
    /** The scene revision of the frame rendered. */
    readonly sceneRevision: number;
    /** The frame's view size, for a compositor sizing what it assembles. */
    readonly size: ViewSize;
    /**
     * How many changes this render made to what it presents (element properties, layer content):
     * a view that did not change makes none.
     */
    readonly writes: number;
    /** Every layer realized, back to front, following the plan's order. */
    readonly layers: readonly CompositionLayer[];
}
/**
 * A renderer prepared for one viewport. It owns the resources it creates until released; whoever
 * prepared it (the presenter, for its viewports) must call {@link RendererSession.release} when
 * done with it. Releasing never touches the producers of the content it presented: an attached
 * endpoint stays the host's.
 */
export interface RendererSession {
    /** The versioned ID of the renderer that prepared it. */
    readonly rendererId: string;
    /** The one viewport it renders. */
    readonly viewportId: Id;
    /**
     * Realizes a planned frame. For the same frame it must produce the same layers in the same
     * order: the order follows the plan, never incidental insertion order.
     */
    render(frame: RenderFrame): RenderedFrame;
    /**
     * Where a surface's own content attaches in this view (the container of its presentation
     * target), once a render has planned it live here; undefined before that.
     */
    targetOf(surfaceId: Id): unknown;
    /**
     * Calls `listener` when the session loses resources it cannot present without (a graphics
     * context, say), with what was lost. Returns a function that stops listening.
     */
    watchLoss(listener: LossListener): () => void;
    /** Releases what the session created. Safe to call more than once. */
    release(): Promise<void>;
}
/** Told what a session lost; the session cannot present until it is replaced. */
export type LossListener = (reason: string) => void;
/**
 * Realizes views. It reads the scene but never changes it, and never manages the producers of
 * what it presents.
 */
export interface RendererBackend {
    /** A versioned ID, `<name>/<version>`. */
    readonly id: string;
    /**
     * The contract version it implements; registration refuses any but
     * {@link PRESENTATION_API_VERSION} with `UNSUPPORTED_CAPABILITY`.
     */
    readonly apiVersion: number;
    /**
     * What it can present. Registration calls it once and keeps a frozen copy, validated by
     * {@link rendererCapabilitiesIssue}; later answers are not consulted.
     */
    capabilities(): RendererCapabilities;
    /**
     * Prepares a session for one viewport, showing `scene` through `view`. The caller owns the
     * session and releases it. A backend that rejects leaves nothing behind, since there is no
     * session to release.
     */
    prepare(scene: SceneState, view: ViewGeometry): Promise<RendererSession>;
}
/** Where a compositor assembles a viewport: the host's container, opaque to the framework. */
export interface CompositionTarget {
    /** The viewport assembled there. */
    readonly viewportId: Id;
    /**
     * The host's container (a DOM element, in a browser), as the viewport's options give it. A
     * compositor removes what it added to it when released; the container stays the host's.
     */
    readonly container: unknown;
}
/** The layers as assembled, back to front. */
export interface ComposedFrame {
    /** The viewport assembled. */
    readonly viewportId: Id;
    /** The scene revision of the frame assembled. */
    readonly sceneRevision: number;
    /** The IDs of the layers as assembled, back to front. */
    readonly order: readonly string[];
    /** How this frame's overlapping layers occlude each other, as the compositor declares. */
    readonly occlusion: Occlusion;
    /** How many changes composing made (stacking, placement, repaints): none for an unchanged frame. */
    readonly writes: number;
}
/**
 * A compositor prepared for one viewport, over one renderer session. It owns what it adds to the
 * container until released; whoever prepared it releases it, before the renderer session it
 * assembles.
 */
export interface CompositorSession {
    /** The versioned ID of the compositor that prepared it. */
    readonly compositorId: string;
    /** The one viewport it assembles. */
    readonly viewportId: Id;
    /**
     * Assembles a rendered frame. An `explicit`-ordering compositor keeps the rendered order; a
     * `dom-order` compositor declares that its order is the DOM's.
     */
    compose(frame: RenderedFrame): ComposedFrame;
    /** As {@link RendererSession.watchLoss}: calls `listener` when the session loses resources. */
    watchLoss(listener: LossListener): () => void;
    /** Releases what the session created. Safe to call more than once. */
    release(): Promise<void>;
}
/** Assembles a renderer's layers into a viewport, keeping chrome apart from content. */
export interface Compositor {
    /** A versioned ID, `<name>/<version>`. */
    readonly id: string;
    /**
     * The contract version it implements; registration refuses any but
     * {@link PRESENTATION_API_VERSION} with `UNSUPPORTED_CAPABILITY`.
     */
    readonly apiVersion: number;
    /**
     * What it can assemble. Registration calls it once and keeps a frozen copy, validated by
     * {@link compositorCapabilitiesIssue}; later answers are not consulted.
     */
    capabilities(): CompositorCapabilities;
    /**
     * Prepares a session assembling `renderer`'s frames in `target`. The caller owns the session
     * and releases it; the renderer session stays the caller's too. A compositor that rejects leaves
     * nothing behind, since there is no session to release.
     */
    prepare(target: CompositionTarget, renderer: RendererSession): Promise<CompositorSession>;
}
//# sourceMappingURL=contracts.d.ts.map