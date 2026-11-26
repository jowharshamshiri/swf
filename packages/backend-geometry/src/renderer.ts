import type { Id, SceneState } from '@swf/core';
import {
  effectiveState,
  makeError,
  nodeFrameGeometry,
  SwfFailure,
  surfaceWorldMatrix,
} from '@swf/core';
import type { Vec2, Vec3 } from '@swf/math';
import { mat4TransformDirection, rectQuad, rectToQuad } from '@swf/math';
import type {
  CompositionLayer,
  NameObstacle,
  NameRequest,
  PlannedFragment,
  ProjectedFragment,
  RenderedFrame,
  RendererBackend,
  RendererCapabilities,
  RendererSession,
  RenderFrame,
  ScreenPoint,
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
import type { Projection, ProjectionModule } from '@swf/projections';
import { projectionFor } from '@swf/projections';
import type { Drawable, Mesh } from './drawing.js';
import { drawableIssue, drawMesh, homographyMesh, outline } from './drawing.js';
import type { WindowFrame } from './frames.js';
import { FRAME_STROKE, windowFrames } from './frames.js';
import type { GeometryLayer } from './layer.js';
import { GEOMETRY_LAYER } from './layer.js';
import { planeMesh } from './sampling.js';

/** The geometry renderer's registered ID, as {@link GeometryRenderer} declares it. */
export const GEOMETRY_RENDERER_ID = 'swf.geometry-renderer/1';

/**
 * The colours drawn on whatever the view is drawn over, as canvas colours: every window frame
 * (and each mark of a window, in view by its label alone or out of view), the selected and the
 * focused window's frame, the names of windows, and the ground each name is written on. Frames
 * and marks should stand out from the view's ground by 3:1 at least (WCAG 1.4.11), text from its
 * ground by 4.5:1 (WCAG 1.4.3).
 */
export interface GeometryInks {
  /**
   * Every window frame, every mark of a window, and the name of a window shown by its label alone:
   * a non-blank canvas colour.
   */
  readonly frame: string;
  /** The selected window's frame and name: a non-blank canvas colour. */
  readonly selected: string;
  /** The focused window's frame and name, over `selected`: a non-blank canvas colour. */
  readonly focused: string;
  /** Windows' names: a non-blank canvas colour. */
  readonly text: string;
  /** The ground a name is written on, so it reads over whatever lies under it: a canvas colour. */
  readonly ground: string;
}

/** Inks that stand out on a light ground by 4.5:1 or more. Frozen. */
export const DEFAULT_GEOMETRY_INKS: GeometryInks = Object.freeze({
  frame: 'rgb(118, 118, 118)',
  selected: 'rgb(0, 95, 184)',
  focused: 'rgb(168, 74, 0)',
  text: 'rgb(30, 30, 30)',
  ground: 'rgb(255, 255, 255)',
});

/** How a window's name is written: its size, the height of its line, and its plate's margin. */
const NAME = Object.freeze({ size: 12, line: 15, margin: 3 });
/**
 * A mark at the view's edge, in CSS pixels: how far round it other names keep clear, how far its
 * own name stands off it, and how wide the ring of the ground ink round it is.
 */
const INDICATOR = Object.freeze({ reach: 10, inset: 14, ring: 4 });

/** What a stand-in draws on its own ground: legible whatever the view is drawn over. */
const STAND_IN = Object.freeze({
  proxy: { ground: 'rgb(72, 84, 108)', edge: 'rgb(48, 56, 72)', ink: 'rgb(255, 255, 255)' },
  placeholder: { ground: 'rgb(220, 220, 220)', edge: 'rgb(90, 90, 90)', ink: 'rgb(40, 40, 40)' },
});

/** What a geometry renderer draws from. Checked when the renderer is made, `inks` every frame. */
export interface GeometryRendererOptions {
  /**
   * The drawable an adapter supplies for a surface, for surfaces presented as drawn content
   * (typically the surface runtime's handle of a `drawable` adapter). Asked at every frame; a
   * surface planned as drawn content whose answer is not a {@link Drawable} fails the frame with
   * `INVALID_INPUT`. The drawables stay the adapters'.
   */
  readonly drawables?: (surfaceId: Id) => unknown;
  /**
   * The projection modules views use. With them the renderer follows each view's projection
   * point by point (mesh warping), and draws window chrome and indicators for windows out of
   * view; without them it places drawn content by its projected corners only.
   */
  readonly projections?: {
    /** The projection module registered under `id`, or undefined when none is. */
    get(id: string): ProjectionModule | undefined;
  };
  /** Cells per side of the mesh a drawable is warped with: a whole number, 1 to 128. Default 12. */
  readonly meshCells?: number;
  /**
   * What a proxy or placeholder says when it stands in for content for a reason (FR-195), as text.
   * Default {@link STAND_IN_TEXT}, in English.
   */
  readonly standIn?: (reason: StandInReason) => string;
  /**
   * The inks, read at every frame so a change of the host's appearance is drawn at the next one.
   * Default {@link DEFAULT_GEOMETRY_INKS}. An ink that is not a non-blank string makes that frame
   * throw `RangeError`.
   */
  readonly inks?: () => GeometryInks;
  /**
   * The font family names are written in, as a canvas font takes it, read at every frame like the
   * inks. Default `sans-serif`. A blank family makes that frame throw `RangeError`.
   */
  readonly typeface?: () => string;
  /**
   * How wide a text is written in a canvas font, in CSS pixels, for placing names. Default: as a
   * 2D context of an `OffscreenCanvas` measures it; where there is none, it must be given.
   */
  readonly measureText?: (text: string, font: string) => number;
}

/**
 * A renderer that draws: adapter-supplied drawables, proxies, placeholders, window chrome and
 * spatial indicators, each a layer of drawing commands in viewport pixels. It never reads pixels
 * back. It cannot present live elements; with nothing else, those are shown as proxies.
 */
export class GeometryRenderer implements RendererBackend {
  /** {@link GEOMETRY_RENDERER_ID}. */
  readonly id = GEOMETRY_RENDERER_ID;
  /** The presentation API version it implements. */
  readonly apiVersion = PRESENTATION_API_VERSION;
  readonly #options: GeometryRendererOptions;
  readonly #cells: number;

  /**
   * A renderer drawing from `options`, which it keeps as given.
   *
   * @throws `RangeError` for a `meshCells` that is not a whole number from 1 to 128.
   */
  constructor(options: GeometryRendererOptions = {}) {
    const cells = options.meshCells ?? 12;
    if (!Number.isInteger(cells) || cells < 1 || cells > 128) {
      throw new RangeError(`meshCells must be an integer from 1 to 128 (got ${String(cells)})`);
    }
    this.#options = options;
    this.#cells = cells;
  }

  /**
   * Drawn content is warped by a mesh (piecewise affine): close to the projection, never claimed
   * exact. With projection modules it follows nonlinear projections point by point; without, it
   * follows the projected corners, as a planar perspective does.
   */
  capabilities(): RendererCapabilities {
    return Object.freeze({
      handleKinds: Object.freeze({ drawable: 'approximate', 'proxy-only': 'proxy' }),
      transformMode: this.#options.projections === undefined ? 'perspective-3d' : 'mesh',
      clipping: 'path',
      hitMapping: false,
      layering: 'raster',
      resourceOwnership: 'renderer',
      recovery: 'rebuild',
    });
  }

  /**
   * A new session for the view's viewport. Rejects with {@link SwfFailure} (`INVALID_INPUT`) for
   * an invalid view.
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
    return Promise.resolve(
      new GeometryRendererSession(this.id, view.viewportId, this.#options, this.#cells),
    );
  }
}

/**
 * A geometry renderer's session for one viewport. It holds no graphics resources, only the
 * layers it drew last, kept so unchanged ones are not drawn anew; the presenter owns and releases
 * it.
 */
export class GeometryRendererSession implements RendererSession {
  /** The renderer that prepared it. */
  readonly rendererId: string;
  /** The viewport it renders. */
  readonly viewportId: Id;
  readonly #options: GeometryRendererOptions;
  readonly #cells: number;
  /** Each layer of the last render, with the inputs it was drawn from. */
  readonly #kept = new Map<
    string,
    { readonly signature: string | null; readonly content: GeometryLayer }
  >();
  #used = new Set<string>();
  #writes = 0;
  /** The inks of the frame being drawn. */
  #inks: GeometryInks = DEFAULT_GEOMETRY_INKS;
  /** The 2D context names are measured with, once made. */
  #measuring: OffscreenCanvasRenderingContext2D | null = null;
  #released = false;

  /** A session as {@link GeometryRenderer.prepare} makes it, with `cells` mesh cells per side. */
  constructor(rendererId: string, viewportId: Id, options: GeometryRendererOptions, cells: number) {
    this.rendererId = rendererId;
    this.viewportId = viewportId;
    this.#options = options;
    this.#cells = cells;
  }

  /**
   * Realizes a frame as drawn layers: drawn content, proxies and placeholders in plan order, each
   * window's chrome after its last fragment, then the windows' names, and the indicators of
   * windows out of view on top (chrome and indicators only with projection modules). A layer whose
   * inputs did not change is the same object as last frame.
   *
   * @throws {@link @swf/core!SwfFailure} `INVALID_TRANSITION` once released; `INVALID_INPUT`
   *   for a frame of another viewport or a missing or invalid drawable; `UNSUPPORTED_CAPABILITY`
   *   for live content, a chrome or overlay fragment, or a projection the modules do not have.
   *   `RangeError` for an invalid ink.
   */
  render(frame: RenderFrame): RenderedFrame {
    return this.renderExcept(frame, new Set());
  }

  /**
   * Renders every planned fragment except the live ones listed, which another renderer realizes
   * (see {@link LayeredRenderer}); window chrome still stacks with them in plan order. Throws as
   * {@link GeometryRendererSession.render} does, but not for the live fragments listed.
   *
   * @param elsewhere - The IDs of live fragments another renderer realizes.
   */
  renderExcept(frame: RenderFrame, elsewhere: ReadonlySet<string>): RenderedFrame {
    if (this.#released) {
      throw new SwfFailure(
        makeError(
          'INVALID_TRANSITION',
          `the geometry renderer session for viewport "${this.viewportId}" was released`,
        ),
      );
    }
    this.#inks = inksOf(this.#options.inks?.() ?? DEFAULT_GEOMETRY_INKS);
    if (frame.viewportId !== this.viewportId) {
      throw new SwfFailure(
        makeError(
          'INVALID_INPUT',
          `a frame for viewport "${frame.viewportId}" was given to viewport "${this.viewportId}"`,
        ),
      );
    }
    const projection = this.#projection(frame.view);
    this.#used = new Set();
    this.#writes = 0;
    const layers: CompositionLayer[] = [];
    const lastOfNode = new Map<Id, string>();
    for (const p of frame.planned) {
      const nodeId = frame.scene.surfaces.get(p.fragment.surfaceId)?.ownerNodeId;
      if (nodeId !== undefined) {
        lastOfNode.set(nodeId, p.fragment.id);
      }
    }
    // Window frames are drawn with projection modules only.
    const frames =
      projection === null ? new Map<Id, WindowFrame>() : windowFrames(frame, projection);
    for (const planned of frame.planned) {
      if (planned.negotiation.layer === 'content-native') {
        if (!elsewhere.has(planned.fragment.id)) {
          throw new SwfFailure(
            makeError(
              'UNSUPPORTED_CAPABILITY',
              `the geometry renderer cannot present live content (fragment "${planned.fragment.id}")`,
              { entityId: planned.fragment.surfaceId },
            ),
          );
        }
      } else {
        layers.push(this.#fragmentLayer(frame, planned, projection));
      }
      for (const [nodeId, last] of lastOfNode) {
        const drawn = frames.get(nodeId);
        if (last === planned.fragment.id && drawn !== undefined) {
          layers.push(this.#chrome(nodeId, drawn, planned.fragment.id));
        }
      }
    }
    layers.push(...this.#names(frame, projection, frames));
    return Object.freeze({
      viewportId: frame.viewportId,
      sceneRevision: frame.sceneRevision,
      size: Object.freeze({
        width: frame.view.width,
        height: frame.view.height,
        devicePixelRatio: frame.view.devicePixelRatio,
      }),
      layers: Object.freeze(layers),
      writes: this.#writes + this.#forgetUnused(),
    });
  }

  /**
   * The layer drawn from these inputs: the same object as last time when its inputs did not
   * change (so nothing is redrawn), or a new one. A null signature always draws anew.
   */
  #keep(id: string, signature: string | null, make: () => GeometryLayer): GeometryLayer {
    this.#used.add(id);
    const kept = this.#kept.get(id);
    if (kept !== undefined && signature !== null && kept.signature === signature) {
      return kept.content;
    }
    const content = make();
    this.#kept.set(id, { signature, content });
    this.#writes += 1;
    return content;
  }

  /** Forgets the layers this render did not draw; each one gone is a change. */
  #forgetUnused(): number {
    let gone = 0;
    for (const id of [...this.#kept.keys()]) {
      if (!this.#used.has(id)) {
        this.#kept.delete(id);
        gone += 1;
      }
    }
    return gone;
  }

  /** It draws everything it shows, so no surface's own content attaches here. */
  targetOf(): undefined {
    return undefined;
  }

  /**
   * It holds no graphics resources (it draws into the compositor's canvases), so this never calls
   * `listener`.
   */
  watchLoss(): () => void {
    return () => undefined;
  }

  /** Ends the session: rendering afterwards throws. It frees nothing. Safe to call twice. */
  release(): Promise<void> {
    this.#released = true;
    return Promise.resolve();
  }

  #projection(view: ViewGeometry): Projection | null {
    const projections = this.#options.projections;
    if (projections === undefined) {
      return null;
    }
    const module = projections.get(view.projectionId);
    if (module === undefined) {
      throw new SwfFailure(
        makeError(
          'UNSUPPORTED_CAPABILITY',
          `viewport "${this.viewportId}" uses projection "${view.projectionId}", which is not registered`,
        ),
      );
    }
    return projectionFor(module, view);
  }

  #fragmentLayer(
    frame: RenderFrame,
    planned: PlannedFragment,
    projection: Projection | null,
  ): CompositionLayer {
    const { fragment, negotiation } = planned;
    const category = negotiation.layer;
    const reason = standInReason(planned);
    const because =
      reason === null ? null : (this.#options.standIn ?? ((r) => STAND_IN_TEXT[r]))(reason);
    let draw: (ctx: CanvasRenderingContext2D) => void;
    let signature: string | null;
    switch (category) {
      case 'content-raster': {
        const drawable = this.#drawable(fragment.surfaceId);
        const mesh = this.#mesh(frame, fragment, drawable, projection);
        signature =
          drawable.revision === undefined
            ? null
            : JSON.stringify([
                'raster',
                fragment.bounds,
                mesh.points,
                identity(drawable.source),
                drawable.width,
                drawable.height,
                drawable.revision,
              ]);
        draw = (ctx) => {
          clipTo(ctx, fragment.bounds);
          drawMesh(ctx, drawable, mesh);
        };
        break;
      }
      case 'proxy':
        if (planned.representation === 'label') {
          // A mark in the middle of where the window is stands for it; its name is written
          // beside it with the other names.
          const ink = this.#inks.frame;
          signature = JSON.stringify(['label', fragment.bounds, ink]);
          draw = (ctx) => {
            const [cx, cy] = centreOf(fragment.bounds);
            ctx.beginPath();
            ctx.arc(cx, cy, NAME_MARK / 2, 0, 2 * Math.PI);
            ctx.fillStyle = ink;
            ctx.fill();
          };
          break;
        }
        signature = JSON.stringify(['proxy', fragment.bounds, fragment.corners, because]);
        draw = (ctx) => {
          clipTo(ctx, fragment.bounds);
          outline(ctx, fragment.corners ?? rectQuad(fragment.bounds));
          ctx.fillStyle = STAND_IN.proxy.ground;
          ctx.fill();
          ctx.strokeStyle = STAND_IN.proxy.edge;
          ctx.lineWidth = 1;
          ctx.stroke();
          if (because !== null) {
            text(ctx, because, shift(fragment.bounds, 16), STAND_IN.proxy.ink);
          }
        };
        break;
      case 'placeholder':
        signature = JSON.stringify(['placeholder', fragment.bounds, fragment.corners, because]);
        draw = (ctx) => {
          clipTo(ctx, fragment.bounds);
          outline(ctx, fragment.corners ?? rectQuad(fragment.bounds));
          ctx.fillStyle = STAND_IN.placeholder.ground;
          ctx.fill();
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = STAND_IN.placeholder.edge;
          ctx.stroke();
          if (because !== null) {
            text(ctx, because, shift(fragment.bounds, 16), STAND_IN.placeholder.ink);
          }
        };
        break;
      case 'content-native':
      case 'chrome':
      case 'overlay':
        throw new SwfFailure(
          makeError(
            'UNSUPPORTED_CAPABILITY',
            `the geometry renderer cannot realize fragment "${fragment.id}" as ${category}`,
            { entityId: fragment.surfaceId },
          ),
        );
    }
    const id = `${category}:${fragment.id}`;
    return Object.freeze({
      id,
      category,
      fragmentId: fragment.id,
      surfaceId: fragment.surfaceId,
      content: this.#keep(id, signature, () => layer(null, draw)),
    });
  }

  #drawable(surfaceId: Id): Drawable {
    const value = this.#options.drawables?.(surfaceId);
    const issue = value === undefined ? 'there is none' : drawableIssue(value);
    if (issue !== null) {
      throw new SwfFailure(
        makeError('INVALID_INPUT', `the drawable of surface "${surfaceId}": ${issue}`, {
          entityId: surfaceId,
        }),
      );
    }
    return value as Drawable;
  }

  /**
   * The mesh a drawable is warped by: sampled through the projection where there is one (each
   * point on the branch of its neighbours, starting in this fragment), else the projective map of
   * the projected corners (or of the bounds, without usable corners).
   */
  #mesh(
    frame: RenderFrame,
    fragment: ProjectedFragment,
    drawable: Drawable,
    projection: Projection | null,
  ): Mesh {
    const n = this.#cells;
    const surface = frame.scene.surfaces.get(fragment.surfaceId);
    const world = surfaceWorldMatrix(frame.scene, fragment.surfaceId);
    if (projection !== null && surface !== undefined && world !== undefined) {
      const [w, h] = surface.bounds;
      return planeMesh(
        projection,
        frame.view,
        world,
        { x0: -w / 2, x1: w / 2, y0: -h / 2, y1: h / 2 },
        n,
        n,
        centreOf(fragment.bounds),
      );
    }
    const m =
      (fragment.corners === null
        ? null
        : rectToQuad(drawable.width, drawable.height, fragment.corners)) ??
      rectToQuad(drawable.width, drawable.height, rectQuad(fragment.bounds));
    if (m === null) {
      // Empty bounds: nothing of the drawable is visible.
      return {
        columns: 1,
        rows: 1,
        points: [
          [null, null],
          [null, null],
        ],
      };
    }
    return homographyMesh(m, drawable.width, drawable.height, n, n);
  }

  /** A window's frame, drawn along its projected frame, stacked after `after`. */
  #chrome(nodeId: Id, drawn: WindowFrame, after: string): CompositionLayer {
    const { outline: points, corners, selected, focused, handles } = drawn;
    const inks = this.#inks;
    const signature = JSON.stringify([points, selected, focused, handles, after, inks]);
    return Object.freeze({
      id: `chrome:${nodeId}`,
      category: 'chrome',
      fragmentId: null,
      surfaceId: null,
      content: this.#keep(`chrome:${nodeId}`, signature, () =>
        layer(after, (ctx) => {
          outline(ctx, points);
          ctx.strokeStyle = focused ? inks.focused : selected ? inks.selected : inks.frame;
          ctx.lineWidth = selected || focused ? FRAME_STROKE.emphasised : FRAME_STROKE.plain;
          ctx.stroke();
          if (handles) {
            const side = FRAME_STROKE.handle;
            ctx.fillStyle = inks.selected;
            for (const [x, y] of corners) {
              ctx.fillRect(x - side / 2, y - side / 2, side, side);
            }
          }
        }),
      ),
    });
  }

  /**
   * The windows' names, and the marks at the view's edge pointing the way to windows the view
   * does not show (with projection modules only), each mark with its window's name: a spatial
   * indicator that keeps windows outside a narrow view findable. Every name is written where it
   * can be read: wholly inside the view, over no other window's frame or mark and over no other
   * name (`placeNames`). A window's name goes above its frame, else inside it, else below it
   * (`windowNames`); one shown by its label alone beside its mark; one out of view inward of its
   * mark at the edge, else as near it along the edge as there is room. Where an edge has no room
   * for every name of its marks, its far end is kept for a count of those it has no room for
   * ("+3"), and the names are placed round it.
   */
  #names(
    frame: RenderFrame,
    projection: Projection | null,
    frames: ReadonlyMap<Id, WindowFrame>,
  ): CompositionLayer[] {
    const { view } = frame;
    const measure = this.#measure();
    const family = this.#options.typeface?.() ?? 'sans-serif';
    if (family.trim() === '') {
      throw new RangeError(`typeface must be a font family (got "${family}")`);
    }
    const font = `${String(NAME.size)}px ${family}`;
    const size = (label: string): readonly [number, number] => [
      Math.ceil(measure(label, font)) + 2 * NAME.margin,
      NAME.line + 2 * NAME.margin,
    ];
    const inView = windowNames(
      frame,
      size,
      new Map([...frames].map(([nodeId, drawn]) => [nodeId, drawn.box])),
    );
    const marks = projection === null ? [] : this.#edgeMarks(frame, projection);
    const obstacles: NameObstacle[] = [
      ...inView.obstacles,
      ...marks.map(({ nodeId, at: [x, y] }) => ({
        owner: nodeId,
        box: [
          x - INDICATOR.reach,
          y - INDICATOR.reach,
          2 * INDICATOR.reach,
          2 * INDICATOR.reach,
        ] as const,
      })),
    ];
    const away: NameRequest[] = marks.map(({ nodeId, label, at, toward }) => {
      const [w, h] = size(label);
      return {
        owner: nodeId,
        text: label,
        size: [w, h],
        places: alongEdge(at, toward, w, h, view),
      };
    });
    // The names in view first, then the marks' names. Where an edge has no room for every one of
    // its marks' names, its far end is kept for the count of those it has no room for, weighed
    // before them, and the names are placed again round it.
    const edges = marks.map((mark) => edgeOf(mark.toward));
    const place = (counted: readonly string[]) => {
      const counts: NameRequest[] = counted.map((edge) => {
        // Room for the most it could ever count.
        const [w, h] = size(`+${String(marks.length)}`);
        return {
          owner: `edge:${edge}`,
          text: '',
          size: [w, h],
          places: edgeEnds(edge, w, h, view),
        };
      });
      const requests: NameRequest[] = [...inView.names, ...counts, ...away];
      return { requests, counts, placed: placeNames(view, obstacles, requests) };
    };
    const unplacedAt = (pass: ReturnType<typeof place>) => {
      const unplaced = new Map<string, number>();
      edges.forEach((edge, i) => {
        if (pass.placed[inView.names.length + pass.counts.length + i] === null) {
          unplaced.set(edge, (unplaced.get(edge) ?? 0) + 1);
        }
      });
      return unplaced;
    };
    let pass = place([]);
    let unplaced = unplacedAt(pass);
    if (unplaced.size > 0) {
      pass = place([...unplaced.keys()]);
      unplaced = unplacedAt(pass);
    }
    const { requests, counts, placed } = pass;
    const own = inView.names.length;
    const written = requests.flatMap((request, i) => {
      const at = placed[i];
      // The counts' places are kept: what each says is known only once every name is placed.
      if (at === null || at === undefined || (i >= own && i < own + counts.length)) {
        return [];
      }
      return [{ request, at, own: i < own }];
    });
    // Each count kept at its edge's end, saying how many names there had no room.
    const countNames = counts.flatMap((request, i) => {
      const at = placed[inView.names.length + i];
      const n = unplaced.get(request.owner.slice('edge:'.length)) ?? 0;
      if (at === null || at === undefined || n === 0) {
        return [];
      }
      const text = `+${String(n)}`;
      return [{ request: { ...request, text, size: size(text) }, at, own: false }];
    });
    const inks = this.#inks;
    const emphasis = new Map<Id, Emphasis>(
      inView.names.map((n) => [
        n.owner,
        n.focused ? 'focused' : n.selected ? 'selected' : n.marked ? 'quiet' : null,
      ]),
    );
    const nameOf = ({ request, at }: { request: NameRequest; at: ScreenPoint }) => ({
      text: request.text,
      box: [at[0], at[1], request.size[0], request.size[1]] as ScreenRect,
      emphasis: emphasis.get(request.owner) ?? null,
    });
    const ownNames = written.filter(({ own }) => own).map(nameOf);
    const awayNames = [...written.filter(({ own }) => !own), ...countNames].map(nameOf);
    const layers: CompositionLayer[] = [];
    if (ownNames.length > 0) {
      const signature = JSON.stringify([ownNames, inks, font]);
      layers.push(
        Object.freeze({
          id: 'overlay:names',
          category: 'overlay',
          fragmentId: null,
          surfaceId: null,
          content: this.#keep('overlay:names', signature, () =>
            layer(null, (ctx) => {
              for (const name of ownNames) {
                plate(ctx, name, inks, font);
              }
            }),
          ),
        }),
      );
    }
    if (marks.length > 0) {
      const arrows = marks.map(({ at, toward }) => ({ at, toward }));
      const signature = JSON.stringify([arrows, awayNames, inks, font]);
      layers.push(
        Object.freeze({
          id: 'overlay:indicators',
          category: 'overlay',
          fragmentId: null,
          surfaceId: null,
          content: this.#keep('overlay:indicators', signature, () =>
            layer(null, (ctx) => {
              for (const { at, toward } of arrows) {
                const [x, y] = at;
                const [dx, dy] = toward;
                ctx.beginPath();
                ctx.moveTo(x + dx * 10, y + dy * 10);
                ctx.lineTo(x - dy * 6, y + dx * 6);
                ctx.lineTo(x + dy * 6, y - dx * 6);
                ctx.closePath();
                // Ringed in the ground ink: a mark at an edge a window reaches reads over it.
                ctx.lineJoin = 'round';
                ctx.lineWidth = INDICATOR.ring;
                ctx.strokeStyle = inks.ground;
                ctx.stroke();
                ctx.fillStyle = inks.frame;
                ctx.fill();
              }
              for (const name of awayNames) {
                plate(ctx, name, inks, font);
              }
            }),
          ),
        }),
      );
    }
    return layers;
  }

  /** How wide a frame's names are written in a font: the host's measure, else an offscreen canvas's. */
  #measure(): (text: string, font: string) => number {
    const given = this.#options.measureText;
    if (given !== undefined) {
      return given;
    }
    if (this.#measuring === null) {
      if (typeof OffscreenCanvas === 'undefined') {
        throw new SwfFailure(
          makeError(
            'UNSUPPORTED_CAPABILITY',
            'the geometry renderer measures names with an OffscreenCanvas, which this environment does not have: give it measureText',
          ),
        );
      }
      const made = new OffscreenCanvas(1, 1).getContext('2d');
      if (made === null) {
        throw new SwfFailure(
          makeError(
            'UNSUPPORTED_CAPABILITY',
            'an OffscreenCanvas here gives no 2D context to measure names with',
          ),
        );
      }
      this.#measuring = made;
    }
    const ctx = this.#measuring;
    // Setting a context's font parses it, which costs more than measuring a name: a frame's
    // names, all in one font, set it once. It is set afresh each frame, so a
    // font that has loaded since is measured as it now is.
    let current: string | null = null;
    return (text, font) => {
      if (font !== current) {
        ctx.font = font;
        current = font;
      }
      return ctx.measureText(text).width;
    };
  }

  /** The mark at the view's edge of each visible window the view does not show. */
  #edgeMarks(
    frame: RenderFrame,
    projection: Projection,
  ): { nodeId: Id; label: string; at: Vec2; toward: Vec2 }[] {
    const { scene, view } = frame;
    const shown = new Set(
      frame.planned.flatMap((p) => {
        const owner = scene.surfaces.get(p.fragment.surfaceId)?.ownerNodeId;
        return owner === undefined ? [] : [owner];
      }),
    );
    const domain = projection.describeDomain();
    const marks: { nodeId: Id; label: string; at: Vec2; toward: Vec2 }[] = [];
    for (const surface of scene.surfaces.values()) {
      const nodeId = surface.ownerNodeId;
      if (shown.has(nodeId)) {
        continue;
      }
      shown.add(nodeId);
      const geometry = nodeFrameGeometry(scene, nodeId);
      if (geometry === undefined || effectiveState(scene.nodes, nodeId)?.visible !== true) {
        continue;
      }
      const centre: Vec3 = [geometry.world[12], geometry.world[13], geometry.world[14]];
      const mark = edgeMark(
        projection,
        view,
        centre,
        domain.horizontalCoverage,
        domain.verticalCoverage,
      );
      if (mark !== null) {
        marks.push({ nodeId, label: scene.nodes.get(nodeId)?.label ?? nodeId, ...mark });
      }
    }
    return marks;
  }
}

