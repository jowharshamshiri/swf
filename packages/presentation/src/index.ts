/**
 * Presentation contracts for the Spatial Workspace Framework: what renderers, compositors and
 * projections advertise, how a surface's presentation is negotiated from their capabilities, the
 * fragments a view is made of, and the stages that take a committed scene to a presented frame.
 * Nothing here depends on a concrete renderer or compositor.
 */
export type {
  ClipSupport,
  CompositorCapabilities,
  LayerCategory,
  Layering,
  Occlusion,
  ProjectionProfile,
  RendererCapabilities,
  TransformMode,
} from './capabilities.js';
export {
  compositorCapabilitiesIssue,
  LAYER_CATEGORIES,
  projectionProfileIssue,
  rendererCapabilitiesIssue,
} from './capabilities.js';
export type {
  ComposedFrame,
  CompositionLayer,
  CompositionTarget,
  Compositor,
  CompositorSession,
  LossListener,
  PlannedFragment,
  RenderedFrame,
  RendererBackend,
  RendererSession,
  RenderFrame,
  ViewSize,
} from './contracts.js';
export { PRESENTATION_API_VERSION } from './contracts.js';
export type {
  ProjectedFragment,
  ScreenPoint,
  ScreenRect,
  ViewGeometry,
  ViewOutput,
} from './fragments.js';
export { createViewOutput, fragmentId, viewGeometryIssue, viewGeometryOf } from './fragments.js';
export type {
  CapabilityGap,
  FallbackDiagnostic,
  FallbackPolicy,
  Negotiation,
  NegotiationInput,
  PresentationMode,
  Requirement,
} from './negotiation.js';
export {
  DEFAULT_FALLBACK_POLICY,
  fallbackPolicy,
  negotiate,
  PRESENTATION_MODES,
} from './negotiation.js';
export type {
  BackendCapabilities,
  BackendChoice,
  DegradedFrame,
  DirtyFlag,
  FrameMetrics,
  FrameSource,
  PresentedViewport,
  Presenter,
  PresenterDiagnostic,
  PresenterEvent,
  PresenterOptions,
  PresenterResources,
  SwitchOutcome,
  SwitchReason,
  ViewportFrame,
  ViewportOptions,
  ViewportState,
  ViewportUpdate,
} from './presenter.js';
export { createPresenter } from './presenter.js';
export type {
  BackendRegistrar,
  PresentationRegistry,
  Registered,
  RegistryChange,
  RegistryDiagnostic,
} from './registry.js';
export { createPresentationRegistry } from './registry.js';
export type {
  Representation,
  RepresentationContext,
  RepresentationPolicy,
} from './representation.js';
export {
  representationFor,
  representationPolicyIssue,
  representedOrder,
  REPRESENTATIONS,
} from './representation.js';
export type { StandInReason, SurfaceCondition } from './conditions.js';
export {
  conditionFor,
  STAND_IN_REASONS,
  STAND_IN_TEXT,
  standInReason,
  surfaceCondition,
} from './conditions.js';
export type { FrameInput, ViewProjector } from './stages.js';
export { groupFallbacks, planFrame, PRESENTATION_STAGES } from './stages.js';
