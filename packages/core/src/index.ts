/**
 * The Spatial Workspace Framework's scene kernel. It holds the canonical spatial state (nodes,
 * hierarchy, transforms, bounds, flags, surface associations, cameras, viewports, selection and
 * focus) and changes it only through atomic, revisioned transactions. It needs no DOM, renderer or UI framework.
 */
export type {
  ArchiveNodeCommand,
  OperationType,
  AttachSurfaceCommand,
  CameraSpec,
  CreateCameraCommand,
  CreateViewportCommand,
  DeleteCameraCommand,
  DeleteViewportCommand,
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
  PatchCameraCommand,
  PatchNodeCommand,
  PatchSurfaceCommand,
  PatchViewportCommand,
  RebindSurfaceCommand,
  ReorderNodeCommand,
  ReorderSurfaceCommand,
  ReparentNodeCommand,
  RestoreArchivedNodeCommand,
  SceneCommand,
  SceneCommandType,
  SetFocusCommand,
  SetOrbitRootCommand,
  SetSelectionCommand,
  SurfaceSpec,
  UngroupNodeCommand,
  ViewportSpec,
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
  CameraField,
  CancelReason,
  EventOf,
  EventPayload,
  NodeField,
  OperationPhase,
  SurfaceField,
  ViewportField,
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
export { canonicalJson, jsonValue } from './json.js';
export type {
  CameraRecord,
  EntityFlags,
  Id,
  InteractionRegion,
  NavigationTarget,
  NodeRecord,
  NodeStatus,
  ProjectionSetting,
  SceneState,
  SurfaceRecord,
  ViewportRecord,
} from './model.js';
export type { ProjectionKind } from './projection-kinds.js';
export { DEFAULT_FLAGS } from './model.js';
export type { CoarseHit, EffectiveState, NodeQuery, SpatialQueryOptions } from './query.js';
export {
  ancestorIds,
  descendantIds,
  effectiveState,
  findNodes,
  nodeFrameGeometry,
  nodesInBox,
  raycastBounds,
  surfaceEffectiveState,
  surfaceWorldMatrix,
  worldBounds,
  worldMatrix,
  worldTransform,
} from './query.js';
export type { SceneSnapshot } from './snapshot.js';
export { SCENE_SNAPSHOT_FIELDS, serializeScene, validateSceneSnapshot } from './snapshot.js';
export type { RecordLookup, Table } from './table.js';
export { VERSIONED_ID } from './validate.js';
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
  RestoreOptions,
  WorkspacePersistence,
  WorkspaceReader,
} from './workspace.js';
export { createWorkspace } from './workspace.js';
