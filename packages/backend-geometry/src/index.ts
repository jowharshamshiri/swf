/**
 * A geometry presentation backend for the Spatial Workspace Framework, written independently of
 * the DOM backend: it draws adapter-supplied drawables (warped by a mesh that follows the view's
 * projection), proxies, placeholders, window chrome and indicators for windows out of view, on
 * canvases, never reading pixels back. A layered renderer pairs it with a native renderer, and the
 * layer compositor stacks live elements and drawn layers in one explicit order.
 */
export type { LayerCompositorSession } from './compositor.js';
export {
  LAYER_COMPOSITOR_CAPABILITIES,
  LAYER_COMPOSITOR_ID,
  LayerCompositor,
} from './compositor.js';
export type { Drawable, Mesh } from './drawing.js';
export { affine, drawableIssue, drawMesh, homographyMesh } from './drawing.js';
export type { WindowFrame } from './frames.js';
export { FRAME_STROKE, windowFrames } from './frames.js';
export type { GeometryLayer } from './layer.js';
export { GEOMETRY_LAYER, isGeometryLayer } from './layer.js';
export type { LayeredRendererOptions, LayeredRendererSession } from './layered.js';
export { LayeredRenderer } from './layered.js';
export type { GeometryInks, GeometryRendererOptions, GeometryRendererSession } from './renderer.js';
export { DEFAULT_GEOMETRY_INKS, GEOMETRY_RENDERER_ID, GeometryRenderer } from './renderer.js';
export { imageNear, planeMesh, planeOutline } from './sampling.js';
