import type { Id, SceneState } from '@swf/core';
import { makeError, nodeFrameGeometry, SwfFailure } from '@swf/core';
import type {
  CompositionLayer,
  PlannedFragment,
  ProjectedFragment,
  RenderedFrame,
  RendererBackend,
  RendererCapabilities,
  RendererSession,
  RenderFrame,
  ScreenRect,
  ViewGeometry,
} from '@swf/presentation';
import { PRESENTATION_API_VERSION, viewGeometryIssue } from '@swf/presentation';
import type { ProjectionModule } from '@swf/projections';
import { projectionFor } from '@swf/projections';
import type { Quad } from './placement.js';
import { cssTransform, offsetQuad, quadMatrix, rectQuad } from './placement.js';

export const DOM_RENDERER_ID = 'swf.dom-renderer/1';

/**
 * What the DOM renderer can do. It presents live DOM elements natively (placing them, never
 * redrawing them) and proxy-only endpoints as proxies. It cannot draw: drawable content falls back
 * to a proxy. Its transforms are planar perspective (a CSS `matrix3d`), so in a nonlinear
 * projection a live element is placed by its projected corners and only approximates the bend.
 */
export const DOM_RENDERER_CAPABILITIES: RendererCapabilities = Object.freeze({
  handleKinds: Object.freeze({ 'native-dom': 'native', 'proxy-only': 'proxy' }),
  transformMode: 'perspective-3d',
  clipping: 'rect',
  hitMapping: false,
  layering: 'dom',
  resourceOwnership: 'renderer',
  recovery: 'rebuild',
});

/** Window chrome: frames, titles and resize handles drawn from each window's projected frame. */
export interface ChromeOptions {
  /** The projection modules views use, to project window frames. */
  readonly projections: { get(id: string): ProjectionModule | undefined };
  /** Thickness of the resize handles along window edges, in CSS px. Default 12. */
  readonly handlePx?: number;
}

export interface DomRendererOptions {
  readonly document: Document;
  /** CSS pixels a live element lays out per world unit of its surface. Default 400. */
  readonly pixelsPerUnit?: number;
  /** Draws window chrome when given; without it the renderer draws content only. */
  readonly chrome?: ChromeOptions;
}

/** The attribute names the renderer marks its elements with, for hosts' styles and tests. */
export const DOM_ATTRIBUTES = Object.freeze({
  viewport: 'data-swf-viewport',
  layer: 'data-swf-layer',
  surface: 'data-swf-surface',
  fragment: 'data-swf-fragment',
  node: 'data-swf-node',
  slot: 'data-swf-slot',
  mode: 'data-swf-mode',
  shape: 'data-swf-shape',
  anchor: 'data-swf-anchor',
  placement: 'data-swf-placement',
  handle: 'data-swf-handle',
  selected: 'data-swf-selected',
  focused: 'data-swf-focused',
  label: 'data-swf-label',
});

/** Each resize handle and the frame sides it lies on. */
const RESIZE_EDGES = Object.freeze({
  n: ['n'],
  s: ['s'],
  e: ['e'],
  w: ['w'],
  ne: ['n', 'e'],
  nw: ['n', 'w'],
  se: ['s', 'e'],
  sw: ['s', 'w'],
} as const);

