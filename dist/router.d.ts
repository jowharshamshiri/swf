import type { CancelReason, Id, WorkspaceMutator, WorkspaceReader } from '@swf/core';
import type { Continuity, ProjectionModule } from '@swf/projections';
import type { CommandOutcome, InteractionCommand } from './commands.js';
import type { InputIntent } from './intents.js';
import type { InputRegion, OcclusionLookup, PickCandidate, PickResult, PresentationLookup } from './pick.js';
import type { GestureFinish, InteractionPolicy } from './policies.js';
import type { InteractionSettings } from './settings.js';
/** Where a dispatched intent went. */
export type Route = 
/** Left to the content under it: the host lets the platform deliver it natively. */
'native'
/** Taken by a gesture (pending or running): the host keeps the pointer captured. */
 | 'gesture'
/** Ran a command. */
 | 'command'
/** Stopped by an active modal. */
 | 'blocked'
/** Nothing handles it. */
 | 'ignored';
/**
 * The answer to a dispatched intent: whether the host must keep it from the platform, and what
 * the router did with it. A fresh object for each dispatch.
 */
export interface DispatchResult {
    /**
     * True when the framework handled the intent and the host must not deliver it elsewhere
     * (prevent the platform's default and keep the pointer captured). False leaves it to the
     * platform: content input stays native.
     */
    readonly consumed: boolean;
    /** Where the intent went. */
    readonly route: Route;
    /** The region under the intent, for pointer and wheel intents that were picked. */
    readonly region: InputRegion | null;
    /**
     * The hit under the intent, for pointer and wheel intents that hit something; for a sample of
     * a gesture in progress, the hit its press picked. Null otherwise.
     */
    readonly target: PickCandidate | null;
    /** The gesture the intent belongs to, once one has won the arena. */
    readonly gestureId: string | null;
    /**
     * What a command or a finished gesture did: set when a command ran (a key binding, a command
     * intent, the wheel's depth move, Escape's `gesture.cancel`) or a gesture finished on this
     * intent. Null otherwise.
     */
    readonly operation: {
        /** The command's ID; for a gesture, the command that does what the gesture does. */
        readonly name: string;
        /** What it came to: a command's outcome, or how the gesture finished. */
        readonly outcome: CommandOutcome | GestureFinish;
    } | null;
    /** Why the intent was not consumed or not acted on, when it was not. */
    readonly reason: string | null;
    /**
     * The hit query the intent made, for pointer and wheel intents that picked: whether its best
     * two candidates tied, and how long it took by the router's timer, in milliseconds.
     */
    readonly pick: PickMeasure | null;
}
/** One hit query, measured. Frozen. */
export interface PickMeasure {
    /** True when the query hit something and its two best candidates tied. */
    readonly ambiguous: boolean;
    /** How long the query took, in milliseconds by the router's `timer`. */
    readonly ms: number;
}
/**
 * The policy ID a gesture held from the keyboard reports: a node picked up with `gesture.grab`,
 * moved, turned and resized in a preview, and put down once with `gesture.drop`, Enter or Space.
 */
export declare const KEYBOARD_HOLD_ID = "swf.keyboard-hold/1";
/**
 * Notifications from the router. Hosts release platform pointer capture and styling on them.
 * Events are delivered synchronously, during the call that caused them, to every listener in turn;
 * a listener that throws does not stop the others, and its error is kept for
 * {@link InteractionRouter.takeListenerErrors}.
 */
