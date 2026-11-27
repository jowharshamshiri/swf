/**
 * Input and interaction for the Spatial Workspace Framework: device-neutral intents, picking on
 * the cards each view draws, input regions that keep content input native, a gesture arena with
 * pointer capture, drags that move windows round the room and preview and commit once, explicit
 * cancellation, and named commands that do every spatial operation without a pointer.
 */
export type { CommandContext, CommandOutcome, InteractionCommand, NodeChange } from './commands.js';
export { BUILT_IN_COMMANDS, commandIssue, eyeOf } from './commands.js';
export type { Placement } from './placement.js';
export { placementOf, turnedAbout, worldOrigin } from './placement.js';
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
export { intentIssue, NO_MODIFIERS, wheelTurn } from './intents.js';
export type {
  InputRegion,
  OcclusionLookup,
  PickCandidate,
  PickContext,
  PickOptions,
  PickResult,
  PresentationLookup,
  RayInfo,
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
export type { RoomLimits, RoomPace, RoomPlace, RoomPointer } from './room.js';
export { ROOM_LIMITS, ROOM_PACE, RoomMotion, roomPlaceOf, standingInRoom } from './room.js';
export type { InteractionSettings, KeyBinding, KeyboardSteps } from './settings.js';
export {
  DEFAULT_KEYBOARD_STEPS,
  DEFAULT_SETTINGS,
  defaultKeymap,
  mergeSettings,
} from './settings.js';
export type { SyntheticInput, SyntheticPointerOptions } from './synthetic.js';
export { createSyntheticInput } from './synthetic.js';
