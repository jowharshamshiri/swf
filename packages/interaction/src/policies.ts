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
import type { Vec3 } from '@swf/math';
import { models } from '@swf/models';
import type { ViewGeometry } from '@swf/presentation';
import type { Projection, RayResult } from '@swf/projections';
import { cameraRotation, headingPitchOf } from '@swf/projections';
import { eyeOf } from './commands.js';
import type { Placement } from './placement.js';
import { placementOf, turnedAbout } from './placement.js';
import type { PointerIntent, WheelIntent } from './intents.js';
import { wheelTurn } from './intents.js';
import type { RoomPlace } from './room.js';
import { ROOM_LIMITS, RoomMotion, roomPlaceOf, standingInRoom } from './room.js';
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
   * A takeover takes the press (`takesOver` of `@swf/models`): the router's takeover control is
   * on, or the takeover modifier was held on the first press over content that does not keep it.
   * Content-area presses may then be claimed.
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

/** A press on a window's title bar or card, or on content when content is not live input here. */
function grabsWindow(context: ClaimContext): boolean {
  return (
    context.region === 'title-bar' ||
    context.region === 'chrome' ||
    (context.region === 'content' &&
      (context.takeover || (context.pick.kind === 'hit' && context.pick.target.proxy)))
  );
}

/**
 * Moves a window round the room with one pointer (`Swf.Room`), previewing on every move and
 * committing once: across turns its heading at the view's angle a pixel, up and down raise and
 * lower it a fixed height a pixel whatever its distance, and with Shift held up and down move it
 * along the floor instead; the wheel moves it along the floor too. Each change of Shift, and each
 * wheel, carries on from where the window then stands.
 */
class MoveGesture implements GestureHandler {
  readonly #session: GestureSession;
  readonly #nodeId: Id;
  readonly #eye: Vec3;
  readonly #motion: RoomMotion;
  #last: SceneCommand[] | null = null;

  constructor(session: GestureSession, target: PickCandidate, down: PointerIntent) {
    this.#session = session;
    this.#nodeId = target.nodeId;
    this.#eye = eyeOf(session.view());
    this.#motion = new RoomMotion(roomPlaceOf(session.scene(), target.nodeId, this.#eye), down);
  }

  update(pointers: readonly PointerIntent[]): void {
    const pointer = pointers[0];
    if (pointer === undefined) {
      return;
    }
    const fieldOfView = this.#session.projection().describeDomain().horizontalCoverage;
    this.#propose(this.#motion.moved(pointer, this.#session.view().width, fieldOfView));
  }

  wheel(intent: WheelIntent): boolean {
    this.#propose(this.#motion.wheeled(wheelTurn(intent)));
    this.#motion.restart();
    return true;
  }

