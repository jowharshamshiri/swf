/**
 * Input and interaction for the Spatial Workspace Framework: device-neutral intents, picking
 * through the projection's inverse and a spatial index, input regions that keep content input
 * native, a gesture arena with pointer capture, drags that preview and commit once, explicit
 * cancellation, and named commands that do every spatial operation without a pointer.
 */
export { BoundingVolumeTree } from './bvh.js';
export { BUILT_IN_COMMANDS, cameraRelativeDelta, commandIssue, eyeOf } from './commands.js';
export { DRAG_MODES, dragAnchor, dragFrame, headingOf, movedTransform, placementOf, translatedBy, turnedAbout, withDepth, worldOrigin, } from './drag.js';
export { intentIssue, NO_MODIFIERS } from './intents.js';
export { pick } from './pick.js';
export { backgroundNavigationPolicy, BUILT_IN_POLICIES, INTERACTION_API_VERSION, pinchDepthPolicy, tapSelectPolicy, windowMovePolicy, windowResizePolicy, } from './policies.js';
export { createInteractionRouter, InteractionRouter, KEYBOARD_HOLD_ID } from './router.js';
export { nodeKey, SceneIndex, surfaceKey } from './scene-index.js';
export { DEFAULT_KEYBOARD_STEPS, DEFAULT_SETTINGS, defaultKeymap, mergeSettings, } from './settings.js';
export { createSyntheticInput } from './synthetic.js';
//# sourceMappingURL=index.js.map