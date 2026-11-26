import type { CancelReason, Id, PreviewOutcome, SceneCommand, SceneState, SwfError, TxOutcome, TxResult } from '@swf/core';
import type { ViewGeometry } from '@swf/presentation';
import type { Projection, RayResult } from '@swf/projections';
import type { PointerIntent, WheelIntent } from './intents.js';
import type { InputRegion, PickResult } from './pick.js';
import type { InteractionSettings } from './settings.js';
/**
 * The version of the policy and input adapter contract this package defines. A policy or input
 * adapter states it as its `apiVersion`; any other value is refused at registration with
 * `UNSUPPORTED_CAPABILITY`.
 */
export declare const INTERACTION_API_VERSION = 1;
/** A pick that found something to press on: a hit or the background. */
export type PressPick = Extract<PickResult, {
    /** The kinds of pick a press can land on. */
    kind: 'hit' | 'background';
}>;
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
export type GestureFinish = {
    /** The gesture's result is committed. */
    readonly outcome: 'committed';
    /**
     * The committing transaction, or null when the gesture changed only view state (a camera
     * turn), which it applied as it went.
     */
    readonly transactionId: string | null;
} | {
    /** The gesture had nothing to commit: it never proposed a change the scene accepted. */
    readonly outcome: 'unchanged';
} | {
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
     * A wheel over the viewport during the gesture; true when the gesture used it, which consumes
     * it. Optional: without it, the wheel is routed as when no gesture runs.
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
/**
 * Drags a window's frame or a non-live surface (or its content during a takeover) to move the
 * window, as the `dragMode` setting maps the pointer, with the wheel adding depth. One pointer, a
 * draggable node that is not locked; previews on every move and commits once (`node.move`).
 * `swf.window-move/1`, priority 100.
 */
export declare const windowMovePolicy: InteractionPolicy;
/**
 * Drags a resize handle to resize a window, keeping the opposite edge in place and no side
 * smaller than `minSize`. One pointer, a resizable node that is not locked; previews on every move
 * and commits once (`node.resize`). `swf.window-resize/1`, priority 110.
 */
export declare const windowResizePolicy: InteractionPolicy;
/**
 * Dragging the background turns the view as the viewport's navigation setting says: never by a
 * guess from where the pointer is. In `camera` navigation the camera turns as the drag goes (view
 * state, not undoable; cancelling turns it back); in `orbit` navigation the orbit root turns in a
 * preview and commits once. One pointer on the background. `swf.background-navigation/1`,
 * priority 10.
 */
export declare const backgroundNavigationPolicy: InteractionPolicy;
/**
 * A tap selects the window it lands on (and focuses it when its surface is only a proxy here, as
 * the eligible activation); a tap on the background clears the selection. A tap on live content
 * stays native and is not claimed. One pointer; commits at once on release.
 * `swf.tap-select/1`, priority 0.
 */
export declare const tapSelectPolicy: InteractionPolicy;
/**
 * Two pointers pressed on one window adjust its depth: spreading them brings it nearer, pinching
 * sends it away, never nearer the camera than `minDistance`. A draggable node that is not locked;
 * previews and commits once (`node.move`). `swf.pinch-depth/1`, priority 200.
 */
export declare const pinchDepthPolicy: InteractionPolicy;
/** The policies a router starts with, unless its options name others; frozen. */
export declare const BUILT_IN_POLICIES: readonly InteractionPolicy[];
//# sourceMappingURL=policies.d.ts.map