  finish(): GestureFinish {
    return commitLast(this.#session, this.#last);
  }

  cancel(): void {
    // Everything this gesture changed is in its preview.
  }

  #propose(place: RoomPlace): void {
    const transform = standingInRoom(this.#session.scene(), this.#nodeId, this.#eye, place);
    if (transform === null) {
      return;
    }
    const commands: SceneCommand[] = [{ type: 'node.patch', id: this.#nodeId, transform }];
    // A rejected proposal (a constraint said no) leaves the last valid one in place.
    if (this.#session.preview(commands).status === 'previewed') {
      this.#last = commands;
      this.#motion.accept(place);
    }
  }
}

/**
 * Drags a window's frame or a non-live surface (or its content during a takeover) to move the
 * window round the room: across turns it, up and down raise and lower it, Shift moves it along the
 * floor, and the wheel does too. One pointer, a draggable node that is not locked; previews on
 * every move and commits once (`node.move`). `swf.window-move/1`, priority 100.
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
    const down = context.pointers[0];
    if (down === undefined) {
      return null;
    }
    return {
      kind: 'drag',
      pointers: 1,
      operation: 'node.move',
      nodeId: target.nodeId,
      begin: (session) => new MoveGesture(session, target, down),
    };
  },
});

/**
 * Resizes a window from an edge or corner of its card, keeping its centre where it is: both sides
 * across, or both up and down, grow by the pointer's motion, in the card's pixels a unit.
 */
class ResizeGesture implements GestureHandler {
  readonly #session: GestureSession;
  readonly #nodeId: Id;
  readonly #edge: ResizeEdge;
  readonly #from: readonly [number, number];
  readonly #pixelsPerUnit: readonly [number, number];
  readonly #bounds: Vec3;
  #last: SceneCommand[] | null = null;

  constructor(
    session: GestureSession,
    target: PickCandidate,
    edge: ResizeEdge,
    down: PointerIntent,
  ) {
    this.#session = session;
    this.#nodeId = target.nodeId;
    this.#edge = edge;
    this.#from = [down.x, down.y];
    this.#pixelsPerUnit = target.pixelsPerUnit;
    const node = session.scene().nodes.get(target.nodeId);
    if (node === undefined) {
      throw new Error(`node "${target.nodeId}" vanished before its resize began`);
    }
    this.#bounds = node.bounds;
  }

  update(pointers: readonly PointerIntent[]): void {
    const pointer = pointers[0];
    if (pointer === undefined) {
      return;
    }
    const dx = (pointer.x - this.#from[0]) / this.#pixelsPerUnit[0];
    const dy = (this.#from[1] - pointer.y) / this.#pixelsPerUnit[1];
    const min = this.#session.settings.minSize;
    const [w, h, d] = this.#bounds;
    const east = this.#edge.includes('e') ? 1 : this.#edge.includes('w') ? -1 : 0;
    const north = this.#edge.includes('n') ? 1 : this.#edge.includes('s') ? -1 : 0;
    const width = east === 0 ? w : Math.max(min, w + 2 * east * dx);
    const height = north === 0 ? h : Math.max(min, h + 2 * north * dy);
    const commands: SceneCommand[] = [
      { type: 'node.patch', id: this.#nodeId, bounds: [width, height, d] },
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
 * Drags a resize handle to resize a window, keeping its centre in place and no side smaller than
 * `minSize`. One pointer, a resizable node that is not locked; previews on every move
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
    const down = context.pointers[0];
    if (target === null || edge === null || down === undefined) {
      return null;
    }
    return {
      kind: 'drag',
      pointers: 1,
      operation: 'node.resize',
      nodeId: target.nodeId,
      begin: (session) => new ResizeGesture(session, target, edge, down),
    };
  },
});

/**
 * Turns the view by dragging the background: the camera in camera navigation (view state,
 * applied as it goes, the camera kept level), or the orbit root in orbit navigation (previewed,
 * committed once), by the pointer's motion across at the view's angle a pixel.
 */
class TurnGesture implements GestureHandler {
  readonly #session: GestureSession;
  readonly #target: 'camera' | 'orbit';
  readonly #view: ViewGeometry;
  /** The view's angle for each pixel across, in radians. */
  readonly #perPixel: number;
  readonly #downX: number;
  readonly #cameraId: Id;
  readonly #rotation: readonly [number, number, number, number];
  readonly #orbit: { rootId: Id; placement: Placement } | null;
  #last: SceneCommand[] | null = null;

  constructor(session: GestureSession, target: 'camera' | 'orbit', down: PointerIntent) {
    this.#session = session;
    this.#target = target;
    this.#view = session.view();
    this.#perPixel = session.projection().describeDomain().horizontalCoverage / this.#view.width;
    this.#downX = down.x;
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
    if (pointer === undefined) {
      return;
    }
    // The room turns under the pointer: by the motion across, at the view's angle a pixel.
    const turn = (pointer.x - this.#downX) * this.#perPixel;
    if (this.#target === 'camera') {
      // The camera stays level: it turns in heading only.
      const { heading } = headingPitchOf(this.#rotation);
      this.#session.transact([
        { type: 'camera.patch', id: this.#cameraId, rotation: cameraRotation(heading - turn, 0) },
      ]);
      return;
    }
    if (this.#orbit === null) {
      return;
    }
    const transform = turnedAbout(this.#orbit.placement, eyeOf(this.#view), turn);
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
  readonly #eye: Vec3;
  readonly #start: RoomPlace;
  readonly #spread: number;
  #last: SceneCommand[] | null = null;

  constructor(session: GestureSession, target: PickCandidate, pointers: readonly PointerIntent[]) {
    this.#session = session;
    this.#nodeId = target.nodeId;
    this.#eye = eyeOf(session.view());
    this.#start = roomPlaceOf(session.scene(), target.nodeId, this.#eye);
    this.#spread = spreadOf(pointers);
  }

  update(pointers: readonly PointerIntent[]): void {
    const spread = spreadOf(pointers);
    if (!(spread >= 1) || !(this.#spread >= 1)) {
      return;
    }
    // Spread apart, the window comes nearer along the floor, by as much as the fingers spread.
    const place = models.keepInRoom(ROOM_LIMITS, {
      ...this.#start,
      floor: this.#start.floor * (this.#spread / spread),
    });
    const transform = standingInRoom(this.#session.scene(), this.#nodeId, this.#eye, place);
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
 * sends it away, along the floor and within the room's limits. A draggable node that is not locked;
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