/** The edge a mark pointing this way stands at. */
function edgeOf([dx, dy]: Vec2): 'left' | 'right' | 'top' | 'bottom' {
  if (dx !== 0) {
    return dx < 0 ? 'left' : 'right';
  }
  return dy < 0 ? 'top' : 'bottom';
}

/**
 * The places for the name of a mark at the view's edge, best first: just inward of the mark,
 * then a line at a time along the edge, nearer places first, as far as the edge runs.
 */
function alongEdge(
  [x, y]: Vec2,
  toward: Vec2,
  w: number,
  h: number,
  view: { readonly width: number; readonly height: number },
): ScreenPoint[] {
  const edge = edgeOf(toward);
  const across = edge === 'left' || edge === 'right';
  const [x0, y0]: ScreenPoint =
    edge === 'left'
      ? [x + INDICATOR.inset, y - h / 2]
      : edge === 'right'
        ? [x - INDICATOR.inset - w, y - h / 2]
        : edge === 'top'
          ? [x - w / 2, y + INDICATOR.inset]
          : [x - w / 2, y - INDICATOR.inset - h];
  const step = across ? h : w + 2 * NAME.margin;
  const length = across ? view.height : view.width;
  const places: ScreenPoint[] = [[x0, y0]];
  for (let k = 1; k * step <= length; k += 1) {
    for (const sign of [-1, 1]) {
      places.push(across ? [x0, y0 + sign * k * step] : [x0 + sign * k * step, y0]);
    }
  }
  return places;
}

