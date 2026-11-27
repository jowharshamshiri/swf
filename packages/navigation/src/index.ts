/**
 * Navigation and spatial interaction for the Spatial Workspace Framework: a host's own content
 * presented in one viewport with the view modes (the panorama, focus, the map and the overview),
 * moving between them, the eight capabilities and the experiments that isolate each, search, and
 * the window operations every navigation control runs, each a named command. A host starts it in
 * its element with {@link createNavigation} and its own surface adapters; navigation never looks
 * into the content, which stays the host's.
 */
export type {
  CommandResult,
  NavigationCommandId,
  NavigationCommandSpecs,
  NavigationCommands,
} from './commands.js';
export {
  NAVIGATION_COMMAND_IDS,
  committed,
  createNavigationCommands,
  refusalOf,
  rejected,
} from './commands.js';
export type { CompositionPlan, GroupTarget, NewWindow, SurfaceLayout } from './composition.js';
export {
  CompositionRefusal,
  WINDOW_FRAME,
  detachSurface,
  freeId,
  groupWindows,
  layoutSurfaces,
  mergeWindow,
  moveSurface,
  partOf,
  recombineParts,
  regroupWindow,
  splitWindow,
} from './composition.js';
export type { Experiment, ExperimentContext, ExperimentId, ExperimentPlan } from './experiments.js';
export {
  CAPABILITY_ORDER,
  EXPERIMENTS,
  EXPERIMENT_IDS,
  experimentOf,
  experimentPlan,
} from './experiments.js';
export type {
  DepthBands,
  FeatureId,
  FeaturePatch,
  FeatureSettings,
  SnapSettings,
} from './features.js';
export {
  ALL_ENABLED,
  DEFAULT_FEATURES,
  FEATURE_IDS,
  FeatureError,
  ARRANGE_RINGS,
  SNAP_RINGS,
  SNAP_SPACING,
  updateFeatures,
} from './features.js';
export type { FocusContext, FocusFrame, FocusOptions, Neighbour } from './focus.js';
export { FOCUS_ID, createFocusMode, focusContext, focusFrame } from './focus.js';
export { MAGNETIC_POLICY_ID } from './magnetic-policy.js';
export type { CardMeasure, Snap, SnapBox, SnapConstraint, SnappedPlace } from './magnetic.js';
export { cardMeasureOf, NO_SNAP, resolveSnap, snappedPlace, spacedPlace } from './magnetic.js';
export type {
  AroundSide,
  MapCamera,
  MapMarker,
  MapScene,
  MapView,
  MarkerSnap,
  PartLink,
} from './map.js';
export {
  MAP_SCALE,
  MarkerDrag,
  aroundCamera,
  arrangedAround,
  inView,
  mapScene,
  markerAt,
  partLinks,
  placedAt,
  MAP_REACH,
  radarView,
  roomMapView,
  ringStep,
  standingAt,
  toGround,
  toMap,
  traced,
  zoomed,
} from './map.js';
export type { EnterContext, ModeContext, Modes, SwitchOptions, ViewMode } from './modes.js';
export {
  FIELD_OF_VIEW,
  MAP,
  ModeRefusal,
  OVERVIEW,
  PANORAMA,
  PANORAMA_VERTICAL,
  createModes,
  fieldOfViewOf,
  panoramaProjection,
} from './modes.js';
export type {
  BackendId,
  ChromeTokens,
  CompositionStep,
  Navigation,
  NavigationOptions,
  NavigationStatus,
  NavigationWords,
  ObservedInput,
  WindowTraits,
} from './navigation.js';
export {
  BACKEND_IDS,
  CAMERA_ID,
  LAYERED_RENDERER_ID,
  VIEWPORT_ID,
  createNavigation,
} from './navigation.js';
export type { OrbitEvent, OrbitState, OrbitTransition } from './orbit.js';
export {
  cameraHeading,
  nodeHeading,
  orbitHeading,
  orbitKeymap,
  orbitRepair,
  orbitStateOf,
  orbitTransition,
} from './orbit.js';
export type {
  OverviewCard,
  OverviewEntry,
  OverviewGroup,
  OverviewLayout,
  OverviewScene,
} from './overview.js';
export { CARD, CARD_SCALES, layOverview, overviewScene } from './overview.js';
export type {
  EndedGesture,
  Policies,
  PolicyOptions,
  PolicyStatus,
  RunningGesture,
} from './policies.js';
export { PolicyRefusal, createPolicies } from './policies.js';
export type { Pose, PoseTarget } from './pose.js';
export { poseOf, posedPatch, wrapDegrees } from './pose.js';
export type {
  Attachment,
  Coverage,
  GroupOption,
  Search,
  SearchFilters,
  SearchOptions,
  SearchQuery,
  SearchResult,
  SortKey,
  Timers,
} from './search.js';
export {
  ATTACHMENT_FILTERS,
  COVERAGE_FILTERS,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_QUERY,
  LOCK_FILTERS,
  NO_FILTERS,
  PAGE_SIZE,
  SORT_KEYS,
  VISIBILITY_FILTERS,
  createSearch,
} from './search.js';
export { distanceFrom, representationAt, semanticDepth } from './semantic-depth.js';
export type { SpaceStatus } from './space.js';
export { spaceStatus } from './space.js';
export type { StripCard, StripLayout, StripMetrics, StripWindow } from './strip.js';
export { stripLayout, stripWindows } from './strip.js';
export type { ViewTransitions, ViewTransitionsOptions } from './transition.js';
export { TRANSITION_MS, TRANSITION_PREVIEW, createViewTransitions } from './transition.js';
export type { WrapFrame, WrappedInputOptions } from './wrapped-cursor.js';
export { wrappedInput } from './wrapped-cursor.js';
export type { ViewSettings } from './mode-machine.js';
export type { SemanticDepthOptions } from './semantic-depth.js';
