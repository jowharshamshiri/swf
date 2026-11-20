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
  ViewGeometry,
} from '@swf/presentation';
import { PRESENTATION_API_VERSION, viewGeometryIssue } from '@swf/presentation';
import type { Projection, ProjectionModule } from '@swf/projections';
import { projectionFor } from '@swf/projections';
import type { Drawable, Mesh } from './drawing.js';
import { drawableIssue, drawMesh, homographyMesh, outline } from './drawing.js';
import type { GeometryLayer } from './layer.js';
import { GEOMETRY_LAYER } from './layer.js';
import { planeMesh, planeOutline } from './sampling.js';

export const GEOMETRY_RENDERER_ID = 'swf.geometry-renderer/1';

export interface GeometryRendererOptions {
  /**
   * The drawable an adapter supplies for a surface, for surfaces presented as drawn content
   * (typically the surface runtime's handle of a `drawable` adapter).
   */
  readonly drawables?: (surfaceId: Id) => unknown;
  /**
   * The projection modules views use. With them the renderer follows each view's projection
   * point by point (mesh warping), and draws window chrome and indicators for windows out of
   * view; without them it places drawn content by its projected corners only.
   */
  readonly projections?: { get(id: string): ProjectionModule | undefined };
  /** Cells per side of the mesh a drawable is warped with. Default 12. */
  readonly meshCells?: number;
}

/**
 * A renderer that draws: adapter-supplied drawables, proxies, placeholders, window chrome and
 * spatial indicators, each a layer of drawing commands in viewport pixels. It never reads pixels
 * back. It cannot present live elements; with nothing else, those are shown as proxies.
 */
export class GeometryRenderer implements RendererBackend {
  readonly id = GEOMETRY_RENDERER_ID;
  readonly apiVersion = PRESENTATION_API_VERSION;
  readonly #options: GeometryRendererOptions;
  readonly #cells: number;

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

export class GeometryRendererSession implements RendererSession {
  readonly rendererId: string;
  readonly viewportId: Id;
  readonly #options: GeometryRendererOptions;
  readonly #cells: number;
  #released = false;

  constructor(rendererId: string, viewportId: Id, options: GeometryRendererOptions, cells: number) {
    this.rendererId = rendererId;
    this.viewportId = viewportId;
    this.#options = options;
    this.#cells = cells;
  }

  render(frame: RenderFrame): RenderedFrame {
    return this.renderExcept(frame, new Set());
  }

  /**
   * Renders every planned fragment except the live ones listed, which another renderer realizes
   * (see {@link LayeredRenderer}); window chrome still stacks with them in plan order.
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
    if (frame.viewportId !== this.viewportId) {
      throw new SwfFailure(
        makeError(
          'INVALID_INPUT',
          `a frame for viewport "${frame.viewportId}" was given to viewport "${this.viewportId}"`,
        ),
      );
    }
    const projection = this.#projection(frame.view);
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
    });
  }

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
    let draw: (ctx: CanvasRenderingContext2D) => void;
    switch (category) {
      case 'content-raster': {
        const drawable = this.#drawable(fragment.surfaceId);
        const mesh = this.#mesh(frame, fragment, drawable, projection);
        draw = (ctx) => {
          clipTo(ctx, fragment.bounds);
          drawMesh(ctx, drawable, mesh);
        };
        break;
      }
      case 'proxy':
        draw = (ctx) => {
          clipTo(ctx, fragment.bounds);
          outline(ctx, fragment.corners ?? rectQuad(fragment.bounds));
          ctx.fillStyle = 'rgba(96, 112, 140, 0.85)';
          ctx.fill();
          ctx.strokeStyle = 'rgb(48, 56, 72)';
          ctx.lineWidth = 1;
          ctx.stroke();
          text(ctx, label, fragment.bounds, 'rgb(255, 255, 255)');
        };
        break;
      case 'placeholder':
        draw = (ctx) => {
          clipTo(ctx, fragment.bounds);
          outline(ctx, fragment.corners ?? rectQuad(fragment.bounds));
          ctx.fillStyle = 'rgba(200, 200, 200, 0.6)';
          ctx.fill();
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = 'rgb(90, 90, 90)';
          ctx.stroke();
          text(ctx, label, fragment.bounds, 'rgb(40, 40, 40)');
          text(ctx, 'Not presented', shift(fragment.bounds, 16), 'rgb(40, 40, 40)');
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
    return Object.freeze({
      id: `${category}:${fragment.id}`,
      category,
      fragmentId: fragment.id,
      surfaceId: fragment.surfaceId,
      content: layer(null, draw),
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
    const owner = frame.planned.find(
      (p) =>
        scene.surfaces.get(p.fragment.surfaceId)?.ownerNodeId === nodeId && p.fragment.nativeOwner,
    );
    if (node === undefined || geometry === undefined || owner === undefined) {
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
    return Object.freeze({
      id: `chrome:${nodeId}`,
      category: 'chrome',
      fragmentId: null,
      surfaceId: null,
      content: layer(after, (ctx) => {
        outline(ctx, points);
        ctx.strokeStyle = focused
          ? 'rgb(255, 196, 0)'
          : selected
            ? 'rgb(0, 120, 215)'
            : 'rgb(70, 70, 70)';
        ctx.lineWidth = selected || focused ? 3 : 1.5;
        ctx.stroke();
        const [tx, ty] = points[0] ?? [0, 0];
        ctx.fillStyle = 'rgb(30, 30, 30)';
        ctx.font = '12px sans-serif';
        ctx.textBaseline = 'bottom';
        // Text drawn on a canvas is only ever text.
        ctx.fillText(label, tx, ty - 3);
        if (handles) {
          ctx.fillStyle = 'rgb(0, 120, 215)';
          for (const [x, y] of corners) {
            ctx.fillRect(x - 4, y - 4, 8, 8);
          }
        }
      }),
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
    return Object.freeze({
      id: 'overlay:indicators',
      category: 'overlay',
      fragmentId: null,
      surfaceId: null,
      content: layer(null, (ctx) => {
        for (const { at, toward, label } of marks) {
          const [x, y] = at;
          const [dx, dy] = toward;
          ctx.beginPath();
          ctx.moveTo(x + dx * 10, y + dy * 10);
          ctx.lineTo(x - dy * 6, y + dx * 6);
          ctx.lineTo(x + dy * 6, y - dx * 6);
          ctx.closePath();
          ctx.fillStyle = 'rgb(0, 120, 215)';
          ctx.fill();
          ctx.font = '11px sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, x - dx * 40 - 20, y - dy * 14);
        }
      }),
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
