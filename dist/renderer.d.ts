import type { Id, SceneState } from '@swf/core';
import type { RenderedFrame, RendererBackend, RendererCapabilities, RendererSession, RenderFrame, StandInReason, ViewGeometry } from '@swf/presentation';
import type { ProjectionModule } from '@swf/projections';
/** The DOM renderer's registered ID, as {@link DomRenderer} declares it. */
export declare const DOM_RENDERER_ID = "swf.dom-renderer/1";
/**
 * What the DOM renderer can do. It presents live DOM elements natively (placing them, never
 * redrawing them) and proxy-only endpoints as proxies. It cannot draw: drawable content falls back
 * to a proxy. Its transforms are planar perspective (a CSS `matrix3d`), so in a nonlinear
 * projection a live element is placed by its projected corners and only approximates the bend.
 */
export declare const DOM_RENDERER_CAPABILITIES: RendererCapabilities;
/**
 * The colours window chrome is drawn in, as CSS colours (a custom property such as
 * `var(--focus)` included): every frame's outline, and the selected and the focused window's.
 * Each should stand out from what the view is drawn over by 3:1 at least (WCAG 1.4.11), so the
 * window keys act on is seen (WCAG 2.4.7).
 */
export interface ChromeInks {
    /** Every window frame's 1 px outline: a non-blank CSS colour. */
    readonly frame: string;
    /** The selected window's 3 px outline: a non-blank CSS colour. */
    readonly selected: string;
    /** The focused window's 3 px outline, over `selected`: a non-blank CSS colour. */
    readonly focused: string;
}
/** Inks that stand out on a light page by 4.5:1 or more. Frozen. */
export declare const DEFAULT_CHROME_INKS: ChromeInks;
/** Window chrome: frames, titles and resize handles drawn from each window's projected frame. */
export interface ChromeOptions {
    /**
     * The projection modules views use, to project window frames: a projection registry will do.
     * A frame of a view whose projection is not here throws `UNSUPPORTED_CAPABILITY`.
     */
    readonly projections: {
        /** The projection module registered under `id`, or undefined when none is. */
        get(id: string): ProjectionModule | undefined;
    };
    /**
     * Thickness of the resize handles along window edges, in CSS px: positive and finite. Default
     * 12.
     */
    readonly handlePx?: number;
    /**
     * The colours chrome is drawn in, copied when the renderer is made. Default
     * {@link DEFAULT_CHROME_INKS}.
     */
    readonly inks?: ChromeInks;
}
/** What a DOM renderer realizes views in, and how. Checked when the renderer is made. */
export interface DomRendererOptions {
    /** The document every view's elements are made in; the host's containers must belong to it. */
    readonly document: Document;
    /**
     * CSS pixels a live element lays out per world unit of its surface: positive and finite.
     * Default 400.
     */
    readonly pixelsPerUnit?: number;
    /** Draws window chrome when given; without it the renderer draws content only. */
    readonly chrome?: ChromeOptions;
    /**
     * What a proxy or placeholder says when it stands in for content for a reason (FR-195), as text.
     * Default {@link STAND_IN_TEXT}, in English.
     */
    readonly standIn?: (reason: StandInReason) => string;
}
/** The attribute names the renderer marks its elements with, for hosts' styles and tests. */
export declare const DOM_ATTRIBUTES: Readonly<{
    /** On a view's root: the viewport's ID. */
    viewport: "data-swf-viewport";
    /** On each layer element: its category (`content-native`, `proxy`, `chrome`, …). */
    layer: "data-swf-layer";
    /** On a live clip box, proxy or placeholder: the surface's ID. */
    surface: "data-swf-surface";
    /** On a live clip box, proxy or placeholder: the fragment's ID. */
    fragment: "data-swf-fragment";
    /** On a window's chrome: the window's node ID. */
    node: "data-swf-node";
    /** On a live slot, the element content is mounted in: the surface's ID. */
    slot: "data-swf-slot";
    /** On a live clip box, proxy or placeholder: the presentation mode negotiated. */
    mode: "data-swf-mode";
    /** On a live clip box, proxy or placeholder: how faithful its shape is (`approximate`, …). */
    shape: "data-swf-shape";
    /** On a live clip box: how faithful its anchoring is. */
    anchor: "data-swf-anchor";
    /** On a live clip box: `corners` when the slot follows its projected corners, or `bounds`. */
    placement: "data-swf-placement";
    /** On a resize handle: its edge or corner (`n`, `ne`, … `nw`). */
    handle: "data-swf-handle";
    /** On a selected window's chrome, present while it is selected. */
    selected: "data-swf-selected";
    /** On the focused window's chrome, present while it is focused. */
    focused: "data-swf-focused";
    /** On a label's element (a proxy's or placeholder's label, a window title). */
    label: "data-swf-label";
    /** On {@link showDegraded}'s status line: the error's code. */
    degraded: "data-swf-degraded";
    /** On a proxy or placeholder: the representation planned for it (`label`, …). */
    representation: "data-swf-representation";
    /** On a proxy or placeholder: why it stands in for the content, or empty when no reason is due. */
    standIn: "data-swf-stand-in";
}>;
/** What a session is made with. */
interface SessionOptions {
    readonly document: Document;
    readonly pixelsPerUnit: number;
    readonly chrome: Required<ChromeOptions> | null;
    readonly standIn: (reason: StandInReason) => string;
}
/**
 * Realizes views as DOM: live slots, proxies, placeholders and chrome under one root per view. It
 * holds nothing itself; each session it prepares owns its view's elements until released.
 */
