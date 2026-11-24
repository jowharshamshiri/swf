import { createVirtualCursor } from '@swf/backend-dom';
import type { CancelReason, Id, NavigationTarget, TxResult, Workspace } from '@swf/core';
import type { CommandOutcome, InputAdapter, InteractionRouter, KeyBinding } from '@swf/interaction';
import type { PresentedViewport, Representation } from '@swf/presentation';
import { viewGeometryOf } from '@swf/presentation';
import type { ProjectionRegistry } from '@swf/projections';
import { projectionFor } from '@swf/projections';
import type { FeaturePatch, FeatureSettings } from './features.js';
import { DEFAULT_FEATURES, updateFeatures } from './features.js';
import type { Snap } from './magnetic.js';
import { magneticMovePolicy } from './magnetic-policy.js';
import type { OrbitEvent, OrbitState } from './orbit.js';
import { orbitKeymap, orbitRepair, orbitStateOf, orbitTransition } from './orbit.js';
import { semanticDepth } from './semantic-depth.js';
import type { WrapFrame } from './wrapped-cursor.js';
import { wrappedInput } from './wrapped-cursor.js';

/**
 * The reference application's optional policies at work: each installed through the framework's
 * public contracts while its feature is on, and taken out, hooks and all, when it is turned off:
 * - workspace orbit: the viewport's background-drag navigation and the orbit root, and the keys
 *   that turn the root;
 * - semantic depth: the viewport's representation policy;
 * - magnetic positioning: an interaction policy for window moves;
 * - the wrapped cursor: between the pointer device and the framework, with a virtual cursor.
 * It also follows the gestures the framework runs, so the shell can show each one's preview, the
 * constraint in force, how to cancel it, and how it ended.
 */

/** A policy's refusal, naming the field at fault. */
export class PolicyRefusal extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyRefusal';
  }
}

/** A gesture the framework is running. */
export interface RunningGesture {
  readonly gestureId: string;
  /** The command it does, such as `node.move`, `orbit.turn` or `camera.turn`. */
  readonly operation: string;
  readonly nodeId: Id | null;
  /** The snap in force, while a magnetic move previews one. */
  readonly snap: Snap | null;
}

/** How the last gesture ended. */
export interface EndedGesture {
  readonly operation: string;
  readonly nodeId: Id | null;
  readonly outcome: 'committed' | 'unchanged' | 'cancelled';
  readonly reason: CancelReason | null;
  /** The snap its commit resolved to. */
  readonly snap: Snap | null;
}

/** What the policies show: read again whenever a listener is told something changed. */
export interface PolicyStatus {
  readonly features: FeatureSettings;
  readonly orbit: OrbitState;
  /** The wrapped cursor can wrap in the view as it is (it shows the whole circle). */
  readonly wraps: boolean;
  readonly gesture: RunningGesture | null;
  readonly ended: EndedGesture | null;
}

export interface Policies {
  status(): PolicyStatus;
  subscribe(listener: () => void): () => void;
  /**
   * Changes the features' settings; a policy turned off is taken out at once, one turned on is
   * installed. Throws a {@link FeatureError} naming the field at fault, changing nothing.
   */
  configure(patch: FeaturePatch): FeatureSettings;
  /** Sets what background drags turn. Throws {@link PolicyRefusal} when it cannot. */
  navigate(to: NavigationTarget): TxResult | null;
  /** Designates the group workspace orbit turns, or none. Throws {@link PolicyRefusal}. */
  designate(nodeId: Id | null): TxResult | null;
  /**
   * Turns the orbit root about the camera by degrees to the right, as the named command
   * `orbit.turn` does: one undoable change. Throws {@link PolicyRefusal} when orbit is off or
   * there is no root.
   */
  turnWorkspace(degrees: number): CommandOutcome;
  /** How the viewport shows a window now (as of its last frame), or null when it is not shown. */
  representationOf(nodeId: Id): Representation | null;
  /** The device's adapter with the wrapped cursor between it and the framework. */
  input(device: InputAdapter): InputAdapter;
  /**
   * Starts presenting through a viewport: its representation policy, and a virtual cursor in its
   * container. The returned function stops.
   */
  attach(viewport: PresentedViewport, container: HTMLElement): () => void;
  dispose(): void;
}

export interface PolicyOptions {
  readonly workspace: Workspace;
  readonly router: InteractionRouter;
  readonly projections: ProjectionRegistry;
  readonly viewportId: Id;
  /** The mode that presents the focused window, in full whatever its depth. */
  readonly focusModeId: string;
  readonly features?: FeatureSettings;
}

