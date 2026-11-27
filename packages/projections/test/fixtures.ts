import type { JsonValue, SceneCommand, Workspace } from '@swf/core';
import { createWorkspace } from '@swf/core';
import type { Quat, Vec3 } from '@swf/math';
import { IDENTITY_QUAT, mat4FromTransform } from '@swf/math';
import type { ViewGeometry } from '@swf/presentation';
import type { Projection } from '../src/index.js';
import { equirectangular } from '../src/index.js';

export const W = 800;
export const H = 400;

export interface ViewOptions {
  readonly width?: number;
  readonly height?: number;
  readonly rotation?: Quat;
  readonly position?: Vec3;
  readonly near?: number;
  readonly far?: number | null;
  readonly config?: { horizontal: number; vertical: number; horizon?: number };
}

/** An equirectangular projection and a view using it. */
export function setup(options: ViewOptions = {}): { projection: Projection; view: ViewGeometry } {
  const config: JsonValue = options.config ?? { horizontal: 360, vertical: 120 };
  return {
    projection: equirectangular.create(config),
    view: {
      viewportId: 'v',
      width: options.width ?? W,
      height: options.height ?? H,
      devicePixelRatio: 1,
      camera: mat4FromTransform({
        position: options.position ?? [0, 0, 0],
        rotation: options.rotation ?? IDENTITY_QUAT,
        scale: [1, 1, 1],
      }),
      near: options.near ?? 0.05,
      far: options.far ?? null,
      projectionId: 'equirectangular/1',
      projectionConfig: config,
    },
  };
}

/** A window of the given size at a heading and height, its distance out along the floor, upright. */
export interface Placement {
  readonly id: string;
  /** Radians right of -Z. */
  readonly heading: number;
  readonly distance: number;
  readonly y?: number;
  readonly size?: readonly [number, number];
  /** A rotation of the window's own, which a card does not show. Default none. */
  readonly rotation?: Quat;
}

export function placedCommands(placements: readonly Placement[]): SceneCommand[] {
  return placements.flatMap((p): SceneCommand[] => {
    const [w, h] = p.size ?? [1, 1];
    return [
      {
        type: 'node.create',
        node: {
          id: `n-${p.id}`,
          kind: 'window',
          bounds: [w, h, 0.01],
          transform: {
            position: [
              p.distance * Math.sin(p.heading),
              p.y ?? 0,
              -p.distance * Math.cos(p.heading),
            ],
            rotation: p.rotation ?? IDENTITY_QUAT,
            scale: [1, 1, 1],
          },
        },
      },
      {
        type: 'surface.attach',
        surface: {
          id: p.id,
          ownerNodeId: `n-${p.id}`,
          bindingKey: `key-${p.id}`,
          adapterTypeId: 'host.view/1',
          bounds: [w, h, 0.01],
        },
      },
    ];
  });
}

/** A workspace holding the placed surfaces. */
export function placed(
  placements: readonly Placement[],
  options: Parameters<typeof createWorkspace>[0] = { id: 'ws' },
): Workspace {
  const ws = createWorkspace(options);
  const result = ws.transaction(placedCommands(placements));
  if (result.status !== 'committed') {
    throw new Error(`fixture failed: ${JSON.stringify(result)}`);
  }
  return ws;
}