export type InteractionEvent = {
    /** A gesture won its arena and began: its pointers stay captured until it ends. */
    readonly type: 'gesture.started';
    /** The gesture's ID, unique within the router (`gesture-<n>`). */
    readonly gestureId: string;
    /** The policy whose gesture won, or {@link KEYBOARD_HOLD_ID} for a keyboard hold. */
    readonly policyId: string;
    /** The command that does what the gesture does, such as `node.move`. */
    readonly operation: string;
    /** The viewport the gesture runs in. */
    readonly viewportId: Id;
    /** The node the gesture acts on, or null when it acts on none (navigating, say). */
    readonly nodeId: Id | null;
    /** The pointers driving it, on their devices; empty for a keyboard hold. */
    readonly pointerIds: readonly number[];
} | {
    /** A gesture ended: committed, with nothing to commit, or cancelled. */
    readonly type: 'gesture.ended';
    /** The gesture that ended. */
    readonly gestureId: string;
    /** The viewport it ran in. */
    readonly viewportId: Id;
    /** How it finished. */
    readonly finish: GestureFinish;
} | {
    /**
     * The router no longer holds this pointer: the host releases its platform capture. Sent for
     * every pointer of an arena when its gesture ends, is cancelled or finds no taker.
     */
    readonly type: 'capture.released';
    /** The pointer's ID on its device. */
    readonly pointerId: number;
    /** The device the pointer belongs to. */
    readonly deviceId: string;
    /** The viewport it was pressed in. */
    readonly viewportId: Id;
}
/** `configure` changed the settings; they are layout-relevant, so a host may save them. */
 | {
    /** The settings changed. */
    readonly type: 'settings.changed';
    /** The settings now in force; frozen. */
    readonly settings: InteractionSettings;
};
/**
 * A device's connection to the router. The adapter and its device stay the host's: the router
 * calls `connect` once at registration and the returned function once when the adapter is
 * unregistered or the router disposed.
 */
export interface InputAdapter {
    /** A versioned ID, `<name>/<version>`, unique among the router's input adapters. */
    readonly id: string;
    /** The interaction contract version it implements; must be {@link INTERACTION_API_VERSION}. */
    readonly apiVersion: number;
    /**
     * Connects the device. The adapter calls `dispatch` with each normalized intent and acts on
     * its {@link DispatchResult} (prevent the platform's default when consumed, keep or release
     * pointer capture). `dispatch` throws as {@link InteractionRouter.dispatch} does.
     *
     * @returns A function that disconnects the device; anything else fails the registration.
     */
    connect(dispatch: (intent: InputIntent) => DispatchResult): () => void;
}
/**
 * What an interaction router works with. The router owns none of it: disposing the router
 * unsubscribes from the workspace and leaves everything here as it was.
 */
export interface InteractionRouterOptions {
    /**
     * The workspace whose scene the router picks in and changes. Gestures preview and commit
     * through it with the source `user`; the router follows its events to cancel gestures whose
     * viewport or target goes away.
     */
    readonly workspace: WorkspaceReader & WorkspaceMutator;
    /** Projection modules by ID, as a projection registry provides them. */
    readonly projections: {
        /**
         * The module registered under `id`, or undefined. Picking in a viewport whose projection is
         * not here throws {@link SwfFailure} (`UNSUPPORTED_CAPABILITY`).
         */
        get(id: string): ProjectionModule | undefined;
    };
    /** How each surface is presented per viewport. Default: every surface is live. */
    readonly presentation?: PresentationLookup;
    /** Which hits hide what lies behind them. Default: all of them. */
    readonly occlusion?: OcclusionLookup;
    /**
     * Overrides of {@link DEFAULT_SETTINGS}, checked as {@link mergeSettings} checks them; every key
     * binding must name a command the router has once `commands` are registered, as
     * {@link InteractionRouter.configure} requires.
     */
    readonly settings?: Partial<InteractionSettings>;
    /** The gesture policies, registered in order. Default: {@link BUILT_IN_POLICIES}. */
    readonly policies?: readonly InteractionPolicy[];
    /** Commands besides {@link BUILT_IN_COMMANDS}, registered after them. */
    readonly commands?: readonly InteractionCommand[];
    /**
     * The clock hit queries are timed with, in milliseconds: a monotonic one, such as
     * `performance.now`, for useful timings. Default `Date.now`. Anything but a function throws
     * {@link SwfFailure} (`INVALID_INPUT`).
     */
    readonly timer?: () => number;
}
/**
 * Routes normalized input: picks what lies under pointers, keeps content input native unless a
 * takeover is active, runs a gesture arena per pressed target, holds pointer capture across seams
 * and outside the viewport, previews gestures and commits each once, cancels them on every
 * documented path, and runs commands for keys and programs.
 *
 * The router is the caller's: dispose it with {@link InteractionRouter.dispose}, which cancels
 * every gesture, disconnects its input adapters and unsubscribes from the workspace. It never
 * disposes the workspace or the projection modules.
 *
 * @throws A {@link SwfFailure}: `INVALID_INPUT` for invalid settings (naming `settings.<field>`),
 *   a key binding to a command it does not have, a malformed command or policy, a taken ID or a
 *   `timer` that is not a function;
 *   `UNSUPPORTED_CAPABILITY` for a policy of another contract version or one whose operation has
 *   no command.
 *
 * @example
 * ```ts
 * const router = createInteractionRouter({ workspace, projections: registry });
 * const input = createSyntheticInput();
 * const unregister = router.registerInputAdapter(input);
 * const unsubscribe = router.subscribe((event) => {
 *   if (event.type === 'capture.released') releaseCapture(event.pointerId);
 * });
 * const result = input.pointer('down', 'main', 320, 240);
 * if (result.consumed) preventDefault();
 * // ...
 * unsubscribe();
 * unregister();
 * router.dispose();
 * ```
 */
