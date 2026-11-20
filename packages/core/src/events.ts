import type { Transform3D } from '@swf/math';
import type { EventSource, SceneCommandType } from './commands.js';
import type { SwfError } from './errors.js';
import type { Id } from './model.js';

/** Where an operation stands. Previews are never persisted or undoable until committed. */
export type OperationPhase = 'requested' | 'preview' | 'committed' | 'rejected' | 'cancelled';

/** Why a preview (a gesture in progress) ended without committing. */
export type CancelReason =
  | 'escape'
  | 'capture-lost'
  | 'view-disposed'
  | 'target-detached'
  | 'constraint-rejected'
  | 'commit-rejected'
  /** A commit by someone else changed the scene so the preview's commands no longer apply. */
  | 'invalidated'
  | 'host'
  | 'workspace-disposed';

/** Node fields reported by `node.updated` (transform, parent and status have their own events). */
export type NodeField = 'bounds' | 'label' | 'tags' | 'flags' | 'metadata' | 'kind';

interface EventPayloads {
  /** The last event of every commit: one per committed revision. */
  'transaction.committed': {
    readonly transactionId: string;
    readonly previousRevision: number;
    readonly commandTypes: readonly SceneCommandType[];
    readonly changedNodeIds: readonly Id[];
    readonly createdIds: readonly Id[];
    readonly idempotencyKey: string | null;
    readonly previewId: string | null;
    /** Set when the commit is an undo or redo of an earlier transaction. */
    readonly history: { readonly action: 'undo' | 'redo'; readonly transactionId: string } | null;
  };
  'transaction.rejected': {
    readonly transactionId: string;
    readonly commandTypes: readonly SceneCommandType[];
    readonly error: SwfError;
  };
  'node.created': { readonly nodeId: Id; readonly parentId: Id | null };
  'node.deleted': { readonly nodeId: Id; readonly parentId: Id | null };
  'node.reparented': {
    readonly nodeId: Id;
    readonly fromParentId: Id | null;
    readonly toParentId: Id | null;
  };
  'node.transformCommitted': {
    readonly nodeId: Id;
    readonly previous: Transform3D;
    readonly transform: Transform3D;
  };
  'node.updated': { readonly nodeId: Id; readonly fields: readonly NodeField[] };
  'node.archived': { readonly nodeId: Id };
  'node.restored': { readonly nodeId: Id };
  /**
   * An existing parent's (or, for null, the root list's) children or their order changed. Not sent
   * for a parent created in the same commit: its children's `node.created` events name it.
   */
  'node.childrenChanged': { readonly parentId: Id | null; readonly childIds: readonly Id[] };
  'selection.changed': { readonly selection: readonly Id[]; readonly previous: readonly Id[] };
  'focus.changed': { readonly focusedId: Id | null; readonly previous: Id | null };
  /** A preview's proposed scene changed. Read it with `getPreview(previewId)`. */
  'transform.preview': { readonly previewId: string; readonly changedNodeIds: readonly Id[] };
  'preview.cancelled': { readonly previewId: string; readonly reason: CancelReason };
  'workspace.disposed': Readonly<Record<string, never>>;
}

export type WorkspaceEventType = keyof EventPayloads;

/** A typed notification. It describes what happened; it is not a command to anything else. */
export type WorkspaceEvent = {
  [T in WorkspaceEventType]: {
    /** Unique within the workspace, in delivery order. */
    readonly id: string;
    readonly type: T;
    readonly workspaceId: Id;
    /** The scene revision the event belongs to. */
    readonly revision: number;
    readonly timestamp: number;
    readonly source: EventSource;
    /** The transaction or operation that caused the event. */
    readonly causationId: string | null;
    readonly phase: OperationPhase;
    readonly payload: EventPayloads[T];
  };
}[WorkspaceEventType];

export type EventOf<T extends WorkspaceEventType> = Extract<WorkspaceEvent, { type: T }>;
export type EventPayload<T extends WorkspaceEventType> = EventPayloads[T];
