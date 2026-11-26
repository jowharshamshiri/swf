import { makeError, SwfFailure } from '@swf/core';
import { PRESENTATION_API_VERSION } from '@swf/presentation';
import { isGeometryLayer } from './layer.js';
/** The layer compositor's registered ID, as {@link LayerCompositor} declares it. */
export const LAYER_COMPOSITOR_ID = 'swf.layer-compositor/1';
/**
 * What the layer compositor can do: it assembles live elements and drawn layers together, in an
 * explicit order. Live elements and canvases are stacked as whole layers, so where they overlap
 * each lies entirely in front of or behind the other (`layer-order`): there is no per-pixel depth
 * between a live element and drawn content. Frozen.
 */
export const LAYER_COMPOSITOR_CAPABILITIES = Object.freeze({
    layerCategories: Object.freeze([
        'content-native',
        'content-raster',
        'proxy',
        'placeholder',
        'chrome',
        'overlay',
    ]),
    ordering: 'explicit',
    masking: false,
    transparency: true,
    clipping: 'path',
    overlays: true,
    interpolation: true,
    directNative: true,
    multiViewport: true,
    occlusion: 'layer-order',
});
/**
 * Assembles a viewport from live element layers and drawn layers. Consecutive drawn layers share
 * one canvas; a live element between them splits them into separate canvases, so the stack is
 * exactly the planned order. Elements are appended once and never moved.
 */
export class LayerCompositor {
    /** {@link LAYER_COMPOSITOR_ID}. */
    id = LAYER_COMPOSITOR_ID;
    /** The presentation API version it implements. */
    apiVersion = PRESENTATION_API_VERSION;
    /** {@link LAYER_COMPOSITOR_CAPABILITIES}, the same object on every call. */
    capabilities() {
        return LAYER_COMPOSITOR_CAPABILITIES;
    }
    /**
     * Builds the view's root in the target container, which must be an element. Rejects with
     * {@link SwfFailure} (`INVALID_INPUT`) when it is not, or when the renderer session belongs to
     * another viewport. The container stays the host's; the session takes its root out again when
     * released.
     */
    prepare(target, renderer) {
        const reject = (message) => Promise.reject(new SwfFailure(makeError('INVALID_INPUT', message)));
        if (renderer.viewportId !== target.viewportId) {
            return reject(`the renderer session belongs to viewport "${renderer.viewportId}", not "${target.viewportId}"`);
        }
        const container = target.container;
        const view = container?.ownerDocument
            ?.defaultView;
        if (view === null || view === undefined || !(container instanceof view.HTMLElement)) {
            return reject(`the container of viewport "${target.viewportId}" must be an element`);
        }
        const root = container.ownerDocument.createElement('div');
        root.setAttribute('data-swf-composition', target.viewportId);
        root.style.setProperty('position', 'relative');
        root.style.setProperty('overflow', 'hidden');
        root.style.setProperty('isolation', 'isolate');
        container.append(root);
        return Promise.resolve(new LayerCompositorSession(this.id, target.viewportId, root));
    }
}
/**
 * A layer compositor's session for one viewport: a root element, marked
 * `data-swf-composition`, holding the view's canvases and live elements. The presenter owns it
 * and releases it.
 */
