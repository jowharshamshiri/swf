import { makeError, nodeFrameGeometry, SwfFailure } from '@swf/core';
import { PRESENTATION_API_VERSION, STAND_IN_TEXT, standInReason, viewGeometryIssue, } from '@swf/presentation';
import { projectionFor } from '@swf/projections';
import { offsetQuad, rectQuad } from '@swf/math';
import { cssTransform, quadMatrix } from './placement.js';
import { DomWriter } from './writer.js';
/** The DOM renderer's registered ID, as {@link DomRenderer} declares it. */
export const DOM_RENDERER_ID = 'swf.dom-renderer/1';
/**
 * What the DOM renderer can do. It presents live DOM elements natively (placing them, never
 * redrawing them) and proxy-only endpoints as proxies. It cannot draw: drawable content falls back
 * to a proxy. Its transforms are planar perspective (a CSS `matrix3d`), so in a nonlinear
 * projection a live element is placed by its projected corners and only approximates the bend.
 */
export const DOM_RENDERER_CAPABILITIES = Object.freeze({
    handleKinds: Object.freeze({ 'native-dom': 'native', 'proxy-only': 'proxy' }),
    transformMode: 'perspective-3d',
    clipping: 'rect',
    hitMapping: false,
    layering: 'dom',
    resourceOwnership: 'renderer',
    recovery: 'rebuild',
});
/** Inks that stand out on a light page by 4.5:1 or more. Frozen. */
export const DEFAULT_CHROME_INKS = Object.freeze({
    frame: 'rgb(118, 118, 118)',
    selected: 'rgb(0, 95, 184)',
    focused: 'rgb(168, 74, 0)',
});
/** The attribute names the renderer marks its elements with, for hosts' styles and tests. */
export const DOM_ATTRIBUTES = Object.freeze({
    /** On a view's root: the viewport's ID. */
    viewport: 'data-swf-viewport',
    /** On each layer element: its category (`content-native`, `proxy`, `chrome`, …). */
    layer: 'data-swf-layer',
    /** On a live clip box, proxy or placeholder: the surface's ID. */
    surface: 'data-swf-surface',
    /** On a live clip box, proxy or placeholder: the fragment's ID. */
    fragment: 'data-swf-fragment',
    /** On a window's chrome: the window's node ID. */
    node: 'data-swf-node',
    /** On a live slot, the element content is mounted in: the surface's ID. */
    slot: 'data-swf-slot',
    /** On a live clip box, proxy or placeholder: the presentation mode negotiated. */
    mode: 'data-swf-mode',
    /** On a live clip box, proxy or placeholder: how faithful its shape is (`approximate`, …). */
    shape: 'data-swf-shape',
    /** On a live clip box: how faithful its anchoring is. */
    anchor: 'data-swf-anchor',
    /** On a live clip box: `corners` when the slot follows its projected corners, or `bounds`. */
    placement: 'data-swf-placement',
    /** On a resize handle: its edge or corner (`n`, `ne`, … `nw`). */
    handle: 'data-swf-handle',
    /** On a selected window's chrome, present while it is selected. */
    selected: 'data-swf-selected',
    /** On the focused window's chrome, present while it is focused. */
    focused: 'data-swf-focused',
    /** On a label's element (a proxy's or placeholder's label, a window title). */
    label: 'data-swf-label',
    /** On {@link showDegraded}'s status line: the error's code. */
    degraded: 'data-swf-degraded',
    /** On a proxy or placeholder: the representation planned for it (`label`, …). */
    representation: 'data-swf-representation',
    /** On a proxy or placeholder: why it stands in for the content, or empty when no reason is due. */
    standIn: 'data-swf-stand-in',
});
/** Each resize handle and the frame sides it lies on. */
const RESIZE_EDGES = Object.freeze({
    n: ['n'],
    s: ['s'],
    e: ['e'],
    w: ['w'],
    ne: ['n', 'e'],
    nw: ['n', 'w'],
    se: ['s', 'e'],
    sw: ['s', 'w'],
});
/**
 * Realizes views as DOM: live slots, proxies, placeholders and chrome under one root per view. It
 * holds nothing itself; each session it prepares owns its view's elements until released.
 */
