import type { Id, SceneState } from '@swf/core';
import type { RenderedFrame, LossListener, RendererBackend, RendererCapabilities, RendererSession, RenderFrame, ViewGeometry } from '@swf/presentation';
import type { GeometryRenderer } from './renderer.js';
import { GeometryRendererSession } from './renderer.js';
/** The two renderers a layered renderer pairs. It keeps them as given and never disposes them. */
export interface LayeredRendererOptions {
    /** A versioned ID for the pair, `<name>/<version>`. Default `swf.layered-renderer/1`. */
    readonly id?: string;
    /**
     * Presents live content (`content-native` layers), such as a DOM renderer without chrome. It
     * must present `native-dom` handles, or {@link LayeredRenderer.capabilities} throws.
     */
    readonly native: RendererBackend;
    /** Draws everything else: drawn content, proxies, placeholders, chrome and indicators. */
    readonly geometry: GeometryRenderer;
}
/**
 * Two independent renderers as one: live content from the native renderer, everything else from
 * the geometry renderer, merged in plan order (each window's chrome right after its content,
 * indicators on top). Its capabilities are what the pair can honestly do together.
 */
export declare class LayeredRenderer implements RendererBackend {
    #private;
    /** The pair's ID, as its options gave it. */
    readonly id: string;
    /** The presentation API version it implements. */
    readonly apiVersion = 1;
    /**
     * Pairs `options.native` and `options.geometry`, which are not checked here.
     *
     * @throws `RangeError` for an `id` that is not a versioned ID.
     */
    constructor(options: LayeredRendererOptions);
    /**
     * What the pair can do together: live content as the native renderer presents it, every other
     * handle kind as the geometry renderer does, and the lower of the two transform modes, clipping
     * and recovery. A new frozen object on every call.
     *
     * @throws {@link @swf/core!SwfFailure} `UNSUPPORTED_CAPABILITY` when the native renderer
     *   presents no `native-dom` content.
     */
    capabilities(): RendererCapabilities;
    /**
     * Prepares a session of each renderer for the view, the native one first, and pairs them. When
     * the geometry renderer fails, or prepares a session that is not a geometry session, every
     * session prepared is released and the failure passed on.
     *
     * @throws `Error` (as a rejection) when the geometry renderer prepares a session of another
     *   kind; and as either renderer's `prepare` rejects. When releasing a session prepared also
     *   fails, it rejects with an `AggregateError` holding the first failure, then each release's.
     */
    prepare(scene: SceneState, view: ViewGeometry): Promise<RendererSession>;
}
/**
 * A layered renderer's session for one viewport: a native session and a geometry session, owned
 * together. The presenter owns it; releasing it releases both.
 */
export declare class LayeredRendererSession implements RendererSession {
    #private;
    /** The layered renderer that prepared it. */
    readonly rendererId: string;
    /** The viewport it renders. */
    readonly viewportId: Id;
    /** The native renderer's own session (for the live slots a host attaches content to). */
    readonly native: RendererSession;
    /** The geometry renderer's own session, which draws everything but live content. */
    readonly geometry: GeometryRendererSession;
    /** Pairs two prepared sessions of one viewport, as {@link LayeredRenderer.prepare} does. */
    constructor(rendererId: string, viewportId: Id, native: RendererSession, geometry: GeometryRendererSession);
    /**
     * Has the native session render the frame's live fragments and the geometry session everything
     * else, then merges their layers in plan order: each fragment's layer, then the chrome stacked
     * after it, then the layers of no fragment on top. Its writes are both sessions' together.
     *
     * @throws {@link @swf/core!SwfFailure} `INVALID_TRANSITION` once released; `INVALID_INPUT`
     *   when the native session makes a layer that is not live content it was asked for; and as
     *   either session's `render` throws.
     */
    render(frame: RenderFrame): RenderedFrame;
    /** Live content attaches where the native renderer puts it. */
    targetOf(surfaceId: Id): unknown;
    /** The native renderer may lose its resources; the geometry renderer holds none to lose. */
    watchLoss(listener: LossListener): () => void;
    /**
     * Releases the native session, then the geometry session, the second even when the first
     * fails. Safe to call more than once: only the first call releases.
     *
     * @throws As a session's `release` rejects; an `AggregateError` holding both failures when
     *   both do.
     */
    release(): Promise<void>;
}
//# sourceMappingURL=layered.d.ts.map