export class LayerCompositorSession {
    /** The compositor that prepared it. */
    compositorId;
    /** The viewport it composes. */
    viewportId;
    /** The view's root: canvases and live elements are its children. */
    root;
    #canvases = [];
    /** What each canvas last showed, and each element's last stacking: unchanged ones are left be. */
    #painted = new WeakMap();
    #stacked = new WeakMap();
    #size = '';
    #writes = 0;
    #lossListeners = new Set();
    #released = false;
    /** A session over `root`, as {@link LayerCompositor.prepare} makes it. */
    constructor(compositorId, viewportId, root) {
        this.compositorId = compositorId;
        this.viewportId = viewportId;
        this.root = root;
    }
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
    compose(frame) {
        if (this.#released) {
            throw new SwfFailure(makeError('INVALID_TRANSITION', `the layer compositor session for viewport "${this.viewportId}" was released`));
        }
        if (frame.viewportId !== this.viewportId) {
            throw new SwfFailure(makeError('INVALID_INPUT', `a frame for viewport "${frame.viewportId}" was given to viewport "${this.viewportId}"`));
        }
        const HTMLElementOf = this.root.ownerDocument.defaultView?.HTMLElement;
        // Split the stack into runs: each live element alone, consecutive drawn layers together.
        const runs = [];
        frame.layers.forEach((layer, index) => {
            const content = layer.content;
            if (isGeometryLayer(content)) {
                const last = runs.at(-1);
                if (last?.kind === 'drawn') {
                    last.layers.push(layer);
                }
                else {
                    runs.push({ kind: 'drawn', layers: [layer], start: index });
                }
            }
            else if (HTMLElementOf !== undefined && content instanceof HTMLElementOf) {
                runs.push({ kind: 'live', element: content, layer, start: index });
            }
            else {
                throw new SwfFailure(makeError('INVALID_INPUT', `layer "${layer.id}" is neither a drawn layer nor an element`));
            }
        });
        this.#writes = 0;
        let canvasIndex = 0;
        for (const run of runs) {
            if (run.kind === 'live') {
                if (run.element.parentElement !== this.root) {
                    if (run.element.parentElement !== null) {
                        throw new SwfFailure(makeError('INVALID_INPUT', `layer "${run.layer.id}" belongs to another parent; it would be moved`));
                    }
                    this.root.append(run.element);
                    this.#writes += 1;
                }
                this.#stack(run.element, run.start);
                continue;
            }
            const canvas = this.#canvas(canvasIndex++);
            this.#stack(canvas, run.start);
            const layers = run.layers.map((l) => l.content);
            const size = `${String(frame.size.width)}x${String(frame.size.height)}@${String(frame.size.devicePixelRatio)}`;
            const painted = this.#painted.get(canvas);
            // A canvas showing exactly these layers at this size is not repainted.
            if (painted?.size !== size ||
                painted.layers.length !== layers.length ||
                painted.layers.some((l, i) => l !== layers[i])) {
                paint(canvas, frame.size, layers);
                this.#painted.set(canvas, { layers, size });
                this.#writes += 1;
            }
        }
        // Canvases this frame did not need go.
        for (const canvas of this.#canvases.splice(canvasIndex)) {
            canvas.remove();
            this.#writes += 1;
        }
        const rootSize = `${String(frame.size.width)}x${String(frame.size.height)}`;
        if (rootSize !== this.#size) {
            this.root.style.setProperty('width', `${String(frame.size.width)}px`);
            this.root.style.setProperty('height', `${String(frame.size.height)}px`);
            this.#size = rootSize;
            this.#writes += 1;
        }
        return Object.freeze({
            viewportId: frame.viewportId,
            sceneRevision: frame.sceneRevision,
            order: Object.freeze(frame.layers.map((l) => l.id)),
            occlusion: LAYER_COMPOSITOR_CAPABILITIES.occlusion,
            writes: this.#writes,
        });
    }
    /** Puts an element at its place in the stack, writing only when the place changed. */
    #stack(element, index) {
        const z = String(index + 1);
        if (this.#stacked.get(element) !== z) {
            element.style.setProperty('z-index', z);
            this.#stacked.set(element, z);
            this.#writes += 1;
        }
    }
    /**
     * Calls `listener` when the browser takes a canvas's 2D context away (it fires `contextlost`
     * under memory pressure or a lost GPU): what is drawn is gone until the session is replaced.
     */
    watchLoss(listener) {
        const entry = (reason) => {
            listener(reason);
        };
        this.#lossListeners.add(entry);
        return () => {
            this.#lossListeners.delete(entry);
        };
    }
    /**
     * Takes the view's root out of its container, with its canvases and whatever live elements it
     * holds, and drops every loss listener. Composing afterwards throws. Safe to call more than once.
     */
    release() {
        if (!this.#released) {
            this.#released = true;
            this.root.remove();
            this.#canvases.length = 0;
            this.#lossListeners.clear();
        }
        return Promise.resolve();
    }
    #canvas(index) {
        let canvas = this.#canvases[index];
        if (canvas === undefined) {
            canvas = this.root.ownerDocument.createElement('canvas');
            canvas.setAttribute('data-swf-layer', 'drawn');
            canvas.style.setProperty('position', 'absolute');
            canvas.style.setProperty('left', '0px');
            canvas.style.setProperty('top', '0px');
            // Drawn layers show; they never take input from what lies under them.
            canvas.style.setProperty('pointer-events', 'none');
            canvas.addEventListener('contextlost', () => {
                if (this.#released) {
                    return;
                }
                for (const listener of [...this.#lossListeners]) {
                    listener('the 2D context of a drawn layer was lost');
                }
            });
            this.root.append(canvas);
            this.#canvases.push(canvas);
            this.#writes += 1;
        }
        return canvas;
    }
}
/** Clears the canvas to the view's size and draws the layers on it, in order. */
function paint(canvas, size, layers) {
    const { width, height, devicePixelRatio: ratio } = size;
    const pixelWidth = Math.round(width * ratio);
    const pixelHeight = Math.round(height * ratio);
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
    }
    canvas.style.setProperty('width', `${String(width)}px`);
    canvas.style.setProperty('height', `${String(height)}px`);
    const ctx = canvas.getContext('2d');
    if (ctx === null) {
        throw new SwfFailure(makeError('UNSUPPORTED_CAPABILITY', 'the browser offers no 2D canvas context'));
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const layer of layers) {
        ctx.save();
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        layer.draw(ctx);
        ctx.restore();
    }
}
//# sourceMappingURL=compositor.js.map