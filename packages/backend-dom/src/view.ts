import type { Id, SwfError, WorkspaceReader } from '@swf/core';
import { makeError, SwfFailure } from '@swf/core';
import type { ComposedFrame, FallbackPolicy, RenderedFrame, RenderFrame } from '@swf/presentation';
import { createViewOutput, planFrame } from '@swf/presentation';
import type { ProjectionModule } from '@swf/projections';
import { projectorOf, viewGeometryOf } from '@swf/projections';
import type { SurfaceCapabilities, SurfaceRuntime } from '@swf/surfaces';
import type { DomCompositor, DomCompositorSession } from './compositor.js';
import type { DomRenderer, DomRendererSession } from './renderer.js';

export interface DomViewOptions {
  readonly workspace: WorkspaceReader;
  readonly runtime: SurfaceRuntime;
  readonly projections: { get(id: string): ProjectionModule | undefined };
  readonly renderer: DomRenderer;
  readonly compositor: DomCompositor;
  /** The host element the view is assembled in. */
  readonly container: HTMLElement;
  readonly viewportId: Id;
  readonly policy?: FallbackPolicy;
}

/** What one update did. */
export interface DomViewUpdate {
  readonly frame: RenderFrame;
  readonly rendered: RenderedFrame;
  readonly composed: ComposedFrame;
  /** Surfaces attached (or revealed) in this view by this update. */
  readonly presented: readonly Id[];
  /** Surfaces hidden in this view by this update. */
  readonly hidden: readonly Id[];
  /** Surfaces whose presentation here the runtime refused; they are shown as proxies instead. */
  readonly refused: readonly { readonly surfaceId: Id; readonly error: SwfError }[];
}

/** One viewport presented as DOM in a host container. */
export interface DomView {
  readonly viewportId: Id;
  /** The view's root element, inside the container. */
  readonly root: HTMLElement;
  /**
   * Brings the view up to date with the scene: projects, plans, renders and composes it, then
   * attaches the surfaces that are live here and hides those that no longer are. Updates run one
   * at a time, in call order.
   */
  update(): Promise<DomViewUpdate>;
  /**
   * Whether a surface's live content is in this view (as of the last update) or it is shown as a
   * proxy or placeholder: what the interaction router needs to route input over it.
   */
  presentation(surfaceId: Id): 'live' | 'proxy';
  /**
   * Releases the view: its surfaces are hidden here (and their attachments released where the
   * endpoint allows), and the view leaves the container. Returns the surfaces whose endpoint did
   * not allow release; their content leaves the document with the view. Safe to call twice.
   */
  dispose(): Promise<{ readonly retained: readonly Id[] }>;
}

const BOUND_STATES = new Set(['ready', 'presented', 'hidden']);

/** Prepares a DOM view of a viewport in `container`. */
export async function createDomView(options: DomViewOptions): Promise<DomView> {
  const scene = options.workspace.getState();
  const view = viewGeometryOf(scene, options.viewportId);
  const rendererSession = (await options.renderer.prepare(scene, view)) as DomRendererSession;
  let compositorSession: DomCompositorSession;
  try {
    compositorSession = (await options.compositor.prepare(
      { viewportId: options.viewportId, container: options.container },
      rendererSession,
    )) as DomCompositorSession;
  } catch (error) {
    await rendererSession.release();
    throw error;
  }
  return new View(options, rendererSession, compositorSession);
}

class View implements DomView {
  readonly viewportId: Id;
  readonly root: HTMLElement;
  readonly #options: DomViewOptions;
  readonly #renderer: DomRendererSession;
  readonly #compositor: DomCompositorSession;
  #queue: Promise<unknown> = Promise.resolve();
  #disposed: Promise<{ readonly retained: readonly Id[] }> | null = null;
  #live: ReadonlySet<Id> = new Set();

  constructor(
    options: DomViewOptions,
    renderer: DomRendererSession,
    compositor: DomCompositorSession,
  ) {
    this.viewportId = options.viewportId;
    this.root = renderer.root;
    this.#options = options;
    this.#renderer = renderer;
    this.#compositor = compositor;
  }

  presentation(surfaceId: Id): 'live' | 'proxy' {
    return this.#live.has(surfaceId) ? 'live' : 'proxy';
  }

  update(): Promise<DomViewUpdate> {
    const next = this.#queue.then(() => this.#update());
    this.#queue = next.catch(() => undefined);
    return next;
  }

  dispose(): Promise<{ readonly retained: readonly Id[] }> {
    this.#disposed ??= this.#queue.then(() => this.#dispose());
    return this.#disposed;
  }

