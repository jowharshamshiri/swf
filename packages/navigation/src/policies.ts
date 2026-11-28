import type { DomPointerLock } from '@swf/backend-dom';
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
import { models } from '@swf/models';
import type { PresentedViewport, Representation } from '@swf/presentation';
import type { Modes, ViewMode } from './modes.js';
import { FIELD_OF_VIEW, fieldOfViewOf } from './modes.js';
import { viewGeometryOf } from '@swf/presentation';
import type { ProjectionRegistry } from '@swf/projections';
import { projectionFor } from '@swf/projections';
import type { FeaturePatch, FeatureSettings } from './features.js';
import { DEFAULT_FEATURES, SNAP_RINGS, updateFeatures } from './features.js';
import type { Snap } from './magnetic.js';
import { cardMeasureOf } from './magnetic.js';
import { MAGNETIC_POLICY_ID, magneticMovePolicy } from './magnetic-policy.js';
import type { OrbitEvent, OrbitState } from './orbit.js';
import { orbitHeading, orbitKeymap, orbitRepair, orbitStateOf, orbitTransition } from './orbit.js';
import { focusCards, semanticDepth } from './semantic-depth.js';
import type { FocusOptions } from './focus.js';
import type { WrapFrame } from './wrapped-cursor.js';
import { createWheelBursts } from './wheel-burst.js';
import { wrappedInput } from './wrapped-cursor.js';

/**
 * Navigation's optional capabilities at work: each installed through the framework's
 * public contracts while its feature is on, and taken out, hooks and all, when it is turned off:
 * - focus and context, and the spatial map: their view modes, registered with the modes;
 * - workspace orbit: the viewport's background-drag navigation and the orbit root, and the keys
 *   that turn the root;
 * - semantic depth: the viewport's representation policy;
 * - magnetic positioning: an interaction policy for window moves;
 * - the wrapped cursor: between the pointer device and the framework, with a virtual cursor;
 * - composition and persistence: their commands and controls, which ask {@link Policies.status}
 *   whether they are on (the host turns saving as the workspace changes on and off).
 * It also follows the gestures the framework runs, so the shell can show each one's preview, the
 * constraint in force, how to cancel it, and how it ended.
 */

/** A policy's refusal, naming the field at fault. */
export class PolicyRefusal extends Error {
  constructor(
    /** The field at fault. */
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyRefusal';
  }
}

/** The gestures that move or resize a window: each selects the window it takes. */
const WINDOW_GESTURES: readonly string[] = Object.freeze(['node.move', 'node.resize']);

/** A gesture running: the framework's, or a burst of the wheel over a window. */
export interface RunningGesture {
  /** The gesture's ID. */
  readonly gestureId: string;
  /** The command it does, such as `node.move`, `orbit.turn` or `camera.turn`. */
  readonly operation: string;
  /** The window it acts on, or null for one that acts on none (a turn of the camera). */
  readonly nodeId: Id | null;
  /** Whether magnetic positioning weighs where it puts the window: a magnetic move. */
  readonly snaps: boolean;
  /** Whether it is a burst of the wheel, navigation's own, rather than the framework's. */
  readonly wheel: boolean;
  /** The snap in force, while a magnetic move previews one. */
  readonly snap: Snap | null;
}

/** How the last gesture ended. */
export interface EndedGesture {
  /** The command it did. */
  readonly operation: string;
  /** The window it acted on, or null. */
  readonly nodeId: Id | null;
  /** How it ended: committed, put down where it was, or cancelled. */
  readonly outcome: 'committed' | 'unchanged' | 'cancelled';
  /** Why it was cancelled, or null when it was not. */
  readonly reason: CancelReason | null;
  /** The snap its commit resolved to. */
  readonly snap: Snap | null;
}

/** What the policies show: read again whenever a listener is told something changed. */
export interface PolicyStatus {
  /** The capabilities' settings. */
  readonly features: FeatureSettings;
  /** Workspace orbit's state. */
  readonly orbit: OrbitState;
  /** The wrapped cursor can wrap in the view as it is (it shows the whole circle). */
  readonly wraps: boolean;
  /** The gesture running, or null. */
  readonly gesture: RunningGesture | null;
  /** How the last gesture ended, or null before any. */
  readonly ended: EndedGesture | null;
}

/**
 * The capabilities at work in one viewport: each turned on and off, and the policies that carry it.
 */
export interface Policies {
  /** What the policies show now. */
  status(): PolicyStatus;
  /** Calls `listener` whenever the status changes; returns what stops it. */
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
   * framework; the wrapped cursor locks the pointer to the view with `lock`, the platform's
   * pointer lock on it, or never where that is null.
   */
  input(device: InputAdapter, lock: DomPointerLock | null): InputAdapter;
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
  /** Takes the policies out and stops following the workspace and the router. */
  dispose(): void;
}

