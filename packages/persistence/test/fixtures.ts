import type { SceneCommand, Workspace } from '@swf/core';
import { createWorkspace } from '@swf/core';
import { quatFromAxisAngle } from '@swf/math';
import type { Persistence, PersistenceOptions, WorkspaceDocument } from '../src/index.js';
import { createPersistence } from '../src/index.js';

export const PANORAMA = { id: 'test.pano/1', configIssue: () => null };

/** A workspace at the given clock with the test projection kind. */
export function workspace(now = () => 1000): Workspace {
  return createWorkspace({ id: 'ws', now, projectionKinds: [PANORAMA] });
}

export function commit(ws: Workspace, commands: readonly SceneCommand[]): void {
  const result = ws.transaction(commands);
  if (result.status !== 'committed') {
    throw new Error(`fixture failed: ${JSON.stringify(result)}`);
  }
}

/**
 * A layout with what a snapshot holds: a hierarchy, surfaces with binding keys, metadata, a
 * camera and a viewport, the orbit root and focus.
 */
export function layout(ws: Workspace = workspace()): Workspace {
  commit(ws, [
    {
      type: 'node.create',
      node: {
        id: 'a',
        kind: 'window',
        bounds: [1.6, 0.9, 0.01],
        label: 'Notes',
        tags: ['pinned'],
        metadata: { 'host.colour': 'teal' },
        transform: {
          position: [-1, 0.2, -3],
          rotation: quatFromAxisAngle([0, 1, 0], 0.4),
          scale: [1, 1, 1],
        },
      },
    },
    {
      type: 'node.create',
      node: { id: 'b', kind: 'window', parentId: 'a', bounds: [0.8, 0.5, 0.01] },
    },
    {
      type: 'surface.attach',
      surface: {
        id: 'a-s',
        ownerNodeId: 'a',
        bindingKey: 'editor-42',
        adapterTypeId: 'host.editor/1',
        bounds: [1.4, 0.7, 0.01],
      },
    },
    { type: 'camera.create', camera: { id: 'cam', position: [0, 1.6, 0] } },
    {
      type: 'viewport.create',
      viewport: {
        id: 'v',
        cameraId: 'cam',
        projection: { id: 'test.pano/1', config: { horizontal: 360, vertical: 120 } },
        size: { width: 1600, height: 800, devicePixelRatio: 2 },
      },
    },
    { type: 'orbitRoot.set', nodeId: 'a' },
    { type: 'focus.set', id: 'a' },
  ]);
  return ws;
}

export function persistenceOf(
  ws: Workspace,
  options: Omit<PersistenceOptions, 'workspace'> = {},
): Persistence {
  return createPersistence({ workspace: ws.persistence(), now: () => 5000, ...options });
}

/** A document as plain data, to change on purpose. */
export function plain(document: WorkspaceDocument): Record<string, unknown> {
  return JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
}

export const REMOVE = Symbol('remove');

/** A copy of a document with values at dot-separated paths replaced, or removed. */
export function edited(
  document: WorkspaceDocument,
  ...edits: (readonly [string, unknown])[]
): Record<string, unknown> {
  const out = plain(document);
  for (const [path, value] of edits) {
    const keys = path.split('.');
    const last = keys.pop() ?? '';
    let at = out;
    for (const key of keys) {
      at = at[key] as Record<string, unknown>;
    }
    if (value === REMOVE) {
      Reflect.deleteProperty(at, last);
    } else {
      at[last] = value;
    }
  }
  return out;
}

/** Lets pending promises and timers run. */
export const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, 0);
  });
