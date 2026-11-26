import type { Id } from '@swf/core';
import type { ComposedFrame, CompositionTarget, Compositor, CompositorCapabilities, CompositorSession, RenderedFrame, LossListener, RendererSession } from '@swf/presentation';
/** The layer compositor's registered ID, as {@link LayerCompositor} declares it. */
export declare const LAYER_COMPOSITOR_ID = "swf.layer-compositor/1";
/**
 * What the layer compositor can do: it assembles live elements and drawn layers together, in an
 * explicit order. Live elements and canvases are stacked as whole layers, so where they overlap
 * each lies entirely in front of or behind the other (`layer-order`): there is no per-pixel depth
 * between a live element and drawn content. Frozen.
 */
export declare const LAYER_COMPOSITOR_CAPABILITIES: CompositorCapabilities;
/**
 * Assembles a viewport from live element layers and drawn layers. Consecutive drawn layers share
 * one canvas; a live element between them splits them into separate canvases, so the stack is
 * exactly the planned order. Elements are appended once and never moved.
 */
export declare class LayerCompositor implements Compositor {
    /** {@link LAYER_COMPOSITOR_ID}. */
    readonly id = "swf.layer-compositor/1";
    /** The presentation API version it implements. */
    readonly apiVersion = 1;
    /** {@link LAYER_COMPOSITOR_CAPABILITIES}, the same object on every call. */
    capabilities(): CompositorCapabilities;
    /**
     * Builds the view's root in the target container, which must be an element. Rejects with
     * {@link SwfFailure} (`INVALID_INPUT`) when it is not, or when the renderer session belongs to
     * another viewport. The container stays the host's; the session takes its root out again when
     * released.
     */
    prepare(target: CompositionTarget, renderer: RendererSession): Promise<CompositorSession>;
}
/**
 * A layer compositor's session for one viewport: a root element, marked
 * `data-swf-composition`, holding the view's canvases and live elements. The presenter owns it
 * and releases it.
 */
export declare class LayerCompositorSession implements CompositorSession {
    #private;
    /** The compositor that prepared it. */
    readonly compositorId: string;
    /** The viewport it composes. */
    readonly viewportId: Id;
    /** The view's root: canvases and live elements are its children. */
    readonly root: HTMLElement;
    /** A session over `root`, as {@link LayerCompositor.prepare} makes it. */
    constructor(compositorId: string, viewportId: Id, root: HTMLElement);
    /**
     * Stacks the frame's layers in order by `z-index`: each live element alone, each run of
     * consecutive drawn layers on one canvas (marked `data-swf-layer="drawn"`, taking no pointer
     * input) at the frame's device pixel ratio. A canvas showing the same layers at the same size is
     * not repainted, and canvases the frame does not need are removed. A live element is appended
     * once and never moved.
     *
     * @throws {@link @swf/core!SwfFailure} `INVALID_TRANSITION` once released; `INVALID_INPUT`
     *   for a frame of another viewport, a layer that is neither drawn nor an element, or an element
     *   with another parent; `UNSUPPORTED_CAPABILITY` when the browser offers no 2D canvas context.
     */
    compose(frame: RenderedFrame): ComposedFrame;
    /**
     * Calls `listener` when the browser takes a canvas's 2D context away (it fires `contextlost`
     * under memory pressure or a lost GPU): what is drawn is gone until the session is replaced.
     */
    watchLoss(listener: LossListener): () => void;
    /**
     * Takes the view's root out of its container, with its canvases and whatever live elements it
     * holds, and drops every loss listener. Composing afterwards throws. Safe to call more than once.
     */
    release(): Promise<void>;
}
//# sourceMappingURL=compositor.d.ts.map