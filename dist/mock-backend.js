/**
 * A DOM-and-raster renderer that warps drawable content exactly and places live elements: the
 * capabilities {@link MockRenderer} declares by default. Frozen.
 */
export const MOCK_RENDERER_CAPABILITIES = Object.freeze({
    handleKinds: Object.freeze({ 'native-dom': 'native', drawable: 'exact', 'proxy-only': 'proxy' }),
    transformMode: 'mesh',
    clipping: 'path',
    hitMapping: true,
    layering: 'dom-and-raster',
    resourceOwnership: 'renderer',
    recovery: 'rebuild',
});
/**
 * A compositor with every layer category, explicit ordering and direct native presentation: the
 * capabilities {@link MockCompositor} declares by default. Frozen.
 */
export const MOCK_COMPOSITOR_CAPABILITIES = Object.freeze({
    layerCategories: Object.freeze([
        'content-native',
        'content-raster',
        'proxy',
        'placeholder',
        'chrome',
        'overlay',
    ]),
    ordering: 'explicit',
    masking: true,
    transparency: true,
    clipping: 'path',
    overlays: true,
    interpolation: true,
    directNative: true,
    multiViewport: true,
    occlusion: 'layer-order',
});
/** Listeners for a session's loss of resources, and a way to make the loss happen. */
class Loss {
    #listeners = new Set();
    watch(listener) {
        const entry = (reason) => {
            listener(reason);
        };
        this.#listeners.add(entry);
        return () => {
            this.#listeners.delete(entry);
        };
    }
    lose(reason) {
        for (const listener of [...this.#listeners]) {
            listener(reason);
        }
    }
    get watchers() {
        return this.#listeners.size;
    }
}
/**
 * A reference renderer that realizes each planned fragment as one layer of the category its
 * negotiation chose, in plan order, with no real resources. Live content attaches to a target
 * object of the session's own, one per surface.
 */
export class MockRenderer {
    /** The renderer's registered ID. */
    id;
    /** The backend API version it implements. */
    apiVersion = 1;
    #capabilities;
    /** Every session it prepared, oldest first, released or not. */
    sessions = [];
    /** When set, preparing fails with this message. */
    failPrepare = null;
    /**
     * @param id - The renderer's ID. Default `mock.renderer/1`.
     * @param capabilities - What it declares. Default {@link MOCK_RENDERER_CAPABILITIES}.
     */
    constructor(id = 'mock.renderer/1', capabilities = MOCK_RENDERER_CAPABILITIES) {
        this.id = id;
        this.#capabilities = capabilities;
    }
    /** The capabilities it was made with, the same object on every call. */
    capabilities() {
        return this.#capabilities;
    }
    /**
     * A new session for the view's viewport, kept in {@link MockRenderer.sessions}; rejects with
     * `Error` while {@link MockRenderer.failPrepare} is set.
     */
    prepare(_scene, view) {
        if (this.failPrepare !== null) {
            return Promise.reject(new Error(this.failPrepare));
        }
        const session = new MockRendererSession(this.id, view.viewportId);
        this.sessions.push(session);
        return Promise.resolve(session);
    }
}
/**
 * A session of {@link MockRenderer} for one viewport. It holds no real resources; a test makes it
 * lose them with {@link MockRendererSession.lose}.
 */
export class MockRendererSession {
    /** The renderer that prepared it. */
    rendererId;
    /** The viewport it renders. */
    viewportId;
    /** How many times it was released: a well-behaved presenter releases it once. */
    released = 0;
    /** When set, rendering throws with this message. */
    failRender = null;
    #loss = new Loss();
    #targets = new Map();
    #live = new Set();
    /** A session of renderer `rendererId` for viewport `viewportId`, as `prepare` makes it. */
    constructor(rendererId, viewportId) {
        this.rendererId = rendererId;
        this.viewportId = viewportId;
    }
    /**
     * The frozen target object live content of `surfaceId` attaches to, the same one each time;
     * undefined unless the last frame placed it as native content.
     */
    targetOf(surfaceId) {
        if (!this.#live.has(surfaceId)) {
            return undefined;
        }
        let target = this.#targets.get(surfaceId);
        if (target === undefined) {
            target = Object.freeze({ rendererId: this.rendererId, surfaceId, session: this });
            this.#targets.set(surfaceId, target);
        }
        return target;
    }
    /** Calls `listener` with the reason whenever {@link lose} is called; returns what stops it. */
    watchLoss(listener) {
        return this.#loss.watch(listener);
    }
    /** Makes the session lose its resources, as a lost graphics context would. */
    lose(reason) {
        this.#loss.lose(reason);
    }
    /** How many are listening for its loss. */
    get lossWatchers() {
        return this.#loss.watchers;
    }
    /**
     * Realizes each planned fragment, in plan order, as one frozen layer of the category its
     * negotiation chose, with the ID `<category>:<fragment ID>`; it reports no writes.
     *
     * @throws `Error` while {@link failRender} is set, or once the session is released.
     */
    render(frame) {
        if (this.failRender !== null) {
            throw new Error(this.failRender);
        }
        if (this.released > 0) {
            throw new Error(`renderer session for viewport "${this.viewportId}" was released`);
        }
        const layers = frame.planned.map((p) => Object.freeze({
            id: `${p.negotiation.layer}:${p.fragment.id}`,
            category: p.negotiation.layer,
            fragmentId: p.fragment.id,
            surfaceId: p.fragment.surfaceId,
            content: Object.freeze({ fragmentId: p.fragment.id }),
        }));
        this.#live = new Set(layers.flatMap((l) => l.category === 'content-native' && l.surfaceId !== null ? [l.surfaceId] : []));
        return Object.freeze({
            viewportId: frame.viewportId,
            sceneRevision: frame.sceneRevision,
            size: Object.freeze({
                width: frame.view.width,
                height: frame.view.height,
                devicePixelRatio: frame.view.devicePixelRatio,
            }),
            layers: Object.freeze(layers),
            writes: 0,
        });
    }
    /** Counts the release in {@link released}; resolves at once. Never refused. */
    release() {
        this.released += 1;
        return Promise.resolve();
    }
}
/** A reference compositor that keeps the rendered order. */
export class MockCompositor {
    /** The compositor's registered ID. */
    id;
    /** The backend API version it implements. */
    apiVersion = 1;
    #capabilities;
    /** Every session it prepared, oldest first, released or not. */
    sessions = [];
    /** When set, preparing fails with this message. */
    failPrepare = null;
    /**
     * @param id - The compositor's ID. Default `mock.compositor/1`.
     * @param capabilities - What it declares. Default {@link MOCK_COMPOSITOR_CAPABILITIES}.
     */
    constructor(id = 'mock.compositor/1', capabilities = MOCK_COMPOSITOR_CAPABILITIES) {
        this.id = id;
        this.#capabilities = capabilities;
    }
    /** The capabilities it was made with, the same object on every call. */
    capabilities() {
        return this.#capabilities;
    }
    /**
     * A new session for the target's viewport, kept in {@link MockCompositor.sessions}. Rejects
     * with `Error` when the renderer session belongs to another viewport, or while
     * {@link MockCompositor.failPrepare} is set.
     */
    prepare(target, renderer) {
        if (renderer.viewportId !== target.viewportId) {
            return Promise.reject(new Error('the renderer session belongs to another viewport'));
        }
        if (this.failPrepare !== null) {
            return Promise.reject(new Error(this.failPrepare));
        }
        const session = new MockCompositorSession(this.id, target.viewportId);
        this.sessions.push(session);
        return Promise.resolve(session);
    }
}
/**
 * A session of {@link MockCompositor} for one viewport. It holds no real resources; a test makes
 * it lose them with {@link MockCompositorSession.lose}.
 */
export class MockCompositorSession {
    /** The compositor that prepared it. */
    compositorId;
    /** The viewport it composes. */
    viewportId;
    /** How many times it was released: a well-behaved presenter releases it once. */
    released = 0;
    #loss = new Loss();
    /** A session of compositor `compositorId` for viewport `viewportId`, as `prepare` makes it. */
    constructor(compositorId, viewportId) {
        this.compositorId = compositorId;
        this.viewportId = viewportId;
    }
    /** Calls `listener` with the reason whenever {@link lose} is called; returns what stops it. */
    watchLoss(listener) {
        return this.#loss.watch(listener);
    }
    /** Makes the session lose its resources, as a lost graphics context would. */
    lose(reason) {
        this.#loss.lose(reason);
    }
    /** How many are listening for its loss. */
    get lossWatchers() {
        return this.#loss.watchers;
    }
    /**
     * Keeps the rendered layers' order as the composed order, with layer-order occlusion; it
     * reports no writes.
     *
     * @throws `Error` once the session is released.
     */
    compose(frame) {
        if (this.released > 0) {
            throw new Error(`compositor session for viewport "${this.viewportId}" was released`);
        }
        return Object.freeze({
            viewportId: frame.viewportId,
            sceneRevision: frame.sceneRevision,
            order: Object.freeze(frame.layers.map((layer) => layer.id)),
            occlusion: MOCK_COMPOSITOR_CAPABILITIES.occlusion,
            writes: 0,
        });
    }
    /** Counts the release in {@link released}; resolves at once. Never refused. */
    release() {
        this.released += 1;
        return Promise.resolve();
    }
}
//# sourceMappingURL=mock-backend.js.map