import type { Workspace } from '@swf/core';
import { createWorkspace, worldMatrix } from '@swf/core';
import type { InteractionEvent, InteractionRouter, SyntheticInput } from '@swf/interaction';
import { createInteractionRouter, createSyntheticInput } from '@swf/interaction';
import type { Vec3 } from '@swf/math';
import { mat4TransformPoint } from '@swf/math';
import type { RepresentationPolicy, ScreenRect } from '@swf/presentation';
import { createPresentationRegistry, viewGeometryOf } from '@swf/presentation';
import type { ProjectionRegistry } from '@swf/projections';
import { createProjectionRegistry, equirectangular, projectorOf } from '@swf/projections';
import { expect } from 'vitest';
import type { PlannedWindow, PresetId } from '../src/presets.js';
import { planPreset, presetCommands } from '../src/presets.js';
import type { DepthBands, FeatureSettings, Modes, Policies } from '@swf/navigation';
import {
  CAMERA_ID,
  FOCUS_ID,
  MAP,
  PANORAMA,
  createFocusMode,
  createModes,
  createPolicies,
  semanticDepth,
} from '@swf/navigation';

/** How focus shows its window, as the reference application has it. */
export const FOCUS = Object.freeze({ fill: 0.75, maxMagnification: 2.5 });

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
  /**
   * The representation policy the panorama draws its cards by, as the application's viewport
   * has it: semantic depth while it is on, every window in full otherwise.
   */
  representation(): RepresentationPolicy | null;
}

/**
 * A preset's scene in the panorama (800×400, 360°×120°) with the reference application's policies
 * installed on a router through the framework's public API, as the application installs them.
 * `now` fixes the workspace's clock, for scenes compared byte for byte.
 */
export function policyWorld(
  scene: PresetId | readonly PlannedWindow[] = 'sparse',
  features?: FeatureSettings,
  options: { readonly now?: () => number } = {},
): PolicyWorld {
  const ws = createWorkspace({
    id: 'test',
    ...(options.now === undefined ? {} : { now: options.now }),
  });
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
  // Picking finds the cards the panorama draws, as the application's router does.
  let depth: { readonly bands: DepthBands; readonly policy: RepresentationPolicy } | null = null;
  const representation = (): RepresentationPolicy | null => {
    const settings = policies.status().features;
    if (!settings.enabled.depth) {
      return null;
    }
    if (depth?.bands !== settings.depth) {
      depth = {
        bands: settings.depth,
        policy: semanticDepth({ bands: settings.depth, focusModeId: FOCUS_ID, focus: FOCUS }),
      };
    }
    return depth.policy;
  };
  const router = createInteractionRouter({ workspace: ws, projections, representation });
  const modes = createModes(ws, VIEWPORT);
  modes.register(PANORAMA);
  const policies = createPolicies({
    workspace: ws,
    router,
    projections,
    viewportId: VIEWPORT,
    modes,
    focusMode: createFocusMode(FOCUS),
    focusOptions: FOCUS,
    mapMode: MAP,
    homeModeId: PANORAMA.id,
    ...(features === undefined ? {} : { features }),
  });
  const input = createSyntheticInput();
  router.registerInputAdapter(policies.input(input, null));
  const events: InteractionEvent[] = [];
  router.subscribe((event) => events.push(event));
  return { ws, projections, router, policies, modes, input, events, representation };
}

/**
 * A note window of the reference application, planned at a place in the room: its heading in
 * degrees, its reach along the floor and its height.
 */
export function note(
  id: string,
  place: { heading: number; reach: number; y?: number; width?: number; height?: number },
): PlannedWindow {
  return {
    id,
    label: id,
    content: 'note',
    bindingKey: `test/${id}`,
    heading: place.heading,
    reach: place.reach,
    y: place.y ?? 0,
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

/**
 * A window's card in the panorama as it draws it and the router picks on it, at the window's own
 * place (not a copy across the seam).
 */
export function cardOf(w: PolicyWorld, id: string, presented = false): ScreenRect {
  const state = presented ? w.ws.getPresented() : w.ws.getState();
  const own = projectorOf(equirectangular)
    .project(
      state,
      viewGeometryOf(state, VIEWPORT),
      (surfaceId) => w.ws.surfaceGeometry(surfaceId),
      w.representation(),
    )
    .find((f) => f.nativeOwner && state.surfaces.get(f.surfaceId)?.ownerNodeId === id);
  if (own === undefined) {
    throw new Error(`window "${id}" has no card in the panorama`);
  }
  return own.card;
}

/** A point of a window's card in the panorama, in the window's own units (x right, y up). */
export function onCard(
  w: PolicyWorld,
  id: string,
  [lx, ly]: readonly [number, number],
  presented = false,
): [number, number] {
  const node = (presented ? w.ws.getPresented() : w.ws.getState()).nodes.get(id);
  if (node === undefined) {
    throw new Error(`no node "${id}"`);
  }
  const [x, y, cw, ch] = cardOf(w, id, presented);
  return [x + cw / 2 + (lx * cw) / node.bounds[0], y + ch / 2 - (ly * ch) / node.bounds[1]];
}
