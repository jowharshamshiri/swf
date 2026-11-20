/**
 * A browser-native DOM presentation backend for the Spatial Workspace Framework. Live DOM content
 * stays browser-owned and natively interactive: the backend places it by its projected corners
 * (declaring when that only approximates the projection), clips it, orders it by explicit stacking
 * and never mounts it twice. Window chrome sits in layers of its own, labels are text, and input
 * the framework does not take reaches content as the browser's own events.
 */
export type { DomCompositorSession } from './compositor.js';
export { DOM_COMPOSITOR_CAPABILITIES, DOM_COMPOSITOR_ID, DomCompositor } from './compositor.js';
export type { DomInputOptions } from './input.js';
export { createDomInput } from './input.js';
export type { CssMatrix } from './placement.js';
export { applyMatrix, cssMatrixOf, cssTransform, quadMatrix } from './placement.js';
export type { ChromeOptions, DomRendererOptions, DomRendererSession } from './renderer.js';
export {
  DOM_ATTRIBUTES,
  DOM_RENDERER_CAPABILITIES,
  DOM_RENDERER_ID,
  DomRenderer,
} from './renderer.js';
export type { DomView, DomViewOptions, DomViewUpdate } from './view.js';
export { createDomView } from './view.js';
