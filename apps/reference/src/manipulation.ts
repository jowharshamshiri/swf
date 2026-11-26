import type { CancelReason, Id, SceneCommand, SwfError } from '@swf/core';
import type {
  ClaimContext,
  GestureClaim,
  GestureFinish,
  GestureHandler,
  GestureSession,
  InteractionPolicy,
  Placement,
  PointerIntent,
} from '@swf/interaction';
import {
  eyeOf,
  headingOf,
  INTERACTION_API_VERSION,
  placementOf,
  translatedBy,
  turnedAbout,
  windowResizePolicy,
  withDepth,
  worldOrigin,
} from '@swf/interaction';
import type { Vec3 } from '@swf/math';
import { mat4FromTransform, mat4Multiply, quatFromAxisAngle, quatRotate, sub } from '@swf/math';

/**
 * Direct manipulation in the panorama beyond the framework's own move and resize: the pointer
 * gestures a window takes with a modifier held. Each previews as the pointer moves, so the window
 * is seen where it would go all the way, and commits once when the pointer is released: one undo
 * puts the whole gesture back, and Escape cancels it with nothing changed.
 * - Shift and drag (the router's depth modifier, which the wheel uses too): the window moves round
 *   the camera as the pointer goes across, and nearer or farther as it goes down or up, as Shift
 *   and the wheel do: down pulls it in, up pushes it away.
 * - Ctrl (⌘ on a Mac) and drag: the window turns about its own vertical, to the right as the
 *   pointer goes right.
 * - Ctrl (⌘) and click: the window joins the selection, or leaves it if it was in it, as Ctrl and
 *   click do in a list; a plain click selects it alone.
 * They are taken on a window's frame or its edges (where a plain drag would move or resize it), or
 * on its content wherever a plain drag would move it (a proxy, or with Alt held).
 */

export const DEPTH_DRAG_POLICY_ID = 'reference.depth-drag/1';
export const TURN_DRAG_POLICY_ID = 'reference.turn-drag/1';
export const SELECT_TOGGLE_POLICY_ID = 'reference.select-toggle/1';

/**
 * How far a pixel of pointer travel takes a gesture: the depth drag scales the window's distance
 * by e^(−0.006) a pixel down (a hundred pixels down brings it to 55% as far, up to 182%), and the
 * turn drag turns it half a degree a pixel across.
 */
export const MANIPULATION = Object.freeze({ depthPerPixel: 0.006, turnPerPixel: Math.PI / 360 });

const reasonOf = (error: SwfError): CancelReason =>
  error.code === 'CONSTRAINT_REJECTED' || error.code === 'LOCKED'
    ? 'constraint-rejected'
    : 'commit-rejected';

/** Ends a previewing gesture: commits its last accepted proposal, or says why not. */
function commitLast(session: GestureSession, last: readonly SceneCommand[] | null): GestureFinish {
  if (last === null) {
    return { outcome: 'unchanged' };
  }
  const result = session.commit(last);
  return result.status === 'committed'
    ? { outcome: 'committed', transactionId: result.transactionId }
    : { outcome: 'cancelled', reason: reasonOf(result.error), error: result.error };
}

/** Where a press may take a window with a modifier: its frame, its edges, or grabbable content. */
function onWindow(context: ClaimContext): boolean {
  return (
    context.region === 'chrome' ||
    context.region === 'resize-handle' ||
    (context.region === 'content' &&
      (context.takeover || (context.pick.kind === 'hit' && context.pick.target.proxy)))
  );
}

/** Ctrl, or ⌘ on a Mac, held at the press. */
const commandHeld = (pointer: PointerIntent): boolean =>
  pointer.modifiers.ctrl || pointer.modifiers.meta;

/** The window one pointer pressed, when its flag lets the gesture act on it and it is not locked. */
function pressedWindow(
  context: ClaimContext,
  flag: 'draggable' | 'rotatable',
): { readonly nodeId: Id; readonly worldPoint: Vec3; readonly down: PointerIntent } | null {
  const down = context.pointers[0];
  if (context.pointers.length !== 1 || down === undefined || context.pick.kind !== 'hit') {
    return null;
  }
  const target = context.pick.target;
  const node = context.scene.nodes.get(target.nodeId);
  if (node?.kind !== 'window' || !node.flags[flag] || node.flags.locked || !onWindow(context)) {
    return null;
  }
  return { nodeId: target.nodeId, worldPoint: target.worldPoint, down };
}

/** The angle a heading has moved from `previous`, taken the short way round. */
const turnFrom = (previous: number, heading: number): number =>
  Math.atan2(Math.sin(heading - previous), Math.cos(heading - previous));

/** Shift and drag: round the camera as the pointer goes across, nearer or farther down and up. */
class DepthDrag implements GestureHandler {
  readonly #session: GestureSession;
  readonly #nodeId: Id;
  readonly #placement: Placement;
  readonly #eye: Vec3;
  readonly #anchor: Vec3;
  readonly #down: PointerIntent;
  /** The pointer's heading at the last sample, and how far round it has gone since the press. */
  #heading: number | null = null;
  #round = 0;
  #last: SceneCommand[] | null = null;

  constructor(session: GestureSession, nodeId: Id, grabbed: Vec3, down: PointerIntent) {
    this.#session = session;
    this.#nodeId = nodeId;
    this.#placement = placementOf(session.scene(), nodeId);
    this.#eye = eyeOf(session.view());
    this.#anchor = grabbed;
    this.#down = down;
    const ray = session.ray(down);
    this.#heading = ray.kind === 'ray' ? headingOf(ray.ray.direction) : null;
  }