/** Realizes views as DOM: live slots, proxies, placeholders and chrome under one root per view. */
export class DomRenderer implements RendererBackend {
  readonly id = DOM_RENDERER_ID;
  readonly apiVersion = PRESENTATION_API_VERSION;
  readonly #options: Required<Pick<DomRendererOptions, 'document' | 'pixelsPerUnit'>> & {
    readonly chrome: Required<ChromeOptions> | null;
  };

  constructor(options: DomRendererOptions) {
    const ppu = options.pixelsPerUnit ?? 400;
    if (!(ppu > 0 && Number.isFinite(ppu))) {
      throw new RangeError(`pixelsPerUnit must be a positive finite number (got ${String(ppu)})`);
    }
    const handlePx = options.chrome?.handlePx ?? 12;
    if (!(handlePx > 0 && Number.isFinite(handlePx))) {
      throw new RangeError(
        `chrome.handlePx must be a positive finite number (got ${String(handlePx)})`,
      );
    }
    this.#options = {
      document: options.document,
      pixelsPerUnit: ppu,
      chrome:
        options.chrome === undefined ? null : { projections: options.chrome.projections, handlePx },
    };
  }

  capabilities(): RendererCapabilities {
    return DOM_RENDERER_CAPABILITIES;
  }

  prepare(_scene: SceneState, view: ViewGeometry): Promise<RendererSession> {
    const issue = viewGeometryIssue(view);
    if (issue !== null) {
      return Promise.reject(
        new SwfFailure(
          makeError('INVALID_INPUT', `view of viewport "${view.viewportId}": ${issue}`),
        ),
      );
    }
    return Promise.resolve(new DomRendererSession(this.id, view, this.#options));
  }
}

/** A live element's place: a clip box at the fragment's visible bounds holding a stable slot. */
interface NativeSlot {
  readonly clip: HTMLElement;
  readonly slot: HTMLElement;
}

export class DomRendererSession implements RendererSession {
  readonly rendererId: string;
  readonly viewportId: Id;
  /** The view's root element; the compositor puts it in the host's container. */
  readonly root: HTMLElement;
  readonly #document: Document;
  readonly #ppu: number;
  readonly #chrome: Required<ChromeOptions> | null;
  readonly #slots = new Map<Id, NativeSlot>();
  readonly #elements = new Map<string, HTMLElement>();
  #released = false;

  constructor(
    rendererId: string,
    view: ViewGeometry,
    options: { document: Document; pixelsPerUnit: number; chrome: Required<ChromeOptions> | null },
  ) {
    this.rendererId = rendererId;
    this.viewportId = view.viewportId;
    this.#document = options.document;
    this.#ppu = options.pixelsPerUnit;
    this.#chrome = options.chrome;
    this.root = options.document.createElement('div');
    this.root.setAttribute(DOM_ATTRIBUTES.viewport, view.viewportId);
    style(this.root, {
      position: 'relative',
      overflow: 'hidden',
      isolation: 'isolate',
      width: `${String(view.width)}px`,
      height: `${String(view.height)}px`,
      'touch-action': 'none',
    });
  }

  /**
   * The element a surface's live content is mounted in for this view: the container to pass to
   * the surface runtime's `present`. It exists once the surface has been planned as live content
   * here, and stays the same element for as long as the session keeps it, so content mounted in it
   * is never moved to another parent.
   */
  slotOf(surfaceId: Id): HTMLElement | undefined {
    return this.#slots.get(surfaceId)?.slot;
  }

  /** The surfaces that have a live slot in this view. */
  slotSurfaces(): Id[] {
    return [...this.#slots.keys()];
  }

  /**
   * Removes a surface's slot. Call it only after the runtime released the surface's attachment in
   * this view: whatever is still mounted in the slot leaves the document with it.
   */
  forget(surfaceId: Id): void {
    const slot = this.#slots.get(surfaceId);
    if (slot !== undefined) {
      slot.clip.remove();
      this.#slots.delete(surfaceId);
    }
  }

  render(frame: RenderFrame): RenderedFrame {
    if (this.#released) {
      throw new SwfFailure(
        makeError(
          'INVALID_TRANSITION',
          `the DOM renderer session for viewport "${this.viewportId}" was released`,
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
    if (frame.scene.revision !== frame.sceneRevision) {
      throw new SwfFailure(makeError('INVALID_INPUT', 'the frame’s scene is not at its revision'));
    }
    style(this.root, {
      width: `${String(frame.view.width)}px`,
      height: `${String(frame.view.height)}px`,
    });
    const layers: CompositionLayer[] = [];
    const usedSlots = new Set<Id>();
    const usedElements = new Set<string>();
    const chrome = this.#chromeFrames(frame);
    const lastOfNode = new Map<Id, number>();
    frame.planned.forEach((p, i) => {
      const nodeId = frame.scene.surfaces.get(p.fragment.surfaceId)?.ownerNodeId;
      if (nodeId !== undefined) {
        lastOfNode.set(nodeId, i);
      }
    });
    frame.planned.forEach((planned, i) => {
      layers.push(this.#content(frame, planned, usedSlots, usedElements));
      for (const [nodeId, last] of lastOfNode) {
        const frameOf = chrome.get(nodeId);
        if (last === i && frameOf !== undefined) {
          layers.push(this.#chromeLayer(frame.scene, nodeId, frameOf, usedElements));
        }
      }
    });
    // Slots of surfaces not live here this frame stay in place, hidden, so their content is not
    // moved or reloaded; everything else unused goes.
    for (const [surfaceId, slot] of this.#slots) {
      if (!usedSlots.has(surfaceId)) {
        slot.clip.style.display = 'none';
      }
    }
    for (const [key, element] of this.#elements) {
      if (!usedElements.has(key)) {
        element.remove();
        this.#elements.delete(key);
      }
    }
    return Object.freeze({
      viewportId: frame.viewportId,
      sceneRevision: frame.sceneRevision,
      layers: Object.freeze(layers),
    });
  }

  release(): Promise<void> {
    if (!this.#released) {
      this.#released = true;
      this.root.remove();
      this.#slots.clear();
      this.#elements.clear();
    }
    return Promise.resolve();
  }

  #content(
    frame: RenderFrame,
    planned: PlannedFragment,
    usedSlots: Set<Id>,
    usedElements: Set<string>,
  ): CompositionLayer {
    const { fragment, negotiation } = planned;
    const category = negotiation.layer;
    const id = `${category}:${fragment.id}`;
    const base = { id, category, fragmentId: fragment.id, surfaceId: fragment.surfaceId };
    switch (category) {
      case 'content-native': {
        if (usedSlots.has(fragment.surfaceId)) {
          throw new SwfFailure(
            makeError(
              'INVALID_INPUT',
              `surface "${fragment.surfaceId}" was planned as live content twice in viewport "${this.viewportId}"; a live element is mounted once`,
              { entityId: fragment.surfaceId },
            ),
          );
        }
        usedSlots.add(fragment.surfaceId);
        const content = this.#place(frame.scene, planned);
        return Object.freeze({ ...base, content });
      }
      case 'proxy':
      case 'placeholder': {
        usedElements.add(id);
        const element = this.#element(id, () => this.#representation(category, fragment));
        element.textContent = '';
        const label = this.#document.createElement('span');
        label.setAttribute(DOM_ATTRIBUTES.label, '');
        // Labels are text, never markup.
        label.textContent = labelOf(frame.scene, fragment.surfaceId);
        element.append(label);
        if (category === 'placeholder') {
          const state = this.#document.createElement('span');
          state.textContent = 'Not presented';
          element.append(state);
        }
        element.setAttribute(DOM_ATTRIBUTES.mode, negotiation.mode);
        element.setAttribute(DOM_ATTRIBUTES.shape, negotiation.shapeFidelity);
        placeBox(element, fragment.bounds);
        return Object.freeze({ ...base, content: element });
      }
      case 'content-raster':
      case 'chrome':
      case 'overlay':
        throw new SwfFailure(
          makeError(
            'UNSUPPORTED_CAPABILITY',
            `the DOM renderer cannot realize fragment "${fragment.id}" as ${category}`,
            { entityId: fragment.surfaceId },
          ),
        );
    }
  }

  /**
   * Places a surface's live slot: a clip box at the fragment's visible bounds, and inside it the
   * slot (laid out at the surface's size in CSS px) mapped onto the surface's projected corners.
   * Without usable corners the slot fills the bounds, and says its shape is approximate.
   */
  #place(scene: SceneState, planned: PlannedFragment): HTMLElement {
    const { fragment, negotiation } = planned;
    const surface = scene.surfaces.get(fragment.surfaceId);
    if (surface === undefined) {
      throw new SwfFailure(
        makeError('INVALID_INPUT', `surface "${fragment.surfaceId}" is not in the frame’s scene`, {
          entityId: fragment.surfaceId,
        }),
      );
    }
    let slot = this.#slots.get(fragment.surfaceId);
    if (slot === undefined) {
      const clip = this.#document.createElement('div');
      clip.setAttribute(DOM_ATTRIBUTES.layer, 'content-native');
      clip.setAttribute(DOM_ATTRIBUTES.surface, fragment.surfaceId);
      style(clip, { position: 'absolute', overflow: 'hidden', 'pointer-events': 'none' });
      const inner = this.#document.createElement('div');
      inner.setAttribute(DOM_ATTRIBUTES.slot, fragment.surfaceId);
      // Only the content takes input; the clip box around it does not.
      style(inner, {
        position: 'absolute',
        left: '0px',
        top: '0px',
        'transform-origin': '0 0',
        'pointer-events': 'auto',
      });
      clip.append(inner);
      slot = { clip, slot: inner };
      this.#slots.set(fragment.surfaceId, slot);
    }
    const [x, y, w, h] = fragment.bounds;
    const width = surface.bounds[0] * this.#ppu;
    const height = surface.bounds[1] * this.#ppu;
    const cornerMatrix =
      fragment.corners === null
        ? null
        : quadMatrix(width, height, offsetQuad(fragment.corners, x, y));
    const followsCorners = cornerMatrix !== null;
    const matrix =
      cornerMatrix ?? quadMatrix(width, height, offsetQuad(rectQuad(fragment.bounds), x, y));
    style(slot.clip, {
      display: '',
      left: `${String(x)}px`,
      top: `${String(y)}px`,
      width: `${String(w)}px`,
      height: `${String(h)}px`,
    });
    style(slot.slot, {
      width: `${String(width)}px`,
      height: `${String(height)}px`,
      transform: matrix === null ? 'scale(0)' : cssTransform(matrix),
    });
    slot.clip.setAttribute(DOM_ATTRIBUTES.fragment, fragment.id);
    slot.clip.setAttribute(DOM_ATTRIBUTES.mode, negotiation.mode);
    slot.clip.setAttribute(DOM_ATTRIBUTES.anchor, negotiation.anchorFidelity);
    // A slot that could not follow the corners is never declared exact.
    slot.clip.setAttribute(
      DOM_ATTRIBUTES.shape,
      followsCorners ? negotiation.shapeFidelity : 'approximate',
    );
    slot.clip.setAttribute(DOM_ATTRIBUTES.placement, followsCorners ? 'corners' : 'bounds');
    return slot.clip;
  }

  #representation(category: 'proxy' | 'placeholder', fragment: ProjectedFragment): HTMLElement {
    const element = this.#document.createElement('div');
    element.setAttribute(DOM_ATTRIBUTES.layer, category);
    element.setAttribute(DOM_ATTRIBUTES.surface, fragment.surfaceId);
    element.setAttribute(DOM_ATTRIBUTES.fragment, fragment.id);
    // A representation hides what lies behind it, so it takes input (for the framework to route).
    style(element, { position: 'absolute', overflow: 'hidden', 'pointer-events': 'auto' });
    return element;
  }

  #element(key: string, make: () => HTMLElement): HTMLElement {
    let element = this.#elements.get(key);
    if (element === undefined) {
      element = make();
      this.#elements.set(key, element);
    }
    return element;
  }

  /** Each window's projected frame (its native-owner piece), when chrome is drawn. */
  #chromeFrames(frame: RenderFrame): Map<Id, ProjectedFragment> {
    const frames = new Map<Id, ProjectedFragment>();
    if (this.#chrome === null) {
      return frames;
    }
    const module = this.#chrome.projections.get(frame.view.projectionId);
    if (module === undefined) {
      throw new SwfFailure(
        makeError(
          'UNSUPPORTED_CAPABILITY',
          `window chrome for viewport "${this.viewportId}" needs projection "${frame.view.projectionId}", which is not registered`,
        ),
      );
    }
    const projection = projectionFor(module, frame.view);
    const nodes = new Set(
      frame.planned.flatMap((p) => {
        const owner = frame.scene.surfaces.get(p.fragment.surfaceId)?.ownerNodeId;
        return owner === undefined ? [] : [owner];
      }),
    );
    for (const nodeId of nodes) {
      const geometry = nodeFrameGeometry(frame.scene, nodeId);
      const piece =
        geometry === undefined
          ? undefined
          : projection.projectGeometry(geometry, frame.view).find((f) => f.nativeOwner);
      if (piece !== undefined) {
        frames.set(nodeId, piece);
      }
    }
    return frames;
  }

  /**
   * A window's chrome, a layer of its own: its frame outline and title (which take no input, so
   * nothing over content is intercepted) and, for a resizable window, handles along the frame
   * edges that lie inside the view, which take input so presses on them reach the framework even
   * where the content under them is a cross-origin frame.
   */
  #chromeLayer(
    scene: SceneState,
    nodeId: Id,
    piece: ProjectedFragment,
    usedElements: Set<string>,
  ): CompositionLayer {
    const chrome = this.#chrome;
    const node = scene.nodes.get(nodeId);
    if (chrome === null || node === undefined) {
      throw new Error('window chrome was drawn without its options or node');
    }
    const id = `chrome:${nodeId}`;
    usedElements.add(id);
    const element = this.#element(id, () => {
      const e = this.#document.createElement('div');
      e.setAttribute(DOM_ATTRIBUTES.layer, 'chrome');
      e.setAttribute(DOM_ATTRIBUTES.node, nodeId);
      style(e, { position: 'absolute', 'pointer-events': 'none' });
      return e;
    });
    element.textContent = '';
    const [x, y, w, h] = piece.bounds;
    placeBox(element, piece.bounds);
    const width = node.bounds[0] * this.#ppu;
    const height = node.bounds[1] * this.#ppu;
    const corners: Quad = piece.corners ?? rectQuad(piece.bounds);
    const matrix =
      quadMatrix(width, height, offsetQuad(corners, x, y)) ??
      quadMatrix(width, height, offsetQuad(rectQuad(piece.bounds), x, y));
    const outline = this.#document.createElement('div');
    outline.setAttribute(DOM_ATTRIBUTES.layer, 'chrome-frame');
    style(outline, {
      position: 'absolute',
      left: '0px',
      top: '0px',
      width: `${String(width)}px`,
      height: `${String(height)}px`,
      'transform-origin': '0 0',
      transform: matrix === null ? 'scale(0)' : cssTransform(matrix),
      'pointer-events': 'none',
      'box-sizing': 'border-box',
    });
    const title = this.#document.createElement('div');
    title.setAttribute(DOM_ATTRIBUTES.label, '');
    style(title, { position: 'absolute', left: '0px', top: '0px', 'pointer-events': 'none' });
    // Labels are text, never markup.
    title.textContent = node.label ?? '';
    outline.append(title);
    element.append(outline);
    element.toggleAttribute(DOM_ATTRIBUTES.selected, scene.selection.includes(nodeId));
    element.toggleAttribute(DOM_ATTRIBUTES.focused, scene.focusedId === nodeId);
    if (node.flags.resizable && !node.flags.locked) {
      const t = chrome.handlePx;
      const [tl, tr, br, bl] = corners;
      // An edge is the window's own only where the piece is not cut there by the view or a seam.
      const inside = (value: number, lo: number, hi: number) =>
        value >= lo - 0.5 && value <= hi + 0.5;
      const has = {
        n: inside(Math.min(tl[1], tr[1]), y, y + h),
        s: inside(Math.max(bl[1], br[1]), y, y + h),
        w: inside(Math.min(tl[0], bl[0]), x, x + w),
        e: inside(Math.max(tr[0], br[0]), x, x + w),
      };
      for (const [edge, sides] of Object.entries(RESIZE_EDGES)) {
        if (!sides.every((side) => has[side])) {
          continue;
        }
        const handle = this.#document.createElement('div');
        handle.setAttribute(DOM_ATTRIBUTES.handle, edge);
        const north = edge.includes('n');
        const south = edge.includes('s');
        const east = edge.includes('e');
        const west = edge.includes('w');
        style(handle, {
          position: 'absolute',
          'pointer-events': 'auto',
          left: `${String(east ? w - t : 0)}px`,
          top: `${String(south ? h - t : 0)}px`,
          width: `${String(east || west ? t : w)}px`,
          height: `${String(north || south ? t : h)}px`,
          cursor: `${edge}-resize`,
        });
        element.append(handle);
      }
    }
    return Object.freeze({
      id,
      category: 'chrome',
      fragmentId: null,
      surfaceId: null,
      content: element,
    });
  }
}

/** A surface's label for its proxy or placeholder: its own, its window's, or its ID. */
function labelOf(scene: SceneState, surfaceId: Id): string {
  const surface = scene.surfaces.get(surfaceId);
  const owner = surface === undefined ? undefined : scene.nodes.get(surface.ownerNodeId);
  return surface?.label ?? owner?.label ?? surfaceId;
}

function placeBox(element: HTMLElement, [x, y, w, h]: ScreenRect): void {
  style(element, {
    left: `${String(x)}px`,
    top: `${String(y)}px`,
    width: `${String(w)}px`,
    height: `${String(h)}px`,
  });
}

function style(element: HTMLElement, properties: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(properties)) {
    element.style.setProperty(name, value);
  }
}
