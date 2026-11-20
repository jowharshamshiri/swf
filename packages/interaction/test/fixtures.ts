import type { SceneCommand, Workspace, WorkspaceOptions } from '@swf/core';
import { createWorkspace, worldMatrix } from '@swf/core';
import type { Quat, Vec3 } from '@swf/math';
import { mat4TransformPoint, quatFromAxisAngle } from '@swf/math';
import { createPresentationRegistry } from '@swf/presentation';
import type { ProjectionRegistry } from '@swf/projections';
import { createProjectionRegistry, equirectangular, viewGeometryOf } from '@swf/projections';
import type {
  InteractionEvent,
  InteractionRouter,
  InteractionRouterOptions,
  SyntheticInput,
} from '../src/index.js';
import { createInteractionRouter, createSyntheticInput } from '../src/index.js';

export const W = 800;
export const H = 400;

/** A window: a node with one content surface inset from its frame. */
export interface WindowPlacement {
  readonly id: string;
  /** Radians right of -Z. */
  readonly heading: number;
  readonly distance: number;
  readonly y?: number;
  /** Frame size. Default [2, 1.2]. */
  readonly size?: readonly [number, number];
  /** How much smaller than the frame the surface is, each way. Default 0.4. */
  readonly inset?: number;
  readonly rotation?: Quat;
  readonly parentId?: string;
  readonly priority?: number;
  readonly interaction?: 'content' | 'none';
}

export function windowCommands(placements: readonly WindowPlacement[]): SceneCommand[] {
  return placements.flatMap((p): SceneCommand[] => {
    const [w, h] = p.size ?? [2, 1.2];
    return [
      {
        type: 'node.create',
        node: {
          id: p.id,
          kind: 'window',
          bounds: [w, h, 0.01],
          ...(p.parentId === undefined ? {} : { parentId: p.parentId }),
          ...(p.priority === undefined ? {} : { flags: { presentationPriority: p.priority } }),
          transform: {
            position: [
              p.distance * Math.sin(p.heading),
              p.y ?? 0,
              -p.distance * Math.cos(p.heading),
            ],
            rotation: p.rotation ?? quatFromAxisAngle([0, 1, 0], -p.heading),
            scale: [1, 1, 1],
          },
        },
      },
      {
        type: 'surface.attach',
        surface: {
          id: `${p.id}-view`,
          ownerNodeId: p.id,
          bindingKey: `key-${p.id}`,
          adapterTypeId: 'host.view/1',
          bounds: [w - (p.inset ?? 0.4), h - (p.inset ?? 0.4), 0.01],
          interaction: p.interaction ?? 'content',
        },
      },
    ];
  });
}

export interface World {
  readonly ws: Workspace;
  readonly projections: ProjectionRegistry;
  readonly router: InteractionRouter;
  readonly input: SyntheticInput;
  readonly events: InteractionEvent[];
}

/**
 * A workspace with the equirectangular projection, a camera at the origin, a viewport `v`
 * (800×400, 360°×120°), the given windows, and a router with synthetic input connected.
 */
export function world(
  placements: readonly WindowPlacement[],
  options: {
    readonly router?: Partial<Omit<InteractionRouterOptions, 'workspace' | 'projections'>>;
    readonly workspace?: Partial<WorkspaceOptions>;
    readonly extra?: readonly SceneCommand[];
  } = {},
): World {
  const ws = createWorkspace({ id: 'ws', ...options.workspace });
  const presentation = createPresentationRegistry();
  const projections = createProjectionRegistry({
    kinds: ws.mutator(),
    projectors: presentation.registrar(),
  });
  projections.register(equirectangular);
  const result = ws.transaction([
    { type: 'camera.create', camera: { id: 'cam' } },
    {
      type: 'viewport.create',
      viewport: {
        id: 'v',
        cameraId: 'cam',
        projection: { id: 'equirectangular/1', config: { horizontal: 360, vertical: 120 } },
        size: { width: W, height: H, devicePixelRatio: 1 },
      },
    },
    ...windowCommands(placements),
    ...(options.extra ?? []),
  ]);
  if (result.status !== 'committed') {
    throw new Error(`fixture failed: ${JSON.stringify(result)}`);
  }
  const router = createInteractionRouter({
    workspace: ws,
    projections,
    ...options.router,
    settings: { handlePx: 4, ...options.router?.settings },
  });
  const input = createSyntheticInput();
  router.registerInputAdapter(input);
  const events: InteractionEvent[] = [];
  router.subscribe((event) => events.push(event));
  return { ws, projections, router, input, events };
}

/** Where a world point appears in viewport `v` (its first image). */
export function screenOf(ws: Workspace, point: Vec3, viewportId = 'v'): [number, number] {
  const view = viewGeometryOf(ws.getState(), viewportId);
  const projection = equirectangular.create(view.projectionConfig);
  const eye: Vec3 = [view.camera[12], view.camera[13], view.camera[14]];
  const image = projection.projectDirection(
    [point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]],
    view,
  ).images[0];
  if (image === undefined) {
    throw new Error(`${JSON.stringify(point)} is not in view`);
  }
  return [image[0], image[1]];
}

/** A point on a window, in its local frame (x right, y up), placed in the world. */
export function onWindow(ws: Workspace, nodeId: string, local: Vec3): Vec3 {
  const m = worldMatrix(ws.getState().nodes, nodeId);
  if (m === undefined) {
    throw new Error(`no node ${nodeId}`);
  }
  return mat4TransformPoint(m, local);
}

/**
 * The screen point of a window's title bar: the frame between the top of its surface (0.2 below
 * the frame's edge) and the resize band along that edge.
 */
export function titleBar(ws: Workspace, nodeId: string): [number, number] {
  const node = ws.getState().nodes.get(nodeId);
  const h = node?.bounds[1] ?? 0;
  return screenOf(ws, onWindow(ws, nodeId, [0, h / 2 - 0.15, 0]));
}

/** The screen point of a window's content centre. */
export function contentOf(ws: Workspace, nodeId: string): [number, number] {
  return screenOf(ws, onWindow(ws, nodeId, [0, 0, 0]));
}
