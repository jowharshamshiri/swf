import { createVirtualCursor } from '@swf/backend-dom';
import type {
  CancelReason,
  Id,
  NavigationTarget,
  PreviewResult,
  TxResult,
  Workspace,
} from '@swf/core';
import type { CommandOutcome, InputAdapter, InteractionRouter, KeyBinding } from '@swf/interaction';
import { placementOf, turnedAbout } from '@swf/interaction';
import type { PresentedViewport, Representation } from '@swf/presentation';
import type { Modes, ViewMode } from './modes.js';
import { viewGeometryOf } from '@swf/presentation';
import type { ProjectionRegistry } from '@swf/projections';
import { projectionFor } from '@swf/projections';
import type { FeaturePatch, FeatureSettings } from './features.js';
import { DEFAULT_FEATURES, updateFeatures } from './features.js';
import type { Snap } from './magnetic.js';
import { magneticMovePolicy } from './magnetic-policy.js';
import type { OrbitEvent, OrbitState } from './orbit.js';
import { orbitHeading, orbitKeymap, orbitRepair, orbitStateOf, orbitTransition } from './orbit.js';
import { semanticDepth } from './semantic-depth.js';
import type { WrapFrame } from './wrapped-cursor.js';
import { createWheelBursts } from './wheel-burst.js';
import { wrappedInput } from './wrapped-cursor.js';

/**
 * The reference application's optional modules at work: each installed through the framework's
 * public contracts while its feature is on, and taken out, hooks and all, when it is turned off:
 * - focus and context, and the spatial map: their view modes, registered with the modes;
 * - workspace orbit: the viewport's background-drag navigation and the orbit root, and the keys
 *   that turn the root;
 * - semantic depth: the viewport's representation policy;
 * - magnetic positioning: an interaction policy for window moves;
 * - the wrapped cursor: between the pointer device and the framework, with a virtual cursor;
 * - composition and persistence: their commands and controls, which ask {@link Policies.status}
 *   whether they are on (the application turns saving as the workspace changes on and off).
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

/** The gestures that move, turn or resize a window: each selects the window it takes. */
const WINDOW_GESTURES: readonly string[] = Object.freeze([
  'node.move',
  'node.rotate',
  'node.resize',
]);

/** A gesture running: the framework's, or a burst of the wheel over a window. */
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
  /**
   * Turns the orbit root about the camera until it stands `degrees` to the right of where it was
   * placed, the shorter way round. With `preview` (a control being dragged) it previews, each
   * preview replacing the last; without, it commits, the preview open included, as one undoable
   * change, or returns null when the root already stands so (ending any preview). Throws
   * {@link PolicyRefusal} when orbit is off, there is no root, or `degrees` is not finite.
   */
  turnWorkspaceTo(
    degrees: number,
    options: { readonly preview: boolean },
  ): TxResult | PreviewResult | null;
  /** How the viewport shows a window now (as of its last frame), or null when it is not shown. */
  representationOf(nodeId: Id): Representation | null;
  /**
   * The device's adapter with the wheel's bursts and the wrapped cursor between it and the
   * framework.
   */
  input(device: InputAdapter): InputAdapter;
  /**
   * Cancels the gesture running, the framework's or a wheel burst, leaving what it moved where it
   * was; false when none is running.
   */
  cancelGesture(): boolean;
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
  /** The modes the focus and map features register while they are on. */
  readonly modes: Modes;
  readonly focusMode: ViewMode;
  readonly mapMode: ViewMode;
  /** The mode a viewport goes back to when the mode it shows is turned off. */
  readonly homeModeId: string;
  readonly features?: FeatureSettings;
}

