/**
 * The Spatial Workspace Framework's scene kernel. It holds the canonical spatial state (nodes,
 * hierarchy, transforms, bounds, flags, selection and focus) and changes it only through atomic,
 * revisioned transactions. It needs no DOM, renderer or UI framework.
 */
export type {
  ArchiveNodeCommand,
  CreateNodeCommand,
  DeleteMode,
  DeleteNodeCommand,
  DuplicateNodeCommand,
  EventSource,
  GroupNodesCommand,
  KeepMode,
  NodeSpec,
  PatchNodeCommand,
  ReorderNodeCommand,
  ReparentNodeCommand,
  RestoreArchivedNodeCommand,
  SceneCommand,
  SceneCommandType,
  SetFocusCommand,
  SetSelectionCommand,
  UngroupNodeCommand,
} from './commands.js';
export { SCENE_COMMAND_TYPES } from './commands.js';
export type {
  Axis,
  Constraint,
  ConstraintInput,
  ConstraintOptions,
  ConstraintOutcome,
} from './constraints.js';
export {
  axisLockConstraint,
  collisionSpacingConstraint,
  distanceConstraint,
  facePointConstraint,
  gridSnapConstraint,
  proposedWorldPosition,
  withWorldPosition,
  worldBoundsConstraint,
} from './constraints.js';
export type { SwfError, SwfErrorCode } from './errors.js';
export { SwfFailure } from './errors.js';
export type {
  CancelReason,
  EventOf,
  EventPayload,
  NodeField,
  OperationPhase,
  WorkspaceEvent,
  WorkspaceEventType,
} from './events.js';
export type { JsonValue, Metadata } from './json.js';
export type { Id, NodeFlags, NodeRecord, NodeStatus, SceneState } from './model.js';
export { DEFAULT_NODE_FLAGS } from './model.js';
export type { CoarseHit, EffectiveState, NodeQuery, SpatialQueryOptions } from './query.js';
export {
  ancestorIds,
  descendantIds,
  effectiveState,
  findNodes,
  nodesInBox,
  raycastBounds,
  worldBounds,
  worldMatrix,
  worldTransform,
} from './query.js';
export type { RecordLookup, Table } from './table.js';
export type {
  Diagnostic,
  HistoryEntry,
  Listener,
  PreviewApplied,
  PreviewOutcome,
  PreviewResult,
  Queued,
  TxCommitted,
  TxOptions,
  TxOutcome,
  TxRejected,
  TxResult,
  Workspace,
  WorkspaceLifecycle,
  WorkspaceOptions,
  WorkspaceReader,
} from './workspace.js';
export { createWorkspace } from './workspace.js';