export declare function createInteractionRouter(options: InteractionRouterOptions): InteractionRouter;
/**
 * The interaction router of one workspace, created with {@link createInteractionRouter}. Once it
 * is disposed, configuring, registering, subscribing, picking, dispatching and cancelling throw
 * {@link SwfFailure} (`INVALID_TRANSITION`); reading its settings, captures, listings and listener
 * errors does not.
 *
 * Gestures: a press on a target opens an arena where policies bid; when the pointer moves beyond
 * the slop the best `drag` bid begins, and when it lifts before that the best `tap` bid. A
 * gesture previews as it goes and commits once on release. It is cancelled by Escape (`escape`),
 * a lost capture (`capture-lost`), its viewport's deletion (`view-disposed`), its target's removal
 * (`target-detached`), a commit elsewhere that invalidates its preview, the workspace's disposal
 * (`workspace-disposed`), {@link InteractionRouter.cancel} (`host`), or an exception thrown by its
 * own code (`host`). Each end sends `gesture.ended` and releases every pointer with
 * `capture.released`.
 */
export declare class InteractionRouter {
    #private;
    /** Makes a router; {@link createInteractionRouter} does the same and is the documented way. */
    constructor(options: InteractionRouterOptions);
    /** The current settings; frozen. */
    settings(): InteractionSettings;
    /**
     * Changes settings, as {@link mergeSettings} merges and checks them, and sends
     * `settings.changed`. Throws {@link SwfFailure} (`INVALID_INPUT`) naming the first invalid field,
     * or a key binding to a command the router does not have, leaving the settings as they were.
     * Gestures already running keep the settings they began with.
     *
     * @returns The settings now in force; frozen.
     */
    configure(patch: Partial<InteractionSettings>): InteractionSettings;
    /**
     * Makes the given nodes (with their descendants) a modal: everything else takes no pointer
     * input until it is cleared with null. Presses and wheels outside it are consumed and
     * `blocked`. Throws {@link SwfFailure} (`UNKNOWN_ENTITY`) for a node the scene does not
     * have, leaving the modal as it was. The list is copied; a node later removed simply drops out.
     * Gestures already running are not cancelled.
     */
    setModal(nodeIds: readonly Id[] | null): void;
    /**
     * A named takeover control: while on, presses on content start gestures instead of input. It
     * stays as set until set again; the takeover modifier does the same for one press.
     */
    setTakeover(active: boolean): void;
    /**
     * The pointers held by pending or running gestures: the ones the host keeps captured. A fresh
     * array.
     */
    captures(): {
        /** The device the pointer belongs to. */
        readonly deviceId: string;
        /** The pointer's ID on its device. */
        readonly pointerId: number;
        /** The gesture it drives, or null while its arena is still pending. */
        readonly gestureId: string | null;
    }[];
    /**
     * Listener failures since the last call (a listener never breaks dispatch), as messages, oldest
     * first; also the failures of a gesture's `cancel`. Taking them clears them.
     */
    takeListenerErrors(): string[];
    /**
     * Calls `listener` with every router event from now on, synchronously and in order, until the
     * returned function is called; that function is safe to call more than once. Disposing the
     * router drops every listener, and a disposed router throws {@link SwfFailure}
     * (`INVALID_TRANSITION`) here, since it sends no more events. The listener is not checked: it
     * must be a function.
     */
    subscribe(listener: (event: InteractionEvent) => void): () => void;
    /**
     * Adds a policy. Throws {@link SwfFailure}: `INVALID_INPUT` for a malformed policy or a taken ID,
     * `UNSUPPORTED_CAPABILITY` for another contract version or an operation with no command. The
     * router keeps the policy object itself and calls it on later presses.
     *
     * @returns A function that removes the policy: its bids in pending arenas are withdrawn, and a
     *   gesture of it already running runs to its end. Calling it again does nothing.
     */
    registerPolicy(policy: InteractionPolicy): () => void;
    /** The IDs of the registered policies, sorted. A fresh array. */
    policyIds(): string[];
    /**
     * Adds a command. Throws {@link SwfFailure} (`INVALID_INPUT`) for a malformed command or a taken
     * ID. A command a registered policy names cannot be removed while that policy is registered.
     *
     * @returns A function that removes the command. It throws {@link SwfFailure}
     *   (`INVALID_TRANSITION`), removing nothing, while a registered policy names the command or a
     *   key binding runs it. Calling it after the command is removed does nothing.
     */
    registerCommand(command: InteractionCommand): () => void;
    /** The IDs of the registered commands, built-in ones included, sorted. A fresh array. */
    commandIds(): string[];
    /**
     * Connects an input device: calls its `connect` at once with a dispatch of its own, which routes
     * intents as {@link InteractionRouter.dispatch} does while the device is connected. Throws
     * {@link SwfFailure}: `INVALID_INPUT` for a malformed adapter, a taken ID or a `connect` that
     * returns no function, `UNSUPPORTED_CAPABILITY` for another contract version. An exception from
     * `connect` itself reaches the caller. A registration that fails leaves the device disconnected:
     * its dispatch then throws {@link SwfFailure} (`INVALID_TRANSITION`), as it does once the device
     * is disconnected, and its ID stays free.
     *
     * @returns A function that disconnects the device, calling the function `connect` returned.
     *   Calling it again does nothing.
     */
    registerInputAdapter(adapter: InputAdapter): () => void;
    /**
     * Picks at a viewport point in the current scene, as {@link pick} does, with the router's
     * settings, modal and lookups. `x` and `y` are in the viewport's CSS pixels from its top-left
     * corner. Throws {@link SwfFailure}: `UNKNOWN_ENTITY` for an unknown viewport,
     * `UNSUPPORTED_CAPABILITY` when its projection is not registered.
     */
    pick(viewportId: Id, x: number, y: number, continuity?: Continuity): PickResult;
    /**
     * Routes an intent. Throws {@link SwfFailure}: `INVALID_INPUT` for a malformed intent or an
     * unknown command, `UNKNOWN_ENTITY` for an unknown viewport, `UNSUPPORTED_CAPABILITY` when its
     * projection is not registered, `INVALID_TRANSITION` when called from inside a workspace event
     * listener in a way that would change the scene; and whatever a command throws.
     *
     * A pointer `down` picks and opens or joins its target's arena; `move` and `up` go to the arena
     * holding the pointer, and samples of a pointer no arena holds are ignored. A second `down` of a
     * pointer still held, or a `cancel`, cancels its gesture (`capture-lost`). Presses on content
     * stay native unless a takeover is active or the content is a proxy. A wheel goes to a running
     * gesture in its viewport that takes it, else moves the window under it in depth when the depth
     * modifier is held. A key runs the keymap while focus is in the workspace, Escape cancels every
     * gesture, and Enter or Space puts a held node down. An exception thrown by a gesture's code
     * cancels that gesture (`host`) and then reaches the caller.
     */
    dispatch(intent: InputIntent): DispatchResult;
    /**
     * Cancels every pending and running gesture with `reason` (default `host`), a held node
     * included; returns how many there were.
     */
    cancel(reason?: CancelReason): number;
    /**
     * Cancels every gesture (`view-disposed`), disconnects adapters and stops listening: listeners
     * receive the resulting `gesture.ended` and `capture.released` events, then are dropped. The
     * workspace is left as it is. Calling it again does nothing.
     */
    dispose(): void;
}
//# sourceMappingURL=router.d.ts.map