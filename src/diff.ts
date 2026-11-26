import type { Transform3D } from '@swf/math';
import type {
  CameraField,
  EventPayload,
  NodeField,
  SurfaceField,
  ViewportField,
  WorkspaceEventType,
} from './events.js';
import type {
  CameraRecord,
  EntityFlags,
  Id,
  NodeRecord,
  SceneState,
  SurfaceRecord,
  ViewportRecord,
} from './model.js';

export interface PendingEvent<T extends WorkspaceEventType = WorkspaceEventType> {
  readonly type: T;
  readonly payload: EventPayload<T>;
}

function pending<T extends WorkspaceEventType>(type: T, payload: EventPayload<T>): PendingEvent {
  return { type, payload };
}

/** The records a change may have touched, by kind, in the order it first touched them. */
export interface Touched {
  readonly nodes: readonly Id[];
  readonly surfaces: readonly Id[];
  readonly cameras: readonly Id[];
  readonly viewports: readonly Id[];
}

/**
 * The entity events that describe the change from `before` to `after`, derived from the records
 * themselves so a commit, an undo and a redo report the same way. Order: node events, surface
 * events, camera and viewport events, child and surface order changes, the orbit root, selection,
 * focus.
 */
export function diffScenes(
  before: SceneState,
  after: SceneState,
  touched: Touched,
): PendingEvent[] {
  const events: PendingEvent[] = [];
  const orderEvents: PendingEvent[] = [];
  for (const id of touched.nodes) {
    const a = before.nodes.get(id);
    const b = after.nodes.get(id);
    if (a === b) {
      continue;
    }
    if (a === undefined && b !== undefined) {
      events.push(pending('node.created', { nodeId: id, parentId: b.parentId }));
      continue;
    }
    if (a !== undefined && b === undefined) {
      events.push(pending('node.deleted', { nodeId: id, parentId: a.parentId }));
      continue;
    }
    if (a === undefined || b === undefined) {
      continue;
    }
    if (a.parentId !== b.parentId) {
      events.push(
        pending('node.reparented', {
          nodeId: id,
          fromParentId: a.parentId,
          toParentId: b.parentId,
        }),
      );
    }
    if (!sameTransform(a.transform, b.transform)) {
      events.push(
        pending('node.transformCommitted', {
          nodeId: id,
          previous: a.transform,
          transform: b.transform,
        }),
      );
    }
    const fields = changedNodeFields(a, b);
    if (fields.length > 0) {
      events.push(pending('node.updated', { nodeId: id, fields }));
    }
    if (a.status !== b.status) {
      events.push(
        pending(b.status === 'archived' ? 'node.archived' : 'node.restored', { nodeId: id }),
      );
    }
    if (!sameList(a.childIds, b.childIds)) {
      orderEvents.push(pending('node.childrenChanged', { parentId: id, childIds: b.childIds }));
    }
    if (!sameList(a.surfaceIds, b.surfaceIds)) {
      orderEvents.push(pending('node.surfacesChanged', { nodeId: id, surfaceIds: b.surfaceIds }));
    }
  }
  for (const id of touched.surfaces) {
    events.push(...surfaceEvents(id, before.surfaces.get(id), after.surfaces.get(id)));
  }
  for (const id of touched.cameras) {
    events.push(...cameraEvents(id, before.cameras.get(id), after.cameras.get(id)));
  }
  for (const id of touched.viewports) {
    events.push(...viewportEvents(id, before.viewports.get(id), after.viewports.get(id)));
  }
  if (!sameList(before.rootIds, after.rootIds)) {
    orderEvents.push(pending('node.childrenChanged', { parentId: null, childIds: after.rootIds }));
  }
  events.push(...orderEvents);
  if (before.orbitRootId !== after.orbitRootId) {
    events.push(
      pending('orbitRoot.changed', { nodeId: after.orbitRootId, previous: before.orbitRootId }),
    );
  }
  if (!sameList(before.selection, after.selection)) {
    events.push(
      pending('selection.changed', { selection: after.selection, previous: before.selection }),
    );
  }
  if (before.focusedId !== after.focusedId) {
    events.push(
      pending('focus.changed', { focusedId: after.focusedId, previous: before.focusedId }),
    );
  }
  return events;
}

function cameraEvents(
  id: Id,
  a: CameraRecord | undefined,
  b: CameraRecord | undefined,
): PendingEvent[] {
  if (a === b) {
    return [];
  }
  if (a === undefined) {
    return b === undefined ? [] : [pending('camera.created', { cameraId: id })];
  }
  if (b === undefined) {
    return [pending('camera.deleted', { cameraId: id })];
  }
  const fields: CameraField[] = [];
  if (!sameList(a.position, b.position)) {
    fields.push('position');
  }
  if (!sameList(a.rotation, b.rotation)) {
    fields.push('rotation');
  }
  if (a.near !== b.near) {
    fields.push('near');
  }
  if (a.far !== b.far) {
    fields.push('far');
  }
  if (a.label !== b.label) {
    fields.push('label');
  }
  if (!sameJson(a.metadata, b.metadata)) {
    fields.push('metadata');
  }
  return fields.length === 0 ? [] : [pending('camera.updated', { cameraId: id, fields })];
}