/** The places for the count of names an edge has no room for: at its far end, else its near end. */
function edgeEnds(
  edge: string,
  w: number,
  h: number,
  view: { readonly width: number; readonly height: number },
): ScreenPoint[] {
  const m = INDICATOR.inset;
  switch (edge) {
    case 'left':
      return [
        [m, view.height - h],
        [m, 0],
      ];
    case 'right':
      return [
        [view.width - m - w, view.height - h],
        [view.width - m - w, 0],
      ];
    case 'top':
      return [
        [view.width - w, m],
        [0, m],
      ];
    default:
      return [
        [view.width - w, view.height - m - h],
        [0, view.height - m - h],
      ];
  }
}

/**
 * How a window's name stands out: as the selected window's, the focused one's, quieter as a far
 * window's shown by its label alone, or not at all.
 */
type Emphasis = 'selected' | 'focused' | 'quiet' | null;

/** A name on its plate, in the ink of its window's state: text drawn on a canvas is only text. */
function plate(
  ctx: CanvasRenderingContext2D,
  {
    text: label,
    box: [x, y, w, h],
    emphasis,
  }: { text: string; box: ScreenRect; emphasis: Emphasis },
  inks: GeometryInks,
  font: string,
): void {
  ctx.fillStyle = inks.ground;
  ctx.fillRect(x, y, w, h);
  if (emphasis === 'selected' || emphasis === 'focused') {
    ctx.strokeStyle = emphasis === 'focused' ? inks.focused : inks.selected;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }
  ctx.fillStyle =
    emphasis === 'focused'
      ? inks.focused
      : emphasis === 'selected'
        ? inks.selected
        : emphasis === 'quiet'
          ? inks.frame
          : inks.text;
  ctx.font = font;
  ctx.textAlign = 'start';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + NAME.margin, y + h / 2);
}

