import type {
  CancelReason,
  Id,
  PreviewOutcome,
  SceneCommand,
  SceneState,
  SwfError,
  TxOutcome,
  TxResult,
} from '@swf/core';
import type { Transform3D, Vec3 } from '@swf/math';
import { mat4InvertAffine, mat4TransformDirection, mat4TransformPoint, sub } from '@swf/math';
import type { ViewGeometry } from '@swf/presentation';
import type { Projection, RayResult } from '@swf/projections';
import { cameraRotation, headingPitchOf } from '@swf/projections';
import { eyeOf } from './commands.js';
import type { DragFrame, Placement } from './drag.js';
import {
  dragAnchor,
  dragFrame,
  movedTransform,
  placementOf,
  translatedBy,
  turnedAbout,
  withDepth,
} from './drag.js';
import type { PointerIntent, WheelIntent } from './intents.js';
import { wheelTurn } from './intents.js';
import type { InputRegion, PickCandidate, PickResult, ResizeEdge } from './pick.js';
import type { InteractionSettings } from './settings.js';

/**
 * The version of the policy and input adapter contract this package defines. A policy or input
 * adapter states it as its `apiVersion`; any other value is refused at registration with
 * `UNSUPPORTED_CAPABILITY`.
 */
export const INTERACTION_API_VERSION = 1;

/** A pick that found something to press on: a hit or the background. */
export type PressPick = Extract<
  PickResult,
  {
    /** The kinds of pick a press can land on. */
    kind: 'hit' | 'background';
  }
>;

/**
 * What a policy sees when pointers press on a target. Built afresh for each press; a policy reads
 * it and must not change the scene from `claim`.
 */
export interface ClaimContext {
  /** The viewport pressed in. */
  readonly viewportId: Id;
  /** The committed scene at the press. */
  readonly scene: SceneState;
  /** The pick under the first pointer. */
  readonly pick: PressPick;
  /**
   * The region the first pointer pressed on. `modal-overlay` never reaches a policy: such presses
   * are blocked.
   */
  readonly region: InputRegion;
  /** The `down` sample of every pointer pressed on the target, in the order they went down. */
  readonly pointers: readonly PointerIntent[];
  /**
   * A takeover is active (the router's takeover control, or the takeover modifier held on the
   * first press): content-area presses may be claimed.
   */
  readonly takeover: boolean;
  /** The router's settings at the press; frozen. */
  readonly settings: InteractionSettings;
}

/** How a gesture ended. */
export type GestureFinish =
  | {
      /** The gesture's result is committed. */
      readonly outcome: 'committed';
      /**
       * The committing transaction, or null when the gesture changed only view state (a camera
       * turn), which it applied as it went.
       */
      readonly transactionId: string | null;
    }
  | {
      /** The gesture had nothing to commit: it never proposed a change the scene accepted. */
      readonly outcome: 'unchanged';
    }
  | {
      /** The gesture was cancelled, or its commit was rejected; nothing of it was committed. */
      readonly outcome: 'cancelled';
      /**
       * Why: a commit refused by a constraint or a lock gives `constraint-rejected`, any other
       * refused commit `commit-rejected`; otherwise the cancellation's own reason.
       */
      readonly reason: CancelReason;
      /** The rejection that cancelled it, when a commit failed. */
      readonly error: SwfError | null;
    };

/**
 * What a gesture can use while it runs. Previews and commits act as the operator (`user`). The
 * session is frozen and belongs to one gesture: the router discards its preview when the gesture
 * ends, so the gesture never cleans it up itself.
 *
 * Previewing, committing and transacting from inside a workspace event listener throw
 * {@link @swf/core!SwfFailure} (`INVALID_TRANSITION`): input is not dispatched from there.
 */
