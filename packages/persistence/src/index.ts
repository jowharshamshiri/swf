/**
 * Persistence for the Spatial Workspace Framework: versioned, canonical workspace snapshots with
 * a published JSON Schema and a validator that rejects malformed, oversized, non-finite, cyclic and
 * prototype-polluting input by path; policy parameters and opaque, namespaced, size-limited
 * extension state; a replaceable storage interface with an in-memory store; and the save state
 * machine. Snapshots hold layout only: never runtime handles, elements, callbacks or content.
 */
export type { ExtensionEntry, SnapshotLimits, WorkspaceDocument } from './document.js';
export {
  DEFAULT_SNAPSHOT_LIMITS,
  exportDocument,
  NAMESPACE,
  parseDocument,
  SNAPSHOT_ENGINE,
  SNAPSHOT_SCHEMA,
  SNAPSHOT_SCHEMA_ID,
  snapshotLimits,
  utf8Length,
  validateDocument,
} from './document.js';
export type {
  Capture,
  CaptureFailure,
  HookContext,
  Persistence,
  PersistenceDiagnostic,
  PersistenceExtension,
  PersistenceOptions,
  PolicySource,
} from './persistence.js';
export { createPersistence } from './persistence.js';
export type { SaveOutcome, Saver, SaverOptions, SaveState } from './saver.js';
export { createSaver } from './saver.js';
export type {
  MemoryStoreOptions,
  SaveAck,
  SaveRequest,
  SnapshotEntry,
  SnapshotStore,
  StoredSnapshot,
  StoreGuarantees,
} from './store.js';
export { createMemoryStore } from './store.js';
