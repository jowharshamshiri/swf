import type { Id } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type {
  ComposedFrame,
  CompositionTarget,
  Compositor,
  CompositorCapabilities,
  CompositorSession,
  RenderedFrame,
  RendererSession,
} from '@swf/presentation';
import { PRESENTATION_API_VERSION } from '@swf/presentation';
import { DomRendererSession } from './renderer.js';
import { DomWriter } from './writer.js';

/** The DOM compositor's registered ID, as {@link DomCompositor} declares it. */
export const DOM_COMPOSITOR_ID = 'swf.dom-compositor/1';

/**
 * What the DOM compositor can do: it assembles live content, proxies, placeholders, chrome and
 * overlays as DOM layers, ordered explicitly (by stacking order, never by moving elements), clipped
 * to rectangles. It has no raster layer. Frozen.
 */
export const DOM_COMPOSITOR_CAPABILITIES: CompositorCapabilities = Object.freeze({
  layerCategories: Object.freeze([
    'content-native',
    'proxy',
    'placeholder',
    'chrome',
    'overlay',
  ] as const),
  ordering: 'explicit',
  masking: false,
  transparency: true,
  clipping: 'rect',
  overlays: true,
  interpolation: false,
  directNative: true,
  multiViewport: true,
  // Elements stack by z-index: each layer lies entirely in front of or behind another.
  occlusion: 'layer-order',
});

/** Assembles a DOM renderer's layers into the host's container, one session per viewport. */
export class DomCompositor implements Compositor {
  /** {@link DOM_COMPOSITOR_ID}. */
  readonly id = DOM_COMPOSITOR_ID;
  /** The presentation API version it implements. */
  readonly apiVersion = PRESENTATION_API_VERSION;

  /** {@link DOM_COMPOSITOR_CAPABILITIES}, the same object on every call. */
  capabilities(): CompositorCapabilities {
    return DOM_COMPOSITOR_CAPABILITIES;
  }

  /**
   * Puts the renderer session's root in the target container. The container must be an element
   * of the renderer's document, and the renderer a DOM renderer session of the same viewport;
   * otherwise it rejects with {@link SwfFailure} (`INVALID_INPUT`). The container stays the
   * host's; the session takes the root out again when released.
   */
  prepare(target: CompositionTarget, renderer: RendererSession): Promise<CompositorSession> {
    const reject = (message: string) =>
      Promise.reject(new SwfFailure(makeError('INVALID_INPUT', message)));
    if (!(renderer instanceof DomRendererSession)) {
      return reject(
        `the DOM compositor assembles only DOM renderer sessions (got "${renderer.rendererId}")`,
      );
    }
    if (renderer.viewportId !== target.viewportId) {
      return reject(
        `the renderer session belongs to viewport "${renderer.viewportId}", not "${target.viewportId}"`,
      );
    }
    const container = target.container;
    const view = renderer.root.ownerDocument.defaultView;
    if (view === null || !(container instanceof view.HTMLElement)) {
      return reject(
        `the container of viewport "${target.viewportId}" must be an element of the renderer's document`,
      );
    }
    container.append(renderer.root);
    return Promise.resolve(new DomCompositorSession(this.id, renderer));
  }
}

/**
 * A DOM compositor's session for one viewport, assembling one DOM renderer session's layers in
 * its root. The presenter owns it and releases it.
 */
export class DomCompositorSession implements CompositorSession {
  /** The compositor that prepared it. */
  readonly compositorId: string;
  /** The viewport it composes: its renderer session's. */
  readonly viewportId: Id;
  readonly #renderer: DomRendererSession;
  readonly #write = new DomWriter();
  #released = false;

  /** A session over `renderer`, as {@link DomCompositor.prepare} makes it. */
  constructor(compositorId: string, renderer: DomRendererSession) {
    this.compositorId = compositorId;
    this.viewportId = renderer.viewportId;
    this.#renderer = renderer;
  }

  /**
   * Stacks the layers in the rendered order by `z-index`. A layer's element is appended to the
   * view's root the first time it appears and never moved after, so live content (an iframe, a
   * video) is never re-parented, which would reload it.
   *
   * @throws {@link @swf/core!SwfFailure} `INVALID_TRANSITION` once released; `INVALID_INPUT`
   *   for a frame of another viewport, or a layer that is not an element of this view or already
   *   has another parent.
   */
  compose(frame: RenderedFrame): ComposedFrame {
    if (this.#released) {
      throw new SwfFailure(
        makeError(
          'INVALID_TRANSITION',
          `the DOM compositor session for viewport "${this.viewportId}" was released`,
        ),
      );
    }
    if (frame.viewportId !== this.viewportId) {
      throw new SwfFailure(
        makeError(
          'INVALID_INPUT',
          `a frame for viewport "${frame.viewportId}" was given to viewport "${this.viewportId}"`,
        ),
      );
    }
    const root = this.#renderer.root;
    const HTMLElementOf = root.ownerDocument.defaultView?.HTMLElement;
    frame.layers.forEach((layer, index) => {
      const element = layer.content;
      if (HTMLElementOf === undefined || !(element instanceof HTMLElementOf)) {
        throw new SwfFailure(
          makeError('INVALID_INPUT', `layer "${layer.id}" is not a DOM element of this view`),
        );
      }
      if (element.parentElement !== root) {
        if (element.parentElement !== null) {
          throw new SwfFailure(
            makeError(
              'INVALID_INPUT',
              `layer "${layer.id}" belongs to another parent; it would be moved`,
            ),
          );
        }
        root.append(element);
        this.#write.structure();
      }
      this.#write.style(element, { 'z-index': String(index + 1) });
    });
    return Object.freeze({
      viewportId: frame.viewportId,
      sceneRevision: frame.sceneRevision,
      order: Object.freeze(frame.layers.map((layer) => layer.id)),
      occlusion: DOM_COMPOSITOR_CAPABILITIES.occlusion,
      writes: this.#write.take(),
    });
  }

  /** DOM elements are never lost, so this never calls `listener`. */
  watchLoss(): () => void {
    return () => undefined;
  }

  /** Takes the view's root out of the container. Safe to call more than once. */
  release(): Promise<void> {
    if (!this.#released) {
      this.#released = true;
      this.#renderer.root.remove();
    }
    return Promise.resolve();
  }
}