/** What the policies act in and on. */
export interface PolicyOptions {
  /** The workspace. */
  readonly workspace: Workspace;
  /** The router the policies and input go through. */
  readonly router: InteractionRouter;
  /** The projections the viewport's view is drawn by. */
  readonly projections: ProjectionRegistry;
  /** The viewport. */
  readonly viewportId: Id;
  /** The modes the focus and map features register while they are on. */
  readonly modes: Modes;
  /** The focus mode, registered while focus is on. */
  readonly focusMode: ViewMode;
  /** How focus shows its window: its card is scaled to it, in focus. */
  readonly focusOptions: FocusOptions;
  /** The map mode, registered while the map is on. */
  readonly mapMode: ViewMode;
  /** The mode a viewport goes back to when the mode it shows is turned off. */
  readonly homeModeId: string;
  /** The settings to start with. Default: {@link DEFAULT_FEATURES}. */
  readonly features?: FeatureSettings;
}

/**
 * The capabilities' policies in a viewport, each on as `features` says, its policies installed
 * through the router and its modes registered.
 */
export function createPolicies(options: PolicyOptions): Policies {
  const { workspace, router, projections, viewportId, modes } = options;
  const focusModeId = options.focusMode.id;
  const focusOptions = options.focusOptions;
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
    return {
      width: view.width,
      height: view.height,
      wraps: domain.fullCircle && domain.seamWrapping,
    };
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
          rings: () => SNAP_RINGS,
          measure: () =>
            cardMeasureOf(
              workspace.getState(),
              viewportId,
              features.enabled.depth ? features.depth : null,
            ),
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
          ? semanticDepth({ bands: features.depth, focusModeId, focus: focusOptions })
          : focusCards({ focusModeId, focus: focusOptions }),
      );
    }
    if (!on.cursor) {
      cursor?.hide();
    }
  };

  // A burst of the wheel over a window, or turning the workspace, is a gesture of its own: shown
  // as one, ended as one. Ctrl and the wheel, or a pinch, over the background zoom the panorama's
  // field of view.
  const bursts = createWheelBursts({
    workspace,
    router,
    viewportId,
    gestureHeld: () =>
      (gesture !== null && !gesture.wheel) ||
      router.captures().some((capture) => capture.viewportId === viewportId),
    zoom(factor) {
      // The panorama's field of view, only while a mode that shows the panorama is active: a mode
      // that frames its own view (focus) leaves the wheel to the browser.
      const viewport = workspace.getState().viewports.get(viewportId);
      const current = modes.list().find((mode) => mode.id === modes.current());
      if (viewport === undefined || current?.panoramic !== true) {
        return false;
      }
      const degrees = Math.min(
        FIELD_OF_VIEW.max,
        Math.max(FIELD_OF_VIEW.min, fieldOfViewOf(viewport.projection) * factor),
      );
      modes.fieldOfView(degrees);
      return true;
    },
    report(report) {
      if (report.kind === 'started') {
        gesture = Object.freeze({
          gestureId: report.burstId,
          operation: report.operation,
          nodeId: report.nodeId,
          snaps: false,
          wheel: true,
          snap: null,
        });
      } else if (gesture?.gestureId === report.burstId) {
        ended = Object.freeze({
          operation: report.operation,
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

  /**
   * A press on a window makes it the window worked on (`selectionOnPress`): it becomes the
   * selection unless it is already among the selected. Not an undo step.
   */
  const pressed = (nodeId: Id) => {
    const next = models.selectionOnPress([...workspace.getState().selection], nodeId);
    if (next !== null) {
      workspace.transaction([{ type: 'selection.set', ids: next }], { source: 'user' });
    }
  };
  const stopRouter = router.subscribe((event) => {
    if (event.type === 'content.pressed' && event.viewportId === viewportId) {
      // Working in a window's live content makes it the window the keys, the inspector and the
      // map act on, as an operating system activates the window pressed.
      pressed(event.nodeId);
    } else if (event.type === 'gesture.started' && event.viewportId === viewportId) {
      // A window taken by a drag is selected, as a press selects it, so the inspector follows it
      // as it goes.
      const nodeId = event.nodeId;
      if (nodeId !== null && WINDOW_GESTURES.includes(event.operation)) {
        pressed(nodeId);
      }
      gesture = Object.freeze({
        gestureId: event.gestureId,
        operation: event.operation,
        nodeId: event.nodeId,
        snaps: event.policyId === MAGNETIC_POLICY_ID,
        wheel: false,
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
        deviceId: 'swf.navigation.controls',
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
        const id = open ?? `swf.orbit.turn-to/${String(scene.revision)}`;
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
    input(device: InputAdapter, lock: DomPointerLock | null): InputAdapter {
      return wrappedInput({
        device: bursts.input(device),
        lock,
        viewportId,
        events: (listener) => router.subscribe(listener),
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
          ? semanticDepth({ bands: features.depth, focusModeId, focus: focusOptions })
          : focusCards({ focusModeId, focus: focusOptions }),
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