  update(pointers: readonly PointerIntent[]): void {
    const pointer = pointers[0];
    if (pointer === undefined) {
      return;
    }
    const ray = this.#session.ray(pointer);
    if (ray.kind === 'ray') {
      const heading = headingOf(ray.ray.direction);
      if (this.#heading !== null) {
        // Unwrapped sample by sample, so going past the seam carries on round.
        this.#round += turnFrom(this.#heading, heading);
      }
      this.#heading = heading;
    }
    const placement = this.#placement;
    const turned = turnedAbout(placement, this.#eye, this.#round);
    if (turned === null) {
      return;
    }
    const round: Placement = {
      local: turned,
      parentWorld: placement.parentWorld,
      world: mat4Multiply(placement.parentWorld, mat4FromTransform(turned)),
    };
    // The grabbed point, carried round the camera with the window.
    const anchor: Vec3 = (() => {
      const q = quatFromAxisAngle([0, 1, 0], -this.#round);
      const offset = quatRotate(q, sub(this.#anchor, this.#eye));
      return [this.#eye[0] + offset[0], this.#eye[1] + offset[1], this.#eye[2] + offset[2]];
    })();
    const radius = Math.hypot(...sub(anchor, this.#eye));
    const scale = Math.exp(-(pointer.y - this.#down.y) * MANIPULATION.depthPerPixel);
    const moved = withDepth(
      this.#eye,
      anchor,
      radius * (scale - 1),
      this.#session.settings.minDistance,
    );
    const transform = translatedBy(round, sub(moved, anchor));
    if (transform === null) {
      return;
    }
    const commands: SceneCommand[] = [{ type: 'node.patch', id: this.#nodeId, transform }];
    // A rejected proposal (a constraint said no) leaves the last valid one in place.
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

/** Ctrl (⌘) and drag: turns the window about its own vertical by how far the pointer went across. */
class TurnDrag implements GestureHandler {
  readonly #session: GestureSession;
  readonly #nodeId: Id;
  readonly #placement: Placement;
  readonly #down: PointerIntent;
  #last: SceneCommand[] | null = null;

  constructor(session: GestureSession, nodeId: Id, down: PointerIntent) {
    this.#session = session;
    this.#nodeId = nodeId;
    this.#placement = placementOf(session.scene(), nodeId);
    this.#down = down;
  }

  update(pointers: readonly PointerIntent[]): void {
    const pointer = pointers[0];
    if (pointer === undefined) {
      return;
    }
    const yaw = (pointer.x - this.#down.x) * MANIPULATION.turnPerPixel;
    const transform = turnedAbout(this.#placement, worldOrigin(this.#placement), yaw);
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

/** The policies, each above the framework's move and resize so a modifier decides the gesture. */
const ABOVE = windowResizePolicy.priority + 10;

/**
 * Shift and drag on a window: round the camera and nearer or farther (`node.move`), previewed and
 * committed once.
 */
export const depthDragPolicy: InteractionPolicy = Object.freeze({
  id: DEPTH_DRAG_POLICY_ID,
  apiVersion: INTERACTION_API_VERSION,
  priority: ABOVE,
  operations: Object.freeze(['node.move']),
  claim(context: ClaimContext): GestureClaim | null {
    const pressed = pressedWindow(context, 'draggable');
    if (!pressed?.down.modifiers[context.settings.depthModifier]) {
      return null;
    }
    return {
      kind: 'drag',
      pointers: 1,
      operation: 'node.move',
      nodeId: pressed.nodeId,
      begin: (session) => new DepthDrag(session, pressed.nodeId, pressed.worldPoint, pressed.down),
    };
  },
});

/**
 * Ctrl (⌘) and drag on a window, without the depth modifier: turns it about its own vertical
 * (`node.rotate`), previewed and committed once.
 */
export const turnDragPolicy: InteractionPolicy = Object.freeze({
  id: TURN_DRAG_POLICY_ID,
  apiVersion: INTERACTION_API_VERSION,
  priority: ABOVE,
  operations: Object.freeze(['node.rotate']),
  claim(context: ClaimContext): GestureClaim | null {
    const pressed = pressedWindow(context, 'rotatable');
    if (
      pressed === null ||
      !commandHeld(pressed.down) ||
      pressed.down.modifiers[context.settings.depthModifier]
    ) {
      return null;
    }
    return {
      kind: 'drag',
      pointers: 1,
      operation: 'node.rotate',
      nodeId: pressed.nodeId,
      begin: (session) => new TurnDrag(session, pressed.nodeId, pressed.down),
    };
  },
});

/**
 * Ctrl (⌘) and click on a window: it joins the selection first, or leaves it if it was in it
 * (`selection.set`), committed at once. Locked windows can be selected too.
 */
export const selectTogglePolicy: InteractionPolicy = Object.freeze({
  id: SELECT_TOGGLE_POLICY_ID,
  apiVersion: INTERACTION_API_VERSION,
  priority: 1,
  operations: Object.freeze(['selection.set']),
  claim(context: ClaimContext): GestureClaim | null {
    const down = context.pointers[0];
    if (
      context.pointers.length !== 1 ||
      down === undefined ||
      !commandHeld(down) ||
      context.pick.kind !== 'hit' ||
      !onWindow(context)
    ) {
      return null;
    }
    const id = context.pick.target.nodeId;
    const selection = context.scene.selection;
    const ids = selection.includes(id)
      ? selection.filter((other) => other !== id)
      : [id, ...selection];
    const commands: SceneCommand[] = [{ type: 'selection.set', ids }];
    return {
      kind: 'tap',
      pointers: 1,
      operation: 'selection.set',
      nodeId: id,
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
  },
});

/** The manipulation policies, as the application registers them. */
export const MANIPULATION_POLICIES: readonly InteractionPolicy[] = Object.freeze([
  depthDragPolicy,
  turnDragPolicy,
  selectTogglePolicy,
]);