export function createPolicies(options: PolicyOptions): Policies {
  const { workspace, router, projections, viewportId, modes } = options;
  const focusModeId = options.focusMode.id;
  /** Each registered mode feature's unregistration. */
  const registered = new Map<string, () => void>();
  /** Registers a feature's mode, or leaves it (for the view it came from) and unregisters it. */
  const offer = (mode: ViewMode, on: boolean) => {
    const unregister = registered.get(mode.id);
    if (on && unregister === undefined) {
      registered.set(mode.id, modes.register(mode));
    } else if (!on && unregister !== undefined) {
      if (modes.current() === mode.id) {
        if (modes.enteredFrom() === null) {
          modes.switchTo(options.homeModeId, {});
        } else {
          modes.back({ source: 'system' });
        }
      }
      unregister();
      registered.delete(mode.id);
    }
  };
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

  /** The preview a control turning the workspace has open, by its ID. */
  let turnPreview: string | null = null;

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
    offer(options.focusMode, on.focus);
    offer(options.mapMode, on.map);
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
        on.depth ? semanticDepth({ bands: features.depth, focusModeId }) : null,
      );
    }
    if (!on.cursor) {
      cursor?.hide();
    }
  };

  // A burst of the wheel over a window, with the depth modifier held, is a gesture of its own:
  // shown as one, ended as one.
  const bursts = createWheelBursts({
    workspace,
    router,
    viewportId,
    gestureRunning: () => gesture !== null && !gesture.gestureId.startsWith('wheel-'),
    report(report) {
      if (report.kind === 'started') {
        gesture = Object.freeze({
          gestureId: report.burstId,
          operation: 'node.move',
          nodeId: report.nodeId,
          snap: null,
        });
      } else if (gesture?.gestureId === report.burstId) {
        ended = Object.freeze({
          operation: 'node.move',
          nodeId: report.nodeId,
          outcome: report.outcome,
          reason: report.outcome === 'cancelled' ? 'escape' : null,
          snap: null,
        });
        gesture = null;
      }
      tell();
    },
  });

  const stopRouter = router.subscribe((event) => {
    if (event.type === 'gesture.started' && event.viewportId === viewportId) {
      // A window taken by a drag is selected, as a press selects it, so the inspector follows it
      // as it goes; one already among the selected keeps the selection. Not an undo step.
      const nodeId = event.nodeId;
      if (
        nodeId !== null &&
        WINDOW_GESTURES.includes(event.operation) &&
        !workspace.getState().selection.includes(nodeId)
      ) {
        workspace.transaction([{ type: 'selection.set', ids: [nodeId] }], { source: 'user' });
      }
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
    turnWorkspaceTo(degrees: number, { preview }: { readonly preview: boolean }) {
      if (typeof degrees !== 'number' || !Number.isFinite(degrees)) {
        throw new PolicyRefusal('degrees', 'must be a finite number of degrees');
      }
      const state = orbit();
      if (!state.enabled) {
        throw new PolicyRefusal('feature', 'workspace orbit is turned off');
      }
      const scene = workspace.getState();
      const rootId = scene.orbitRootId;
      const turned = orbitHeading(scene);
      if (rootId === null || turned === null) {
        throw new PolicyRefusal('orbit', 'no group is designated for workspace orbit');
      }
      const viewport = scene.viewports.get(viewportId);
      const camera = viewport === undefined ? undefined : scene.cameras.get(viewport.cameraId);
      if (camera === undefined) {
        throw new Error(`viewport "${viewportId}" has no camera`);
      }
      // The shorter way round: never more than half a turn.
      const target = (degrees * Math.PI) / 180;
      const angle = Math.atan2(Math.sin(target - turned), Math.cos(target - turned));
      const open = turnPreview;
      if (!preview && open === null && Math.abs(angle) < 1e-12) {
        return null;
      }
      const transform = turnedAbout(placementOf(scene, rootId), camera.position, angle);
      if (transform === null) {
        throw new PolicyRefusal(
          'orbit',
          'the orbit group cannot be turned: its parent is singular',
        );
      }
      const commands = [{ type: 'node.patch' as const, id: rootId, transform }];
      if (preview) {
        const id = open ?? `reference.orbit.turn-to/${String(scene.revision)}`;
        turnPreview = id;
        return workspace.preview(id, commands, { source: 'user' });
      }
      turnPreview = null;
      return workspace.transaction(commands, {
        source: 'user',
        ...(open === null ? {} : { previewId: open }),
      });
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
        device: bursts.input(device),
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
        features.enabled.depth ? semanticDepth({ bands: features.depth, focusModeId }) : null,
      );
      return () => {
        cursor?.dispose();
        cursor = null;
        viewport = null;
      };
    },
    cancelGesture() {
      return bursts.cancel() || router.cancel('host') > 0;
    },
    dispose() {
      bursts.dispose();
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
