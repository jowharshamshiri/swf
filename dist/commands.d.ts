import type { CancelReason, Id, JsonValue, PreviewApplied, SceneState, TxOutcome, WorkspaceMutator, WorkspaceReader } from '@swf/core';
import type { Transform3D, Vec3 } from '@swf/math';
import type { ViewGeometry } from '@swf/presentation';
import type { InteractionSettings } from './settings.js';
/**
 * What a command can use, as the router hands it to {@link InteractionCommand.run}. Built afresh
 * for each run; valid only during it.
 */
export interface CommandContext {
    /**
     * The router's workspace. Commands change it with the source `user`; a transaction requested
     * from inside a workspace event listener is refused.
     */
    readonly workspace: WorkspaceReader & WorkspaceMutator;
    /** The router's settings now; frozen. */
    readonly settings: InteractionSettings;
    /** The view of a viewport in the current scene; throws `UNKNOWN_ENTITY` for an unknown one. */
    view(viewportId: Id): ViewGeometry;
    /** Cancels every gesture in progress; returns how many there were. */
    cancelGestures(reason: CancelReason): number;
    /**
     * Picks a node up from the keyboard in a viewport: until it is put down or cancelled, the
     * commands that move, turn and resize it preview instead of committing. One node is held at a
     * time: a second hold, or a node already in a pointer's gesture, is `unchanged`; a node the
     * operator may not move (a locked one) is refused as its preview is. Throws
     * {@link SwfFailure} (`UNKNOWN_ENTITY`) for an unknown viewport, or a node that is unknown or
     * archived.
     */
    hold(viewportId: Id, nodeId: Id): CommandOutcome;
    /**
     * Puts the held node down: what its preview shows is committed once, or nothing when it was not
     * changed. `unchanged` when no node is held.
     */
    putDown(): CommandOutcome;
}
/**
 * How a command ended: a transaction's outcome, `previewed` when it changed only what a held
 * node's preview shows, `cancelled` with how many gestures were cancelled, or `unchanged` with why
 * nothing was done. The built-in commands report refusals of the scene as outcomes; they throw
 * only for invalid arguments, unknown entities, and a run from inside a workspace event listener
 * (`INVALID_TRANSITION`).
 */
export type CommandOutcome = TxOutcome | PreviewApplied | {
    /** Gestures were cancelled (`gesture.cancel`, or Escape). */
    readonly status: 'cancelled';
    /** How many gestures, pending and running, were cancelled; possibly 0. */
    readonly count: number;
} | {
    /** The command did nothing, and the scene is as it was. */
    readonly status: 'unchanged';
    /** Why, in words for the operator or a log: no node selected, the node may not move, … */
    readonly reason: string;
};
/**
 * A spatial operation by name. Keyboard bindings, controls and programs run commands; every pointer
 * gesture names the command that does the same thing, so nothing needs pointer precision.
 *
 * The built-in commands ({@link BUILT_IN_COMMANDS}) take an object of arguments and reject any
 * other argument; `nodeId`, where taken, defaults to the first selected node.
 */
export interface InteractionCommand {
    /**
     * A stable command ID such as `node.move`: two or more dot-separated words, each a lower-case
     * letter followed by letters and digits. Unique within a router.
     */
    readonly id: string;
    /**
     * Runs it, synchronously. Throws {@link SwfFailure} (`INVALID_INPUT`) naming the argument at
     * fault as the path `args.<name>`.
     */
    run(args: JsonValue, context: CommandContext): CommandOutcome;
}
/**
 * Why a value is not a valid command (not an object, an ID not shaped like `node.move`, no
 * `run`), or null when it is.
 */
export declare function commandIssue(value: unknown): string | null;
/** The camera position of a view, in world space: the translation of its camera matrix. */
export declare const eyeOf: (view: ViewGeometry) => Vec3;
/**
 * The world translation for moving `right` and `up` along the camera's axes and `depth` along
 * the line from the camera to `point`, never bringing it nearer than `minDistance`. All in world
 * units: `right` and `up` follow the camera's +X and +Y, and a positive `depth` moves away from
 * the camera.
 */
export declare function cameraRelativeDelta(view: ViewGeometry, point: Vec3, right: number, up: number, depth: number, minDistance: number): Vec3;
/** A change to one node's placement or size, as a `node.patch` makes it. */
export interface NodeChange {
    /** The node's new local transform, relative to its parent; absent when it stays. */
    readonly transform?: Transform3D;
    /** The node's new extent, width, height and depth in world units; absent when it stays. */
    readonly bounds?: Vec3;
}
type Unchanged = Extract<CommandOutcome, {
    status: 'unchanged';
}>;
/**
 * What a command does to a held node, worked out on `scene` (the node as its hold shows it); null
 * when the command is not one that moves, turns or resizes a node, or names another node, and so
 * runs as it always does.
 */
export declare function heldChange(id: string, args: JsonValue, scene: SceneState, heldId: Id, ctx: CommandContext): NodeChange | Unchanged | null;
/**
 * The commands every router offers; frozen. Each acts as the operator (source `user`) and commits
 * at once, except that moving, turning and resizing a held node previews it:
 * - `selection.set` `{ ids }`; `selection.next` and `selection.previous` `{}`, cycling through
 *   the selectable nodes in tree order;
 * - `focus.set` `{ nodeId }` (an ID or null); `focus.selected` `{}`;
 * - `node.move` `{ nodeId?, viewportId, right?, up?, depth? }`, along the viewport camera's axes
 *   and the line from it, in world units;
 * - `node.rotate` `{ nodeId?, yaw? }`, radians about the world vertical through the node's origin,
 *   positive turning clockwise seen from above;
 * - `node.resize` `{ nodeId?, width?, height? }`, changes in world units, never below `minSize`;
 * - `camera.turn` `{ viewportId, heading?, pitch? }`, radians, the pitch kept within ±π/2 (view
 *   state, not undoable); `orbit.turn` `{ viewportId, angle? }`, radians, the orbit root about the
 *   vertical through the camera (undoable);
 * - `history.undo` and `history.redo` `{}`;
 * - `gesture.grab` `{ viewportId, nodeId? }`, picking a node up from the keyboard;
 *   `gesture.drop` `{}`, putting it down; `gesture.cancel` `{}`, cancelling every gesture
 *   (`host`).
 */
export declare const BUILT_IN_COMMANDS: readonly InteractionCommand[];
export {};
//# sourceMappingURL=commands.d.ts.map