/**
 * Where an out-of-view point's marker goes: its direction from the camera, turned towards the
 * view until it lies just inside the covered angles, projected; with the unit screen direction
 * from the marker towards the point. Null when the point is in view.
 */
function edgeMark(
  projection: Projection,
  view: ViewGeometry,
  point: Vec3,
  horizontal: number,
  vertical: number,
): { at: Vec2; toward: Vec2 } | null {
  const c = view.camera;
  const d: Vec3 = [point[0] - c[12], point[1] - c[13], point[2] - c[14]];
  // Into the camera's frame: its columns are right, up and back.
  const local: Vec3 = [
    d[0] * c[0] + d[1] * c[1] + d[2] * c[2],
    d[0] * c[4] + d[1] * c[5] + d[2] * c[6],
    d[0] * c[8] + d[1] * c[9] + d[2] * c[10],
  ];
  const longitude = Math.atan2(local[0], -local[2]);
  const latitude = Math.atan2(local[1], Math.hypot(local[0], local[2]));
  const marginH = horizontal * 0.03;
  const marginV = vertical * 0.05;
  const lon = Math.max(-horizontal / 2 + marginH, Math.min(horizontal / 2 - marginH, longitude));
  const lat = Math.max(-vertical / 2 + marginV, Math.min(vertical / 2 - marginV, latitude));
  if (lon === longitude && lat === latitude) {
    return null;
  }
  const inside: Vec3 = [
    Math.cos(lat) * Math.sin(lon),
    Math.sin(lat),
    -Math.cos(lat) * Math.cos(lon),
  ];
  const image = projection.projectDirection(mat4TransformDirection(c, inside), view).images[0];
  if (image === undefined) {
    return null;
  }
  const dx = Math.sign(longitude - lon);
  const dy = -Math.sign(latitude - lat);
  const length = Math.hypot(dx, dy);
  return { at: image, toward: [dx / length, dy / length] };
}

