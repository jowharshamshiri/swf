import type { Id } from '@swf/core';
import type { ComposedFrame, CompositionTarget, Compositor, CompositorCapabilities, CompositorSession, RenderedFrame, RendererSession } from '@swf/presentation';
import { DomRendererSession } from './renderer.js';
/** The DOM compositor's registered ID, as {@link DomCompositor} declares it. */
export declare const DOM_COMPOSITOR_ID = "swf.dom-compositor/1";
/**
 * What the DOM compositor can do: it assembles live content, proxies, placeholders, chrome and
 * overlays as DOM layers, ordered explicitly (by stacking order, never by moving elements), clipped
 * to rectangles. It has no raster layer. Frozen.
 */
export declare const DOM_COMPOSITOR_CAPABILITIES: CompositorCapabilities;
/** Assembles a DOM renderer's layers into the host's container, one session per viewport. */
export declare class DomCompositor implements Compositor {
    /** {@link DOM_COMPOSITOR_ID}. */
    readonly id = "swf.dom-compositor/1";
    /** The presentation API version it implements. */
    readonly apiVersion = 1;
    /** {@link DOM_COMPOSITOR_CAPABILITIES}, the same object on every call. */
    capabilities(): CompositorCapabilities;
    /**
     * Puts the renderer session's root in the target container. The container must be an element
     * of the renderer's document, and the renderer a DOM renderer session of the same viewport;
     * otherwise it rejects with {@link SwfFailure} (`INVALID_INPUT`). The container stays the
     * host's; the session takes the root out again when released.
     */
    prepare(target: CompositionTarget, renderer: RendererSession): Promise<CompositorSession>;
}
/**
 * A DOM compositor's session for one viewport, assembling one DOM renderer session's layers in
 * its root. The presenter owns it and releases it.
 */
export declare class DomCompositorSession implements CompositorSession {
    #private;
    /** The compositor that prepared it. */
    readonly compositorId: string;
    /** The viewport it composes: its renderer session's. */
    readonly viewportId: Id;
    /** A session over `renderer`, as {@link DomCompositor.prepare} makes it. */
    constructor(compositorId: string, renderer: DomRendererSession);
    /**
     * Stacks the layers in the rendered order by `z-index`. A layer's element is appended to the
     * view's root the first time it appears and never moved after, so live content (an iframe, a
     * video) is never re-parented, which would reload it.
     *
     * @throws {@link @swf/core!SwfFailure} `INVALID_TRANSITION` once released; `INVALID_INPUT`
     *   for a frame of another viewport, or a layer that is not an element of this view or already
     *   has another parent.
     */
    compose(frame: RenderedFrame): ComposedFrame;
    /** DOM elements are never lost, so this never calls `listener`. */
    watchLoss(): () => void;
    /** Takes the view's root out of the container. Safe to call more than once. */
    release(): Promise<void>;
}
//# sourceMappingURL=compositor.d.ts.map