function viewportEvents(
  id: Id,
  a: ViewportRecord | undefined,
  b: ViewportRecord | undefined,
): PendingEvent[] {
  if (a === b) {
    return [];
  }
  if (a === undefined) {
    return b === undefined ? [] : [pending('viewport.created', { viewportId: id })];
  }
  if (b === undefined) {
    return [pending('viewport.deleted', { viewportId: id })];
  }
  const fields: ViewportField[] = [];
  for (const key of [
    'cameraId',
    'mode',
    'navigation',
    'renderer',
    'compositor',
    'label',
  ] as const) {
    if (a[key] !== b[key]) {
      fields.push(key);
    }
  }
  for (const key of ['projection', 'size', 'metadata'] as const) {
    if (!sameJson(a[key], b[key])) {
      fields.push(key);
    }
  }
  return fields.length === 0 ? [] : [pending('viewport.updated', { viewportId: id, fields })];
}

function surfaceEvents(
  id: Id,
  a: SurfaceRecord | undefined,
  b: SurfaceRecord | undefined,
): PendingEvent[] {
  if (a === b) {
    return [];
  }
  if (a === undefined) {
    return b === undefined
      ? []
      : [pending('surface.attached', { surfaceId: id, ownerNodeId: b.ownerNodeId })];
  }
  if (b === undefined) {
    return [pending('surface.detached', { surfaceId: id, ownerNodeId: a.ownerNodeId })];
  }
  const events: PendingEvent[] = [];
  if (a.ownerNodeId !== b.ownerNodeId) {
    events.push(
      pending('surface.moved', {
        surfaceId: id,
        fromOwnerId: a.ownerNodeId,
        toOwnerId: b.ownerNodeId,
      }),
    );
  }
  if (!sameTransform(a.transform, b.transform)) {
    events.push(
      pending('surface.transformCommitted', {
        surfaceId: id,
        previous: a.transform,
        transform: b.transform,
      }),
    );
  }
  if (a.bindingKey !== b.bindingKey || a.adapterTypeId !== b.adapterTypeId) {
    events.push(
      pending('surface.rebound', {
        surfaceId: id,
        previous: { bindingKey: a.bindingKey, adapterTypeId: a.adapterTypeId },
        binding: { bindingKey: b.bindingKey, adapterTypeId: b.adapterTypeId },
      }),
    );
  }
  const fields = changedSurfaceFields(a, b);
  if (fields.length > 0) {
    events.push(pending('surface.updated', { surfaceId: id, fields }));
  }
  return events;
}

function changedNodeFields(a: NodeRecord, b: NodeRecord): NodeField[] {
  const fields: NodeField[] = [];
  if (a.kind !== b.kind) {
    fields.push('kind');
  }
  if (!sameList(a.bounds, b.bounds)) {
    fields.push('bounds');
  }
  if (a.label !== b.label) {
    fields.push('label');
  }
  if (!sameList(a.tags, b.tags)) {
    fields.push('tags');
  }
  if (!sameFlags(a.flags, b.flags)) {
    fields.push('flags');
  }
  if (!sameJson(a.metadata, b.metadata)) {
    fields.push('metadata');
  }
  return fields;
}

function changedSurfaceFields(a: SurfaceRecord, b: SurfaceRecord): SurfaceField[] {
  const fields: SurfaceField[] = [];
  if (!sameList(a.bounds, b.bounds)) {
    fields.push('bounds');
  }
  if (!sameJson(a.geometry, b.geometry)) {
    fields.push('geometry');
  }
  if (a.interaction !== b.interaction) {
    fields.push('interaction');
  }
  if (!sameFlags(a.flags, b.flags)) {
    fields.push('flags');
  }
  if (a.label !== b.label) {
    fields.push('label');
  }
  if (!sameJson(a.metadata, b.metadata)) {
    fields.push('metadata');
  }
  return fields;
}

export function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a === b || (a.length === b.length && a.every((v, i) => v === b[i]));
}

function sameJson(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function sameTransform(a: Transform3D, b: Transform3D): boolean {
  return (
    a === b ||
    (sameList(a.position, b.position) &&
      sameList(a.rotation, b.rotation) &&
      sameList(a.scale, b.scale))
  );
}

function sameFlags(a: EntityFlags, b: EntityFlags): boolean {
  return a === b || (Object.keys(a) as (keyof EntityFlags)[]).every((key) => a[key] === b[key]);
}
