import type { Transform3D } from '@swf/math';
import type { EventSource, OperationType, SceneCommand } from './commands.js';
import type { SwfError } from './errors.js';
import type { Id } from './model.js';
/** Where an operation stands. Previews are never persisted or undoable until committed. */
export type OperationPhase = 'requested' | 'preview' | 'committed' | 'rejected' | 'cancelled';
/** Why a preview (a gesture in progress) ended without committing. */
export type CancelReason = 
/** The operator pressed Escape. */
'escape'
/** The pointer capture the gesture relied on was lost. */
 | 'capture-lost'
/** The view the gesture ran in was disposed. */
 | 'view-disposed'
/** A commit removed an entity the preview's commands name. */
 | 'target-detached'
/** A required constraint refused the preview's placement after a commit, or its own commit. */
 | 'constraint-rejected'
/** The transaction that was to commit the preview was rejected. */
 | 'commit-rejected'
/** A commit by someone else changed the scene so the preview's commands no longer apply. */
 | 'invalidated'
/** The host ended it. */
 | 'host'
/** The workspace was disposed while the preview was open. */
 | 'workspace-disposed';
/** Node fields reported by `node.updated` (transform, parent and status have their own events). */
export type NodeField = 'bounds' | 'label' | 'tags' | 'flags' | 'metadata' | 'kind';
/**
 * Surface fields reported by `surface.updated` (transform, owner and binding have their own
 * events).
 */
export type SurfaceField = 'bounds' | 'geometry' | 'interaction' | 'flags' | 'label' | 'metadata';
/** Camera fields reported by `camera.updated`. */
export type CameraField = 'position' | 'rotation' | 'near' | 'far' | 'label' | 'metadata';
/** Viewport fields reported by `viewport.updated`. */
export type ViewportField = 'cameraId' | 'projection' | 'mode' | 'size' | 'navigation' | 'renderer' | 'compositor' | 'label' | 'metadata';
/** Which endpoint a surface association names. */
export interface BindingRef {
    /** The host's opaque key for the endpoint, or null when none is assigned. */
    readonly bindingKey: string | null;
    /** The adapter type that resolves the key, as `<name>/<version>`. */
    readonly adapterTypeId: string;
}
/**
 * The payload of each workspace event, by event type. A payload is shared with every listener and
 * may share arrays and records with the scene: listeners read it and must not change it.
 */
