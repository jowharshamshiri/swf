import type { Id, SceneState } from '@swf/core';
import { makeError, SwfFailure, VERSIONED_ID } from '@swf/core';
import type {
  CompositionLayer,
  RenderedFrame,
  LossListener,
  RendererBackend,
  RendererCapabilities,
  RendererSession,
  RenderFrame,
  ViewGeometry,
} from '@swf/presentation';
import { PRESENTATION_API_VERSION } from '@swf/presentation';
import type { Fidelity } from '@swf/surfaces';
import type { GeometryRenderer } from './renderer.js';
import { GeometryRendererSession } from './renderer.js';
import { isGeometryLayer } from './layer.js';

const TRANSFORMS = ['translate', 'affine-2d', 'perspective-3d', 'mesh'] as const;
const CLIPS = ['none', 'rect', 'path'] as const;
const RECOVERY = ['none', 'rebuild', 'restore'] as const;

export interface LayeredRendererOptions {
  /** A versioned ID for the pair. Default `swf.layered-renderer/1`. */
  readonly id?: string;
  /** Presents live content (`content-native` layers), such as a DOM renderer without chrome. */
  readonly native: RendererBackend;
  /** Draws everything else: drawn content, proxies, placeholders, chrome and indicators. */
  readonly geometry: GeometryRenderer;
}

/**
 * Two independent renderers as one: live content from the native renderer, everything else from
 * the geometry renderer, merged in plan order (each window's chrome right after its content,
 * indicators on top). Its capabilities are what the pair can honestly do together.
 */
export class LayeredRenderer implements RendererBackend {
  readonly id: string;
  readonly apiVersion = PRESENTATION_API_VERSION;
  readonly #native: RendererBackend;
  readonly #geometry: GeometryRenderer;

  constructor(options: LayeredRendererOptions) {
    const id = options.id ?? 'swf.layered-renderer/1';
    if (!VERSIONED_ID.test(id)) {
      throw new RangeError(
        `a layered renderer ID must look like "name/1" (got ${JSON.stringify(id)})`,
      );
    }
    this.id = id;
    this.#native = options.native;
    this.#geometry = options.geometry;
  }

  capabilities(): RendererCapabilities {
    const native = this.#native.capabilities();
    const geometry = this.#geometry.capabilities();
    if (native.handleKinds['native-dom'] === undefined) {
      throw new SwfFailure(
        makeError(
          'UNSUPPORTED_CAPABILITY',
          `renderer "${this.#native.id}" presents no live content`,
        ),
      );
    }
    const kinds: Record<string, Fidelity> = { ...geometry.handleKinds };
    kinds['native-dom'] = native.handleKinds['native-dom'];
    const lowest = <T extends string>(order: readonly T[], a: T, b: T): T =>
      order.indexOf(a) <= order.indexOf(b) ? a : b;
    return Object.freeze({
      handleKinds: Object.freeze(kinds),
      // Each kind of content keeps its own renderer's transforms; the pair claims only what both
      // can do, so nothing is promised that one of them cannot keep.
      transformMode: lowest(TRANSFORMS, native.transformMode, geometry.transformMode),
      clipping: lowest(CLIPS, native.clipping, geometry.clipping),
      hitMapping: native.hitMapping && geometry.hitMapping,
      layering: 'dom-and-raster',
      resourceOwnership: 'renderer',
      recovery: lowest(RECOVERY, native.recovery, geometry.recovery),
    });
  }

  async prepare(scene: SceneState, view: ViewGeometry): Promise<RendererSession> {
    const native = await this.#native.prepare(scene, view);
    let geometry: RendererSession;
    try {
      geometry = await this.#geometry.prepare(scene, view);
    } catch (error) {
      await native.release();
      throw error;
    }
    if (!(geometry instanceof GeometryRendererSession)) {
      throw new Error('the geometry renderer prepared a session of another kind');
    }
    return new LayeredRendererSession(this.id, view.viewportId, native, geometry);
  }
}

export class LayeredRendererSession implements RendererSession {
  readonly rendererId: string;
  readonly viewportId: Id;
  /** The native renderer's own session (for the live slots a host attaches content to). */
  readonly native: RendererSession;
  readonly geometry: GeometryRendererSession;
  #released = false;

  constructor(
    rendererId: string,
    viewportId: Id,
    native: RendererSession,
    geometry: GeometryRendererSession,
  ) {
    this.rendererId = rendererId;
    this.viewportId = viewportId;
    this.native = native;
    this.geometry = geometry;
  }

  render(frame: RenderFrame): RenderedFrame {
    if (this.#released) {
      throw new SwfFailure(
        makeError(
          'INVALID_TRANSITION',
          `the layered renderer session for viewport "${this.viewportId}" was released`,
        ),
      );
    }
    const live = frame.planned.filter((p) => p.negotiation.layer === 'content-native');
    const liveIds = new Set(live.map((p) => p.fragment.id));
    const native = this.native.render({ ...frame, planned: live });
    const nativeOf = new Map<string, CompositionLayer>();
    for (const l of native.layers) {
      if (l.category !== 'content-native' || l.fragmentId === null || !liveIds.has(l.fragmentId)) {
        throw new SwfFailure(
          makeError(
            'INVALID_INPUT',
            `the native renderer produced layer "${l.id}", which is not the live content it was asked for`,
          ),
        );
      }
      nativeOf.set(l.fragmentId, l);
    }
    const drawn = this.geometry.renderExcept(frame, liveIds);
    const drawnOf = new Map<string, CompositionLayer>();
    const after = new Map<string, CompositionLayer[]>();
    const top: CompositionLayer[] = [];
    for (const l of drawn.layers) {
      if (l.fragmentId !== null) {
        drawnOf.set(l.fragmentId, l);
        continue;
      }
      const anchor = isGeometryLayer(l.content) ? l.content.after : null;
      if (anchor === null) {
        top.push(l);
      } else {
        after.set(anchor, [...(after.get(anchor) ?? []), l]);
      }
    }
    const layers: CompositionLayer[] = [];
    for (const p of frame.planned) {
      const own = nativeOf.get(p.fragment.id) ?? drawnOf.get(p.fragment.id);
      if (own === undefined) {
        throw new Error(`fragment "${p.fragment.id}" was realized by neither renderer`);
      }
      layers.push(own, ...(after.get(p.fragment.id) ?? []));
    }
    layers.push(...top);
    return Object.freeze({
      viewportId: frame.viewportId,
      sceneRevision: frame.sceneRevision,
      size: drawn.size,
      layers: Object.freeze(layers),
      writes: native.writes + drawn.writes,
    });
  }

  /** Live content attaches where the native renderer puts it. */
  targetOf(surfaceId: Id): unknown {
    return this.native.targetOf(surfaceId);
  }

  /** The native renderer may lose its resources; the geometry renderer holds none to lose. */
  watchLoss(listener: LossListener): () => void {
    return this.native.watchLoss(listener);
  }

  async release(): Promise<void> {
    if (!this.#released) {
      this.#released = true;
      await this.native.release();
      await this.geometry.release();
    }
  }
}