  async #update(): Promise<DomViewUpdate> {
    if (this.#disposed !== null) {
      throw new SwfFailure(
        makeError(
          'INVALID_TRANSITION',
          `the DOM view of viewport "${this.viewportId}" is disposed`,
        ),
      );
    }
    const { runtime } = this.#options;
    const refused: { surfaceId: Id; error: SwfError }[] = [];
    const notHere = new Set<Id>();
    const presented: Id[] = [];
    // Each refusal shows that surface as a proxy and plans again; refusals only grow, so this ends.
    for (;;) {
      const { frame, rendered, composed } = this.#frame(notHere);
      const live = rendered.layers.flatMap((l) =>
        l.category === 'content-native' && l.surfaceId !== null ? [l.surfaceId] : [],
      );
      let replan = false;
      for (const surfaceId of live) {
        const attachment = runtime
          .get(surfaceId)
          ?.viewports.find((v) => v.viewportId === this.viewportId);
        if (attachment?.visible === true) {
          continue;
        }
        const slot = this.#renderer.slotOf(surfaceId);
        if (slot === undefined) {
          throw new Error(
            `surface "${surfaceId}" is live in viewport "${this.viewportId}" without a slot`,
          );
        }
        const outcome = await runtime.present(surfaceId, this.viewportId, slot);
        if (outcome.status === 'ok') {
          presented.push(surfaceId);
        } else {
          refused.push({ surfaceId, error: outcome.error });
          notHere.add(surfaceId);
          replan = true;
        }
      }
      if (replan) {
        continue;
      }
      const hidden: Id[] = [];
      for (const presentation of runtime.list()) {
        const here = presentation.viewports.find((v) => v.viewportId === this.viewportId);
        if (here?.visible === true && !live.includes(presentation.surfaceId)) {
          const outcome = await runtime.hide(presentation.surfaceId, this.viewportId);
          if (outcome.status === 'rejected') {
            throw new SwfFailure(outcome.error);
          }
          hidden.push(presentation.surfaceId);
        }
      }
      this.#live = new Set(live);
      return Object.freeze({
        frame,
        rendered,
        composed,
        presented: Object.freeze(presented),
        hidden: Object.freeze(hidden),
        refused: Object.freeze(refused),
      });
    }
  }

  #frame(notHere: ReadonlySet<Id>) {
    const { workspace, runtime, projections, renderer, compositor } = this.#options;
    const scene = workspace.getState();
    const view = viewGeometryOf(scene, this.viewportId);
    const module = projections.get(view.projectionId);
    if (module === undefined) {
      throw new SwfFailure(
        makeError(
          'UNSUPPORTED_CAPABILITY',
          `viewport "${this.viewportId}" uses projection "${view.projectionId}", which is not registered`,
        ),
      );
    }
    const geometry = (id: Id) => workspace.surfaceGeometry(id);
    const output = createViewOutput(
      scene,
      this.viewportId,
      projectorOf(module).project(scene, view, geometry),
    );
    const capabilities = (id: Id): SurfaceCapabilities | null => {
      const presentation = runtime.get(id);
      return presentation !== undefined && BOUND_STATES.has(presentation.state)
        ? presentation.capabilities
        : null;
    };
    const frame = planFrame({
      scene,
      view,
      output,
      renderer: { id: renderer.id, capabilities: renderer.capabilities() },
      compositor: { id: compositor.id, capabilities: compositor.capabilities() },
      projection: module.profile,
      ...(this.#options.policy === undefined ? {} : { policy: this.#options.policy }),
      surfaceCapabilities: capabilities,
      // A single-owner handle presented in another viewport stays there; this one shows a proxy.
      viewportOwns: (id) => {
        if (notHere.has(id)) {
          return false;
        }
        const presentation = runtime.get(id);
        const elsewhere =
          presentation?.viewports.some((v) => v.viewportId !== this.viewportId) ?? false;
        return !(capabilities(id)?.viewportSharing === 'single-owner' && elsewhere);
      },
      geometry,
    });
    const rendered = this.#renderer.render(frame);
    const composed = this.#compositor.compose(rendered);
    return { frame, rendered, composed };
  }

  async #dispose(): Promise<{ readonly retained: readonly Id[] }> {
    const { runtime } = this.#options;
    const retained: Id[] = [];
    for (const presentation of runtime.list()) {
      const here = presentation.viewports.find((v) => v.viewportId === this.viewportId);
      if (here === undefined) {
        continue;
      }
      const outcome = await runtime.hide(presentation.surfaceId, this.viewportId, {
        release: true,
      });
      const still = runtime
        .get(presentation.surfaceId)
        ?.viewports.some((v) => v.viewportId === this.viewportId);
      if (outcome.status === 'rejected' || still === true) {
        retained.push(presentation.surfaceId);
      }
    }
    await this.#compositor.release();
    await this.#renderer.release();
    return Object.freeze({ retained: Object.freeze(retained) });
  }
}
