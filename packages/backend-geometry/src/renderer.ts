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
  PRESENTATION_API_VERSION,
  STAND_IN_TEXT,
  standInReason,
  viewGeometryIssue,
} from '@swf/presentation';
import type { Projection, ProjectionModule } from '@swf/projections';
import { projectionFor } from '@swf/projections';
import type { Drawable, Mesh } from './drawing.js';
import { drawableIssue, drawMesh, homographyMesh, outline } from './drawing.js';
import type { GeometryLayer } from './layer.js';
import { GEOMETRY_LAYER } from './layer.js';
import { planeMesh, planeOutline } from './sampling.js';

/** The geometry renderer's registered ID, as {@link GeometryRenderer} declares it. */
export const GEOMETRY_RENDERER_ID = 'swf.geometry-renderer/1';

/**
 * The colours drawn on whatever the view is drawn over, as canvas colours: every window frame
 * (and each mark pointing to a window out of view), the selected and the focused window's frame,
 * and text (window titles, labels standing for windows, the marks' names). Frames and marks should
 * stand out from the view's ground by 3:1 at least (WCAG 1.4.11), text by 4.5:1 (WCAG 1.4.3).
 */
export interface GeometryInks {
  /** Every window frame and every mark of a window out of view: a non-blank canvas colour. */
  readonly frame: string;
  /** The selected window's frame: a non-blank canvas colour. */
  readonly selected: string;
  /** The focused window's frame, over `selected`: a non-blank canvas colour. */
  readonly focused: string;
  /** Titles, labels standing for windows and the marks' names: a non-blank canvas colour. */
  readonly text: string;
}

