import type { Id, SceneState } from '@swf/core';
import type {
  ComposedFrame,
  CompositionLayer,
  CompositionTarget,
  Compositor,
  CompositorCapabilities,
  CompositorSession,
  LossListener,
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

/** Listeners for a session's loss of resources, and a way to make the loss happen. */
class Loss {
  readonly #listeners = new Set<LossListener>();

  watch(listener: LossListener): () => void {
    const entry: LossListener = (reason) => {
      listener(reason);
    };
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }

  lose(reason: string): void {
    for (const listener of [...this.#listeners]) {
      listener(reason);
    }
  }

  get watchers(): number {
    return this.#listeners.size;
  }
}

/**
 * A reference renderer that realizes each planned fragment as one layer of the category its
 * negotiation chose, in plan order, with no real resources. Live content attaches to a target
 * object of the session's own, one per surface.
 */
export class MockRenderer implements RendererBackend {
  readonly id: string;
  readonly apiVersion = 1;
  readonly #capabilities: RendererCapabilities;
  readonly sessions: MockRendererSession[] = [];
  /** When set, preparing fails with this message. */
  failPrepare: string | null = null;

  constructor(id = 'mock.renderer/1', capabilities = MOCK_RENDERER_CAPABILITIES) {
    this.id = id;
    this.#capabilities = capabilities;
  }

  capabilities(): RendererCapabilities {
    return this.#capabilities;
  }

  prepare(_scene: SceneState, view: ViewGeometry): Promise<RendererSession> {
    if (this.failPrepare !== null) {
      return Promise.reject(new Error(this.failPrepare));
    }
    const session = new MockRendererSession(this.id, view.viewportId);
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}

export class MockRendererSession implements RendererSession {
  readonly rendererId: string;
  readonly viewportId: Id;
  released = 0;
  /** When set, rendering throws with this message. */
  failRender: string | null = null;
  readonly #loss = new Loss();
  readonly #targets = new Map<Id, object>();
  #live = new Set<Id>();

  constructor(rendererId: string, viewportId: Id) {
    this.rendererId = rendererId;
    this.viewportId = viewportId;
  }

  targetOf(surfaceId: Id): unknown {
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

  watchLoss(listener: LossListener): () => void {
    return this.#loss.watch(listener);
  }

  /** Makes the session lose its resources, as a lost graphics context would. */
  lose(reason: string): void {
    this.#loss.lose(reason);
  }

  /** How many are listening for its loss. */
  get lossWatchers(): number {
    return this.#loss.watchers;
  }

  render(frame: RenderFrame): RenderedFrame {
    if (this.failRender !== null) {
      throw new Error(this.failRender);
    }
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
    this.#live = new Set(
      layers.flatMap((l) =>
        l.category === 'content-native' && l.surfaceId !== null ? [l.surfaceId] : [],
      ),
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
      writes: 0,
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
  readonly sessions: MockCompositorSession[] = [];
  /** When set, preparing fails with this message. */
  failPrepare: string | null = null;

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
    if (this.failPrepare !== null) {
      return Promise.reject(new Error(this.failPrepare));
    }
    const session = new MockCompositorSession(this.id, target.viewportId);
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}

export class MockCompositorSession implements CompositorSession {
  readonly compositorId: string;
  readonly viewportId: Id;
  released = 0;
  readonly #loss = new Loss();

  constructor(compositorId: string, viewportId: Id) {
    this.compositorId = compositorId;
    this.viewportId = viewportId;
  }

  watchLoss(listener: LossListener): () => void {
    return this.#loss.watch(listener);
  }

  /** Makes the session lose its resources, as a lost graphics context would. */
  lose(reason: string): void {
    this.#loss.lose(reason);
  }

  get lossWatchers(): number {
    return this.#loss.watchers;
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
      writes: 0,
    });
  }

  release(): Promise<void> {
    this.released += 1;
    return Promise.resolve();
  }
}
