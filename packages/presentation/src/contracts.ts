import type { Id, SceneState } from '@swf/core';
import type {
  CompositorCapabilities,
  LayerCategory,
  Occlusion,
  RendererCapabilities,
} from './capabilities.js';
import type { ProjectedFragment, ViewGeometry, ViewOutput } from './fragments.js';
import type { FallbackDiagnostic, Negotiation } from './negotiation.js';
import type { Representation } from './representation.js';
import type { SurfaceCondition } from './conditions.js';

/** The version of the renderer and compositor contracts this package defines. */
export const PRESENTATION_API_VERSION = 1;

/** A fragment with the presentation negotiated for it. */
export interface PlannedFragment {
  readonly fragment: ProjectedFragment;
  readonly negotiation: Negotiation;
  /**
   * How the viewport's representation policy chose to represent the surface: `full` unless one
   * chose less. A `compact` or `label` fragment is negotiated among the modes that stand for the
   * surface (a proxy, or a placeholder when no proxy is possible); a renderer draws a `label`
   * proxy as the surface's label alone, and leaves out its window's chrome.
   */
  readonly representation: Representation;
  /** Where the surface's binding stands: what a stand-in for its content says (FR-195). */
  readonly condition: SurfaceCondition;
}

/** One frame for one viewport: what to realize, in presentation order (back to front). */
export interface RenderFrame {
  readonly viewportId: Id;
  readonly sceneRevision: number;
  /** The scene at `sceneRevision`, for what a renderer shows besides content (labels, selection). */
  readonly scene: SceneState;
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

/** The size of a view: CSS pixels across and down, and device pixels per CSS pixel. */
export interface ViewSize {
  readonly width: number;
  readonly height: number;
  readonly devicePixelRatio: number;
}

/** What a renderer realized for a frame, in presentation order (back to front). */
export interface RenderedFrame {
  readonly viewportId: Id;
  readonly sceneRevision: number;
  /** The frame's view size, for a compositor sizing what it assembles. */
  readonly size: ViewSize;
  /**
   * How many changes this render made to what it presents (element properties, layer content):
   * a view that did not change makes none.
   */
  readonly writes: number;
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
  /**
   * Where a surface's own content attaches in this view (the container of its presentation
   * target), once a render has planned it live here; undefined before that.
   */
  targetOf(surfaceId: Id): unknown;
  /**
   * Calls `listener` when the session loses resources it cannot present without (a graphics
   * context, say), with what was lost. Returns a function that stops listening.
   */
  watchLoss(listener: LossListener): () => void;
  /** Releases what the session created. Safe to call more than once. */
  release(): Promise<void>;
}

/** Told what a session lost; the session cannot present until it is replaced. */
export type LossListener = (reason: string) => void;

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
  /** How this frame's overlapping layers occlude each other, as the compositor declares. */
  readonly occlusion: Occlusion;
  /** How many changes composing made (stacking, placement, repaints): none for an unchanged frame. */
  readonly writes: number;
}

export interface CompositorSession {
  readonly compositorId: string;
  readonly viewportId: Id;
  /**
   * Assembles a rendered frame. An `explicit`-ordering compositor keeps the rendered order; a
   * `dom-order` compositor declares that its order is the DOM's.
   */
  compose(frame: RenderedFrame): ComposedFrame;
  /** As {@link RendererSession.watchLoss}: calls `listener` when the session loses resources. */
  watchLoss(listener: LossListener): () => void;
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
