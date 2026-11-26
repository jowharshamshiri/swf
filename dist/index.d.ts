/**
 * Diagnostics for the Spatial Workspace Framework, for local performance engineering and
 * integration work: each viewport's backend and its capabilities, the fallbacks its frames chose
 * and why, frame, attachment and scene-operation measures, scene density, resource health and the
 * last typed errors; a trace of the workspace's operations to reproduce interaction bugs; and an
 * export of both that discloses labels, binding keys and the host's data only when asked. It keeps
 * identifiers, counts and timings, never content, and sends nothing anywhere.
 */
export type { AttachmentReport, BackendReport, DensityReport, Diagnostics, DiagnosticsOptions, DiagnosticsReport, FallbackReport, FrameReport, OperationReport, ReportedError, ResourceReport, } from './diagnostics.js';
export { createDiagnostics } from './diagnostics.js';
export type { DiagnosticsExportInput } from './export.js';
export { exportDiagnostics } from './export.js';
export type { Disclosure, OperationTrace, OperationTraceOptions, TraceEntry } from './trace.js';
export { createOperationTrace, disclosureOf, PRIVATE_DISCLOSURE, redactor } from './trace.js';
//# sourceMappingURL=index.d.ts.map