/**
 * Diagnostics for the Spatial Workspace Framework, for local performance engineering and
 * integration work: each viewport's backend and its capabilities, the fallbacks its frames chose
 * and why, frame and attachment measures, scene density, resource health and the last typed
 * errors. It keeps identifiers, counts and timings only, never content, and sends nothing
 * anywhere.
 */
export type {
  AttachmentReport,
  BackendReport,
  DensityReport,
  Diagnostics,
  DiagnosticsOptions,
  DiagnosticsReport,
  FallbackReport,
  FrameReport,
  ReportedError,
  ResourceReport,
} from './diagnostics.js';
export { createDiagnostics } from './diagnostics.js';
