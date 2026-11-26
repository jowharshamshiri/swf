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
  StandInReason,
  ViewGeometry,
} from '@swf/presentation';
import {
  NAME_MARK,
  placeNames,
  PRESENTATION_API_VERSION,
  STAND_IN_TEXT,
  standInReason,
  viewGeometryIssue,
  windowNames,
} from '@swf/presentation';
import type { ProjectionModule } from '@swf/projections';
import { projectionFor } from '@swf/projections';
import type { Quad2 } from '@swf/math';
import { offsetQuad, rectQuad } from '@swf/math';
import { cssTransform, quadMatrix } from './placement.js';
import { DomWriter } from './writer.js';

/** The DOM renderer's registered ID, as {@link DomRenderer} declares it. */
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

/**
 * The colours window chrome is drawn in, as CSS colours (a custom property such as
 * `var(--focus)` included): every frame's outline and the mark of a window shown by its label
 * alone, the selected and the focused window's outline and name, every other name, and the ground
 * names are written on. Outlines and marks should stand out from what the view is drawn over by
 * 3:1 at least (WCAG 1.4.11), so the window keys act on is seen (WCAG 2.4.7); names from their
 * ground by 4.5:1 (WCAG 1.4.3).
 */
export interface ChromeInks {
  /**
   * Every window frame's 1 px outline, each window's mark, and the name of a window shown by its
   * label alone: a non-blank CSS colour.
   */
  readonly frame: string;
  /** The selected window's 3 px outline and its name: a non-blank CSS colour. */
  readonly selected: string;
  /** The focused window's 3 px outline and its name, over `selected`: a non-blank CSS colour. */
  readonly focused: string;
  /** Every other window's name: a non-blank CSS colour. */
  readonly text: string;
  /** The ground a name is written on, so it reads over whatever lies under it: a CSS colour. */
  readonly ground: string;
}

/** Inks that stand out on a light page by 4.5:1 or more. Frozen. */
export const DEFAULT_CHROME_INKS: ChromeInks = Object.freeze({
  frame: 'rgb(118, 118, 118)',
  selected: 'rgb(0, 95, 184)',
  focused: 'rgb(168, 74, 0)',
  text: 'rgb(30, 30, 30)',
  ground: 'rgb(255, 255, 255)',
});

/** How a window's name is written: its size, the height of its line, and its plate's margin. */
const NAME = Object.freeze({ size: 12, line: 15, margin: 3 });

/**
 * Window chrome: frames, names and resize handles drawn from each window's projected frame. Each
 * window's name is written flat, where it can be read: wholly inside the view, over no other
 * window and over no other name (`placeNames` of `@swf/presentation`).
 */
export interface ChromeOptions {
  /**
   * The projection modules views use, to project window frames: a projection registry will do.
   * A frame of a view whose projection is not here throws `UNSUPPORTED_CAPABILITY`.
   */
  readonly projections: {
    /** The projection module registered under `id`, or undefined when none is. */
    get(id: string): ProjectionModule | undefined;
  };
  /**
   * Thickness of the resize handles along window edges, in CSS px: positive and finite. Default
   * 12.
   */
  readonly handlePx?: number;
  /**
   * The colours chrome is drawn in, copied when the renderer is made. Default
   * {@link DEFAULT_CHROME_INKS}.
   */
  readonly inks?: ChromeInks;
}

/** What a DOM renderer realizes views in, and how. Checked when the renderer is made. */
export interface DomRendererOptions {
  /** The document every view's elements are made in; the host's containers must belong to it. */
  readonly document: Document;
  /**
   * CSS pixels a live element lays out per world unit of its surface: positive and finite.
   * Default 400.
   */
  readonly pixelsPerUnit?: number;
  /** Draws window chrome when given; without it the renderer draws content only. */
  readonly chrome?: ChromeOptions;
  /**
   * What a proxy or placeholder says when it stands in for content for a reason (FR-195), as text.
   * Default {@link STAND_IN_TEXT}, in English.
   */
  readonly standIn?: (reason: StandInReason) => string;
}