export interface EventPayloads {
    /** The last event of every commit: one per committed revision. */
    'transaction.committed': {
        /** The committed transaction, unique within the workspace. */
        readonly transactionId: string;
        /** The revision before the commit; the event's own `revision` is the one it made. */
        readonly previousRevision: number;
        /** The operations committed, in order; an undo or redo repeats the original's. */
        readonly commandTypes: readonly OperationType[];
        /** Nodes created, changed or removed, in the order they were first touched. */
        readonly changedNodeIds: readonly Id[];
        /** Surfaces created, changed or removed, in the order they were first touched. */
        readonly changedSurfaceIds: readonly Id[];
        /** Nodes and surfaces the commit created. */
        readonly createdIds: readonly Id[];
        /** The idempotency key the transaction was given, or null. */
        readonly idempotencyKey: string | null;
        /** The preview the transaction committed, or null. */
        readonly previewId: string | null;
        /** Set when the commit is an undo or redo of an earlier transaction. */
        readonly history: {
            /** Which way the history moved. */
            readonly action: 'undo' | 'redo';
            /** The transaction undone or redone. */
            readonly transactionId: string;
        } | null;
        /**
         * The commands committed, as the caller gave them, for tracing; null for an undo, redo or
         * restore, which carry none of their own. Listeners must not change them.
         */
        readonly commands: readonly SceneCommand[] | null;
        /** How long the transaction took, by the workspace's timer, in milliseconds. */
        readonly durationMs: number;
    };
    /**
     * A transaction, undo, redo or restore was refused; the scene is unchanged. Not sent for a
     * rejected preview, nor once the workspace is disposing.
     */
    'transaction.rejected': {
        /** The refused transaction. */
        readonly transactionId: string;
        /** The recognised operation types among the commands it was given, in order. */
        readonly commandTypes: readonly OperationType[];
        /** Why it was refused, as the rejected result reports it. */
        readonly error: SwfError;
        /** How long it took to be refused, by the workspace's timer, in milliseconds. */
        readonly durationMs: number;
    };
    /** A node was added to the scene. */
    'node.created': {
        /** The new node. */
        readonly nodeId: Id;
        /** Its parent, or null for a root. */
        readonly parentId: Id | null;
    };
    /** A node was removed from the scene, with its surface associations. */
    'node.deleted': {
        /** The removed node. */
        readonly nodeId: Id;
        /** The parent it had, or null for a root. */
        readonly parentId: Id | null;
    };
    /** A node moved to another parent. */
    'node.reparented': {
        /** The moved node. */
        readonly nodeId: Id;
        /** The parent it left, or null for the roots. */
        readonly fromParentId: Id | null;
        /** The parent it joined, or null for the roots. */
        readonly toParentId: Id | null;
    };
    /** A node's local transform changed in a commit. */
    'node.transformCommitted': {
        /** The node. */
        readonly nodeId: Id;
        /** Its local transform before the commit. */
        readonly previous: Transform3D;
        /** Its local transform after the commit. */
        readonly transform: Transform3D;
    };
    /** Descriptive or extent fields of a node changed. */
    'node.updated': {
        /** The node. */
        readonly nodeId: Id;
        /** The fields that changed. */
        readonly fields: readonly NodeField[];
    };
    /** A node was archived: it keeps its ID and layout but leaves the active scene. */
    'node.archived': {
        /** The node. */
        readonly nodeId: Id;
    };
    /** An archived node was restored to the active scene. */
    'node.restored': {
        /** The node. */
        readonly nodeId: Id;
    };
    /**
     * An existing parent's (or, for null, the root list's) children or their order changed. Not sent
     * for a parent created in the same commit: its children's `node.created` events name it.
     */
    'node.childrenChanged': {
        /** The parent, or null for the root list. */
        readonly parentId: Id | null;
        /** Its children after the change, in presentation order. */
        readonly childIds: readonly Id[];
    };
    /** An existing node's surfaces or their order changed (not sent for a node created alongside). */
    'node.surfacesChanged': {
        /** The node. */
        readonly nodeId: Id;
        /** Its surfaces after the change, in presentation order. */
        readonly surfaceIds: readonly Id[];
    };
    /** A surface association was added. */
    'surface.attached': {
        /** The new surface. */
        readonly surfaceId: Id;
        /** The node that holds it. */
        readonly ownerNodeId: Id;
    };
    /** The association was removed; the endpoint itself is the host's and was not touched. */
    'surface.detached': {
        /** The removed surface. */
        readonly surfaceId: Id;
        /** The node that held it. */
        readonly ownerNodeId: Id;
    };
    /** A surface moved to another node. */
    'surface.moved': {
        /** The moved surface. */
        readonly surfaceId: Id;
        /** The node it left. */
        readonly fromOwnerId: Id;
        /** The node it joined. */
        readonly toOwnerId: Id;
    };
    /** A surface's transform relative to its owner changed in a commit. */
    'surface.transformCommitted': {
        /** The surface. */
        readonly surfaceId: Id;
        /** Its transform before the commit. */
        readonly previous: Transform3D;
        /** Its transform after the commit. */
        readonly transform: Transform3D;
    };
    /** The surface now names another endpoint (or none); its ID, placement and order are kept. */
    'surface.rebound': {
        /** The surface. */
        readonly surfaceId: Id;
        /** The endpoint it named before. */
        readonly previous: BindingRef;
        /** The endpoint it names now. */
        readonly binding: BindingRef;
    };
    /** Descriptive, extent or geometry fields of a surface changed. */
    'surface.updated': {
        /** The surface. */
        readonly surfaceId: Id;
        /** The fields that changed. */
        readonly fields: readonly SurfaceField[];
    };
    /** A camera was added. */
    'camera.created': {
        /** The new camera. */
        readonly cameraId: Id;
    };
    /** A camera moved, turned or changed its visibility settings: view state only. */
    'camera.updated': {
        /** The camera. */
        readonly cameraId: Id;
        /** The fields that changed. */
        readonly fields: readonly CameraField[];
    };
    /** A camera was removed. */
    'camera.deleted': {
        /** The removed camera. */
        readonly cameraId: Id;
    };
    /** A viewport was added. */
    'viewport.created': {
        /** The new viewport. */
        readonly viewportId: Id;
    };
    /** A viewport's camera, projection, mode, size or preferences changed: view state only. */
    'viewport.updated': {
        /** The viewport. */
        readonly viewportId: Id;
        /** The fields that changed. */
        readonly fields: readonly ViewportField[];
    };
    /** A viewport was removed. */
    'viewport.deleted': {
        /** The removed viewport. */
        readonly viewportId: Id;
    };
    /** The node that workspace orbit rotates changed, including to or from none. */
    'orbitRoot.changed': {
        /** The orbit root now, or null for none. */
        readonly nodeId: Id | null;
        /** The orbit root before, or null for none. */
        readonly previous: Id | null;
    };
    /** The selection changed, in membership or order. */
    'selection.changed': {
        /** The selected nodes now, in selection order. */
        readonly selection: readonly Id[];
        /** The selected nodes before. */
        readonly previous: readonly Id[];
    };
    /** The focused node changed. */
    'focus.changed': {
        /** The focused node now, or null for none. */
        readonly focusedId: Id | null;
        /** The focused node before, or null for none. */
        readonly previous: Id | null;
    };
    /** A preview's proposed scene changed. Read it with `getPreview(previewId)`. */
    'transform.preview': {
        /** The preview. */
        readonly previewId: string;
        /**
         * Nodes the preview's commands create, change or remove. When events are coalesced to frame
         * boundaries, every such node since the preview's last delivered event.
         */
        readonly changedNodeIds: readonly Id[];
        /** Surfaces the preview's commands create, change or remove, coalesced the same way. */
        readonly changedSurfaceIds: readonly Id[];
    };
    /** A preview ended without committing; its proposed scene is gone. */
    'preview.cancelled': {
        /** The preview. */
        readonly previewId: string;
        /** Why it ended. */
        readonly reason: CancelReason;
    };
    /**
     * The workspace is being disposed: the last event it delivers. Listeners are released after
     * it.
     */
    'workspace.disposed': Readonly<Record<string, never>>;
}
/** The type of a workspace event: one key of {@link EventPayloads}. */
export type WorkspaceEventType = keyof EventPayloads;
/**
 * A typed notification. It describes what happened; it is not a command to anything else. The
 * event object is frozen. Events are delivered synchronously, in the order they happened, once
 * the operation that caused them has finished: a commit's entity events come first, then its
 * `transaction.committed`. With a `frameBoundary` option, `transform.preview` events are held
 * until the next boundary instead, still in order with every other event.
 */
