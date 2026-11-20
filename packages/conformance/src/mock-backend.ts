import type { Id, SceneState } from '@swf/core';
import type {
  ComposedFrame,
  CompositionLayer,
  CompositionTarget,
  Compositor,
  CompositorCapabilities,
  CompositorSession,
  RenderedFrame,
  RendererBackend,
  RendererCapabilities,
  RendererSession,
  RenderFrame,
  ViewGeometry,
} from '@swf/presentation';

/** A DOM-and-raster renderer that warps drawable content exactly and places live elements. */
export const MOCK_RENDERER_CAPABILITIES: RendererCapabilities = Object.freeze({
  handleKinds: Object.freeze({ 'native-dom': 'native', drawable: 'exact', 'proxy-only': 'proxy' }),
  transformMode: 'mesh',
  clipping: 'path',
  hitMapping: true,
  layering: 'dom-and-raster',
  resourceOwnership: 'renderer',
  recovery: 'rebuild',
});

/** A compositor with every layer category, explicit ordering and direct native presentation. */
export const MOCK_COMPOSITOR_CAPABILITIES: CompositorCapabilities = Object.freeze({
  layerCategories: Object.freeze([
    'content-native',
    'content-raster',
    'proxy',
    'placeholder',
    'chrome',
    'overlay',
  ] as const),
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

/**
 * A reference renderer that realizes each planned fragment as one layer of the category its
 * negotiation chose, in plan order, with no real resources.
 */
export class MockRenderer implements RendererBackend {
  readonly id: string;
  readonly apiVersion = 1;
  readonly #capabilities: RendererCapabilities;
  readonly sessions: MockRendererSession[] = [];

  constructor(id = 'mock.renderer/1', capabilities = MOCK_RENDERER_CAPABILITIES) {
    this.id = id;
    this.#capabilities = capabilities;
  }

  capabilities(): RendererCapabilities {
    return this.#capabilities;
  }

  prepare(_scene: SceneState, view: ViewGeometry): Promise<RendererSession> {
    const session = new MockRendererSession(this.id, view.viewportId);
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}

export class MockRendererSession implements RendererSession {
  readonly rendererId: string;
  readonly viewportId: Id;
  released = 0;

  constructor(rendererId: string, viewportId: Id) {
    this.rendererId = rendererId;
    this.viewportId = viewportId;
  }

  render(frame: RenderFrame): RenderedFrame {
    if (this.released > 0) {
      throw new Error(`renderer session for viewport "${this.viewportId}" was released`);
    }
    const layers: CompositionLayer[] = frame.planned.map((p) =>
      Object.freeze({
        id: `${p.negotiation.layer}:${p.fragment.id}`,
        category: p.negotiation.layer,
        fragmentId: p.fragment.id,
        surfaceId: p.fragment.surfaceId,
        content: Object.freeze({ fragmentId: p.fragment.id }),
      }),
    );
    return Object.freeze({
      viewportId: frame.viewportId,
      sceneRevision: frame.sceneRevision,
      size: Object.freeze({
        width: frame.view.width,
        height: frame.view.height,
        devicePixelRatio: frame.view.devicePixelRatio,
      }),
      layers: Object.freeze(layers),
    });
  }

  release(): Promise<void> {
    this.released += 1;
    return Promise.resolve();
  }
}

/** A reference compositor that keeps the rendered order. */
export class MockCompositor implements Compositor {
  readonly id: string;
  readonly apiVersion = 1;
  readonly #capabilities: CompositorCapabilities;

  constructor(id = 'mock.compositor/1', capabilities = MOCK_COMPOSITOR_CAPABILITIES) {
    this.id = id;
    this.#capabilities = capabilities;
  }

  capabilities(): CompositorCapabilities {
    return this.#capabilities;
  }

  prepare(target: CompositionTarget, renderer: RendererSession): Promise<CompositorSession> {
    if (renderer.viewportId !== target.viewportId) {
      return Promise.reject(new Error('the renderer session belongs to another viewport'));
    }
    return Promise.resolve(new MockCompositorSession(this.id, target.viewportId));
  }
}

export class MockCompositorSession implements CompositorSession {
  readonly compositorId: string;
  readonly viewportId: Id;
  released = 0;

  constructor(compositorId: string, viewportId: Id) {
    this.compositorId = compositorId;
    this.viewportId = viewportId;
  }

  compose(frame: RenderedFrame): ComposedFrame {
    if (this.released > 0) {
      throw new Error(`compositor session for viewport "${this.viewportId}" was released`);
    }
    return Object.freeze({
      viewportId: frame.viewportId,
      sceneRevision: frame.sceneRevision,
      order: Object.freeze(frame.layers.map((layer) => layer.id)),
      occlusion: MOCK_COMPOSITOR_CAPABILITIES.occlusion,
    });
  }

  release(): Promise<void> {
    this.released += 1;
    return Promise.resolve();
  }
}
