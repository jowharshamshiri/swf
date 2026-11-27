/**
 * Projections for the Spatial Workspace Framework: the contract a projection implements (forward
 * and inverse mapping of directions, interaction rays), its registration and validation, the
 * equirectangular reference projection, the projector that places every window as a card at the
 * image of its centre, and helpers that derive a viewport's view from the scene.
 */
export type {
  Continuity,
  ProjectedDirection,
  Projection,
  ProjectionDomain,
  ProjectionModule,
  RayResult,
} from './contract.js';
export { PROJECTION_API_VERSION } from './contract.js';
export type { EquirectangularConfig } from './equirectangular.js';
export {
  DEFAULT_EQUIRECTANGULAR_CONFIG,
  EQUIRECTANGULAR_POLE_BAND,
  equirectangular,
} from './equirectangular.js';
export type { GeometryOf } from './projector.js';
export { projectionFor, projectorOf } from './projector.js';
export type { ProjectionRegistry, ProjectionTargets } from './registry.js';
export { createProjectionRegistry, validateProjectionModule } from './registry.js';
export { cameraRotation, headingPitchOf } from './view.js';
