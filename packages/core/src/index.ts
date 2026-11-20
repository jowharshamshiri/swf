/**
 * The Spatial Workspace Framework's scene kernel. It holds the canonical spatial state (nodes,
 * hierarchy, transforms, bounds, flags, surface associations, selection and focus) and changes it
 * only through atomic, revisioned transactions. It needs no DOM, renderer or UI framework.
 */
export type {
  ArchiveNodeCommand,
  AttachSurfaceCommand,
  CreateNodeCommand,
  DeleteMode,
  DeleteNodeCommand,
  DetachSurfaceCommand,
  DuplicateNodeCommand,
  EventSource,
  GroupNodesCommand,
  KeepMode,
  MetadataPatch,
  MoveSurfaceCommand,
  NodeSpec,
  PatchNodeCommand,
  PatchSurfaceCommand,
  RebindSurfaceCommand,
  ReorderNodeCommand,
  ReorderSurfaceCommand,
  ReparentNodeCommand,
  RestoreArchivedNodeCommand,
  SceneCommand,
  SceneCommandType,
  SetFocusCommand,
  SetSelectionCommand,
  SurfaceSpec,
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
export { makeError, SwfFailure } from './errors.js';
export type {
  BindingRef,
  CancelReason,
  EventOf,
  EventPayload,
  NodeField,
  OperationPhase,
  SurfaceField,
  WorkspaceEvent,
  WorkspaceEventType,
} from './events.js';
export type {
  GeometryDescriptor,
  GeometryFidelity,
  GeometryLimits,
  GeometryProvider,
  LocalHit,
  LocalRay,
  ResolvedGeometry,
  WorldHit,
} from './geometry.js';
export {
  DEFAULT_GEOMETRY_LIMITS,
  polygonGeometry,
  RECT_GEOMETRY,
  rectGeometry,
} from './geometry.js';
export type { JsonValue, Metadata } from './json.js';
export type {
  EntityFlags,
  Id,
  InteractionRegion,
  NodeRecord,
  NodeStatus,
  SceneState,
  SurfaceRecord,
} from './model.js';
export { DEFAULT_FLAGS } from './model.js';
export type { CoarseHit, EffectiveState, NodeQuery, SpatialQueryOptions } from './query.js';
export {
  ancestorIds,
  descendantIds,
  effectiveState,
  findNodes,
  nodesInBox,
  raycastBounds,
  surfaceEffectiveState,
  surfaceWorldMatrix,
  worldBounds,
  worldMatrix,
  worldTransform,
} from './query.js';
export type { RecordLookup, Table } from './table.js';
export { ADAPTER_TYPE_ID } from './validate.js';
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
  WorkspaceMutator,
  WorkspaceOptions,
  WorkspaceReader,
} from './workspace.js';
export { createWorkspace } from './workspace.js';
