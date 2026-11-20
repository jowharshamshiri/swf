import type { JsonValue, ResolvedGeometry, SceneCommand, Workspace } from '@swf/core';
import { createWorkspace } from '@swf/core';
import type { Quat, Vec3 } from '@swf/math';
import { IDENTITY_QUAT, mat4FromTransform, quatFromAxisAngle } from '@swf/math';
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
  readonly config?: { horizontal: number; vertical: number };
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

/** A flat surface of the given size facing the origin from a heading and height, at a distance. */
export interface Placement {
  readonly id: string;
  /** Radians right of -Z. */
  readonly heading: number;
  readonly distance: number;
  readonly y?: number;
  readonly size?: readonly [number, number];
  /** Overrides the facing rotation. */
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
            rotation: p.rotation ?? quatFromAxisAngle([0, 1, 0], -p.heading),
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

/** The resolved geometry of one placed surface. */
export function geometryOf(placement: Placement): ResolvedGeometry {
  const g = placed([placement]).surfaceGeometry(placement.id);
  if (g === undefined) {
    throw new Error('no geometry');
  }
  return g;
}
