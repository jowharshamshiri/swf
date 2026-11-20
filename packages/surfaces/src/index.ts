/**
 * Opaque presentation surfaces. A host registers adapters that bind its existing presentation
 * endpoints to the surface associations in a workspace's scene; the runtime negotiates each
 * endpoint's capabilities and drives it through the presentation lifecycle, without ever
 * inspecting, decoding or running what the endpoint shows.
 */
export type {
  BindingContext,
  OcclusionConfidence,
  PresentationHint,
  PresentationTarget,
  SurfaceAdapter,
} from './adapter.js';
export { ADAPTER_API_VERSION } from './adapter.js';
export type {
  AttachStrategy,
  Fidelity,
  InteractionSupport,
  ResizeHandling,
  SurfaceCapabilities,
  ViewportSharing,
} from './capabilities.js';
export {
  ATTACH_STRATEGIES,
  capabilitiesIssue,
  exceededCapabilities,
  FIDELITY_ORDER,
  INTERACTION_ORDER,
} from './capabilities.js';
export type {
  PresentationState,
  RuntimeEvent,
  RuntimeEventPayload,
  RuntimeEventType,
  UnboundReason,
} from './events.js';
export type {
  HintOutcome,
  PresentationOutcome,
  RuntimeDiagnostic,
  RuntimeListener,
  SurfaceBinder,
  SurfacePresentation,
  SurfaceRuntime,
  SurfaceRuntimeOptions,
  ViewportAttachment,
} from './runtime.js';
export { createSurfaceRuntime } from './runtime.js';
