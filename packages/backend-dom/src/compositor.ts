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

export const DOM_COMPOSITOR_ID = 'swf.dom-compositor/1';

/**
 * What the DOM compositor can do: it assembles live content, proxies, placeholders, chrome and
 * overlays as DOM layers, ordered explicitly (by stacking order, never by moving elements), clipped
 * to rectangles. It has no raster layer.
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
});

/** Assembles a DOM renderer's layers into the host's container, one session per viewport. */
export class DomCompositor implements Compositor {
  readonly id = DOM_COMPOSITOR_ID;
  readonly apiVersion = PRESENTATION_API_VERSION;

  capabilities(): CompositorCapabilities {
    return DOM_COMPOSITOR_CAPABILITIES;
  }

  /**
   * Puts the renderer session's root in the target container. The container must be an element
   * of the renderer's document, and the renderer a DOM renderer session of the same viewport.
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

export class DomCompositorSession implements CompositorSession {
  readonly compositorId: string;
  readonly viewportId: Id;
  readonly #renderer: DomRendererSession;
  #released = false;

  constructor(compositorId: string, renderer: DomRendererSession) {
    this.compositorId = compositorId;
    this.viewportId = renderer.viewportId;
    this.#renderer = renderer;
  }

  /**
   * Stacks the layers in the rendered order by `z-index`. A layer's element is appended to the
   * view's root the first time it appears and never moved after, so live content (an iframe, a
   * video) is never re-parented, which would reload it.
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
      }
      element.style.setProperty('z-index', String(index + 1));
    });
    return Object.freeze({
      viewportId: frame.viewportId,
      sceneRevision: frame.sceneRevision,
      order: Object.freeze(frame.layers.map((layer) => layer.id)),
    });
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
