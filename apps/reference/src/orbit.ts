import type { Id, NavigationTarget, SceneCommand, SceneState } from '@swf/core';
import { worldMatrix } from '@swf/core';
import type { KeyBinding } from '@swf/interaction';
import type * as Lean from '@swf/models';
import { models } from '@swf/models';
import { headingPitchOf } from '@swf/projections';

/**
 * Workspace orbit, as plain data with explicit transitions. A drag on the panorama's background
 * either turns the camera (view state, never undone) or turns the designated group, the orbit
 * root, about the camera (a change to the scene, undone like any other). Which one is the
 * viewport's navigation setting, chosen explicitly and said aloud; it never switches by itself
 * from where the pointer is. Every transition is decided by the Lean model `Swf.AppOrbit`
 * (models/Swf/AppOrbit.lean), where its invariants are proved; this module carries the scene's
 * facts to it and its commands back. Nothing here touches a scene: a transition says which
 * commands make it, and the caller commits them.
 */

/** What the orbit policy weighs. */
export interface OrbitState {
  /** The orbit policy is on. */
  readonly enabled: boolean;
  /** What a background drag turns in the viewport. */
  readonly navigation: NavigationTarget;
  /** The designated group, or null. */
  readonly rootId: Id | null;
}

export type OrbitEvent =
  /** Background drags turn this from now on. */
  | { readonly kind: 'navigate'; readonly to: NavigationTarget }
  /** Designates the group orbit turns, or none. */
  | { readonly kind: 'designate'; readonly nodeId: Id | null }
  /** The policy is turned on or off. */
  | { readonly kind: 'enable'; readonly enabled: boolean };

export type OrbitTransition =
  | {
      readonly kind: 'next';
      readonly state: OrbitState;
      /** The commands that make it: one transaction, or none when nothing changes. */
      readonly commands: readonly SceneCommand[];
    }
  | { readonly kind: 'refused'; readonly field: string; readonly reason: string };

/** The orbit state of a viewport in a scene, with the policy on or off. */
export function orbitStateOf(scene: SceneState, viewportId: Id, enabled: boolean): OrbitState {
  const viewport = scene.viewports.get(viewportId);
  if (viewport === undefined) {
    throw new Error(`no viewport "${viewportId}"`);
  }
  return Object.freeze({ enabled, navigation: viewport.navigation, rootId: scene.orbitRootId });
}

/** Why a node cannot be the orbit root, or null when it can: only an active group can. */
export function orbitRootIssue(scene: SceneState, nodeId: Id): string | null {
  return models.orbitRootIssue(candidateOf(scene, nodeId));
}

/**
 * The next state for an event. Orbit navigation needs the policy on and a designated group;
 * turning the policy off, or taking the group away, returns background drags to the camera.
 */
export function orbitTransition(
  scene: SceneState,
  viewportId: Id,
  state: OrbitState,
  event: OrbitEvent,
): OrbitTransition {
  const step = models.orbitStep(leanState(state), leanEvent(scene, event));
  if (step.kind === 'refused') {
    return Object.freeze({ kind: 'refused', field: step.field, reason: step.reason });
  }
  return Object.freeze({
    kind: 'next',
    state: Object.freeze({
      enabled: step.state.enabled,
      navigation: step.state.navigation.kind,
      rootId: step.state.rootId,
    }),
    commands: Object.freeze(
      step.commands.map((command): SceneCommand =>
        command.kind === 'setRoot'
          ? { type: 'orbitRoot.set', nodeId: command.nodeId }
          : { type: 'viewport.patch', id: viewportId, navigation: command.to.kind },
      ),
    ),
  });
}

/**
 * The commands that bring a viewport back in line after the scene changed by another route: when
 * its navigation turns the orbit root but the policy is off or there is no root, drags go back to
 * the camera.
 */
export function orbitRepair(state: OrbitState, viewportId: Id): readonly SceneCommand[] {
  return models.orbitNeedsRepair(leanState(state))
    ? [{ type: 'viewport.patch', id: viewportId, navigation: 'camera' }]
    : [];
}

/** The key bindings while the policy is on or off: off, none turns the orbit root. */
export function orbitKeymap(keymap: readonly KeyBinding[], enabled: boolean): KeyBinding[] {
  return keymap.filter((binding) => models.orbitKeepsBinding(enabled, binding.command));
}

/**
 * How far the orbit root is turned about the vertical from where it was placed, in radians to
 * the right; null when there is no root.
 */
export function orbitHeading(scene: SceneState): number | null {
  const rootId = scene.orbitRootId;
  return rootId === null ? null : nodeHeading(scene, rootId);
}

/**
 * How far a node is turned about the vertical, in radians to the right of straight ahead; null when
 * there is no such node.
 */
export function nodeHeading(scene: SceneState, nodeId: string): number | null {
  const world = worldMatrix(scene.nodes, nodeId);
  if (world === undefined) {
    return null;
  }
  // The node's -Z axis, seen from above: how far its "ahead" has turned.
  const x = -world[8];
  const z = -world[10];
  const heading = Math.hypot(x, z) === 0 ? 0 : Math.atan2(x, -z);
  // Unturned is no turn at all, never a turn of minus zero.
  return heading === 0 ? 0 : heading;
}

/** How far the camera of a viewport is turned, in radians to the right of straight ahead. */
export function cameraHeading(scene: SceneState, viewportId: Id): number {
  const viewport = scene.viewports.get(viewportId);
  const camera = viewport === undefined ? undefined : scene.cameras.get(viewport.cameraId);
  if (camera === undefined) {
    throw new Error(`viewport "${viewportId}" has no camera`);
  }
  return headingPitchOf(camera.rotation).heading;
}

/** A node of the scene as designating it weighs it, by ID. */
function candidateOf(scene: SceneState, nodeId: Id): Lean.OrbitCandidate {
  const node = scene.nodes.get(nodeId);
  return {
    id: nodeId,
    node:
      node === undefined
        ? null
        : { kind: node.kind, label: node.label, active: node.status === 'active' },
  };
}

function leanState(state: OrbitState): Lean.OrbitState {
  return { enabled: state.enabled, navigation: { kind: state.navigation }, rootId: state.rootId };
}

function leanEvent(scene: SceneState, event: OrbitEvent): Lean.OrbitEvent {
  switch (event.kind) {
    case 'navigate':
      return { kind: 'navigate', to: { kind: event.to } };
    case 'designate':
      return {
        kind: 'designate',
        candidate: event.nodeId === null ? null : candidateOf(scene, event.nodeId),
      };
    case 'enable':
      return { kind: 'enable', enabled: event.enabled };
  }
}