export class DomRenderer {
    /** {@link DOM_RENDERER_ID}. */
    id = DOM_RENDERER_ID;
    /** The presentation API version it implements. */
    apiVersion = PRESENTATION_API_VERSION;
    #options;
    /**
     * A renderer for `options.document`, which is not checked.
     *
     * @throws `RangeError` for a `pixelsPerUnit` or `chrome.handlePx` that is not positive and
     *   finite, or a `chrome.inks` colour that is not a non-blank string.
     */
    constructor(options) {
        const ppu = options.pixelsPerUnit ?? 400;
        if (!(ppu > 0 && Number.isFinite(ppu))) {
            throw new RangeError(`pixelsPerUnit must be a positive finite number (got ${String(ppu)})`);
        }
        const handlePx = options.chrome?.handlePx ?? 12;
        if (!(handlePx > 0 && Number.isFinite(handlePx))) {
            throw new RangeError(`chrome.handlePx must be a positive finite number (got ${String(handlePx)})`);
        }
        const inks = options.chrome?.inks ?? DEFAULT_CHROME_INKS;
        for (const name of ['frame', 'selected', 'focused']) {
            const ink = inks[name];
            if (typeof ink !== 'string' || ink.trim() === '') {
                throw new RangeError(`chrome.inks.${name} must be a CSS colour (got ${String(ink)})`);
            }
        }
        this.#options = {
            document: options.document,
            pixelsPerUnit: ppu,
            chrome: options.chrome === undefined
                ? null
                : {
                    projections: options.chrome.projections,
                    handlePx,
                    inks: Object.freeze({
                        frame: inks.frame,
                        selected: inks.selected,
                        focused: inks.focused,
                    }),
                },
            standIn: options.standIn ?? ((reason) => STAND_IN_TEXT[reason]),
        };
    }
    /** {@link DOM_RENDERER_CAPABILITIES}, the same object on every call. */
    capabilities() {
        return DOM_RENDERER_CAPABILITIES;
    }
    /**
     * A new session for the view's viewport, with a root element sized to the view and not yet in
     * any container. Rejects with {@link SwfFailure} (`INVALID_INPUT`) for an invalid view.
     */
    prepare(_scene, view) {
        const issue = viewGeometryIssue(view);
        if (issue !== null) {
            return Promise.reject(new SwfFailure(makeError('INVALID_INPUT', `view of viewport "${view.viewportId}": ${issue}`)));
        }
        return Promise.resolve(new DomRendererSession(this.id, view, this.#options));
    }
}
/**
 * A DOM renderer's session for one viewport: the view's root element and everything in it. The
 * presenter owns it and releases it; until then the elements are the session's, and content a
 * surface runtime mounts in a slot stays the adapter's.
 */
export class DomRendererSession {
    /** The renderer that prepared it. */
    rendererId;
    /** The viewport it renders. */
    viewportId;
    /** The view's root element; the compositor puts it in the host's container. */
    root;
    #document;
    #ppu;
    #chrome;
    #standIn;
    #slots = new Map();
    #elements = new Map();
    #write = new DomWriter();
    #released = false;
    /** A session for `view`, as {@link DomRenderer.prepare} makes it. */
    constructor(rendererId, view, options) {
        this.rendererId = rendererId;
        this.viewportId = view.viewportId;
        this.#document = options.document;
        this.#ppu = options.pixelsPerUnit;
        this.#chrome = options.chrome;
        this.#standIn = options.standIn;
        this.root = options.document.createElement('div');
        this.root.setAttribute(DOM_ATTRIBUTES.viewport, view.viewportId);
        style(this.root, {
            position: 'relative',
            overflow: 'hidden',
            isolation: 'isolate',
            width: `${String(view.width)}px`,
            height: `${String(view.height)}px`,
            'touch-action': 'none',
        });
    }
    /**
     * The element a surface's live content is mounted in for this view: the container to pass to
     * the surface runtime's `present`. It exists once the surface has been planned as live content
     * here, and stays the same element for as long as the session keeps it, so content mounted in it
     * is never moved to another parent.
     */
    targetOf(surfaceId) {
        return this.#slots.get(surfaceId)?.slot;
    }
    /** DOM elements are never lost, so this never calls `listener`. */
    watchLoss() {
        return () => undefined;
    }
    /** The surfaces that have a live slot in this view. */
    slotSurfaces() {
        return [...this.#slots.keys()];
    }
    /**
     * Removes a surface's slot. Call it only after the runtime released the surface's attachment in
     * this view: whatever is still mounted in the slot leaves the document with it.
     */
    forget(surfaceId) {
        const slot = this.#slots.get(surfaceId);
        if (slot !== undefined) {
            slot.clip.remove();
            this.#slots.delete(surfaceId);
        }
    }
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
    render(frame) {
        if (this.#released) {
            throw new SwfFailure(makeError('INVALID_TRANSITION', `the DOM renderer session for viewport "${this.viewportId}" was released`));
        }
        if (frame.viewportId !== this.viewportId) {
            throw new SwfFailure(makeError('INVALID_INPUT', `a frame for viewport "${frame.viewportId}" was given to viewport "${this.viewportId}"`));
        }
        if (frame.scene.revision !== frame.sceneRevision) {
            throw new SwfFailure(makeError('INVALID_INPUT', 'the frame’s scene is not at its revision'));
        }
        this.#write.style(this.root, {
            width: `${String(frame.view.width)}px`,
            height: `${String(frame.view.height)}px`,
        });
        const layers = [];
        const usedSlots = new Set();
        const usedElements = new Set();
        const chrome = this.#chromeFrames(frame);
        const lastOfNode = new Map();
        frame.planned.forEach((p, i) => {
            const nodeId = frame.scene.surfaces.get(p.fragment.surfaceId)?.ownerNodeId;
            if (nodeId !== undefined) {
                lastOfNode.set(nodeId, i);
            }
        });
        frame.planned.forEach((planned, i) => {
            layers.push(this.#content(frame, planned, usedSlots, usedElements));
            for (const [nodeId, last] of lastOfNode) {
                const frameOf = chrome.get(nodeId);
                if (last === i && frameOf !== undefined) {
                    layers.push(this.#chromeLayer(frame.scene, nodeId, frameOf, usedElements));
                }
            }
        });
        // Slots of surfaces not live here this frame stay in place, hidden, so their content is not
        // moved or reloaded; everything else unused goes.
        for (const [surfaceId, slot] of this.#slots) {
            if (!usedSlots.has(surfaceId)) {
                this.#write.style(slot.clip, { display: 'none' });
            }
        }
        for (const [key, element] of this.#elements) {
            if (!usedElements.has(key)) {
                element.remove();
                this.#elements.delete(key);
                this.#write.structure();
            }
        }
        return Object.freeze({
            viewportId: frame.viewportId,
            sceneRevision: frame.sceneRevision,
            size: Object.freeze({
                width: frame.view.width,
                height: frame.view.height,
                devicePixelRatio: frame.view.devicePixelRatio,
            }),
            layers: Object.freeze(layers),
            writes: this.#write.take(),
        });
    }
    /**
     * Takes the root out of the document and forgets every slot and element; whatever is still
     * mounted in a slot leaves the document with it. Rendering afterwards throws. Safe to call more
     * than once.
     */
    release() {
        if (!this.#released) {
            this.#released = true;
            this.root.remove();
            this.#slots.clear();
            this.#elements.clear();
        }
        return Promise.resolve();
    }
    #content(frame, planned, usedSlots, usedElements) {
        const { fragment, negotiation } = planned;
        const category = negotiation.layer;
        const id = `${category}:${fragment.id}`;
        const base = { id, category, fragmentId: fragment.id, surfaceId: fragment.surfaceId };
        switch (category) {
            case 'content-native': {
                if (usedSlots.has(fragment.surfaceId)) {
                    throw new SwfFailure(makeError('INVALID_INPUT', `surface "${fragment.surfaceId}" was planned as live content twice in viewport "${this.viewportId}"; a live element is mounted once`, { entityId: fragment.surfaceId }));
                }
                usedSlots.add(fragment.surfaceId);
                const content = this.#place(frame.scene, planned);
                return Object.freeze({ ...base, content });
            }
            case 'proxy':
            case 'placeholder': {
                usedElements.add(id);
                const element = this.#element(id, () => this.#representation(category, fragment));
                const label = element.firstElementChild;
                if (label !== null) {
                    // Labels are text, never markup.
                    this.#write.text(label, labelOf(frame.scene, fragment.surfaceId));
                }
                // Why it stands in for the content, when it is for a reason the view does not show.
                const reason = standInReason(planned);
                // The element is this session's own: its last child is the span made for the reason.
                const note = element.lastElementChild;
                if (note !== null && note !== label) {
                    this.#write.text(note, reason === null ? '' : this.#standIn(reason));
                    this.#write.style(note, { display: reason === null ? 'none' : 'block' });
                }
                this.#write.attribute(element, DOM_ATTRIBUTES.standIn, reason ?? '');
                this.#write.attribute(element, DOM_ATTRIBUTES.mode, negotiation.mode);
                this.#write.attribute(element, DOM_ATTRIBUTES.shape, negotiation.shapeFidelity);
                this.#write.attribute(element, DOM_ATTRIBUTES.representation, planned.representation);
                // A label alone stands, whole and on one line, in the middle of where the window is,
                // however small that is; a proxy reads from its top, clipped to the window.
                const alone = planned.representation === 'label';
                this.#write.style(element, {
                    ...boxOf(fragment.bounds),
                    display: alone ? 'flex' : 'block',
                    'align-items': alone ? 'center' : 'normal',
                    'justify-content': alone ? 'center' : 'normal',
                    'text-align': alone ? 'center' : 'start',
                    overflow: alone ? 'visible' : 'hidden',
                    'white-space': alone ? 'nowrap' : 'normal',
                    'font-size': alone ? '11px' : '',
                });
                return Object.freeze({ ...base, content: element });
            }
            case 'content-raster':
            case 'chrome':
            case 'overlay':
                throw new SwfFailure(makeError('UNSUPPORTED_CAPABILITY', `the DOM renderer cannot realize fragment "${fragment.id}" as ${category}`, { entityId: fragment.surfaceId }));
        }
    }
    /**
     * Places a surface's live slot: a clip box at the fragment's visible bounds, and inside it the
     * slot (laid out at the surface's size in CSS px) mapped onto the surface's projected corners.
     * Without usable corners the slot fills the bounds, and says its shape is approximate.
     */
    #place(scene, planned) {
        const { fragment, negotiation } = planned;
        const surface = scene.surfaces.get(fragment.surfaceId);
        if (surface === undefined) {
            throw new SwfFailure(makeError('INVALID_INPUT', `surface "${fragment.surfaceId}" is not in the frame’s scene`, {
                entityId: fragment.surfaceId,
            }));
        }
        let slot = this.#slots.get(fragment.surfaceId);
        if (slot === undefined) {
            const clip = this.#document.createElement('div');
            clip.setAttribute(DOM_ATTRIBUTES.layer, 'content-native');
            clip.setAttribute(DOM_ATTRIBUTES.surface, fragment.surfaceId);
            style(clip, { position: 'absolute', overflow: 'hidden', 'pointer-events': 'none' });
            const inner = this.#document.createElement('div');
            inner.setAttribute(DOM_ATTRIBUTES.slot, fragment.surfaceId);
            // Only the content takes input; the clip box around it does not.
            style(inner, {
                position: 'absolute',
                left: '0px',
                top: '0px',
                'transform-origin': '0 0',
                'pointer-events': 'auto',
            });
            clip.append(inner);
            slot = { clip, slot: inner };
            this.#slots.set(fragment.surfaceId, slot);
        }
        const [x, y, w, h] = fragment.bounds;
        const width = surface.bounds[0] * this.#ppu;
        const height = surface.bounds[1] * this.#ppu;
        const cornerMatrix = fragment.corners === null
            ? null
            : quadMatrix(width, height, offsetQuad(fragment.corners, x, y));
        const followsCorners = cornerMatrix !== null;
        const matrix = cornerMatrix ?? quadMatrix(width, height, offsetQuad(rectQuad(fragment.bounds), x, y));
        this.#write.style(slot.clip, {
            display: '',
            left: `${String(x)}px`,
            top: `${String(y)}px`,
            width: `${String(w)}px`,
            height: `${String(h)}px`,
        });
        this.#write.style(slot.slot, {
            width: `${String(width)}px`,
            height: `${String(height)}px`,
            transform: matrix === null ? 'scale(0)' : cssTransform(matrix),
        });
        this.#write.attribute(slot.clip, DOM_ATTRIBUTES.fragment, fragment.id);
        this.#write.attribute(slot.clip, DOM_ATTRIBUTES.mode, negotiation.mode);
        this.#write.attribute(slot.clip, DOM_ATTRIBUTES.anchor, negotiation.anchorFidelity);
        // A slot that could not follow the corners is never declared exact.
        this.#write.attribute(slot.clip, DOM_ATTRIBUTES.shape, followsCorners ? negotiation.shapeFidelity : 'approximate');
        this.#write.attribute(slot.clip, DOM_ATTRIBUTES.placement, followsCorners ? 'corners' : 'bounds');
        return slot.clip;
    }
    #representation(category, fragment) {
        const element = this.#document.createElement('div');
        element.setAttribute(DOM_ATTRIBUTES.layer, category);
        element.setAttribute(DOM_ATTRIBUTES.surface, fragment.surfaceId);
        element.setAttribute(DOM_ATTRIBUTES.fragment, fragment.id);
        // A representation hides what lies behind it, so it takes input (for the framework to route).
        style(element, { position: 'absolute', overflow: 'hidden', 'pointer-events': 'auto' });
        const label = this.#document.createElement('span');
        label.setAttribute(DOM_ATTRIBUTES.label, '');
        // The reason it stands in, when there is one: written with each frame.
        const note = this.#document.createElement('span');
        element.append(label, note);
        return element;
    }
    #element(key, make) {
        let element = this.#elements.get(key);
        if (element === undefined) {
            element = make();
            this.#elements.set(key, element);
        }
        return element;
    }
    /**
     * A window's chrome element, built once: a frame outline with its title (taking no input) and
     * the eight resize handles (taking input), shown or hidden as the window's edges allow.
     */
    #chromeElement(nodeId) {
        const e = this.#document.createElement('div');
        e.setAttribute(DOM_ATTRIBUTES.layer, 'chrome');
        e.setAttribute(DOM_ATTRIBUTES.node, nodeId);
        style(e, { position: 'absolute', 'pointer-events': 'none' });
        const outline = this.#document.createElement('div');
        outline.setAttribute(DOM_ATTRIBUTES.layer, 'chrome-frame');
        style(outline, {
            position: 'absolute',
            left: '0px',
            top: '0px',
            'transform-origin': '0 0',
            'pointer-events': 'none',
            'box-sizing': 'border-box',
        });
        const title = this.#document.createElement('div');
        title.setAttribute(DOM_ATTRIBUTES.label, '');
        style(title, { position: 'absolute', left: '0px', top: '0px', 'pointer-events': 'none' });
        outline.append(title);
        e.append(outline);
        for (const edge of Object.keys(RESIZE_EDGES)) {
            const handle = this.#document.createElement('div');
            handle.setAttribute(DOM_ATTRIBUTES.handle, edge);
            style(handle, { position: 'absolute', 'pointer-events': 'auto', cursor: `${edge}-resize` });
            e.append(handle);
        }
        return e;
    }
    /** Each window's projected frame (its native-owner piece), when chrome is drawn. */
    #chromeFrames(frame) {
        const frames = new Map();
        if (this.#chrome === null) {
            return frames;
        }
        const module = this.#chrome.projections.get(frame.view.projectionId);
        if (module === undefined) {
            throw new SwfFailure(makeError('UNSUPPORTED_CAPABILITY', `window chrome for viewport "${this.viewportId}" needs projection "${frame.view.projectionId}", which is not registered`));
        }
        const projection = projectionFor(module, frame.view);
        // A window whose every surface is represented by its label alone has no chrome: the label
        // stands for the whole window.
        const nodes = new Set(frame.planned.flatMap((p) => {
            const owner = frame.scene.surfaces.get(p.fragment.surfaceId)?.ownerNodeId;
            return owner === undefined || p.representation === 'label' ? [] : [owner];
        }));
        for (const nodeId of nodes) {
            const geometry = nodeFrameGeometry(frame.scene, nodeId);
            const piece = geometry === undefined
                ? undefined
                : projection.projectGeometry(geometry, frame.view).find((f) => f.nativeOwner);
            if (piece !== undefined) {
                frames.set(nodeId, piece);
            }
        }
        return frames;
    }
    /**
     * A window's chrome, a layer of its own: its frame outline and title (which take no input, so
     * nothing over content is intercepted) and, for a resizable window, handles along the frame
     * edges that lie inside the view, which take input so presses on them reach the framework even
     * where the content under them is a cross-origin frame.
     */
    #chromeLayer(scene, nodeId, piece, usedElements) {
        const chrome = this.#chrome;
        const node = scene.nodes.get(nodeId);
        if (chrome === null || node === undefined) {
            throw new Error('window chrome was drawn without its options or node');
        }
        const id = `chrome:${nodeId}`;
        usedElements.add(id);
        const element = this.#element(id, () => this.#chromeElement(nodeId));
        const outline = element.firstElementChild;
        const title = outline?.firstElementChild ?? null;
        if (outline === null || title === null) {
            throw new Error(`the chrome of window "${nodeId}" lost its frame`);
        }
        const [x, y, w, h] = piece.bounds;
        this.#write.style(element, boxOf(piece.bounds));
        const width = node.bounds[0] * this.#ppu;
        const height = node.bounds[1] * this.#ppu;
        const corners = piece.corners ?? rectQuad(piece.bounds);
        const matrix = quadMatrix(width, height, offsetQuad(corners, x, y)) ??
            quadMatrix(width, height, offsetQuad(rectQuad(piece.bounds), x, y));
        const selected = scene.selection.includes(nodeId);
        const focused = scene.focusedId === nodeId;
        this.#write.style(outline, {
            width: `${String(width)}px`,
            height: `${String(height)}px`,
            transform: matrix === null ? 'scale(0)' : cssTransform(matrix),
            // The window keys act on is marked, and the one in focus above it.
            border: `${focused || selected ? '3px' : '1px'} solid ${focused ? chrome.inks.focused : selected ? chrome.inks.selected : chrome.inks.frame}`,
        });
        // Labels are text, never markup.
        this.#write.text(title, node.label ?? '');
        this.#write.toggle(element, DOM_ATTRIBUTES.selected, selected);
        this.#write.toggle(element, DOM_ATTRIBUTES.focused, focused);
        const resizable = node.flags.resizable && !node.flags.locked;
        const t = chrome.handlePx;
        const [tl, tr, br, bl] = corners;
        // An edge is the window's own only where the piece is not cut there by the view or a seam.
        const inside = (value, lo, hi) => value >= lo - 0.5 && value <= hi + 0.5;
        const has = {
            n: inside(Math.min(tl[1], tr[1]), y, y + h),
            s: inside(Math.max(bl[1], br[1]), y, y + h),
            w: inside(Math.min(tl[0], bl[0]), x, x + w),
            e: inside(Math.max(tr[0], br[0]), x, x + w),
        };
        for (const handle of element.querySelectorAll(`[${DOM_ATTRIBUTES.handle}]`)) {
            const edge = handle.getAttribute(DOM_ATTRIBUTES.handle);
            const shown = resizable && RESIZE_EDGES[edge].every((side) => has[side]);
            const north = edge.includes('n');
            const south = edge.includes('s');
            const east = edge.includes('e');
            const west = edge.includes('w');
            this.#write.style(handle, shown
                ? {
                    display: '',
                    left: `${String(east ? w - t : 0)}px`,
                    top: `${String(south ? h - t : 0)}px`,
                    width: `${String(east || west ? t : w)}px`,
                    height: `${String(north || south ? t : h)}px`,
                }
                : { display: 'none' });
        }
        return Object.freeze({
            id,
            category: 'chrome',
            fragmentId: null,
            surfaceId: null,
            content: element,
        });
    }
}
/** A surface's label for its proxy or placeholder: its own, its window's, or its ID. */
function labelOf(scene, surfaceId) {
    const surface = scene.surfaces.get(surfaceId);
    const owner = surface === undefined ? undefined : scene.nodes.get(surface.ownerNodeId);
    return surface?.label ?? owner?.label ?? surfaceId;
}
function boxOf([x, y, w, h]) {
    return {
        left: `${String(x)}px`,
        top: `${String(y)}px`,
        width: `${String(w)}px`,
        height: `${String(h)}px`,
    };
}
function style(element, properties) {
    for (const [name, value] of Object.entries(properties)) {
        element.style.setProperty(name, value);
    }
}
//# sourceMappingURL=renderer.js.map