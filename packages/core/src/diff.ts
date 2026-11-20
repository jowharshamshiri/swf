import type { Transform3D } from '@swf/math';
import type { EventPayload, NodeField, WorkspaceEventType } from './events.js';
import type { Id, NodeRecord, SceneState } from './model.js';

export interface PendingEvent<T extends WorkspaceEventType = WorkspaceEventType> {
  readonly type: T;
  readonly payload: EventPayload<T>;
}

function pending<T extends WorkspaceEventType>(type: T, payload: EventPayload<T>): PendingEvent {
  return { type, payload };
}

/**
 * The entity events that describe the change from `before` to `after`, derived from the records
 * themselves so a commit, an undo and a redo report the same way. `touched` lists the nodes that
 * may differ, in the order the change first touched them.
 */
export function diffScenes(
  before: SceneState,
  after: SceneState,
  touched: readonly Id[],
): PendingEvent[] {
  const events: PendingEvent[] = [];
  const childEvents: PendingEvent[] = [];
  for (const id of touched) {
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
    const fields = changedFields(a, b);
    if (fields.length > 0) {
      events.push(pending('node.updated', { nodeId: id, fields }));
    }
    if (a.status !== b.status) {
      events.push(
        pending(b.status === 'archived' ? 'node.archived' : 'node.restored', { nodeId: id }),
      );
    }
    if (!sameList(a.childIds, b.childIds)) {
      childEvents.push(pending('node.childrenChanged', { parentId: id, childIds: b.childIds }));
    }
  }
  if (!sameList(before.rootIds, after.rootIds)) {
    childEvents.push(pending('node.childrenChanged', { parentId: null, childIds: after.rootIds }));
  }
  events.push(...childEvents);
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

function changedFields(a: NodeRecord, b: NodeRecord): NodeField[] {
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
  if (a.metadata !== b.metadata && JSON.stringify(a.metadata) !== JSON.stringify(b.metadata)) {
    fields.push('metadata');
  }
  return fields;
}

export function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a === b || (a.length === b.length && a.every((v, i) => v === b[i]));
}

function sameTransform(a: Transform3D, b: Transform3D): boolean {
  return (
    a === b ||
    (sameList(a.position, b.position) &&
      sameList(a.rotation, b.rotation) &&
      sameList(a.scale, b.scale))
  );
}

function sameFlags(a: NodeRecord['flags'], b: NodeRecord['flags']): boolean {
  return (
    a === b || (Object.keys(a) as (keyof NodeRecord['flags'])[]).every((key) => a[key] === b[key])
  );
}
