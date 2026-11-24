import type { Id, NavigationTarget, SceneCommand, SceneState } from '@swf/core';
import { worldMatrix } from '@swf/core';
import type { KeyBinding } from '@swf/interaction';
import { headingPitchOf } from '@swf/projections';

/**
 * Workspace orbit, as plain data with explicit transitions. A drag on the panorama's background
 * either turns the camera (view state, never undone) or turns the designated group, the orbit
 * root, about the camera (a change to the scene, undone like any other). Which one is the
 * viewport's navigation setting, chosen explicitly and said aloud; it never switches by itself
 * from where the pointer is. Nothing here touches a scene: a transition says which commands make
 * it, and the caller commits them.
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
  const node = scene.nodes.get(nodeId);
  if (node === undefined) {
    return `no node "${nodeId}"`;
  }
  if (node.kind !== 'group') {
    return `"${node.label ?? nodeId}" is a ${node.kind}, not a group`;
  }
  if (node.status !== 'active') {
    return `"${node.label ?? nodeId}" is archived`;
  }
  return null;
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
  const navigate = (navigation: NavigationTarget): SceneCommand[] =>
    navigation === state.navigation ? [] : [{ type: 'viewport.patch', id: viewportId, navigation }];
  switch (event.kind) {
    case 'navigate': {
      if (event.to === 'orbit') {
        if (!state.enabled) {
          return refused('navigation', 'workspace orbit is turned off');
        }
        if (state.rootId === null) {
          return refused('navigation', 'no group is designated for workspace orbit');
        }
      }
      return next({ ...state, navigation: event.to }, navigate(event.to));
    }
    case 'designate': {
      if (event.nodeId !== null) {
        const issue = orbitRootIssue(scene, event.nodeId);
        if (issue !== null) {
          return refused('nodeId', issue);
        }
      }
      const navigation = event.nodeId === null ? 'camera' : state.navigation;
      const commands: SceneCommand[] =
        event.nodeId === state.rootId ? [] : [{ type: 'orbitRoot.set', nodeId: event.nodeId }];
      return next({ ...state, rootId: event.nodeId, navigation }, [
        ...commands,
        ...navigate(navigation),
      ]);
    }
    case 'enable': {
      const navigation = event.enabled ? state.navigation : 'camera';
      return next({ ...state, enabled: event.enabled, navigation }, navigate(navigation));
    }
  }
}

/**
 * The commands that bring a viewport back in line after the scene changed by another route: when
 * its navigation turns the orbit root but the policy is off or there is no root, drags go back to
 * the camera.
 */
export function orbitRepair(state: OrbitState, viewportId: Id): readonly SceneCommand[] {
  return state.navigation === 'orbit' && (!state.enabled || state.rootId === null)
    ? [{ type: 'viewport.patch', id: viewportId, navigation: 'camera' }]
    : [];
}

/** The key bindings while the policy is on or off: off, none turns the orbit root. */
export function orbitKeymap(keymap: readonly KeyBinding[], enabled: boolean): KeyBinding[] {
  return enabled ? [...keymap] : keymap.filter((binding) => binding.command !== 'orbit.turn');
}

/**
 * How far the orbit root is turned about the vertical from where it was placed, in radians to
 * the right; null when there is no root.
 */
export function orbitHeading(scene: SceneState): number | null {
  const rootId = scene.orbitRootId;
  const world = rootId === null ? undefined : worldMatrix(scene.nodes, rootId);
  if (world === undefined) {
    return null;
  }
  // The root's -Z axis, seen from above: how far its "ahead" has turned.
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

function next(state: OrbitState, commands: readonly SceneCommand[]): OrbitTransition {
  return Object.freeze({
    kind: 'next',
    state: Object.freeze(state),
    commands: Object.freeze(commands),
  });
}

function refused(field: string, reason: string): OrbitTransition {
  return Object.freeze({ kind: 'refused', field, reason });
}