export interface GestureSession {
  /** The gesture's ID, as `gesture.started` and `gesture.ended` report it. */
  readonly gestureId: string;
  /** The viewport the gesture runs in. */
  readonly viewportId: Id;
  /** The router's settings when the gesture began; frozen. */
  readonly settings: InteractionSettings;
  /** The committed scene now. */
  scene(): SceneState;
  /** The viewport's view now: it follows resizes and camera changes during the gesture. */
  view(): ViewGeometry;
  /**
   * The projection of the viewport's view now. Throws {@link @swf/core!SwfFailure}
   * (`UNSUPPORTED_CAPABILITY`) when the viewport's projection is not registered.
   */
  projection(): Projection;
  /**
   * The world ray under a pointer sample in the current view, its longitude unwrapped against the
   * pointer's previous sample so it stays continuous across a seam.
   */
  ray(pointer: PointerIntent): RayResult;
  /**
   * Proposes the gesture's result; it replaces the gesture's previous proposal. A proposal the
   * scene refuses is reported as rejected and leaves the previous one shown.
   */
  preview(commands: readonly SceneCommand[]): PreviewOutcome;
  /**
   * Commits the gesture's result once, ending its preview. A rejected commit cancels the preview
   * (`constraint-rejected` or `commit-rejected`), which cancels the gesture.
   */
  commit(commands: readonly SceneCommand[]): TxOutcome;
  /** Commits commands at once, outside the gesture's preview (view state, or a tap's result). */
  transact(commands: readonly SceneCommand[]): TxOutcome;
  /**
   * Like `transact`, for use while cancelling: a cancellation can arrive while the workspace is
   * delivering events, and the change then runs right after the delivery.
   */
  apply(commands: readonly SceneCommand[]): TxResult;
}

/**
 * A running gesture, as its claim's `begin` returns it. The router calls `update` for every move
 * of its pointers, then `finish` when they are released or `cancel` when the gesture is cancelled
 * first; a pointer gesture whose `finish` reports `cancelled` also gets `cancel` with that reason,
 * so it can undo view state. An exception thrown from
 * `update`, `wheel` or `finish` cancels the gesture (`host`) and reaches the dispatcher; one from
 * `cancel` is kept for {@link InteractionRouter.takeListenerErrors}.
 */
export interface GestureHandler {
  /** The latest sample of each captured pointer, in the order they went down. */
  update(pointers: readonly PointerIntent[]): void;
  /**
   * A wheel over the viewport during the gesture; true when the gesture used it. While a press is
   * held in a viewport every wheel there is its gesture's, so nothing else changes the scene in
   * the middle of it: a wheel the gesture does not use (it returns false, or has no `wheel`) is
   * consumed and does nothing, as is one while the press is still pending.
   */
  wheel?(intent: WheelIntent): boolean;
  /** The pointers were released: commit (once) or report why not. */
  finish(): GestureFinish;
  /**
   * The gesture is cancelled. Its preview is discarded by the router; undo here anything applied
   * outside the preview (view state).
   */
  cancel(reason: CancelReason): void;
}

/** A policy's bid for pressed pointers. */
export interface GestureClaim {
  /** `drag` wins when a pointer moves beyond the slop; `tap` when pointers lift before that. */
  readonly kind: 'drag' | 'tap';
  /** How many pointers the gesture takes; it competes only when exactly that many are pressed. */
  readonly pointers: number;
  /** The command that does what this gesture does, without a pointer. */
  readonly operation: string;
  /** The node it acts on, or null. */
  readonly nodeId: Id | null;
  /**
   * Starts the gesture once the claim wins its arena: called once, with the gesture's own
   * session. An exception it throws releases the arena's pointers and reaches the dispatcher.
   */
  begin(session: GestureSession): GestureHandler;
}

/**
 * An interaction policy: it bids for pressed pointers with gestures. Among bids for the same
 * pointers the highest priority wins (then the lower policy ID), once the arena resolves.
 */
export interface InteractionPolicy {
  /** A versioned ID, `<name>/<version>`, unique among the router's policies. */
  readonly id: string;
  /** The contract version it implements; must be {@link INTERACTION_API_VERSION}. */
  readonly apiVersion: number;
  /** Its rank among competing bids: a finite number, higher winning. */
  readonly priority: number;
  /**
   * Every command its gestures may name as their operation: at least one, each registered with
   * the router. A claim naming another throws {@link @swf/core!SwfFailure}
   * (`UNSUPPORTED_CAPABILITY`) from the dispatch.
   */
  readonly operations: readonly string[];
  /**
   * Bids for the pointers pressed on a target, or declines with null. Called on each press of the
   * arena, with every pointer pressed so far; a claim counts only when its `pointers` equals that
   * number. It must not change anything: it may be outbid.
   */
  claim(context: ClaimContext): GestureClaim | null;
}

const reasonOf = (error: SwfError): CancelReason =>
  error.code === 'CONSTRAINT_REJECTED' || error.code === 'LOCKED'
    ? 'constraint-rejected'
    : 'commit-rejected';

