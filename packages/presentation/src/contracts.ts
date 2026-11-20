import type { Id, SceneState } from '@swf/core';
import type {
  CompositorCapabilities,
  LayerCategory,
  RendererCapabilities,
} from './capabilities.js';
import type { ProjectedFragment, ViewGeometry, ViewOutput } from './fragments.js';
import type { FallbackDiagnostic, Negotiation } from './negotiation.js';

/** The version of the renderer and compositor contracts this package defines. */
export const PRESENTATION_API_VERSION = 1;

/** A fragment with the presentation negotiated for it. */
export interface PlannedFragment {
  readonly fragment: ProjectedFragment;
  readonly negotiation: Negotiation;
}

/** One frame for one viewport: what to realize, in presentation order (back to front). */
export interface RenderFrame {
  readonly viewportId: Id;
  readonly sceneRevision: number;
  readonly view: ViewGeometry;
  readonly output: ViewOutput;
  readonly planned: readonly PlannedFragment[];
  /** Every fallback negotiation chose, for diagnostics. */
  readonly fallbacks: readonly FallbackDiagnostic[];
}

/**
 * One layer a renderer produced. Content, proxy and placeholder layers each realize exactly one
 * fragment; chrome and overlay layers may belong to a surface or to none.
 */
export interface CompositionLayer {
  /** Unique within the frame and stable for the same fragment and category across frames. */
  readonly id: string;
  readonly category: LayerCategory;
  readonly fragmentId: string | null;
  readonly surfaceId: Id | null;
  /** The renderer's own resource for the layer, opaque to everyone else. */
  readonly content: unknown;
}

/** What a renderer realized for a frame, in presentation order (back to front). */
export interface RenderedFrame {
  readonly viewportId: Id;
  readonly sceneRevision: number;
  readonly layers: readonly CompositionLayer[];
}

/** A renderer prepared for one viewport. It owns the resources it creates until released. */
export interface RendererSession {
  readonly rendererId: string;
  readonly viewportId: Id;
  /**
   * Realizes a planned frame. For the same frame it must produce the same layers in the same
   * order: the order follows the plan, never incidental insertion order.
   */
  render(frame: RenderFrame): RenderedFrame;
  /** Releases what the session created. Safe to call more than once. */
  release(): Promise<void>;
}

/**
 * Realizes views. It reads the scene but never changes it, and never manages the producers of
 * what it presents.
 */
export interface RendererBackend {
  /** A versioned ID, `<name>/<version>`. */
  readonly id: string;
  readonly apiVersion: number;
  capabilities(): RendererCapabilities;
  prepare(scene: SceneState, view: ViewGeometry): Promise<RendererSession>;
}

/** Where a compositor assembles a viewport: the host's container, opaque to the framework. */
export interface CompositionTarget {
  readonly viewportId: Id;
  readonly container: unknown;
}

/** The layers as assembled, back to front. */
export interface ComposedFrame {
  readonly viewportId: Id;
  readonly sceneRevision: number;
  readonly order: readonly string[];
}

export interface CompositorSession {
  readonly compositorId: string;
  readonly viewportId: Id;
  /**
   * Assembles a rendered frame. An `explicit`-ordering compositor keeps the rendered order; a
   * `dom-order` compositor declares that its order is the DOM's.
   */
  compose(frame: RenderedFrame): ComposedFrame;
  /** Releases what the session created. Safe to call more than once. */
  release(): Promise<void>;
}

/** Assembles a renderer's layers into a viewport, keeping chrome apart from content. */
export interface Compositor {
  /** A versioned ID, `<name>/<version>`. */
  readonly id: string;
  readonly apiVersion: number;
  capabilities(): CompositorCapabilities;
  prepare(target: CompositionTarget, renderer: RendererSession): Promise<CompositorSession>;
}