function layer(after: string | null, draw: (ctx: CanvasRenderingContext2D) => void): GeometryLayer {
  return Object.freeze({ kind: GEOMETRY_LAYER, after, draw });
}

const identities = new WeakMap<object, number>();
let nextIdentity = 1;

/** A number that stands for one object for as long as it lives. */
function identity(object: object): number {
  let id = identities.get(object);
  if (id === undefined) {
    id = nextIdentity++;
    identities.set(object, id);
  }
  return id;
}

function centreOf([x, y, w, h]: ScreenRect): Vec2 {
  return [x + w / 2, y + h / 2];
}

function shift([x, y, w, h]: ScreenRect, dy: number): ScreenRect {
  return [x, y + dy, w, h - dy];
}

function clipTo(ctx: CanvasRenderingContext2D, [x, y, w, h]: ScreenRect): void {
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
}

/** The inks a host gives, checked: each a non-blank colour. */
function inksOf(inks: GeometryInks): GeometryInks {
  for (const name of ['frame', 'selected', 'focused', 'text', 'ground'] as const) {
    const ink: unknown = inks[name];
    if (typeof ink !== 'string' || ink.trim() === '') {
      throw new RangeError(`inks.${name} must be a canvas colour (got ${String(ink)})`);
    }
  }
  return inks;
}

/** A text at the top-left of the bounds, as text only. */
function text(
  ctx: CanvasRenderingContext2D,
  label: string,
  bounds: ScreenRect,
  colour: string,
): void {
  ctx.fillStyle = colour;
  ctx.font = '12px sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(label, bounds[0] + 4, bounds[1] + 4, Math.max(0, bounds[2] - 8));
}