/** Ends a previewing gesture: commits its last accepted proposal, or reports why not. */
function commitLast(session: GestureSession, last: readonly SceneCommand[] | null): GestureFinish {
  if (last === null) {
    return { outcome: 'unchanged' };
  }
  const result = session.commit(last);
  return result.status === 'committed'
    ? { outcome: 'committed', transactionId: result.transactionId }
    : { outcome: 'cancelled', reason: reasonOf(result.error), error: result.error };
}

/** The target a press on a window may move or resize, if its flags allow. */
function movableTarget(
  context: ClaimContext,
  flag: 'draggable' | 'resizable',
): PickCandidate | null {
  if (context.pick.kind !== 'hit') {
    return null;
  }
  const target = context.pick.target;
  const node = context.scene.nodes.get(target.nodeId);
  return node !== undefined && node.flags[flag] && !node.flags.locked ? target : null;
}

/** A press on chrome, or on content when content is not live input here. */
function grabsWindow(context: ClaimContext): boolean {
  return (
    context.region === 'chrome' ||
    (context.region === 'content' &&
      (context.takeover || (context.pick.kind === 'hit' && context.pick.target.proxy)))
  );
}

/** Moves a window with one pointer, previewing on every move and committing once. */
class MoveGesture implements GestureHandler {
  readonly #session: GestureSession;
  readonly #nodeId: Id;
  readonly #placement: Placement;
  readonly #frame: DragFrame;
  #depth = 0;
  #pointer: PointerIntent | null = null;
  #last: SceneCommand[] | null = null;

