/**
 * Projections for the Spatial Workspace Framework: the contract a projection implements (forward
 * and inverse mapping, geometry placement as fragments, visibility, interaction rays), its
 * registration and validation, the equirectangular reference projection, and helpers that derive
 * a viewport's view from the scene and pick surfaces under a point.
 */
export type {
  Continuity,
  ProjectedDirection,
  Projection,
  ProjectionDomain,
  ProjectionModule,
  RayResult,
  Visibility,
} from './contract.js';
export { PROJECTION_API_VERSION } from './contract.js';
export type { EquirectangularConfig } from './equirectangular.js';
export { DEFAULT_EQUIRECTANGULAR_CONFIG, equirectangular } from './equirectangular.js';
export type { Pick, PickCandidate } from './projector.js';
export { pickAt, projectionFor, projectorOf } from './projector.js';
export type { ProjectionRegistry, ProjectionTargets } from './registry.js';
export { createProjectionRegistry, validateProjectionModule } from './registry.js';
export { cameraRotation, headingPitchOf } from './view.js';