export function createPolicies(options: PolicyOptions): Policies {
  const { workspace, router, projections, viewportId } = options;
  const keymap: readonly KeyBinding[] = router.settings().keymap;
  let features = options.features ?? DEFAULT_FEATURES;
  let gesture: RunningGesture | null = null;
  let ended: EndedGesture | null = null;
  let viewport: PresentedViewport | null = null;
  let cursor: ReturnType<typeof createVirtualCursor> | null = null;
  let unregisterSnap: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const tell = () => {
    for (const listener of listeners) {
      listener();
    }
  };

  const orbit = (): OrbitState =>
    orbitStateOf(workspace.getState(), viewportId, features.enabled.orbit);

  const wrapFrame = (): WrapFrame => {
    const state = workspace.getState();
    const view = viewGeometryOf(state, viewportId);
    const module = projections.get(view.projectionId);
    if (module === undefined) {
      throw new Error(`projection "${view.projectionId}" is not registered`);
    }
    const domain = projectionFor(module, view).describeDomain();
    return { width: view.width, wraps: domain.fullCircle && domain.seamWrapping };
  };

  /** Commits an orbit transition, or throws its refusal. */
  const transit = (event: OrbitEvent, source: 'user' | 'system' = 'user'): TxResult | null => {
    const next = orbitTransition(workspace.getState(), viewportId, orbit(), event);
    if (next.kind === 'refused') {
      throw new PolicyRefusal(next.field, next.reason);
    }
    return next.commands.length === 0 ? null : workspace.transaction(next.commands, { source });
  };

  const install = (previous: FeatureSettings | null) => {
    const on = features.enabled;
    if (previous?.enabled.orbit !== on.orbit) {
      router.configure({ keymap: orbitKeymap(keymap, on.orbit) });
      if (previous !== null) {
        transit({ kind: 'enable', enabled: on.orbit });
      }
    }
    if (on.snap && unregisterSnap === null) {
      unregisterSnap = router.registerPolicy(
        magneticMovePolicy({
          settings: () => features.snap,
          report: ({ gestureId, snap }) => {
            if (gesture?.gestureId === gestureId) {
              gesture = Object.freeze({ ...gesture, snap });
              tell();
            }
          },
        }),
      );
    } else if (!on.snap && unregisterSnap !== null) {
      unregisterSnap();
      unregisterSnap = null;
    }
    if (
      viewport !== null &&
      (previous?.enabled.depth !== on.depth || previous.depth !== features.depth)
    ) {
      viewport.setRepresentation(
        on.depth
          ? semanticDepth({ bands: features.depth, focusModeId: options.focusModeId })
          : null,
      );
    }
    if (!on.cursor) {
      cursor?.hide();
    }
  };

  const stopRouter = router.subscribe((event) => {
    if (event.type === 'gesture.started' && event.viewportId === viewportId) {
      gesture = Object.freeze({
        gestureId: event.gestureId,
        operation: event.operation,
        nodeId: event.nodeId,
        snap: null,
      });
      tell();
    } else if (event.type === 'gesture.ended' && gesture?.gestureId === event.gestureId) {
      const finish = event.finish;
      ended = Object.freeze({
        operation: gesture.operation,
        nodeId: gesture.nodeId,
        outcome: finish.outcome,
        reason: finish.outcome === 'cancelled' ? finish.reason : null,
        snap: finish.outcome === 'committed' ? gesture.snap : null,
      });
      gesture = null;
      tell();
    }
  });
  // A scene changed by another route (a scene loaded, a group removed) can leave background drags
  // turning a root that is gone: they go back to the camera.
  const stopScene = workspace.subscribe((event) => {
    if (event.type !== 'transaction.committed') {
      return;
    }
    const repair = orbitRepair(orbit(), viewportId);
    if (repair.length > 0) {
      workspace.transaction(repair, { source: 'system' });
    }
    tell();
  });

  install(null);

  return Object.freeze({
    status: () =>
      Object.freeze({ features, orbit: orbit(), wraps: wrapFrame().wraps, gesture, ended }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    configure(patch: FeaturePatch) {
      const previous = features;
      const next = updateFeatures(previous, patch);
      if (next !== previous) {
        features = next;
        install(previous);
        tell();
      }
      return features;
    },
    navigate: (to: NavigationTarget) => transit({ kind: 'navigate', to }),
    designate: (nodeId: Id | null) => transit({ kind: 'designate', nodeId }),
    turnWorkspace(degrees: number): CommandOutcome {
      if (!Number.isFinite(degrees)) {
        throw new PolicyRefusal('degrees', 'must be a finite number of degrees');
      }
      const state = orbit();
      if (!state.enabled) {
        throw new PolicyRefusal('feature', 'workspace orbit is turned off');
      }
      if (state.rootId === null) {
        throw new PolicyRefusal('orbit', 'no group is designated for workspace orbit');
      }
      const result = router.dispatch({
        kind: 'command',
        command: 'orbit.turn',
        args: { viewportId, angle: (degrees * Math.PI) / 180 },
        deviceId: 'reference.controls',
        timestamp: performance.now(),
      });
      const outcome = result.operation?.outcome;
      if (outcome === undefined || !('status' in outcome)) {
        throw new Error(`orbit.turn did not run: ${String(result.reason)}`);
      }
      return outcome;
    },
    representationOf(nodeId: Id): Representation | null {
      const frame = viewport?.lastFrame()?.frame;
      if (frame === undefined) {
        return null;
      }
      const surfaces = new Set(frame.scene.nodes.get(nodeId)?.surfaceIds ?? []);
      return frame.planned.find((p) => surfaces.has(p.fragment.surfaceId))?.representation ?? null;
    },
    input(device: InputAdapter): InputAdapter {
      return wrappedInput({
        device,
        enabled: () => features.enabled.cursor,
        frame: wrapFrame,
        cursor: (at) => {
          if (at === null) {
            cursor?.hide();
          } else {
            cursor?.show(at.x, at.y);
          }
        },
      });
    },
    attach(presented: PresentedViewport, container: HTMLElement) {
      viewport = presented;
      cursor = createVirtualCursor({ container });
      viewport.setRepresentation(
        features.enabled.depth
          ? semanticDepth({ bands: features.depth, focusModeId: options.focusModeId })
          : null,
      );
      return () => {
        cursor?.dispose();
        cursor = null;
        viewport = null;
      };
    },
    dispose() {
      stopRouter();
      stopScene();
      unregisterSnap?.();
      unregisterSnap = null;
      cursor?.dispose();
      cursor = null;
      listeners.clear();
    },
  });
}