export declare class DomRenderer implements RendererBackend {
    #private;
    /** {@link DOM_RENDERER_ID}. */
    readonly id = "swf.dom-renderer/1";
    /** The presentation API version it implements. */
    readonly apiVersion = 1;
    /**
     * A renderer for `options.document`, which is not checked.
     *
     * @throws `RangeError` for a `pixelsPerUnit` or `chrome.handlePx` that is not positive and
     *   finite, or a `chrome.inks` colour that is not a non-blank string.
     */
    constructor(options: DomRendererOptions);
    /** {@link DOM_RENDERER_CAPABILITIES}, the same object on every call. */
    capabilities(): RendererCapabilities;
    /**
     * A new session for the view's viewport, with a root element sized to the view and not yet in
     * any container. Rejects with {@link SwfFailure} (`INVALID_INPUT`) for an invalid view.
     */
    prepare(_scene: SceneState, view: ViewGeometry): Promise<RendererSession>;
}
/**
 * A DOM renderer's session for one viewport: the view's root element and everything in it. The
 * presenter owns it and releases it; until then the elements are the session's, and content a
 * surface runtime mounts in a slot stays the adapter's.
 */
export declare class DomRendererSession implements RendererSession {
    #private;
    /** The renderer that prepared it. */
    readonly rendererId: string;
    /** The viewport it renders. */
    readonly viewportId: Id;
    /** The view's root element; the compositor puts it in the host's container. */
    readonly root: HTMLElement;
    /** A session for `view`, as {@link DomRenderer.prepare} makes it. */
    constructor(rendererId: string, view: ViewGeometry, options: SessionOptions);
    /**
     * The element a surface's live content is mounted in for this view: the container to pass to
     * the surface runtime's `present`. It exists once the surface has been planned as live content
     * here, and stays the same element for as long as the session keeps it, so content mounted in it
     * is never moved to another parent.
     */
    targetOf(surfaceId: Id): HTMLElement | undefined;
    /** DOM elements are never lost, so this never calls `listener`. */
    watchLoss(): () => void;
    /** The surfaces that have a live slot in this view. */
    slotSurfaces(): Id[];
    /**
     * Removes a surface's slot. Call it only after the runtime released the surface's attachment in
     * this view: whatever is still mounted in the slot leaves the document with it.
     */
    forget(surfaceId: Id): void;
    /**
     * Realizes a frame: each planned fragment as a live clip box and slot, a proxy or a placeholder,
     * with each window's chrome after its last fragment, in plan order. Elements are reused and
     * written only where something changed; slots unused this frame stay in place, hidden, and
     * other unused elements are removed.
     *
     * @throws {@link @swf/core!SwfFailure} `INVALID_TRANSITION` once released; `INVALID_INPUT`
     *   for a frame of another viewport, a scene not at the frame's revision, or a surface planned
     *   as live content twice; `UNSUPPORTED_CAPABILITY` for a raster, chrome or overlay fragment,
     *   or chrome over a projection the chrome options do not have.
     */
    render(frame: RenderFrame): RenderedFrame;
    /**
     * Takes the root out of the document and forgets every slot and element; whatever is still
     * mounted in a slot leaves the document with it. Rendering afterwards throws. Safe to call more
     * than once.
     */
    release(): Promise<void>;
}
export {};
//# sourceMappingURL=renderer.d.ts.map