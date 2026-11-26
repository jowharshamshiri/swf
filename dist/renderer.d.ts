import type { Id, SceneState } from '@swf/core';
import type { RenderedFrame, RendererBackend, RendererCapabilities, RendererSession, RenderFrame, StandInReason, ViewGeometry } from '@swf/presentation';
import type { ProjectionModule } from '@swf/projections';
/** The geometry renderer's registered ID, as {@link GeometryRenderer} declares it. */
export declare const GEOMETRY_RENDERER_ID = "swf.geometry-renderer/1";
/**
 * The colours drawn on whatever the view is drawn over, as canvas colours: every window frame
 * (and each mark pointing to a window out of view), the selected and the focused window's frame,
 * and text (window titles, labels standing for windows, the marks' names). Frames and marks should
 * stand out from the view's ground by 3:1 at least (WCAG 1.4.11), text by 4.5:1 (WCAG 1.4.3).
 */
export interface GeometryInks {
    /** Every window frame and every mark of a window out of view: a non-blank canvas colour. */
    readonly frame: string;
    /** The selected window's frame: a non-blank canvas colour. */
    readonly selected: string;
    /** The focused window's frame, over `selected`: a non-blank canvas colour. */
    readonly focused: string;
    /** Titles, labels standing for windows and the marks' names: a non-blank canvas colour. */
    readonly text: string;
}
/** Inks that stand out on a light ground by 4.5:1 or more. Frozen. */
export declare const DEFAULT_GEOMETRY_INKS: GeometryInks;
/** What a geometry renderer draws from. Checked when the renderer is made, `inks` every frame. */
export interface GeometryRendererOptions {
    /**
     * The drawable an adapter supplies for a surface, for surfaces presented as drawn content
     * (typically the surface runtime's handle of a `drawable` adapter). Asked at every frame; a
     * surface planned as drawn content whose answer is not a {@link Drawable} fails the frame with
     * `INVALID_INPUT`. The drawables stay the adapters'.
     */
    readonly drawables?: (surfaceId: Id) => unknown;
    /**
     * The projection modules views use. With them the renderer follows each view's projection
     * point by point (mesh warping), and draws window chrome and indicators for windows out of
     * view; without them it places drawn content by its projected corners only.
     */
    readonly projections?: {
        /** The projection module registered under `id`, or undefined when none is. */
        get(id: string): ProjectionModule | undefined;
    };
    /** Cells per side of the mesh a drawable is warped with: a whole number, 1 to 128. Default 12. */
    readonly meshCells?: number;
    /**
     * What a proxy or placeholder says when it stands in for content for a reason (FR-195), as text.
     * Default {@link STAND_IN_TEXT}, in English.
     */
    readonly standIn?: (reason: StandInReason) => string;
    /**
     * The inks, read at every frame so a change of the host's appearance is drawn at the next one.
     * Default {@link DEFAULT_GEOMETRY_INKS}. An ink that is not a non-blank string makes that frame
     * throw `RangeError`.
     */
    readonly inks?: () => GeometryInks;
}
/**
 * A renderer that draws: adapter-supplied drawables, proxies, placeholders, window chrome and
 * spatial indicators, each a layer of drawing commands in viewport pixels. It never reads pixels
 * back. It cannot present live elements; with nothing else, those are shown as proxies.
 */
export declare class GeometryRenderer implements RendererBackend {
    #private;
    /** {@link GEOMETRY_RENDERER_ID}. */
    readonly id = "swf.geometry-renderer/1";
    /** The presentation API version it implements. */
    readonly apiVersion = 1;
    /**
     * A renderer drawing from `options`, which it keeps as given.
     *
     * @throws `RangeError` for a `meshCells` that is not a whole number from 1 to 128.
     */
    constructor(options?: GeometryRendererOptions);
    /**
     * Drawn content is warped by a mesh (piecewise affine): close to the projection, never claimed
     * exact. With projection modules it follows nonlinear projections point by point; without, it
     * follows the projected corners, as a planar perspective does.
     */
    capabilities(): RendererCapabilities;
    /**
     * A new session for the view's viewport. Rejects with {@link SwfFailure} (`INVALID_INPUT`) for
     * an invalid view.
     */
    prepare(_scene: SceneState, view: ViewGeometry): Promise<RendererSession>;
}
/**
 * A geometry renderer's session for one viewport. It holds no graphics resources, only the
 * layers it drew last, kept so unchanged ones are not drawn anew; the presenter owns and releases
 * it.
 */
export declare class GeometryRendererSession implements RendererSession {
    #private;
    /** The renderer that prepared it. */
    readonly rendererId: string;
    /** The viewport it renders. */
    readonly viewportId: Id;
    /** A session as {@link GeometryRenderer.prepare} makes it, with `cells` mesh cells per side. */
    constructor(rendererId: string, viewportId: Id, options: GeometryRendererOptions, cells: number);
    /**
     * Realizes a frame as drawn layers: drawn content, proxies and placeholders in plan order, each
     * window's chrome after its last fragment, and the indicators of windows out of view on top
     * (chrome and indicators only with projection modules). A layer whose inputs did not change is
     * the same object as last frame.
     *
     * @throws {@link @swf/core!SwfFailure} `INVALID_TRANSITION` once released; `INVALID_INPUT`
     *   for a frame of another viewport or a missing or invalid drawable; `UNSUPPORTED_CAPABILITY`
     *   for live content, a chrome or overlay fragment, or a projection the modules do not have.
     *   `RangeError` for an invalid ink.
     */
    render(frame: RenderFrame): RenderedFrame;
    /**
     * Renders every planned fragment except the live ones listed, which another renderer realizes
     * (see {@link LayeredRenderer}); window chrome still stacks with them in plan order. Throws as
     * {@link GeometryRendererSession.render} does, but not for the live fragments listed.
     *
     * @param elsewhere - The IDs of live fragments another renderer realizes.
     */
    renderExcept(frame: RenderFrame, elsewhere: ReadonlySet<string>): RenderedFrame;
    /** It draws everything it shows, so no surface's own content attaches here. */
    targetOf(): undefined;
    /**
     * It holds no graphics resources (it draws into the compositor's canvases), so this never calls
     * `listener`.
     */
    watchLoss(): () => void;
    /** Ends the session: rendering afterwards throws. It frees nothing. Safe to call twice. */
    release(): Promise<void>;
}
//# sourceMappingURL=renderer.d.ts.map