  constructor(session: GestureSession, target: PickCandidate) {
    this.#session = session;
    this.#nodeId = target.nodeId;
    this.#placement = placementOf(session.scene(), target.nodeId);
    const s = session.settings;
    this.#frame = dragFrame(
      s.dragMode,
      eyeOf(session.view()),
      target.worldPoint,
      s.worldPlaneNormal,
      s.minDistance,
    );
  }

  update(pointers: readonly PointerIntent[]): void {
    const pointer = pointers[0];
    if (pointer === undefined) {
      return;
    }
    this.#pointer = pointer;
    const ray = this.#session.ray(pointer);
    if (ray.kind !== 'ray') {
      // Outside the image or where it has no inverse: hold the last position, keep the capture.
      return;
    }
    const anchor = dragAnchor(this.#frame, ray.ray, this.#depth);
    if (anchor !== null) {
      this.#propose(anchor);
    }
  }

  wheel(intent: WheelIntent): boolean {
    this.#depth -= wheelTurn(intent) * this.#session.settings.wheelDepthPerPixel;
    if (this.#pointer === null) {
      this.#propose(
        withDepth(this.#frame.eye, this.#frame.anchor, this.#depth, this.#frame.minDistance),
      );
    } else {
      this.update([this.#pointer]);
    }
    return true;
  }

  finish(): GestureFinish {
    return commitLast(this.#session, this.#last);
  }

  cancel(): void {
    // Everything this gesture changed is in its preview.
  }

  #propose(anchor: Vec3): void {
    const transform = movedTransform(this.#placement, this.#frame, anchor);
    if (transform === null) {
      return;
    }
    const commands: SceneCommand[] = [{ type: 'node.patch', id: this.#nodeId, transform }];
    // A rejected proposal (a constraint said no) leaves the last valid one in place.
    if (this.#session.preview(commands).status === 'previewed') {
      this.#last = commands;
    }
  }
}

/**
 * Drags a window's frame or a non-live surface (or its content during a takeover) to move the
 * window, as the `dragMode` setting maps the pointer, with the wheel adding depth. One pointer, a
 * draggable node that is not locked; previews on every move and commits once (`node.move`).
 * `swf.window-move/1`, priority 100.
 */
export const windowMovePolicy: InteractionPolicy = Object.freeze({
  id: 'swf.window-move/1',
  apiVersion: INTERACTION_API_VERSION,
  priority: 100,
  operations: Object.freeze(['node.move']),
  claim(context: ClaimContext): GestureClaim | null {
    const target = context.pointers.length === 1 ? movableTarget(context, 'draggable') : null;
    if (target === null || !grabsWindow(context)) {
      return null;
    }
    return {
      kind: 'drag',
      pointers: 1,
      operation: 'node.move',
      nodeId: target.nodeId,
      begin: (session) => new MoveGesture(session, target),
    };
  },
});

/** Resizes a window from an edge or corner, keeping the opposite side in place. */
class ResizeGesture implements GestureHandler {
  readonly #session: GestureSession;
  readonly #nodeId: Id;
  readonly #edge: ResizeEdge;
  readonly #placement: Placement;
  readonly #start: Vec3;
  readonly #bounds: Vec3;
  #last: SceneCommand[] | null = null;

  constructor(session: GestureSession, target: PickCandidate, edge: ResizeEdge) {
    this.#session = session;
    this.#nodeId = target.nodeId;
    this.#edge = edge;
    const scene = session.scene();
    this.#placement = placementOf(scene, target.nodeId);
    this.#start = target.localPoint;
    const node = scene.nodes.get(target.nodeId);
    if (node === undefined) {
      throw new Error(`node "${target.nodeId}" vanished before its resize began`);
    }
    this.#bounds = node.bounds;
  }

  update(pointers: readonly PointerIntent[]): void {
    const pointer = pointers[0];
    const ray = pointer === undefined ? null : this.#session.ray(pointer);
    const toLocal = mat4InvertAffine(this.#placement.world);
    if (ray?.kind !== 'ray' || toLocal === null) {
      return;
    }
    // Where the ray meets the window's own plane, in its local frame.
    const origin = mat4TransformPoint(toLocal, ray.ray.origin);
    const direction = mat4TransformDirection(toLocal, ray.ray.direction);
    if (direction[2] === 0) {
      return;
    }
    const t = -origin[2] / direction[2];
    if (!(t > 0)) {
      return;
    }
    const dx = origin[0] + t * direction[0] - this.#start[0];
    const dy = origin[1] + t * direction[1] - this.#start[1];
    const min = this.#session.settings.minSize;
    const [w, h, d] = this.#bounds;
    const east = this.#edge.includes('e') ? 1 : this.#edge.includes('w') ? -1 : 0;
    const north = this.#edge.includes('n') ? 1 : this.#edge.includes('s') ? -1 : 0;
    const width = east === 0 ? w : Math.max(min, w + east * dx);
    const height = north === 0 ? h : Math.max(min, h + north * dy);
    // The centre moves half the growth towards the dragged side.
    const shiftLocal: Vec3 = [(east * (width - w)) / 2, (north * (height - h)) / 2, 0];
    const shift = mat4TransformDirection(this.#placement.world, shiftLocal);
    const transform: Transform3D | null = translatedBy(this.#placement, shift);
    if (transform === null) {
      return;
    }
    const commands: SceneCommand[] = [
      { type: 'node.patch', id: this.#nodeId, bounds: [width, height, d], transform },
    ];
    if (this.#session.preview(commands).status === 'previewed') {
      this.#last = commands;
    }
  }

  finish(): GestureFinish {
    return commitLast(this.#session, this.#last);
  }

  cancel(): void {
    // Everything this gesture changed is in its preview.
  }
}

/**
 * Drags a resize handle to resize a window, keeping the opposite edge in place and no side
 * smaller than `minSize`. One pointer, a resizable node that is not locked; previews on every move
 * and commits once (`node.resize`). `swf.window-resize/1`, priority 110.
 */
export const windowResizePolicy: InteractionPolicy = Object.freeze({
  id: 'swf.window-resize/1',
  apiVersion: INTERACTION_API_VERSION,
  priority: 110,
  operations: Object.freeze(['node.resize']),
  claim(context: ClaimContext): GestureClaim | null {
    const target =
      context.pointers.length === 1 && context.region === 'resize-handle'
        ? movableTarget(context, 'resizable')
        : null;
    const edge = target?.edge ?? null;
    if (target === null || edge === null) {
      return null;
    }
    return {
      kind: 'drag',
      pointers: 1,
      operation: 'node.resize',
      nodeId: target.nodeId,
      begin: (session) => new ResizeGesture(session, target, edge),
    };
  },
});

/**
 * Turns the view by dragging the background: the camera in camera navigation (view state,
 * applied as it goes), or the orbit root in orbit navigation (previewed, committed once). The
 * grabbed direction stays under the pointer: angles are read in the view as it was at the press.
 */
class TurnGesture implements GestureHandler {
  readonly #session: GestureSession;
  readonly #target: 'camera' | 'orbit';
  readonly #view: ViewGeometry;
  readonly #projection: Projection;
  readonly #down: { longitude: number; latitude: number } | null;
  readonly #cameraId: Id;
  readonly #rotation: readonly [number, number, number, number];
  readonly #orbit: { rootId: Id; placement: Placement } | null;
  #previous: number;
  #last: SceneCommand[] | null = null;

  constructor(session: GestureSession, target: 'camera' | 'orbit', down: PointerIntent) {
    this.#session = session;
    this.#target = target;
    this.#view = session.view();
    this.#projection = session.projection();
    const at = this.#projection.interactionRay(down.x, down.y, this.#view);
    this.#down = at.kind === 'ray' ? { longitude: at.longitude, latitude: at.latitude } : null;
    this.#previous = this.#down?.longitude ?? 0;
    const scene = session.scene();
    const viewport = scene.viewports.get(session.viewportId);
    const camera = viewport === undefined ? undefined : scene.cameras.get(viewport.cameraId);
    if (camera === undefined) {
      throw new Error(`viewport "${session.viewportId}" has no camera`);
    }
    this.#cameraId = camera.id;
    this.#rotation = camera.rotation;
    const rootId = scene.orbitRootId;
    this.#orbit =
      target === 'orbit' && rootId !== null
        ? { rootId, placement: placementOf(scene, rootId) }
        : null;
  }

  update(pointers: readonly PointerIntent[]): void {
    const pointer = pointers[0];
    if (pointer === undefined || this.#down === null) {
      return;
    }
    const at = this.#projection.interactionRay(pointer.x, pointer.y, this.#view, {
      previousLongitude: this.#previous,
    });
    if (at.kind !== 'ray') {
      return;
    }
    this.#previous = at.longitude;
    const dLongitude = at.longitude - this.#down.longitude;
    const dLatitude = at.latitude - this.#down.latitude;
    if (this.#target === 'camera') {
      const { heading, pitch } = headingPitchOf(this.#rotation);
      const nextPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch - dLatitude));
      this.#session.transact([
        {
          type: 'camera.patch',
          id: this.#cameraId,
          rotation: cameraRotation(heading - dLongitude, nextPitch),
        },
      ]);
      return;
    }
    if (this.#orbit === null) {
      return;
    }
    const transform = turnedAbout(this.#orbit.placement, eyeOf(this.#view), dLongitude);
    if (transform === null) {
      return;
    }
    const commands: SceneCommand[] = [{ type: 'node.patch', id: this.#orbit.rootId, transform }];
    if (this.#session.preview(commands).status === 'previewed') {
      this.#last = commands;
    }
  }

  finish(): GestureFinish {
    return this.#target === 'camera'
      ? { outcome: 'committed', transactionId: null }
      : commitLast(this.#session, this.#last);
  }

  cancel(): void {
    if (this.#target === 'camera') {
      // The camera turned as the drag went; turn it back.
      this.#session.apply([{ type: 'camera.patch', id: this.#cameraId, rotation: this.#rotation }]);
    }
  }
}

/**
 * Dragging the background turns the view as the viewport's navigation setting says: never by a
 * guess from where the pointer is. In `camera` navigation the camera turns as the drag goes (view
 * state, not undoable; cancelling turns it back); in `orbit` navigation the orbit root turns in a
 * preview and commits once. One pointer on the background. `swf.background-navigation/1`,
 * priority 10.
 */
export const backgroundNavigationPolicy: InteractionPolicy = Object.freeze({
  id: 'swf.background-navigation/1',
  apiVersion: INTERACTION_API_VERSION,
  priority: 10,
  operations: Object.freeze(['camera.turn', 'orbit.turn']),
  claim(context: ClaimContext): GestureClaim | null {
    const down = context.pointers[0];
    const viewport = context.scene.viewports.get(context.viewportId);
    if (context.region !== 'background' || context.pointers.length !== 1 || down === undefined) {
      return null;
    }
    if (viewport === undefined) {
      return null;
    }
    const target = viewport.navigation;
    if (target === 'orbit' && context.scene.orbitRootId === null) {
      return null;
    }
    return {
      kind: 'drag',
      pointers: 1,
      operation: target === 'camera' ? 'camera.turn' : 'orbit.turn',
      nodeId: target === 'orbit' ? context.scene.orbitRootId : null,
      begin: (session) => new TurnGesture(session, target, down),
    };
  },
});

/**
 * A tap selects the window it lands on (and focuses it when its surface is only a proxy here, as
 * the eligible activation); a tap on the background clears the selection. A tap on live content
 * stays native and is not claimed. One pointer; commits at once on release.
 * `swf.tap-select/1`, priority 0.
 */
export const tapSelectPolicy: InteractionPolicy = Object.freeze({
  id: 'swf.tap-select/1',
  apiVersion: INTERACTION_API_VERSION,
  priority: 0,
  operations: Object.freeze(['selection.set', 'focus.set']),
  claim(context: ClaimContext): GestureClaim | null {
    if (context.pointers.length !== 1) {
      return null;
    }
    if (context.region === 'background') {
      return tap(null, [{ type: 'selection.set', ids: [] }]);
    }
    if (
      context.pick.kind !== 'hit' ||
      !(grabsWindow(context) || context.region === 'resize-handle')
    ) {
      return null;
    }
    const target = context.pick.target;
    const commands: SceneCommand[] = [{ type: 'selection.set', ids: [target.nodeId] }];
    if (target.proxy) {
      commands.push({ type: 'focus.set', id: target.nodeId });
    }
    return tap(target.nodeId, commands);
  },
});

function tap(nodeId: Id | null, commands: readonly SceneCommand[]): GestureClaim {
  return {
    kind: 'tap',
    pointers: 1,
    operation: 'selection.set',
    nodeId,
    begin: (session) => ({
      update: () => undefined,
      finish(): GestureFinish {
        const result = session.transact(commands);
        return result.status === 'committed'
          ? { outcome: 'committed', transactionId: result.transactionId }
          : { outcome: 'cancelled', reason: reasonOf(result.error), error: result.error };
      },
      cancel: () => undefined,
    }),
  };
}

/** Two pointers on a window: spreading them brings it nearer, pinching sends it away. */
class PinchDepthGesture implements GestureHandler {
  readonly #session: GestureSession;
  readonly #nodeId: Id;
  readonly #placement: Placement;
  readonly #eye: Vec3;
  readonly #anchor: Vec3;
  readonly #spread: number;
  #last: SceneCommand[] | null = null;

  constructor(session: GestureSession, target: PickCandidate, pointers: readonly PointerIntent[]) {
    this.#session = session;
    this.#nodeId = target.nodeId;
    this.#placement = placementOf(session.scene(), target.nodeId);
    this.#eye = eyeOf(session.view());
    this.#anchor = target.worldPoint;
    this.#spread = spreadOf(pointers);
  }

  update(pointers: readonly PointerIntent[]): void {
    const spread = spreadOf(pointers);
    if (!(spread >= 1) || !(this.#spread >= 1)) {
      return;
    }
    const radius = Math.hypot(...sub(this.#anchor, this.#eye));
    const depth = radius * (this.#spread / spread) - radius;
    const anchor = withDepth(this.#eye, this.#anchor, depth, this.#session.settings.minDistance);
    const transform = translatedBy(this.#placement, sub(anchor, this.#anchor));
    if (transform === null) {
      return;
    }
    const commands: SceneCommand[] = [{ type: 'node.patch', id: this.#nodeId, transform }];
    if (this.#session.preview(commands).status === 'previewed') {
      this.#last = commands;
    }
  }

  finish(): GestureFinish {
    return commitLast(this.#session, this.#last);
  }

  cancel(): void {
    // Everything this gesture changed is in its preview.
  }
}

function spreadOf(pointers: readonly PointerIntent[]): number {
  const [a, b] = pointers;
  return a === undefined || b === undefined ? 0 : Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Two pointers pressed on one window adjust its depth: spreading them brings it nearer, pinching
 * sends it away, never nearer the camera than `minDistance`. A draggable node that is not locked;
 * previews and commits once (`node.move`). `swf.pinch-depth/1`, priority 200.
 */
export const pinchDepthPolicy: InteractionPolicy = Object.freeze({
  id: 'swf.pinch-depth/1',
  apiVersion: INTERACTION_API_VERSION,
  priority: 200,
  operations: Object.freeze(['node.move']),
  claim(context: ClaimContext): GestureClaim | null {
    const target = context.pointers.length === 2 ? movableTarget(context, 'draggable') : null;
    if (target === null || !(grabsWindow(context) || context.region === 'resize-handle')) {
      return null;
    }
    const pointers = context.pointers;
    return {
      kind: 'drag',
      pointers: 2,
      operation: 'node.move',
      nodeId: target.nodeId,
      begin: (session) => new PinchDepthGesture(session, target, pointers),
    };
  },
});

/** The policies a router starts with, unless its options name others; frozen. */
export const BUILT_IN_POLICIES: readonly InteractionPolicy[] = Object.freeze([
  windowMovePolicy,
  windowResizePolicy,
  backgroundNavigationPolicy,
  tapSelectPolicy,
  pinchDepthPolicy,
]);