export type WorkspaceEvent = {
    [T in WorkspaceEventType]: {
        /** Unique within the workspace, in delivery order. */
        readonly id: string;
        /** What happened; it decides the payload's shape. */
        readonly type: T;
        /** The workspace that sent the event. */
        readonly workspaceId: Id;
        /** The scene revision the event belongs to. */
        readonly revision: number;
        /**
         * When the operation that sent the event happened, by the workspace's clock, in milliseconds:
         * the clock is read once as an operation begins, so every event of one operation carries the
         * same time.
         */
        readonly timestamp: number;
        /** Who originated the operation that caused the event. */
        readonly source: EventSource;
        /**
         * What caused the event: the host's `causeId` for the operation, or the operation's own ID
         * without one. Every event of a commit (its entity events and `transaction.committed`) and a
         * refusal's `transaction.rejected` carry the transaction's cause or ID; every
         * `transform.preview` and `preview.cancelled` carries its preview's cause or ID, even when
         * a commit or the disposal sends it. `workspace.disposed` carries null.
         */
        readonly causationId: string | null;
        /** Where the operation stood when the event was made. */
        readonly phase: OperationPhase;
        /** What happened, in detail: see {@link EventPayloads}. */
        readonly payload: EventPayloads[T];
    };
}[WorkspaceEventType];
/** The workspace event of one type, with its payload narrowed to that type's. */
export type EventOf<T extends WorkspaceEventType> = Extract<WorkspaceEvent, {
    /** The event type to narrow to. */
    type: T;
}>;
/** The payload of one event type. */
export type EventPayload<T extends WorkspaceEventType> = EventPayloads[T];
//# sourceMappingURL=events.d.ts.map