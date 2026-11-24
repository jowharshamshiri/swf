/**
 * Input and interaction for the Spatial Workspace Framework: device-neutral intents, picking
 * through the projection's inverse and a spatial index, input regions that keep content input
 * native, a gesture arena with pointer capture, drags that preview and commit once, explicit
 * cancellation, and named commands that do every spatial operation without a pointer.
 */
export { BoundingVolumeTree } from './bvh.js';
export type { CommandContext, CommandOutcome, InteractionCommand, NodeChange } from './commands.js';
export { BUILT_IN_COMMANDS, cameraRelativeDelta, commandIssue, eyeOf } from './commands.js';
export type { DragFrame, DragMode, Placement } from './drag.js';
export {
  DRAG_MODES,
  dragAnchor,
  dragFrame,
  headingOf,
  movedTransform,
  placementOf,
  translatedBy,
  turnedAbout,
  withDepth,
  worldOrigin,
} from './drag.js';
export type {
  CommandIntent,
  InputIntent,
  KeyIntent,
  ModifierKey,
  Modifiers,
  PointerIntent,
  PointerPhase,
  PointerType,
  WheelIntent,
} from './intents.js';
export { intentIssue, NO_MODIFIERS } from './intents.js';
export type {
  InputRegion,
  OcclusionLookup,
  PickCandidate,
  PickContext,
  PickOptions,
  PickResult,
  PresentationLookup,
  ResizeEdge,
} from './pick.js';
export { pick } from './pick.js';
export type {
  ClaimContext,
  GestureClaim,
  GestureFinish,
  GestureHandler,
  GestureSession,
  InteractionPolicy,
  PressPick,
} from './policies.js';
export {
  backgroundNavigationPolicy,
  BUILT_IN_POLICIES,
  INTERACTION_API_VERSION,
  pinchDepthPolicy,
  tapSelectPolicy,
  windowMovePolicy,
  windowResizePolicy,
} from './policies.js';
export type {
  DispatchResult,
  PickMeasure,
  InputAdapter,
  InteractionEvent,
  InteractionRouterOptions,
  Route,
} from './router.js';
export { createInteractionRouter, InteractionRouter, KEYBOARD_HOLD_ID } from './router.js';
export type { IndexKey } from './scene-index.js';
export { nodeKey, SceneIndex, surfaceKey } from './scene-index.js';
export type { InteractionSettings, KeyBinding, KeyboardSteps } from './settings.js';
export { DEFAULT_SETTINGS, defaultKeymap, mergeSettings } from './settings.js';
export type { SyntheticInput, SyntheticPointerOptions } from './synthetic.js';
export { createSyntheticInput } from './synthetic.js';
