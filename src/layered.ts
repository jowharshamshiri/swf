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

/** The two renderers a layered renderer pairs. It keeps them as given and never disposes them. */
export interface LayeredRendererOptions {
  /** A versioned ID for the pair, `<name>/<version>`. Default `swf.layered-renderer/1`. */
  readonly id?: string;
  /**
   * Presents live content (`content-native` layers), such as a DOM renderer without chrome. It
   * must present `native-dom` handles, or {@link LayeredRenderer.capabilities} throws.
   */
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
  /** The pair's ID, as its options gave it. */
  readonly id: string;
  /** The presentation API version it implements. */
  readonly apiVersion = PRESENTATION_API_VERSION;
  readonly #native: RendererBackend;
  readonly #geometry: GeometryRenderer;

  /**
   * Pairs `options.native` and `options.geometry`, which are not checked here.
   *
   * @throws `RangeError` for an `id` that is not a versioned ID.
   */
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

  /**
   * What the pair can do together: live content as the native renderer presents it, every other
   * handle kind as the geometry renderer does, and the lower of the two transform modes, clipping
   * and recovery. A new frozen object on every call.
   *
   * @throws {@link @swf/core!SwfFailure} `UNSUPPORTED_CAPABILITY` when the native renderer
   *   presents no `native-dom` content.
   */
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

  /**
   * Prepares a session of each renderer for the view, the native one first, and pairs them. When
   * the geometry renderer fails, or prepares a session that is not a geometry session, every
   * session prepared is released and the failure passed on.
   *
   * @throws `Error` (as a rejection) when the geometry renderer prepares a session of another
   *   kind; and as either renderer's `prepare` rejects. When releasing a session prepared also
   *   fails, it rejects with an `AggregateError` holding the first failure, then each release's.
   */
  async prepare(scene: SceneState, view: ViewGeometry): Promise<RendererSession> {
    const native = await this.#native.prepare(scene, view);
    let geometry: RendererSession;
    try {
      geometry = await this.#geometry.prepare(scene, view);
    } catch (error) {
      return failWith(error, await releaseEach([() => native.release()]));
    }
    if (!(geometry instanceof GeometryRendererSession)) {
      const other = geometry;
      return failWith(
        new Error('the geometry renderer prepared a session of another kind'),
        await releaseEach([() => native.release(), () => other.release()]),
      );
    }
    return new LayeredRendererSession(this.id, view.viewportId, native, geometry);
  }
}

/**
 * A layered renderer's session for one viewport: a native session and a geometry session, owned
 * together. The presenter owns it; releasing it releases both.
 */
export class LayeredRendererSession implements RendererSession {
  /** The layered renderer that prepared it. */
  readonly rendererId: string;
  /** The viewport it renders. */
  readonly viewportId: Id;
  /** The native renderer's own session (for the live slots a host attaches content to). */
  readonly native: RendererSession;
  /** The geometry renderer's own session, which draws everything but live content. */
  readonly geometry: GeometryRendererSession;
  #released = false;

  /** Pairs two prepared sessions of one viewport, as {@link LayeredRenderer.prepare} does. */
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

  /**
   * Has the native session render the frame's live fragments and the geometry session everything
   * else, then merges their layers in plan order: each fragment's layer, then the chrome stacked
   * after it, then the layers of no fragment on top. Its writes are both sessions' together.
   *
   * @throws {@link @swf/core!SwfFailure} `INVALID_TRANSITION` once released; `INVALID_INPUT`
   *   when the native session makes a layer that is not live content it was asked for; and as
   *   either session's `render` throws.
   */
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

  /**
   * Releases the native session, then the geometry session, the second even when the first
   * fails. Safe to call more than once: only the first call releases.
   *
   * @throws As a session's `release` rejects; an `AggregateError` holding both failures when
   *   both do.
   */
  async release(): Promise<void> {
    if (!this.#released) {
      this.#released = true;
      const [first, ...more] = await releaseEach([
        () => this.native.release(),
        () => this.geometry.release(),
      ]);
      if (first !== undefined) {
        failWith(first.error, more);
      }
    }
  }
}

/**
 * Runs each release in turn, every one even when one before it fails, and resolves to what
 * failed, in order.
 */
async function releaseEach(
  releases: readonly (() => Promise<void>)[],
): Promise<{ readonly error: unknown }[]> {
  const failed: { readonly error: unknown }[] = [];
  for (const release of releases) {
    try {
      await release();
    } catch (error) {
      failed.push({ error });
    }
  }
  return failed;
}

/**
 * Throws `error` as it is when nothing else `failed`; otherwise an `AggregateError` holding
 * `error`, then each other failure, in order.
 */
function failWith(error: unknown, failed: readonly { readonly error: unknown }[]): never {
  if (failed.length === 0) {
    throw error;
  }
  const all = [error, ...failed.map((f) => f.error)];
  throw new AggregateError(all, all.map(describe).join('; and then '));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
