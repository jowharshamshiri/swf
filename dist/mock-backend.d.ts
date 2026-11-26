import type { Id, SceneState } from '@swf/core';
import type { ComposedFrame, CompositionTarget, Compositor, CompositorCapabilities, CompositorSession, LossListener, RenderedFrame, RendererBackend, RendererCapabilities, RendererSession, RenderFrame, ViewGeometry } from '@swf/presentation';
/**
 * A DOM-and-raster renderer that warps drawable content exactly and places live elements: the
 * capabilities {@link MockRenderer} declares by default. Frozen.
 */
export declare const MOCK_RENDERER_CAPABILITIES: RendererCapabilities;
/**
 * A compositor with every layer category, explicit ordering and direct native presentation: the
 * capabilities {@link MockCompositor} declares by default. Frozen.
 */
export declare const MOCK_COMPOSITOR_CAPABILITIES: CompositorCapabilities;
/**
 * A reference renderer that realizes each planned fragment as one layer of the category its
 * negotiation chose, in plan order, with no real resources. Live content attaches to a target
 * object of the session's own, one per surface.
 */
export declare class MockRenderer implements RendererBackend {
    #private;
    /** The renderer's registered ID. */
    readonly id: string;
    /** The backend API version it implements. */
    readonly apiVersion = 1;
    /** Every session it prepared, oldest first, released or not. */
    readonly sessions: MockRendererSession[];
    /** When set, preparing fails with this message. */
    failPrepare: string | null;
    /**
     * @param id - The renderer's ID. Default `mock.renderer/1`.
     * @param capabilities - What it declares. Default {@link MOCK_RENDERER_CAPABILITIES}.
     */
    constructor(id?: string, capabilities?: RendererCapabilities);
    /** The capabilities it was made with, the same object on every call. */
    capabilities(): RendererCapabilities;
    /**
     * A new session for the view's viewport, kept in {@link MockRenderer.sessions}; rejects with
     * `Error` while {@link MockRenderer.failPrepare} is set.
     */
    prepare(_scene: SceneState, view: ViewGeometry): Promise<RendererSession>;
}
/**
 * A session of {@link MockRenderer} for one viewport. It holds no real resources; a test makes it
 * lose them with {@link MockRendererSession.lose}.
 */
export declare class MockRendererSession implements RendererSession {
    #private;
    /** The renderer that prepared it. */
    readonly rendererId: string;
    /** The viewport it renders. */
    readonly viewportId: Id;
    /** How many times it was released: a well-behaved presenter releases it once. */
    released: number;
    /** When set, rendering throws with this message. */
    failRender: string | null;
    /** A session of renderer `rendererId` for viewport `viewportId`, as `prepare` makes it. */
    constructor(rendererId: string, viewportId: Id);
    /**
     * The frozen target object live content of `surfaceId` attaches to, the same one each time;
     * undefined unless the last frame placed it as native content.
     */
    targetOf(surfaceId: Id): unknown;
    /** Calls `listener` with the reason whenever {@link lose} is called; returns what stops it. */
    watchLoss(listener: LossListener): () => void;
    /** Makes the session lose its resources, as a lost graphics context would. */
    lose(reason: string): void;
    /** How many are listening for its loss. */
    get lossWatchers(): number;
    /**
     * Realizes each planned fragment, in plan order, as one frozen layer of the category its
     * negotiation chose, with the ID `<category>:<fragment ID>`; it reports no writes.
     *
     * @throws `Error` while {@link failRender} is set, or once the session is released.
     */
    render(frame: RenderFrame): RenderedFrame;
    /** Counts the release in {@link released}; resolves at once. Never refused. */
    release(): Promise<void>;
}
/** A reference compositor that keeps the rendered order. */
export declare class MockCompositor implements Compositor {
    #private;
    /** The compositor's registered ID. */
    readonly id: string;
    /** The backend API version it implements. */
    readonly apiVersion = 1;
    /** Every session it prepared, oldest first, released or not. */
    readonly sessions: MockCompositorSession[];
    /** When set, preparing fails with this message. */
    failPrepare: string | null;
    /**
     * @param id - The compositor's ID. Default `mock.compositor/1`.
     * @param capabilities - What it declares. Default {@link MOCK_COMPOSITOR_CAPABILITIES}.
     */
    constructor(id?: string, capabilities?: CompositorCapabilities);
    /** The capabilities it was made with, the same object on every call. */
    capabilities(): CompositorCapabilities;
    /**
     * A new session for the target's viewport, kept in {@link MockCompositor.sessions}. Rejects
     * with `Error` when the renderer session belongs to another viewport, or while
     * {@link MockCompositor.failPrepare} is set.
     */
    prepare(target: CompositionTarget, renderer: RendererSession): Promise<CompositorSession>;
}
/**
 * A session of {@link MockCompositor} for one viewport. It holds no real resources; a test makes
 * it lose them with {@link MockCompositorSession.lose}.
 */
export declare class MockCompositorSession implements CompositorSession {
    #private;
    /** The compositor that prepared it. */
    readonly compositorId: string;
    /** The viewport it composes. */
    readonly viewportId: Id;
    /** How many times it was released: a well-behaved presenter releases it once. */
    released: number;
    /** A session of compositor `compositorId` for viewport `viewportId`, as `prepare` makes it. */
    constructor(compositorId: string, viewportId: Id);
    /** Calls `listener` with the reason whenever {@link lose} is called; returns what stops it. */
    watchLoss(listener: LossListener): () => void;
    /** Makes the session lose its resources, as a lost graphics context would. */
    lose(reason: string): void;
    /** How many are listening for its loss. */
    get lossWatchers(): number;
    /**
     * Keeps the rendered layers' order as the composed order, with layer-order occlusion; it
     * reports no writes.
     *
     * @throws `Error` once the session is released.
     */
    compose(frame: RenderedFrame): ComposedFrame;
    /** Counts the release in {@link released}; resolves at once. Never refused. */
    release(): Promise<void>;
}
//# sourceMappingURL=mock-backend.d.ts.map