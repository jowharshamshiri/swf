import type { Id } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type {
  ComposedFrame,
  CompositionLayer,
  CompositionTarget,
  Compositor,
  CompositorCapabilities,
  CompositorSession,
  RenderedFrame,
  RendererSession,
  ViewSize,
} from '@swf/presentation';
import { PRESENTATION_API_VERSION } from '@swf/presentation';
import type { GeometryLayer } from './layer.js';
import { isGeometryLayer } from './layer.js';

export const LAYER_COMPOSITOR_ID = 'swf.layer-compositor/1';

/**
 * What the layer compositor can do: it assembles live elements and drawn layers together, in an
 * explicit order. Live elements and canvases are stacked as whole layers, so where they overlap
 * each lies entirely in front of or behind the other (`layer-order`): there is no per-pixel depth
 * between a live element and drawn content.
 */
export const LAYER_COMPOSITOR_CAPABILITIES: CompositorCapabilities = Object.freeze({
  layerCategories: Object.freeze([
    'content-native',
    'content-raster',
    'proxy',
    'placeholder',
    'chrome',
    'overlay',
  ] as const),
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
export class LayerCompositor implements Compositor {
  readonly id = LAYER_COMPOSITOR_ID;
  readonly apiVersion = PRESENTATION_API_VERSION;

  capabilities(): CompositorCapabilities {
    return LAYER_COMPOSITOR_CAPABILITIES;
  }

  /** Builds the view's root in the target container, which must be an element. */
  prepare(target: CompositionTarget, renderer: RendererSession): Promise<CompositorSession> {
    const reject = (message: string) =>
      Promise.reject(new SwfFailure(makeError('INVALID_INPUT', message)));
    if (renderer.viewportId !== target.viewportId) {
      return reject(
        `the renderer session belongs to viewport "${renderer.viewportId}", not "${target.viewportId}"`,
      );
    }
    const container = target.container;
    const view = (container as { ownerDocument?: Document | null } | null)?.ownerDocument
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

export class LayerCompositorSession implements CompositorSession {
  readonly compositorId: string;
  readonly viewportId: Id;
  /** The view's root: canvases and live elements are its children. */
  readonly root: HTMLElement;
  readonly #canvases: HTMLCanvasElement[] = [];
  #released = false;

  constructor(compositorId: string, viewportId: Id, root: HTMLElement) {
    this.compositorId = compositorId;
    this.viewportId = viewportId;
    this.root = root;
  }

  compose(frame: RenderedFrame): ComposedFrame {
    if (this.#released) {
      throw new SwfFailure(
        makeError(
          'INVALID_TRANSITION',
          `the layer compositor session for viewport "${this.viewportId}" was released`,
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
    const HTMLElementOf = this.root.ownerDocument.defaultView?.HTMLElement;
    // Split the stack into runs: each live element alone, consecutive drawn layers together.
    const runs: (
      | { kind: 'drawn'; layers: CompositionLayer[]; start: number }
      | { kind: 'live'; element: HTMLElement; layer: CompositionLayer; start: number }
    )[] = [];
    frame.layers.forEach((layer, index) => {
      const content = layer.content;
      if (isGeometryLayer(content)) {
        const last = runs.at(-1);
        if (last?.kind === 'drawn') {
          last.layers.push(layer);
        } else {
          runs.push({ kind: 'drawn', layers: [layer], start: index });
        }
      } else if (HTMLElementOf !== undefined && content instanceof HTMLElementOf) {
        runs.push({ kind: 'live', element: content, layer, start: index });
      } else {
        throw new SwfFailure(
          makeError('INVALID_INPUT', `layer "${layer.id}" is neither a drawn layer nor an element`),
        );
      }
    });
    let canvasIndex = 0;
    for (const run of runs) {
      if (run.kind === 'live') {
        if (run.element.parentElement !== this.root) {
          if (run.element.parentElement !== null) {
            throw new SwfFailure(
              makeError(
                'INVALID_INPUT',
                `layer "${run.layer.id}" belongs to another parent; it would be moved`,
              ),
            );
          }
          this.root.append(run.element);
        }
        run.element.style.setProperty('z-index', String(run.start + 1));
        continue;
      }
      const canvas = this.#canvas(canvasIndex++);
      canvas.style.setProperty('z-index', String(run.start + 1));
      paint(
        canvas,
        frame.size,
        run.layers.map((l) => l.content as GeometryLayer),
      );
    }
    // Canvases this frame did not need go.
    for (const canvas of this.#canvases.splice(canvasIndex)) {
      canvas.remove();
    }
    this.root.style.setProperty('width', `${String(frame.size.width)}px`);
    this.root.style.setProperty('height', `${String(frame.size.height)}px`);
    return Object.freeze({
      viewportId: frame.viewportId,
      sceneRevision: frame.sceneRevision,
      order: Object.freeze(frame.layers.map((l) => l.id)),
      occlusion: LAYER_COMPOSITOR_CAPABILITIES.occlusion,
    });
  }

  /** Takes the view's root out of its container. Safe to call more than once. */
  release(): Promise<void> {
    if (!this.#released) {
      this.#released = true;
      this.root.remove();
      this.#canvases.length = 0;
    }
    return Promise.resolve();
  }

  #canvas(index: number): HTMLCanvasElement {
    let canvas = this.#canvases[index];
    if (canvas === undefined) {
      canvas = this.root.ownerDocument.createElement('canvas');
      canvas.setAttribute('data-swf-layer', 'drawn');
      canvas.style.setProperty('position', 'absolute');
      canvas.style.setProperty('left', '0px');
      canvas.style.setProperty('top', '0px');
      // Drawn layers show; they never take input from what lies under them.
      canvas.style.setProperty('pointer-events', 'none');
      this.root.append(canvas);
      this.#canvases.push(canvas);
    }
    return canvas;
  }
}

/** Clears the canvas to the view's size and draws the layers on it, in order. */
function paint(canvas: HTMLCanvasElement, size: ViewSize, layers: readonly GeometryLayer[]): void {
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
    throw new SwfFailure(
      makeError('UNSUPPORTED_CAPABILITY', 'the browser offers no 2D canvas context'),
    );
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
