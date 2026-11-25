/**
 * Persistence for the Spatial Workspace Framework: versioned, canonical workspace snapshots with
 * a published JSON Schema and a validator that rejects malformed, oversized, non-finite, cyclic and
 * prototype-polluting input by path; policy parameters and opaque, namespaced, size-limited
 * extension state; a replaceable storage interface with an in-memory store; and the save state
 * machine. Snapshots hold layout only: never runtime handles, elements, callbacks or content.
 */
export type {
  Handler as IdbHandler,
  IdbDatabase,
  IdbError,
  IdbFactory,
  IdbObjectStore,
  IdbOpenRequest,
  IdbRequest,
  IdbTransaction,
  IndexedDbStoreOptions,
  WebStorage,
  WebStorageStoreOptions,
} from './browser.js';
export { createIndexedDbStore, createWebStorageStore } from './browser.js';
export type { ExtensionEntry, SnapshotLimits, WorkspaceDocument } from './document.js';
export {
  DEFAULT_SNAPSHOT_LIMITS,
  exportDocument,
  NAMESPACE,
  parseDocument,
  parseJson,
  SNAPSHOT_ENGINE,
  SNAPSHOT_SCHEMA,
  SNAPSHOT_SCHEMA_ID,
  snapshotLimits,
  utf8Length,
  validateDocument,
} from './document.js';
export type { Migrated, MigrationStep, SchemaMigration } from './migrations.js';
export { migrateDocument, SNAPSHOT_MIGRATIONS } from './migrations.js';
export type { JsonSyntaxError } from './syntax.js';
export { jsonSyntaxError } from './syntax.js';
export type {
  Capture,
  CaptureFailure,
  HookContext,
  Persistence,
  PersistenceDiagnostic,
  PersistenceExtension,
  PersistenceOptions,
  PolicySource,
  RestoreFailure,
  RestoreOutcome,
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