/** The attribute names the renderer marks its elements with, for hosts' styles and tests. */
export const DOM_ATTRIBUTES = Object.freeze({
  /** On a view's root: the viewport's ID. */
  viewport: 'data-swf-viewport',
  /** On each layer element: its category (`content-native`, `proxy`, `chrome`, …). */
  layer: 'data-swf-layer',
  /** On a live clip box, proxy or placeholder: the surface's ID. */
  surface: 'data-swf-surface',
  /** On a live clip box, proxy or placeholder: the fragment's ID. */
  fragment: 'data-swf-fragment',
  /** On a window's chrome: the window's node ID. */
  node: 'data-swf-node',
  /** On a live slot, the element content is mounted in: the surface's ID. */
  slot: 'data-swf-slot',
  /** On a live clip box, proxy or placeholder: the presentation mode negotiated. */
  mode: 'data-swf-mode',
  /** On a live clip box, proxy or placeholder: how faithful its shape is (`approximate`, …). */
  shape: 'data-swf-shape',
  /** On a live clip box: how faithful its anchoring is. */
  anchor: 'data-swf-anchor',
  /** On a live clip box: `corners` when the slot follows its projected corners, or `bounds`. */
  placement: 'data-swf-placement',
  /** On a resize handle: its edge or corner (`n`, `ne`, … `nw`). */
  handle: 'data-swf-handle',
  /** On a selected window's chrome, present while it is selected. */
  selected: 'data-swf-selected',
  /** On the focused window's chrome, present while it is focused. */
  focused: 'data-swf-focused',
  /** On a window's name, in the layer of names. */
  label: 'data-swf-label',
  /** On the mark of a window shown by its label alone. */
  mark: 'data-swf-mark',
  /** On {@link showDegraded}'s status line: the error's code. */
  degraded: 'data-swf-degraded',
  /** On a proxy or placeholder: the representation planned for it (`label`, …). */
  representation: 'data-swf-representation',
  /** On a proxy or placeholder: why it stands in for the content, or empty when no reason is due. */
  standIn: 'data-swf-stand-in',
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

/** What a session is made with. */
interface SessionOptions {
  readonly document: Document;
  readonly pixelsPerUnit: number;
  readonly chrome: Required<ChromeOptions> | null;
  readonly standIn: (reason: StandInReason) => string;
}

/**
 * Realizes views as DOM: live slots, proxies, placeholders and chrome under one root per view. It
 * holds nothing itself; each session it prepares owns its view's elements until released.
 */
export class DomRenderer implements RendererBackend {
  /** {@link DOM_RENDERER_ID}. */
  readonly id = DOM_RENDERER_ID;
  /** The presentation API version it implements. */
  readonly apiVersion = PRESENTATION_API_VERSION;
  readonly #options: SessionOptions;

  /**
   * A renderer for `options.document`, which is not checked.
   *
   * @throws `RangeError` for a `pixelsPerUnit` or `chrome.handlePx` that is not positive and
   *   finite, or a `chrome.inks` colour that is not a non-blank string.
   */
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
    const inks = options.chrome?.inks ?? DEFAULT_CHROME_INKS;
    for (const name of ['frame', 'selected', 'focused', 'text', 'ground'] as const) {
      const ink: unknown = inks[name];
      if (typeof ink !== 'string' || ink.trim() === '') {
        throw new RangeError(`chrome.inks.${name} must be a CSS colour (got ${String(ink)})`);
      }
    }
    this.#options = {
      document: options.document,
      pixelsPerUnit: ppu,
      chrome:
        options.chrome === undefined
          ? null
          : {
              projections: options.chrome.projections,
              handlePx,
              inks: Object.freeze({
                frame: inks.frame,
                selected: inks.selected,
                focused: inks.focused,
                text: inks.text,
                ground: inks.ground,
              }),
            },
      standIn: options.standIn ?? ((reason) => STAND_IN_TEXT[reason]),
    };
  }

  /** {@link DOM_RENDERER_CAPABILITIES}, the same object on every call. */
  capabilities(): RendererCapabilities {
    return DOM_RENDERER_CAPABILITIES;
  }

  /**
   * A new session for the view's viewport, with a root element sized to the view and not yet in
   * any container. Rejects with {@link SwfFailure} (`INVALID_INPUT`) for an invalid view.
   */
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

/**
 * A DOM renderer's session for one viewport: the view's root element and everything in it. The
 * presenter owns it and releases it; until then the elements are the session's, and content a
 * surface runtime mounts in a slot stays the adapter's.
 */
export class DomRendererSession implements RendererSession {
  /** The renderer that prepared it. */
  readonly rendererId: string;
  /** The viewport it renders. */
  readonly viewportId: Id;
  /** The view's root element; the compositor puts it in the host's container. */
  readonly root: HTMLElement;
  readonly #document: Document;
  readonly #ppu: number;
  readonly #chrome: Required<ChromeOptions> | null;
  readonly #standIn: (reason: StandInReason) => string;
  readonly #slots = new Map<Id, NativeSlot>();
  readonly #elements = new Map<string, HTMLElement>();
  readonly #write = new DomWriter();
  /** The font family names are written in, once read from the view in its document. */
  #family: string | null = null;
  /** The 2D context names are measured with, once made. */
  #measuring: OffscreenCanvasRenderingContext2D | null = null;
  #released = false;

  /** A session for `view`, as {@link DomRenderer.prepare} makes it. */
  constructor(rendererId: string, view: ViewGeometry, options: SessionOptions) {
    this.rendererId = rendererId;
    this.viewportId = view.viewportId;
    this.#document = options.document;
    this.#ppu = options.pixelsPerUnit;
    this.#chrome = options.chrome;
    this.#standIn = options.standIn;
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
  targetOf(surfaceId: Id): HTMLElement | undefined {
    return this.#slots.get(surfaceId)?.slot;
  }

  /** DOM elements are never lost, so this never calls `listener`. */
  watchLoss(): () => void {
    return () => undefined;
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

  /**
   * Realizes a frame: each planned fragment as a live clip box and slot, a proxy or a placeholder,
   * with each window's chrome after its last fragment, in plan order, and, with chrome, the
   * windows' names on top. Elements are reused and
   * written only where something changed; slots unused this frame stay in place, hidden, and
   * other unused elements are removed.
   *
   * @throws {@link @swf/core!SwfFailure} `INVALID_TRANSITION` once released; `INVALID_INPUT`
   *   for a frame of another viewport, a scene not at the frame's revision, or a surface planned
   *   as live content twice; `UNSUPPORTED_CAPABILITY` for a raster, chrome or overlay fragment,
   *   or chrome over a projection the chrome options do not have.
   */
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
    this.#write.style(this.root, {
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
    if (this.#chrome !== null) {
      layers.push(this.#namesLayer(frame, chrome, usedElements));
    }
    // Slots of surfaces not live here this frame stay in place, hidden, so their content is not
    // moved or reloaded; everything else unused goes.
    for (const [surfaceId, slot] of this.#slots) {
      if (!usedSlots.has(surfaceId)) {
        this.#write.style(slot.clip, { display: 'none' });
      }
    }
    for (const [key, element] of this.#elements) {
      if (!usedElements.has(key)) {
        element.remove();
        this.#elements.delete(key);
        this.#write.structure();
      }
    }
    return Object.freeze({
      viewportId: frame.viewportId,
      sceneRevision: frame.sceneRevision,
      size: Object.freeze({
        width: frame.view.width,
        height: frame.view.height,
        devicePixelRatio: frame.view.devicePixelRatio,
      }),
      layers: Object.freeze(layers),
      writes: this.#write.take(),
    });
  }

  /**
   * Takes the root out of the document and forgets every slot and element; whatever is still
   * mounted in a slot leaves the document with it. Rendering afterwards throws. Safe to call more
   * than once.
   */
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
        // The element is this session's own: its children are the mark and the reason's span.
        const mark = element.firstElementChild as HTMLElement | null;
        const note = element.lastElementChild as HTMLElement | null;
        if (mark === null || note === null || mark === note) {
          throw new Error(`the stand-in "${id}" lost its mark or its note`);
        }
        // Why it stands in for the content, when it is for a reason the view does not show.
        const reason = standInReason(planned);
        this.#write.text(note, reason === null ? '' : this.#standIn(reason));
        this.#write.style(note, { display: reason === null ? 'none' : 'block' });
        this.#write.attribute(element, DOM_ATTRIBUTES.standIn, reason ?? '');
        this.#write.attribute(element, DOM_ATTRIBUTES.mode, negotiation.mode);
        this.#write.attribute(element, DOM_ATTRIBUTES.shape, negotiation.shapeFidelity);
        this.#write.attribute(element, DOM_ATTRIBUTES.representation, planned.representation);
        // A window shown by its label alone is marked in the middle of where it is, its name
        // written beside the mark with the other names; a proxy reads from its top, clipped to
        // the window.
        const alone = planned.representation === 'label';
        const [, , w, h] = fragment.bounds;
        this.#write.style(element, boxOf(fragment.bounds));
        this.#write.style(
          mark,
          alone
            ? {
                display: 'block',
                left: `${String(w / 2 - NAME_MARK / 2)}px`,
                top: `${String(h / 2 - NAME_MARK / 2)}px`,
                background: this.#chrome?.inks.frame ?? 'currentColor',
              }
            : { display: 'none' },
        );
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
    this.#write.style(slot.clip, {
      display: '',
      left: `${String(x)}px`,
      top: `${String(y)}px`,
      width: `${String(w)}px`,
      height: `${String(h)}px`,
    });
    this.#write.style(slot.slot, {
      width: `${String(width)}px`,
      height: `${String(height)}px`,
      transform: matrix === null ? 'scale(0)' : cssTransform(matrix),
    });
    this.#write.attribute(slot.clip, DOM_ATTRIBUTES.fragment, fragment.id);
    this.#write.attribute(slot.clip, DOM_ATTRIBUTES.mode, negotiation.mode);
    this.#write.attribute(slot.clip, DOM_ATTRIBUTES.anchor, negotiation.anchorFidelity);
    // A slot that could not follow the corners is never declared exact.
    this.#write.attribute(
      slot.clip,
      DOM_ATTRIBUTES.shape,
      followsCorners ? negotiation.shapeFidelity : 'approximate',
    );
    this.#write.attribute(
      slot.clip,
      DOM_ATTRIBUTES.placement,
      followsCorners ? 'corners' : 'bounds',
    );
    return slot.clip;
  }

  #representation(category: 'proxy' | 'placeholder', fragment: ProjectedFragment): HTMLElement {
    const element = this.#document.createElement('div');
    element.setAttribute(DOM_ATTRIBUTES.layer, category);
    element.setAttribute(DOM_ATTRIBUTES.surface, fragment.surfaceId);
    element.setAttribute(DOM_ATTRIBUTES.fragment, fragment.id);
    // A representation hides what lies behind it, so it takes input (for the framework to route).
    style(element, { position: 'absolute', overflow: 'hidden', 'pointer-events': 'auto' });
    // The mark of a window shown by its label alone.
    const mark = this.#document.createElement('span');
    mark.setAttribute(DOM_ATTRIBUTES.mark, '');
    style(mark, {
      position: 'absolute',
      width: `${String(NAME_MARK)}px`,
      height: `${String(NAME_MARK)}px`,
      'border-radius': '50%',
    });
    // The reason it stands in, when there is one: written with each frame.
    const note = this.#document.createElement('span');
    element.append(mark, note);
    return element;
  }

  /**
   * The windows' names, flat over the view, each written where it can be read: wholly inside the
   * view, over no other window and over no other name (`placeNames`), on a plate of the ground
   * ink, in the selected or the focused window's ink for theirs. A name with no such place is not
   * written.
   */
  #namesLayer(
    frame: RenderFrame,
    frames: ReadonlyMap<Id, ProjectedFragment>,
    usedElements: Set<string>,
  ): CompositionLayer {
    const chrome = this.#chrome;
    if (chrome === null) {
      throw new Error('names were written without chrome');
    }
    const id = 'overlay:names';
    usedElements.add(id);
    const layer = this.#element(id, () => {
      const e = this.#document.createElement('div');
      e.setAttribute(DOM_ATTRIBUTES.layer, 'names');
      style(e, { position: 'absolute', left: '0px', top: '0px', 'pointer-events': 'none' });
      return e;
    });
    const font = `${String(NAME.size)}px ${this.#fontFamily()}`;
    const measure = this.#measurer();
    // A frame's border is drawn inside its piece's bounds.
    const { obstacles, names } = windowNames(
      frame,
      (text) => [Math.ceil(measure(text, font)) + 2 * NAME.margin, NAME.line + 2 * NAME.margin],
      new Map([...frames].map(([nodeId, piece]) => [nodeId, piece.bounds])),
    );
    const placed = placeNames(frame.view, obstacles, names);
    names.forEach((name, i) => {
      const at = placed[i];
      if (at === null || at === undefined) {
        return;
      }
      const key = `name:${name.owner}`;
      usedElements.add(key);
      const span = this.#element(key, () => {
        const e = this.#document.createElement('span');
        e.setAttribute(DOM_ATTRIBUTES.label, '');
        e.setAttribute(DOM_ATTRIBUTES.node, name.owner);
        style(e, {
          position: 'absolute',
          'box-sizing': 'border-box',
          'white-space': 'nowrap',
          overflow: 'hidden',
          'pointer-events': 'none',
        });
        return e;
      });
      if (span.parentElement !== layer) {
        layer.append(span);
        this.#write.structure();
      }
      // The window keys act on stands out; a far window's name, shown by its label alone, is
      // quieter than a near one's.
      const ink = name.focused
        ? chrome.inks.focused
        : name.selected
          ? chrome.inks.selected
          : name.marked
            ? chrome.inks.frame
            : chrome.inks.text;
      // Names are text, never markup.
      this.#write.text(span, name.text);
      this.#write.style(span, {
        left: `${String(at[0])}px`,
        top: `${String(at[1])}px`,
        width: `${String(name.size[0])}px`,
        height: `${String(name.size[1])}px`,
        padding: `${String(NAME.margin)}px`,
        font,
        'line-height': `${String(NAME.line)}px`,
        color: ink,
        background: chrome.inks.ground,
        outline: name.selected || name.focused ? `1px solid ${ink}` : 'none',
        'outline-offset': '-1px',
      });
    });
    return Object.freeze({
      id,
      category: 'overlay',
      fragmentId: null,
      surfaceId: null,
      content: layer,
    });
  }

  /** The font family names are written in: the view's own, once it is in a document. */
  #fontFamily(): string {
    if (this.#family !== null) {
      return this.#family;
    }
    const view = this.#document.defaultView;
    if (view === null) {
      throw new Error('names are written in a document that is in no window');
    }
    const family = view.getComputedStyle(
      this.root.isConnected ? this.root : this.#document.documentElement,
    ).fontFamily;
    if (this.root.isConnected) {
      this.#family = family;
    }
    return family;
  }

  /**
   * How wide a frame's names are written in a font, as a 2D context of an `OffscreenCanvas` of the
   * document's window measures them: a canvas in the document resolves its font against the
   * document's style, and setting it after the frame's writes would make WebKit recalculate that
   * style in the middle of the frame. An offscreen canvas of the same window measures in the
   * document's fonts to the same width.
   */
  #measurer(): (text: string, font: string) => number {
    if (this.#measuring === null) {
      const view = this.#document.defaultView;
      const ctx =
        view === null || typeof view.OffscreenCanvas !== 'function'
          ? null
          : new view.OffscreenCanvas(1, 1).getContext('2d');
      if (ctx === null) {
        throw new SwfFailure(
          makeError(
            'UNSUPPORTED_CAPABILITY',
            'the document’s window gives no OffscreenCanvas 2D context to measure names in',
          ),
        );
      }
      this.#measuring = ctx;
    }
    const ctx = this.#measuring;
    // Setting a context's font parses it, which costs more than measuring a name: a frame's
    // names, all in one font, set it once. It is set afresh each frame, so a font that has loaded
    // since is measured as it now is.
    let current: string | null = null;
    return (text, font) => {
      if (font !== current) {
        ctx.font = font;
        current = font;
      }
      return ctx.measureText(text).width;
    };
  }

  #element(key: string, make: () => HTMLElement): HTMLElement {
    let element = this.#elements.get(key);
    if (element === undefined) {
      element = make();
      this.#elements.set(key, element);
    }
    return element;
  }

  /**
   * A window's chrome element, built once: a frame outline (taking no input) and the eight resize
   * handles (taking input), shown or hidden as the window's edges allow.
   */
  #chromeElement(nodeId: Id): HTMLElement {
    const e = this.#document.createElement('div');
    e.setAttribute(DOM_ATTRIBUTES.layer, 'chrome');
    e.setAttribute(DOM_ATTRIBUTES.node, nodeId);
    style(e, { position: 'absolute', 'pointer-events': 'none' });
    const outline = this.#document.createElement('div');
    outline.setAttribute(DOM_ATTRIBUTES.layer, 'chrome-frame');
    style(outline, {
      position: 'absolute',
      left: '0px',
      top: '0px',
      'transform-origin': '0 0',
      'pointer-events': 'none',
      'box-sizing': 'border-box',
    });
    e.append(outline);
    for (const edge of Object.keys(RESIZE_EDGES)) {
      const handle = this.#document.createElement('div');
      handle.setAttribute(DOM_ATTRIBUTES.handle, edge);
      style(handle, { position: 'absolute', 'pointer-events': 'auto', cursor: `${edge}-resize` });
      e.append(handle);
    }
    return e;
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
    // A window whose every surface is represented by its label alone has no chrome: the label
    // stands for the whole window.
    const nodes = new Set(
      frame.planned.flatMap((p) => {
        const owner = frame.scene.surfaces.get(p.fragment.surfaceId)?.ownerNodeId;
        return owner === undefined || p.representation === 'label' ? [] : [owner];
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
   * A window's chrome, a layer of its own: its frame outline (which takes no input, so
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
    const element = this.#element(id, () => this.#chromeElement(nodeId));
    const outline = element.firstElementChild as HTMLElement | null;
    if (outline === null) {
      throw new Error(`the chrome of window "${nodeId}" lost its frame`);
    }
    const [x, y, w, h] = piece.bounds;
    this.#write.style(element, boxOf(piece.bounds));
    const width = node.bounds[0] * this.#ppu;
    const height = node.bounds[1] * this.#ppu;
    const corners: Quad2 = piece.corners ?? rectQuad(piece.bounds);
    const matrix =
      quadMatrix(width, height, offsetQuad(corners, x, y)) ??
      quadMatrix(width, height, offsetQuad(rectQuad(piece.bounds), x, y));
    const selected = scene.selection.includes(nodeId);
    const focused = scene.focusedId === nodeId;
    this.#write.style(outline, {
      width: `${String(width)}px`,
      height: `${String(height)}px`,
      transform: matrix === null ? 'scale(0)' : cssTransform(matrix),
      // The window keys act on is marked, and the one in focus above it.
      border: `${focused || selected ? '3px' : '1px'} solid ${
        focused ? chrome.inks.focused : selected ? chrome.inks.selected : chrome.inks.frame
      }`,
    });
    this.#write.toggle(element, DOM_ATTRIBUTES.selected, selected);
    this.#write.toggle(element, DOM_ATTRIBUTES.focused, focused);
    const resizable = node.flags.resizable && !node.flags.locked;
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
    for (const handle of element.querySelectorAll<HTMLElement>(`[${DOM_ATTRIBUTES.handle}]`)) {
      const edge = handle.getAttribute(DOM_ATTRIBUTES.handle) as keyof typeof RESIZE_EDGES;
      const shown = resizable && RESIZE_EDGES[edge].every((side) => has[side]);
      const north = edge.includes('n');
      const south = edge.includes('s');
      const east = edge.includes('e');
      const west = edge.includes('w');
      this.#write.style(
        handle,
        shown
          ? {
              display: '',
              left: `${String(east ? w - t : 0)}px`,
              top: `${String(south ? h - t : 0)}px`,
              width: `${String(east || west ? t : w)}px`,
              height: `${String(north || south ? t : h)}px`,
            }
          : { display: 'none' },
      );
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

function boxOf([x, y, w, h]: ScreenRect): Record<string, string> {
  return {
    left: `${String(x)}px`,
    top: `${String(y)}px`,
    width: `${String(w)}px`,
    height: `${String(h)}px`,
  };
}

function style(element: HTMLElement, properties: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(properties)) {
    element.style.setProperty(name, value);
  }
}
