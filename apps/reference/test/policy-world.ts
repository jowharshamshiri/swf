import type { Workspace } from '@swf/core';
import { createWorkspace, worldMatrix } from '@swf/core';
import type { InteractionEvent, InteractionRouter, SyntheticInput } from '@swf/interaction';
import { createInteractionRouter, createSyntheticInput } from '@swf/interaction';
import type { Vec3 } from '@swf/math';
import { mat4TransformPoint } from '@swf/math';
import { createPresentationRegistry, viewGeometryOf } from '@swf/presentation';
import type { ProjectionRegistry } from '@swf/projections';
import { createProjectionRegistry, equirectangular } from '@swf/projections';
import { expect } from 'vitest';
import type { FeatureSettings } from '../src/features.js';
import { createFocusMode } from '../src/focus.js';
import type { Modes } from '../src/modes.js';
import { createModes, MAP, PANORAMA } from '../src/modes.js';
import type { Policies } from '../src/policies.js';
import { createPolicies } from '../src/policies.js';
import type { PlannedWindow, PresetId } from '../src/presets.js';
import { CAMERA_ID, planPreset, presetCommands } from '../src/presets.js';

/** The viewport the reference application presents (as `app.ts` names it). */
export const VIEWPORT = 'main';
export const W = 800;
export const H = 400;

export interface PolicyWorld {
  readonly ws: Workspace;
  readonly projections: ProjectionRegistry;
  readonly router: InteractionRouter;
  readonly policies: Policies;
  /** The view modes; the focus and map features register theirs while they are on. */
  readonly modes: Modes;
  /** A pointer device, connected through the policies' wrapped cursor as the page's is. */
  readonly input: SyntheticInput;
  readonly events: InteractionEvent[];
}

/**
 * A preset's scene in the panorama (800×400, 360°×120°) with the reference application's policies
 * installed on a router through the framework's public API, as the application installs them.
 */
export function policyWorld(
  scene: PresetId | readonly PlannedWindow[] = 'sparse',
  features?: FeatureSettings,
): PolicyWorld {
  const ws = createWorkspace({ id: 'test' });
  const projections = createProjectionRegistry({
    kinds: ws.mutator(),
    projectors: createPresentationRegistry().registrar(),
  });
  projections.register(equirectangular);
  const result = ws.transaction([
    { type: 'camera.create', camera: { id: CAMERA_ID } },
    {
      type: 'viewport.create',
      viewport: {
        id: VIEWPORT,
        cameraId: CAMERA_ID,
        mode: PANORAMA.id,
        projection: PANORAMA.projection,
        size: { width: W, height: H, devicePixelRatio: 1 },
      },
    },
    ...presetCommands(typeof scene === 'string' ? planPreset(scene, 1) : scene),
  ]);
  expect(result.status).toBe('committed');
  const router = createInteractionRouter({ workspace: ws, projections });
  const modes = createModes(ws, VIEWPORT);
  modes.register(PANORAMA);
  const policies = createPolicies({
    workspace: ws,
    router,
    projections,
    viewportId: VIEWPORT,
    modes,
    focusMode: createFocusMode({ fill: 0.75, maxMagnification: 2.5, pixelsPerUnit: 160 }),
    mapMode: MAP,
    homeModeId: PANORAMA.id,
    ...(features === undefined ? {} : { features }),
  });
  const input = createSyntheticInput();
  router.registerInputAdapter(policies.input(input));
  const events: InteractionEvent[] = [];
  router.subscribe((event) => events.push(event));
  return { ws, projections, router, policies, modes, input, events };
}

/** A note window of the reference application, planned at a place round the camera. */
export function note(
  id: string,
  place: { heading: number; distance: number; elevation?: number; width?: number; height?: number },
): PlannedWindow {
  return {
    id,
    label: id,
    content: 'note',
    bindingKey: `test/${id}`,
    heading: place.heading,
    elevation: place.elevation ?? 0,
    distance: place.distance,
    width: place.width ?? 1,
    height: place.height ?? 0.6,
    hue: 0,
  };
}

/** A node's world matrix, which the test expects to exist. */
export function worldOf(ws: Workspace, id: string, presented = false) {
  const state = presented ? ws.getPresented() : ws.getState();
  const m = worldMatrix(state.nodes, id);
  if (m === undefined) {
    throw new Error(`no node "${id}"`);
  }
  return m;
}

/** A node's world centre. */
export function centreOf(ws: Workspace, id: string, presented = false): Vec3 {
  const m = worldOf(ws, id, presented);
  return [m[12], m[13], m[14]];
}

/** A point of a node's local frame, in the world. */
export function pointOn(ws: Workspace, id: string, local: Vec3, presented = false): Vec3 {
  return mat4TransformPoint(worldOf(ws, id, presented), local);
}

/** Where a world point appears in the viewport: its image nearest the given x, if any. */
export function screenOf(ws: Workspace, point: Vec3, nearX = W / 2): [number, number] {
  const view = viewGeometryOf(ws.getState(), VIEWPORT);
  const projection = equirectangular.create(view.projectionConfig);
  const eye: Vec3 = [view.camera[12], view.camera[13], view.camera[14]];
  const images = projection.projectDirection(
    [point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]],
    view,
  ).images;
  const best = [...images].sort((a, b) => Math.abs(a[0] - nearX) - Math.abs(b[0] - nearX))[0];
  if (best === undefined) {
    throw new Error('the point is not in the view');
  }
  return [best[0], best[1]];
}

/** Drags with the primary button from one point to another in steps, then releases. */
export function drag(
  input: SyntheticInput,
  from: readonly [number, number],
  to: readonly [number, number],
  steps = 8,
  release = true,
): void {
  input.pointer('down', VIEWPORT, from[0], from[1]);
  for (let i = 1; i <= steps; i += 1) {
    const f = i / steps;
    input.pointer(
      'move',
      VIEWPORT,
      from[0] + (to[0] - from[0]) * f,
      from[1] + (to[1] - from[1]) * f,
    );
  }
  if (release) {
    input.pointer('up', VIEWPORT, to[0], to[1], { buttons: 0 });
  }
}
