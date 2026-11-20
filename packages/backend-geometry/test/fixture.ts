import type { Id, SceneCommand, Workspace } from '@swf/core';
import { createWorkspace } from '@swf/core';
import { quatFromAxisAngle } from '@swf/math';
import type { CompositorCapabilities, RenderFrame, RendererCapabilities } from '@swf/presentation';
import { createPresentationRegistry, createViewOutput, planFrame } from '@swf/presentation';
import type { ProjectionRegistry } from '@swf/projections';
import {
  createProjectionRegistry,
  equirectangular,
  projectorOf,
  viewGeometryOf,
} from '@swf/projections';
import type { SurfaceCapabilities } from '@swf/surfaces';

export const W = 800;
export const H = 400;

/** What a surface's endpoint is in these scenes. */
export type Kind = 'live' | 'drawn' | 'proxied' | 'unbound';

export function capabilitiesOf(kind: Kind): SurfaceCapabilities | null {
  const base: SurfaceCapabilities = {
    attachStrategy: 'native-dom',
    nativeInteraction: 'full',
    uvAddressing: true,
    transformFidelity: 'approximate',
    transparency: false,
    clipping: true,
    cursorMapping: true,
    resize: 'intrinsic',
    viewportSharing: 'single-owner',
    safeDetach: true,
    rebinding: true,
    placeholder: false,
    snapshotHooks: false,
  };
  switch (kind) {
    case 'live':
      return base;
    case 'drawn':
      return {
        ...base,
        attachStrategy: 'drawable',
        nativeInteraction: 'none',
        transformFidelity: 'exact',
        viewportSharing: 'shared',
      };
    case 'proxied':
      return {
        ...base,
        attachStrategy: 'proxy-only',
        nativeInteraction: 'none',
        transformFidelity: 'proxy',
        uvAddressing: false,
        cursorMapping: false,
      };
    case 'unbound':
      return null;
  }
}

export interface Placed {
  readonly id: string;
  readonly kind: Kind;
  readonly heading: number;
  readonly distance: number;
  readonly y?: number;
  readonly size?: readonly [number, number];
  readonly label?: string;
}

/**
 * A workspace with the equirectangular projection, a camera at the origin and a viewport `v`
 * (800×400, `horizontal`×120°), holding one window per placement with one surface `<id>-s` the
 * size of its window.
 */
export function scene(
  placed: readonly Placed[],
  horizontal = 360,
): { ws: Workspace; projections: ProjectionRegistry; kinds: Map<Id, Kind> } {
  const ws = createWorkspace({ id: 'ws' });
  const projections = createProjectionRegistry({
    kinds: ws.mutator(),
    projectors: createPresentationRegistry().registrar(),
  });
  projections.register(equirectangular);
  const commands: SceneCommand[] = [
    { type: 'camera.create', camera: { id: 'cam' } },
    {
      type: 'viewport.create',
      viewport: {
        id: 'v',
        cameraId: 'cam',
        projection: { id: 'equirectangular/1', config: { horizontal, vertical: 120 } },
        size: { width: W, height: H, devicePixelRatio: 1 },
      },
    },
  ];
  for (const p of placed) {
    const [w, h] = p.size ?? [2, 1.2];
    commands.push(
      {
        type: 'node.create',
        node: {
          id: p.id,
          kind: 'window',
          bounds: [w, h, 0.01],
          ...(p.label === undefined ? {} : { label: p.label }),
          transform: {
            position: [
              p.distance * Math.sin(p.heading),
              p.y ?? 0,
              -p.distance * Math.cos(p.heading),
            ],
            rotation: quatFromAxisAngle([0, 1, 0], -p.heading),
            scale: [1, 1, 1],
          },
        },
      },
      {
        type: 'surface.attach',
        surface: {
          id: `${p.id}-s`,
          ownerNodeId: p.id,
          bindingKey: p.kind === 'unbound' ? null : `key-${p.id}`,
          adapterTypeId: 'test.view/1',
          bounds: [w, h, 0.01],
        },
      },
    );
  }
  const result = ws.transaction(commands);
  if (result.status !== 'committed') {
    throw new Error(`scene failed: ${JSON.stringify(result)}`);
  }
  return { ws, projections, kinds: new Map(placed.map((p) => [`${p.id}-s`, p.kind])) };
}

/**
 * Projects and plans viewport `v` for a renderer and a compositor of these capabilities; with
 * `reverse`, the projected fragments are supplied in reverse order.
 */
export function plan(
  ws: Workspace,
  projections: ProjectionRegistry,
  kinds: ReadonlyMap<Id, Kind>,
  renderer: { readonly id: string; readonly capabilities: RendererCapabilities },
  compositor: { readonly id: string; readonly capabilities: CompositorCapabilities },
  reverse = false,
): RenderFrame {
  const state = ws.getState();
  const view = viewGeometryOf(state, 'v');
  const module = projections.get(view.projectionId);
  if (module === undefined) {
    throw new Error('no projection');
  }
  const geometry = (id: Id) => ws.surfaceGeometry(id);
  return planFrame({
    scene: state,
    view,
    output: createViewOutput(
      state,
      'v',
      ordered(projectorOf(module).project(state, view, geometry), reverse),
    ),
    renderer,
    compositor,
    projection: module.profile,
    surfaceCapabilities: (id) => capabilitiesOf(kinds.get(id) ?? 'unbound'),
    viewportOwns: () => true,
    geometry,
  });
}

function ordered<T>(items: T[], reverse: boolean): T[] {
  return reverse ? [...items].reverse() : items;
}