/** Inks that stand out on a light ground by 4.5:1 or more. Frozen. */
export const DEFAULT_GEOMETRY_INKS: GeometryInks = Object.freeze({
  frame: 'rgb(118, 118, 118)',
  selected: 'rgb(0, 95, 184)',
  focused: 'rgb(168, 74, 0)',
  text: 'rgb(30, 30, 30)',
});

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
   * window's chrome after its last fragment, and the indicators of windows out of view on top
   * (chrome and indicators only with projection modules). A layer whose inputs did not change is
   * the same object as last frame.
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
      if (projection !== null) {
        for (const [nodeId, last] of lastOfNode) {
          if (last === planned.fragment.id) {
            const chrome = this.#chrome(frame, nodeId, planned.fragment.id, projection);
            if (chrome !== null) {
              layers.push(chrome);
            }
          }
        }
      }
    }
    if (projection !== null) {
      const indicators = this.#indicators(frame, projection);
      if (indicators !== null) {
        layers.push(indicators);
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
    const label = labelOf(frame.scene, fragment.surfaceId);
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
          // The label alone stands for the window, in the middle of where it is.
          const ink = this.#inks.text;
          signature = JSON.stringify(['label', fragment.bounds, label, ink]);
          draw = (ctx) => {
            clipTo(ctx, fragment.bounds);
            centredText(ctx, label, fragment.bounds, ink);
          };
          break;
        }
        signature = JSON.stringify(['proxy', fragment.bounds, fragment.corners, label, because]);
        draw = (ctx) => {
          clipTo(ctx, fragment.bounds);
          outline(ctx, fragment.corners ?? rectQuad(fragment.bounds));
          ctx.fillStyle = STAND_IN.proxy.ground;
          ctx.fill();
          ctx.strokeStyle = STAND_IN.proxy.edge;
          ctx.lineWidth = 1;
          ctx.stroke();
          text(ctx, label, fragment.bounds, STAND_IN.proxy.ink);
          if (because !== null) {
            text(ctx, because, shift(fragment.bounds, 16), STAND_IN.proxy.ink);
          }
        };
        break;
      case 'placeholder':
        signature = JSON.stringify([
          'placeholder',
          fragment.bounds,
          fragment.corners,
          label,
          because,
        ]);
        draw = (ctx) => {
          clipTo(ctx, fragment.bounds);
          outline(ctx, fragment.corners ?? rectQuad(fragment.bounds));
          ctx.fillStyle = STAND_IN.placeholder.ground;
          ctx.fill();
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = STAND_IN.placeholder.edge;
          ctx.stroke();
          text(ctx, label, fragment.bounds, STAND_IN.placeholder.ink);
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

  /** A window's frame and title, drawn along its projected frame, stacked after `after`. */
  #chrome(
    frame: RenderFrame,
    nodeId: Id,
    after: string,
    projection: Projection,
  ): CompositionLayer | null {
    const scene = frame.scene;
    const node = scene.nodes.get(nodeId);
    const geometry = nodeFrameGeometry(scene, nodeId);
    const own = frame.planned.filter(
      (p) => scene.surfaces.get(p.fragment.surfaceId)?.ownerNodeId === nodeId,
    );
    const owner = own.find((p) => p.fragment.nativeOwner);
    // A window whose every surface is represented by its label alone has no chrome.
    if (
      node === undefined ||
      geometry === undefined ||
      owner === undefined ||
      own.every((p) => p.representation === 'label')
    ) {
      return null;
    }
    const [w, h] = node.bounds;
    const points = planeOutline(
      projection,
      frame.view,
      geometry.world,
      { x0: -w / 2, x1: w / 2, y0: -h / 2, y1: h / 2 },
      12,
      centreOf(owner.fragment.bounds),
    );
    if (points.length < 2) {
      return null;
    }
    const selected = scene.selection.includes(nodeId);
    const focused = scene.focusedId === nodeId;
    const label = node.label ?? '';
    const handles = selected && node.flags.resizable && !node.flags.locked;
    const corners = [0, 12, 24, 36].flatMap((i) => (points[i] === undefined ? [] : [points[i]]));
    const inks = this.#inks;
    const signature = JSON.stringify([points, label, selected, focused, handles, after, inks]);
    return Object.freeze({
      id: `chrome:${nodeId}`,
      category: 'chrome',
      fragmentId: null,
      surfaceId: null,
      content: this.#keep(`chrome:${nodeId}`, signature, () =>
        layer(after, (ctx) => {
          outline(ctx, points);
          ctx.strokeStyle = focused ? inks.focused : selected ? inks.selected : inks.frame;
          ctx.lineWidth = selected || focused ? 3 : 1.5;
          ctx.stroke();
          const [tx, ty] = points[0] ?? [0, 0];
          ctx.fillStyle = inks.text;
          ctx.font = '12px sans-serif';
          ctx.textBaseline = 'bottom';
          // Text drawn on a canvas is only ever text.
          ctx.fillText(label, tx, ty - 3);
          if (handles) {
            ctx.fillStyle = inks.selected;
            for (const [x, y] of corners) {
              ctx.fillRect(x - 4, y - 4, 8, 8);
            }
          }
        }),
      ),
    });
  }

  /**
   * Markers at the view's edge for windows the view does not show, pointing the way to them: a
   * spatial indicator that keeps windows outside a narrow view findable.
   */
  #indicators(frame: RenderFrame, projection: Projection): CompositionLayer | null {
    const { scene, view } = frame;
    const shown = new Set(
      frame.planned.flatMap((p) => {
        const owner = scene.surfaces.get(p.fragment.surfaceId)?.ownerNodeId;
        return owner === undefined ? [] : [owner];
      }),
    );
    const domain = projection.describeDomain();
    const marks: { at: Vec2; toward: Vec2; label: string }[] = [];
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
        marks.push({ ...mark, label: scene.nodes.get(nodeId)?.label ?? nodeId });
      }
    }
    if (marks.length === 0) {
      return null;
    }
    const inks = this.#inks;
    const signature = JSON.stringify([marks, inks.frame, inks.text]);
    return Object.freeze({
      id: 'overlay:indicators',
      category: 'overlay',
      fragmentId: null,
      surfaceId: null,
      content: this.#keep('overlay:indicators', signature, () =>
        layer(null, (ctx) => {
          for (const { at, toward, label } of marks) {
            const [x, y] = at;
            const [dx, dy] = toward;
            ctx.beginPath();
            ctx.moveTo(x + dx * 10, y + dy * 10);
            ctx.lineTo(x - dy * 6, y + dx * 6);
            ctx.lineTo(x + dy * 6, y - dx * 6);
            ctx.closePath();
            ctx.fillStyle = inks.frame;
            ctx.fill();
            ctx.fillStyle = inks.text;
            ctx.font = '11px sans-serif';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, x - dx * 40 - 20, y - dy * 14);
          }
        }),
      ),
    });
  }
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

function labelOf(scene: SceneState, surfaceId: Id): string {
  const surface = scene.surfaces.get(surfaceId);
  const owner = surface === undefined ? undefined : scene.nodes.get(surface.ownerNodeId);
  return surface?.label ?? owner?.label ?? surfaceId;
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

/** A label at the top-left of the bounds, as text only. */
/** A label in the middle of a box, as large as the box lets it be read. */
/** The inks a host gives, checked: each a non-blank colour. */
function inksOf(inks: GeometryInks): GeometryInks {
  for (const name of ['frame', 'selected', 'focused', 'text'] as const) {
    const ink: unknown = inks[name];
    if (typeof ink !== 'string' || ink.trim() === '') {
      throw new RangeError(`inks.${name} must be a canvas colour (got ${String(ink)})`);
    }
  }
  return inks;
}

function centredText(
  ctx: CanvasRenderingContext2D,
  label: string,
  [x, y, w, h]: ScreenRect,
  colour: string,
): void {
  ctx.fillStyle = colour;
  ctx.font = '12px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + w / 2, y + h / 2, Math.max(0, w - 8));
  ctx.textAlign = 'start';
}

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
