import type { Id, ResolvedGeometry, SceneCommand, Workspace } from '@swf/core';
import { createWorkspace } from '@swf/core';
import { quatFromAxisAngle } from '@swf/math';
import { createPresentationRegistry, viewGeometryOf } from '@swf/presentation';
import { describe, expect, it } from 'vitest';
import {
  cameraRotation,
  createProjectionRegistry,
  equirectangular,
  projectorOf,
} from '../src/index.js';

/** Six windows round the camera, three of them in a group, and a viewport looking at them. */
function scene(): Workspace {
  const ws = createWorkspace({ id: 'ws', now: () => 0 });
  createProjectionRegistry({
    kinds: ws.mutator(),
    projectors: createPresentationRegistry().registrar(),
  }).register(equirectangular);
  const window = (id: string, heading: number, parentId?: string): SceneCommand[] => [
    {
      type: 'node.create',
      node: {
        id,
        kind: 'window',
        ...(parentId === undefined ? {} : { parentId }),
        bounds: [1, 0.6, 0.01],
        transform: {
          position: [3 * Math.sin(heading), 0, -3 * Math.cos(heading)],
          rotation: quatFromAxisAngle([0, 1, 0], -heading),
          scale: [1, 1, 1],
        },
      },
    },
    {
      type: 'surface.attach',
      surface: {
        id: `${id}-s`,
        ownerNodeId: id,
        adapterTypeId: 'test/1',
        bindingKey: null,
        bounds: [0.9, 0.5, 0.01],
      },
    },
  ];
  const result = ws.transaction([
    { type: 'camera.create', camera: { id: 'cam' } },
    {
      type: 'viewport.create',
      viewport: {
        id: 'v',
        cameraId: 'cam',
        projection: { id: 'equirectangular/1', config: { horizontal: 360, vertical: 120 } },
        size: { width: 800, height: 400, devicePixelRatio: 1 },
      },
    },
    { type: 'node.create', node: { id: 'group', kind: 'group', bounds: [8, 8, 8] } },
    ...window('a', -1),
    ...window('b', 0),
    ...window('c', 1),
    ...window('d', 2, 'group'),
    ...window('e', 2.5, 'group'),
    ...window('f', 3, 'group'),
  ]);
  if (result.status !== 'committed') {
    throw new Error(JSON.stringify(result));
  }
  return ws;
}

const projector = projectorOf(equirectangular);

/** Projects the workspace's scene, counting which surfaces' geometry the projector asked for. */
function project(ws: Workspace, previous?: Parameters<typeof projector.project>[3]) {
  const asked: Id[] = [];
  const state = ws.getState();
  const geometry = (id: Id): ResolvedGeometry | undefined => {
    asked.push(id);
    return ws.surfaceGeometry(id);
  };
  const fragments = projector.project(state, viewGeometryOf(state, 'v'), geometry, previous);
  return { state, fragments, asked };
}

const move = (ws: Workspace, id: Id, heading: number) => {
  ws.dispatch({
    type: 'node.patch',
    id,
    transform: {
      position: [3 * Math.sin(heading), 0.2, -3 * Math.cos(heading)],
      rotation: quatFromAxisAngle([0, 1, 0], -heading),
      scale: [1, 1, 1],
    },
  });
};

describe('projecting only what changed (NFR-005, NFR-016, NFR-020)', () => {
  it('projects again only the surface of a window that moved, the rest as they were', () => {
    const ws = scene();
    const first = project(ws);
    expect(first.asked).toHaveLength(6);
    move(ws, 'b', 0.3);
    const next = project(ws, { scene: first.state, fragments: first.fragments });
    expect(next.asked).toEqual(['b-s']);
    // Exactly what projecting everything afresh gives.
    expect(next.fragments).toEqual(project(ws).fragments);
  });

  it('projects again every surface inside a group that moved', () => {
    const ws = scene();
    const first = project(ws);
    ws.dispatch({
      type: 'node.patch',
      id: 'group',
      transform: { position: [0, 0, 0], rotation: cameraRotation(0.2, 0), scale: [1, 1, 1] },
    });
    const next = project(ws, { scene: first.state, fragments: first.fragments });
    expect([...next.asked].sort()).toEqual(['d-s', 'e-s', 'f-s']);
    expect(next.fragments).toEqual(project(ws).fragments);
  });

  it('drops a surface that was hidden or removed, and projects one that was added', () => {
    const ws = scene();
    const first = project(ws);
    ws.transaction([
      { type: 'node.patch', id: 'a', flags: { visible: false } },
      { type: 'node.delete', id: 'c', mode: 'subtree' },
      ...[
        {
          type: 'node.create',
          node: {
            id: 'g',
            kind: 'window',
            bounds: [1, 0.6, 0.01],
            transform: { position: [0, 0, -2], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
          },
        } as SceneCommand,
        {
          type: 'surface.attach',
          surface: {
            id: 'g-s',
            ownerNodeId: 'g',
            adapterTypeId: 'test/1',
            bindingKey: null,
            bounds: [0.9, 0.5, 0.01],
          },
        } as SceneCommand,
      ],
    ]);
    const next = project(ws, { scene: first.state, fragments: first.fragments });
    expect(next.asked).toEqual(['g-s']);
    expect(next.fragments).toEqual(project(ws).fragments);
    expect(next.fragments.some((f) => f.surfaceId === 'a-s' || f.surfaceId === 'c-s')).toBe(false);
  });
});
