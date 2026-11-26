import { descendantIds, makeError, SwfFailure, VERSIONED_ID } from '@swf/core';
import { viewGeometryOf } from '@swf/presentation';
import { projectionFor } from '@swf/projections';
import { models } from '@swf/models';
import { BUILT_IN_COMMANDS, commandIssue, heldChange } from './commands.js';
import { intentIssue } from './intents.js';
import { pick } from './pick.js';
import { BUILT_IN_POLICIES, INTERACTION_API_VERSION } from './policies.js';
import { SceneIndex } from './scene-index.js';
import { DEFAULT_SETTINGS, keyName, mergeSettings } from './settings.js';
/**
 * The policy ID a gesture held from the keyboard reports: a node picked up with `gesture.grab`,
 * moved, turned and resized in a preview, and put down once with `gesture.drop`, Enter or Space.
 */
export const KEYBOARD_HOLD_ID = 'swf.keyboard-hold/1';
/** A pointer is identified by its device and its ID on that device. */
const pointerKey = (p) => `${p.deviceId}\u0000${String(p.pointerId)}`;
/** The arena of whatever gesture runs on a node in a viewport, pointer or keyboard. */
const nodeArenaKey = (viewportId, nodeId) => `${viewportId}\u0000node:${nodeId}`;
/** Keys that put a held node down. */
const NOT_HANDLED = (reason, extra = {}) => ({
    consumed: false,
    route: 'ignored',
    region: null,
    target: null,
    gestureId: null,
    operation: null,
    reason,
    ...extra,
});
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
export function createInteractionRouter(options) {
    return new InteractionRouter(options);
}
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
export class InteractionRouter {
    #workspace;
    #projections;
    #presentation;
    #occlusion;
    #timer;
    /** The hit query of the dispatch under way, once it has made one. */
    #lastPick = null;
    #settings;
    #policies = new Map();
    #commands = new Map();
    #adapters = new Map();
    #arenas = new Map();
    #pressed = new Map();
    #listeners = new Set();
    #index = new SceneIndex();
    #unsubscribe;
    #modal = null;
    #takeover = false;
    #nextGesture = 1;
    #hold = null;
    #disposed = false;
    #errors = [];
    /** Makes a router; {@link createInteractionRouter} does the same and is the documented way. */
    constructor(options) {
        this.#workspace = options.workspace;
        this.#projections = options.projections;
        this.#presentation = options.presentation ?? (() => 'live');
        this.#occlusion = options.occlusion ?? (() => 'occluding');
        if (options.timer !== undefined && typeof options.timer !== 'function') {
            throw failure('INVALID_INPUT', 'timer must be a function');
        }
        this.#timer = options.timer ?? Date.now;
        this.#settings = mergeSettings(DEFAULT_SETTINGS, options.settings ?? {});
        for (const command of [...BUILT_IN_COMMANDS, ...(options.commands ?? [])]) {
            this.registerCommand(command);
        }
        this.#checkKeymap(this.#settings);
        for (const policy of options.policies ?? BUILT_IN_POLICIES) {
            this.registerPolicy(policy);
        }
        this.#unsubscribe = this.#workspace.subscribe((event) => {
            this.#onWorkspaceEvent(event);
        });
    }
    /** The current settings; frozen. */
    settings() {
        return this.#settings;
    }
    /**
     * Changes settings, as {@link mergeSettings} merges and checks them, and sends
     * `settings.changed`. Throws {@link SwfFailure} (`INVALID_INPUT`) naming the first invalid field,
     * or a key binding to a command the router does not have, leaving the settings as they were.
     * Gestures already running keep the settings they began with.
     *
     * @returns The settings now in force; frozen.
     */
    configure(patch) {
        this.#live();
        const next = mergeSettings(this.#settings, patch);
        this.#checkKeymap(next);
        this.#settings = next;
        this.#emit({ type: 'settings.changed', settings: next });
        return next;
    }
    /**
     * Makes the given nodes (with their descendants) a modal: everything else takes no pointer
     * input until it is cleared with null. Presses and wheels outside it are consumed and
     * `blocked`. Throws {@link SwfFailure} (`UNKNOWN_ENTITY`) for a node the scene does not
     * have, leaving the modal as it was. The list is copied; a node later removed simply drops out.
     * Gestures already running are not cancelled.
     */
    setModal(nodeIds) {
        this.#live();
        if (nodeIds !== null) {
            const scene = this.#workspace.getState();
            const unknown = nodeIds.find((id) => !scene.nodes.has(id));
            if (unknown !== undefined) {
                throw failure('UNKNOWN_ENTITY', `no node "${unknown}" for the modal`);
            }
        }
        this.#modal = nodeIds === null ? null : Object.freeze([...nodeIds]);
    }
    /**
     * A named takeover control: while on, presses on content start gestures instead of input. It
     * stays as set until set again; the takeover modifier does the same for one press.
     */
    setTakeover(active) {
        this.#live();
        this.#takeover = active;
    }
    /**
     * The pointers held by pending or running gestures: the ones the host keeps captured. A fresh
     * array.
     */
    captures() {
        return [...this.#pressed.entries()].map(([key, arena]) => {
            const pressed = arena.pointers.get(key);
            if (pressed === undefined) {
                throw new Error('a captured pointer has no arena entry');
            }
            return {
                deviceId: pressed.down.deviceId,
                pointerId: pressed.down.pointerId,
                gestureId: arena.running?.id ?? null,
            };
        });
    }
    /**
     * Listener failures since the last call (a listener never breaks dispatch), as messages, oldest
     * first; also the failures of a gesture's `cancel`. Taking them clears them.
     */
    takeListenerErrors() {
        const errors = this.#errors;
        this.#errors = [];
        return errors;
    }
    /**
     * Calls `listener` with every router event from now on, synchronously and in order, until the
     * returned function is called; that function is safe to call more than once. Disposing the
     * router drops every listener, and a disposed router throws {@link SwfFailure}
     * (`INVALID_TRANSITION`) here, since it sends no more events. The listener is not checked: it
     * must be a function.
     */
    subscribe(listener) {
        this.#live();
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }
    /**
     * Adds a policy. Throws {@link SwfFailure}: `INVALID_INPUT` for a malformed policy or a taken ID,
     * `UNSUPPORTED_CAPABILITY` for another contract version or an operation with no command. The
     * router keeps the policy object itself and calls it on later presses.
     *
     * @returns A function that removes the policy: its bids in pending arenas are withdrawn, and a
     *   gesture of it already running runs to its end. Calling it again does nothing.
     */
    registerPolicy(policy) {
        this.#live();
        const raw = policy;
        if (typeof raw !== 'object' || raw === null) {
            throw failure('INVALID_INPUT', 'a policy must be an object');
        }
        if (typeof policy.id !== 'string' || !VERSIONED_ID.test(policy.id)) {
            throw failure('INVALID_INPUT', `a policy ID must look like "name/1" (got ${JSON.stringify(policy.id)})`);
        }
        if (typeof policy.claim !== 'function') {
            throw failure('INVALID_INPUT', `policy "${policy.id}" must implement claim()`);
        }
        if (typeof policy.priority !== 'number' || !Number.isFinite(policy.priority)) {
            throw failure('INVALID_INPUT', `policy "${policy.id}" must have a finite priority`);
        }
        if (policy.apiVersion !== INTERACTION_API_VERSION) {
            throw failure('UNSUPPORTED_CAPABILITY', `policy "${policy.id}" implements contract version ${String(policy.apiVersion)}, not ${String(INTERACTION_API_VERSION)}`);
        }
        const operations = policy.operations;
        if (!Array.isArray(operations) || operations.length === 0) {
            throw failure('INVALID_INPUT', `policy "${policy.id}" must list its operations`);
        }
        const missing = operations.find((op) => typeof op !== 'string' || !this.#commands.has(op));
        if (missing !== undefined) {
            throw failure('UNSUPPORTED_CAPABILITY', `policy "${policy.id}" performs ${JSON.stringify(missing)}, which has no command equivalent`);
        }
        if (this.#policies.has(policy.id)) {
            throw failure('INVALID_INPUT', `policy "${policy.id}" is already registered`);
        }
        this.#policies.set(policy.id, policy);
        return () => {
            if (this.#policies.get(policy.id) === policy) {
                this.#policies.delete(policy.id);
                for (const arena of this.#arenas.values()) {
                    arena.claims = arena.claims.filter((c) => c.policy !== policy);
                }
            }
        };
    }
    /** The IDs of the registered policies, sorted. A fresh array. */
    policyIds() {
        return [...this.#policies.keys()].sort();
    }
    /**
     * Adds a command. Throws {@link SwfFailure} (`INVALID_INPUT`) for a malformed command or a taken
     * ID. A command a registered policy names cannot be removed while that policy is registered.
     *
     * @returns A function that removes the command. It throws {@link SwfFailure}
     *   (`INVALID_TRANSITION`), removing nothing, while a registered policy names the command or a
     *   key binding runs it. Calling it after the command is removed does nothing.
     */
    registerCommand(command) {
        this.#live();
        const issue = commandIssue(command);
        if (issue !== null) {
            throw failure('INVALID_INPUT', issue);
        }
        if (this.#commands.has(command.id)) {
            throw failure('INVALID_INPUT', `command "${command.id}" is already registered`);
        }
        this.#commands.set(command.id, command);
        return () => {
            if (this.#commands.get(command.id) !== command) {
                return;
            }
            const user = [...this.#policies.values()].find((p) => p.operations.includes(command.id));
            if (user !== undefined) {
                throw failure('INVALID_TRANSITION', `command "${command.id}" is the equivalent of policy "${user.id}"; remove the policy first`);
            }
            const bound = this.#settings.keymap.find((b) => b.command === command.id);
            if (bound !== undefined) {
                throw failure('INVALID_TRANSITION', `command "${command.id}" is bound to the key "${bound.key}"; rebind it first`);
            }
            this.#commands.delete(command.id);
        };
    }
    /** The IDs of the registered commands, built-in ones included, sorted. A fresh array. */
    commandIds() {
        return [...this.#commands.keys()].sort();
    }
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
    registerInputAdapter(adapter) {
        this.#live();
        const raw = adapter;
        if (typeof raw !== 'object' || raw === null || typeof adapter.connect !== 'function') {
            throw failure('INVALID_INPUT', 'an input adapter must be an object with connect()');
        }
        if (typeof adapter.id !== 'string' || !VERSIONED_ID.test(adapter.id)) {
            throw failure('INVALID_INPUT', `an input adapter ID must look like "name/1" (got ${JSON.stringify(adapter.id)})`);
        }
        if (adapter.apiVersion !== INTERACTION_API_VERSION) {
            throw failure('UNSUPPORTED_CAPABILITY', `input adapter "${adapter.id}" implements contract version ${String(adapter.apiVersion)}, not ${String(INTERACTION_API_VERSION)}`);
        }
        if (this.#adapters.has(adapter.id)) {
            throw failure('INVALID_INPUT', `input adapter "${adapter.id}" is already registered`);
        }
        let connected = true;
        const dispatch = (intent) => {
            if (!connected) {
                throw failure('INVALID_TRANSITION', `input adapter "${adapter.id}" is not connected`);
            }
            return this.dispatch(intent);
        };
        let returned;
        try {
            returned = adapter.connect(dispatch);
        }
        catch (error) {
            connected = false;
            throw error;
        }
        if (typeof returned !== 'function') {
            connected = false;
            throw failure('INVALID_INPUT', `input adapter "${adapter.id}" must return a disconnect function`);
        }
        const release = returned;
        const disconnect = () => {
            connected = false;
            release();
        };
        this.#adapters.set(adapter.id, disconnect);
        return () => {
            if (this.#adapters.get(adapter.id) === disconnect) {
                this.#adapters.delete(adapter.id);
                disconnect();
            }
        };
    }
    /**
     * Picks at a viewport point in the current scene, as {@link pick} does, with the router's
     * settings, modal and lookups. `x` and `y` are in the viewport's CSS pixels from its top-left
     * corner. Throws {@link SwfFailure}: `UNKNOWN_ENTITY` for an unknown viewport,
     * `UNSUPPORTED_CAPABILITY` when its projection is not registered.
     */
    pick(viewportId, x, y, continuity) {
        this.#live();
        const scene = this.#workspace.getState();
        const view = viewGeometryOf(scene, viewportId);
        return this.#pickIn(scene, view, x, y, continuity);
    }
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
    dispatch(intent) {
        this.#live();
        const issue = intentIssue(intent);
        if (issue !== null) {
            throw failure('INVALID_INPUT', `intent: ${issue}`);
        }
        // A dispatch made while another runs (by a policy, say) reports its own hit query only.
        const outer = this.#lastPick;
        this.#lastPick = null;
        try {
            const routed = this.#route(intent);
            return { ...routed, pick: this.#lastPick };
        }
        finally {
            this.#lastPick = outer;
        }
    }
    #route(intent) {
        switch (intent.kind) {
            case 'pointer':
                return this.#pointer(intent);
            case 'wheel':
                return this.#wheel(intent);
            case 'key':
                return this.#key(intent);
            case 'command':
                return this.#command(intent);
        }
    }
    /**
     * Cancels every pending and running gesture with `reason` (default `host`), a held node
     * included; returns how many there were.
     */
    cancel(reason = 'host') {
        this.#live();
        return this.#cancelWhere(() => true, reason);
    }
    /**
     * Cancels every gesture (`view-disposed`), disconnects adapters and stops listening: listeners
     * receive the resulting `gesture.ended` and `capture.released` events, then are dropped. The
     * workspace is left as it is. Calling it again does nothing.
     */
    dispose() {
        if (this.#disposed) {
            return;
        }
        this.#cancelWhere(() => true, 'view-disposed');
        for (const disconnect of this.#adapters.values()) {
            disconnect();
        }
        this.#adapters.clear();
        this.#unsubscribe();
        this.#listeners.clear();
        this.#disposed = true;
    }
    // --- pointers ---------------------------------------------------------------------------
    #pointer(intent) {
        const key = pointerKey(intent);
        const arena = this.#pressed.get(key);
        const route = models.pointerRoute({ kind: intent.phase }, arena !== undefined);
        if (route.kind === 'press') {
            return this.#press(intent, key);
        }
        if (route.kind === 'ignore') {
            // A sample of a pointer no gesture holds (one already ended or cancelled) is ignored.
            return NOT_HANDLED('the pointer is not captured');
        }
        if (arena === undefined) {
            throw new Error(`the gesture model routed a sample of an uncaptured pointer to ${route.kind}`);
        }
        switch (route.kind) {
            case 'pressAfterLost':
                // A second press of a pointer still held means its release was lost.
                this.#cancelArena(arena, 'capture-lost');
                return this.#press(intent, key);
            case 'move':
                return this.#move(arena, key, intent);
            case 'release':
                return this.#release(arena, key, intent);
            case 'lost':
                this.#cancelArena(arena, 'capture-lost');
                return { ...this.#handled(arena), reason: 'capture lost' };
        }
    }
    #press(intent, key) {
        const scene = this.#workspace.getState();
        const view = viewGeometryOf(scene, intent.viewportId);
        const result = this.#pickIn(scene, view, intent.x, intent.y);
        const picked = result.kind === 'hit' || result.kind === 'background' ? result : null;
        const target = picked?.kind === 'hit' ? picked.target : null;
        const takeover = this.#takeover || intent.modifiers[this.#settings.takeoverModifier];
        const arenaKey = target === null
            ? `${intent.viewportId}\u0000background`
            : nodeArenaKey(intent.viewportId, target.nodeId);
        const existing = this.#arenas.get(arenaKey);
        const route = models.pressRoute({
            pick: { kind: picked === null ? 'none' : picked.kind },
            region: { kind: REGIONS[picked?.region ?? 'background'] },
            takeover,
            proxy: target?.proxy === true,
            busy: existing?.running != null,
        });
        if (picked === null) {
            if (route.kind !== 'ignore' || result.kind === 'hit' || result.kind === 'background') {
                throw new Error(`the gesture model routed a press on nothing to ${route.kind}`);
            }
            return NOT_HANDLED(result.reason);
        }
        const base = { region: picked.region, target };
        switch (route.kind) {
            case 'ignore':
                throw new Error('the gesture model ignored a press on something picked');
            case 'blocked':
                return { ...NOT_HANDLED('a modal is active'), ...base, consumed: true, route: 'blocked' };
            case 'native':
                return { ...NOT_HANDLED('content input stays native'), ...base, route: 'native' };
            case 'busy':
                // One gesture per target: a further pointer neither joins it nor reaches anything else.
                return {
                    ...NOT_HANDLED('the target is already in a gesture'),
                    ...base,
                    consumed: true,
                };
            case 'claim':
                break;
        }
        const arena = existing ?? {
            key: arenaKey,
            viewportId: intent.viewportId,
            pick: picked,
            region: picked.region,
            pointers: new Map(),
            claims: [],
            running: null,
            phase: IDLE,
            ending: false,
        };
        arena.pointers.set(key, { down: intent, last: intent, continuity: undefined });
        const claims = this.#claims(arena, scene, takeover);
        if (claims.length === 0) {
            arena.pointers.delete(key);
            return { ...NOT_HANDLED('no policy takes this press'), ...base };
        }
        arena.claims = claims;
        if (existing === undefined) {
            this.#step(arena, { kind: 'claimed' });
        }
        this.#arenas.set(arenaKey, arena);
        this.#pressed.set(key, arena);
        return { ...this.#handled(arena), ...base };
    }
    #claims(arena, scene, takeover) {
        const { pick, region } = arena;
        if (pick === null || region === null) {
            throw new Error('only pressed pointers are claimed');
        }
        const context = {
            viewportId: arena.viewportId,
            scene,
            pick,
            region,
            pointers: [...arena.pointers.values()].map((p) => p.down),
            takeover,
            settings: this.#settings,
        };
        const claims = [];
        for (const policy of this.#policies.values()) {
            const claim = policy.claim(context);
            if (claim === null) {
                continue;
            }
            if (claim.pointers !== context.pointers.length) {
                continue;
            }
            if (!policy.operations.includes(claim.operation)) {
                throw failure('UNSUPPORTED_CAPABILITY', `policy "${policy.id}" claimed operation "${claim.operation}", which it does not declare`);
            }
            claims.push({ policy, claim });
        }
        return claims;
    }
    #move(arena, key, intent) {
        const pressed = arena.pointers.get(key);
        if (pressed === undefined) {
            return NOT_HANDLED('the pointer is not captured');
        }
        pressed.last = intent;
        if (arena.running !== null) {
            this.#guard(arena, () => {
                arena.running?.handler.update(this.#lasts(arena));
            });
            return this.#handled(arena);
        }
        const moved = Math.hypot(intent.x - pressed.down.x, intent.y - pressed.down.y);
        if (!models.beyondSlop(moved, this.#settings.slopPx)) {
            return this.#handled(arena);
        }
        const winner = best(arena.claims, 'drag', arena.pointers.size);
        if (this.#step(arena, { kind: 'movedBeyond', winner: winner !== null }) === 'idle' ||
            winner === null) {
            this.#forget(arena);
            return { ...this.#handled(arena), gestureId: null, reason: 'no gesture drags this press' };
        }
        this.#begin(arena, winner);
        this.#guard(arena, () => {
            arena.running?.handler.update(this.#lasts(arena));
        });
        return this.#handled(arena);
    }
    #release(arena, key, intent) {
        const pressed = arena.pointers.get(key);
        if (pressed !== undefined) {
            pressed.last = intent;
        }
        if (arena.running === null) {
            const winner = best(arena.claims, 'tap', arena.pointers.size);
            if (this.#step(arena, { kind: 'releasedPending', winner: winner !== null }) === 'idle' ||
                winner === null) {
                this.#forget(arena);
                return { ...this.#handled(arena), reason: 'no gesture takes a tap here' };
            }
            this.#begin(arena, winner);
        }
        const running = arena.running;
        if (running === null) {
            throw new Error('a gesture that began is not running');
        }
        const finish = this.#guard(arena, () => running.handler.finish());
        this.#finished(arena, finish);
        const result = {
            ...this.#handled(arena),
            operation: { name: running.operation, outcome: finish },
        };
        if (finish.outcome === 'cancelled') {
            const { reason } = finish;
            this.#guardQuietly(() => {
                running.handler.cancel(reason);
            });
        }
        this.#end(arena, finish);
        return result;
    }
    #begin(arena, winner) {
        const id = `gesture-${String(this.#nextGesture++)}`;
        const previewId = `interaction:${id}`;
        const session = this.#session(arena, id, previewId);
        let handler;
        try {
            handler = winner.claim.begin(session);
        }
        catch (error) {
            this.#forget(arena);
            throw error;
        }
        arena.running = {
            id,
            policyId: winner.policy.id,
            operation: winner.claim.operation,
            nodeId: winner.claim.nodeId,
            handler,
            previewId,
        };
        arena.claims = [];
        this.#emit({
            type: 'gesture.started',
            gestureId: id,
            policyId: winner.policy.id,
            operation: winner.claim.operation,
            viewportId: arena.viewportId,
            nodeId: winner.claim.nodeId,
            pointerIds: [...arena.pointers.values()].map((p) => p.down.pointerId),
        });
    }
    #session(arena, gestureId, previewId) {
        const workspace = this.#workspace;
        const viewportId = arena.viewportId;
        const user = { source: 'user' };
        const view = () => viewGeometryOf(workspace.getState(), viewportId);
        const projection = (v) => this.#projection(v);
        return Object.freeze({
            gestureId,
            viewportId,
            settings: this.#settings,
            scene: () => workspace.getState(),
            view,
            projection: () => projection(view()),
            ray: (pointer) => {
                const pressed = arena.pointers.get(pointerKey(pointer));
                const v = view();
                const result = projection(v).interactionRay(pointer.x, pointer.y, v, pressed?.continuity);
                if (result.kind === 'ray' && pressed !== undefined) {
                    pressed.continuity = { previousLongitude: result.longitude };
                }
                return result;
            },
            preview: (commands) => settled(workspace.preview(previewId, commands, user)),
            commit: (commands) => settled(workspace.transaction(commands, { ...user, previewId })),
            transact: (commands) => settled(workspace.transaction(commands, user)),
            apply: (commands) => workspace.transaction(commands, user),
        });
    }
    /** Moves the arena's gesture as the gesture model decides; an event out of order is a defect. */
    #step(arena, event) {
        const next = models.gestureStep(arena.phase, event);
        if (next === null) {
            throw new Error(`a gesture cannot take ${event.kind} while ${arena.phase.kind}`);
        }
        arena.phase = next;
        return next.kind;
    }
    /** Records how the arena's gesture finished: committed, with nothing to commit, or not. */
    #finished(arena, finish) {
        if (arena.ending) {
            // Cancelled while finishing (its refused commit cancelled its preview): already ended.
            return;
        }
        this.#step(arena, {
            kind: 'finished',
            f: { kind: finish.outcome === 'cancelled' ? 'rejected' : finish.outcome },
        });
    }
    /** Ends an arena: discards a leftover preview, releases its pointers, reports the outcome. */
    #end(arena, finish) {
        if (arena.ending) {
            return;
        }
        arena.ending = true;
        this.#step(arena, { kind: 'ended' });
        const running = arena.running;
        if (running !== null && this.#workspace.getPreview(running.previewId) !== undefined) {
            this.#workspace.cancelPreview(running.previewId, finish.outcome === 'cancelled' ? finish.reason : 'host');
        }
        this.#forget(arena);
        if (running !== null) {
            this.#emit({
                type: 'gesture.ended',
                gestureId: running.id,
                viewportId: arena.viewportId,
                finish,
            });
        }
    }
    /** Releases an arena's pointers and forgets it. */
    #forget(arena) {
        arena.ending = true;
        if (this.#hold?.arena === arena) {
            this.#hold = null;
        }
        if (this.#arenas.get(arena.key) === arena) {
            this.#arenas.delete(arena.key);
        }
        for (const [key, pressed] of arena.pointers) {
            if (this.#pressed.get(key) === arena) {
                this.#pressed.delete(key);
                this.#emit({
                    type: 'capture.released',
                    pointerId: pressed.down.pointerId,
                    deviceId: pressed.down.deviceId,
                    viewportId: arena.viewportId,
                });
            }
        }
    }
    #cancelArena(arena, reason) {
        if (arena.ending) {
            return;
        }
        const running = arena.running;
        const next = this.#step(arena, { kind: 'cancel' });
        if (next === 'idle' || running === null) {
            // A pending press is forgotten.
            this.#forget(arena);
            return;
        }
        this.#guardQuietly(() => {
            running.handler.cancel(reason);
        });
        this.#end(arena, { outcome: 'cancelled', reason, error: null });
    }
    #cancelWhere(match, reason) {
        const arenas = [...this.#arenas.values()].filter(match);
        for (const arena of arenas) {
            this.#cancelArena(arena, reason);
        }
        return arenas.length;
    }
    /**
     * Runs gesture code; if it throws, the gesture is cancelled (`host`) so nothing is left captured
     * or previewed, and the error propagates.
     */
    #guard(arena, run) {
        try {
            return run();
        }
        catch (error) {
            this.#cancelArena(arena, 'host');
            throw error;
        }
    }
    #guardQuietly(run) {
        try {
            run();
        }
        catch (error) {
            this.#errors.push(`a gesture failed while cancelling: ${messageOf(error)}`);
        }
    }
    #lasts(arena) {
        return [...arena.pointers.values()].map((p) => p.last);
    }
    #handled(arena) {
        return {
            consumed: true,
            route: 'gesture',
            region: arena.region,
            target: arena.pick?.kind === 'hit' ? arena.pick.target : null,
            gestureId: arena.running?.id ?? null,
            operation: null,
            reason: null,
        };
    }
    // --- wheel, keys and commands -----------------------------------------------------------
    #wheel(intent) {
        const scene = this.#workspace.getState();
        for (const arena of this.#arenas.values()) {
            const handler = arena.running?.handler;
            if (arena.viewportId === intent.viewportId && handler?.wheel !== undefined) {
                if (this.#guard(arena, () => handler.wheel?.(intent) ?? false)) {
                    return this.#handled(arena);
                }
            }
        }
        const view = viewGeometryOf(scene, intent.viewportId);
        const result = this.#pickIn(scene, view, intent.x, intent.y);
        if (result.kind !== 'hit') {
            return NOT_HANDLED(result.kind === 'background' ? 'nothing spatial is under the wheel' : result.reason, result.kind === 'background' ? { region: result.region } : {});
        }
        const base = { region: result.region, target: result.target };
        if (result.region === 'modal-overlay') {
            return { ...NOT_HANDLED('a modal is active'), ...base, consumed: true, route: 'blocked' };
        }
        // Wheel over a window scrolls its content (or the page) unless the depth modifier is held.
        if (!intent.modifiers[this.#settings.depthModifier]) {
            return {
                ...NOT_HANDLED('the wheel stays with the content without the depth modifier'),
                ...base,
                route: result.region === 'content' ? 'native' : 'ignored',
            };
        }
        const outcome = this.#run('node.move', {
            nodeId: result.target.nodeId,
            viewportId: intent.viewportId,
            depth: -intent.deltaY * this.#settings.wheelDepthPerPixel,
        });
        return {
            consumed: true,
            route: 'command',
            ...base,
            gestureId: null,
            operation: { name: 'node.move', outcome },
            reason: null,
        };
    }
    #key(intent) {
        const held = ['shift', 'ctrl', 'alt', 'meta'].filter((m) => intent.modifiers[m]);
        const route = models.keyRoute({
            phase: { kind: intent.phase },
            key: intent.key,
            inContent: intent.focus === 'content',
            gestures: this.#arenas.size > 0,
            holding: this.#hold !== null,
            modified: held.length > 0,
        });
        switch (route.kind) {
            case 'cancelAll': {
                const count = this.#cancelWhere(() => true, 'escape');
                return commandResult('gesture.cancel', { status: 'cancelled', count });
            }
            case 'native':
                return { ...NOT_HANDLED('keyboard focus is in content'), route: 'native' };
            case 'ignoreRelease':
                return NOT_HANDLED('key releases run nothing');
            case 'putDown':
                return commandResult('gesture.drop', this.#putDown());
            case 'keymap':
                break;
        }
        const binding = this.#settings.keymap.find((b) => {
            if (keyName(b.key) !== keyName(intent.key)) {
                return false;
            }
            // A sign is typed with Shift on many layouts (+ is Shift and =): Shift does not count
            // against a binding of one that does not list it. A letter's case is Shift's to say.
            const signed = isSign(b.key) && !b.modifiers.includes('shift');
            const counted = signed ? held.filter((m) => m !== 'shift') : held;
            return b.modifiers.length === counted.length && b.modifiers.every((m) => intent.modifiers[m]);
        });
        if (binding === undefined) {
            return NOT_HANDLED('no binding for this key');
        }
        const bound = binding.args;
        const args = isRecord(bound) &&
            intent.viewportId !== null &&
            VIEWPORT_COMMANDS.has(binding.command) &&
            !('viewportId' in bound)
            ? { ...bound, viewportId: intent.viewportId }
            : bound;
        return commandResult(binding.command, this.#run(binding.command, args));
    }
    #command(intent) {
        return commandResult(intent.command, this.#run(intent.command, intent.args));
    }
    #run(id, args) {
        const command = this.#commands.get(id);
        if (command === undefined) {
            throw failure('INVALID_INPUT', `no command "${id}"`);
        }
        const context = {
            workspace: this.#workspace,
            settings: this.#settings,
            view: (viewportId) => viewGeometryOf(this.#workspace.getState(), viewportId),
            cancelGestures: (reason) => this.#cancelWhere(() => true, reason),
            hold: (viewportId, nodeId) => this.#holdNode(viewportId, nodeId),
            putDown: () => this.#putDown(),
        };
        const hold = this.#hold;
        if (hold !== null) {
            const shown = this.#workspace.getPreview(hold.arena.running?.previewId ?? '');
            if (shown === undefined) {
                throw new Error('a held node lost its preview without its hold ending');
            }
            const change = heldChange(id, args, shown, hold.nodeId, context);
            if (change !== null) {
                return 'status' in change ? change : this.#moveHeld(hold, change);
            }
        }
        return command.run(args, context);
    }
    // --- holding a node from the keyboard ---------------------------------------------------
    #holdNode(viewportId, nodeId) {
        const scene = this.#workspace.getState();
        const node = scene.nodes.get(nodeId);
        const key = nodeArenaKey(viewportId, nodeId);
        const gate = models.holdGate(this.#hold !== null, scene.viewports.has(viewportId), node?.status === 'active', this.#arenas.has(key));
        switch (gate.kind) {
            case 'alreadyHolding':
                return {
                    status: 'unchanged',
                    reason: `window "${String(this.#hold?.nodeId)}" is already held`,
                };
            case 'unknownViewport':
                // Names the unknown viewport as such.
                viewGeometryOf(scene, viewportId);
                throw failure('UNKNOWN_ENTITY', `no viewport "${viewportId}"`);
            case 'unknownNode':
                throw failure('UNKNOWN_ENTITY', `no node "${nodeId}" to hold`);
            case 'busy':
                return { status: 'unchanged', reason: `window "${nodeId}" is already in a gesture` };
            case 'hold':
                break;
        }
        if (node === undefined) {
            throw new Error(`the gesture model let a missing node "${nodeId}" be held`);
        }
        const id = `gesture-${String(this.#nextGesture++)}`;
        const previewId = `interaction:${id}`;
        const arena = {
            key,
            viewportId,
            pick: null,
            region: null,
            pointers: new Map(),
            claims: [],
            running: null,
            phase: IDLE,
            ending: false,
        };
        const session = this.#session(arena, id, previewId);
        // Held where it is: a node the operator may not move (a locked one) is refused here.
        const shown = session.preview([{ type: 'node.patch', id: nodeId, transform: node.transform }]);
        if (shown.status === 'rejected') {
            return shown;
        }
        const hold = { arena, nodeId, session, change: null, outcome: null };
        const handler = {
            update: () => {
                // A hold has no pointers.
            },
            finish: () => {
                if (hold.change === null) {
                    return { outcome: 'unchanged' };
                }
                const outcome = session.commit([{ type: 'node.patch', id: nodeId, ...hold.change }]);
                hold.outcome = outcome;
                return outcome.status === 'committed'
                    ? { outcome: 'committed', transactionId: outcome.transactionId }
                    : {
                        outcome: 'cancelled',
                        reason: outcome.error.code === 'CONSTRAINT_REJECTED' || outcome.error.code === 'LOCKED'
                            ? 'constraint-rejected'
                            : 'commit-rejected',
                        error: outcome.error,
                    };
            },
            cancel: () => {
                // Everything the hold changed is in its preview.
            },
        };
        this.#step(arena, { kind: 'held' });
        arena.running = {
            id,
            policyId: KEYBOARD_HOLD_ID,
            operation: 'gesture.grab',
            nodeId,
            handler,
            previewId,
        };
        this.#arenas.set(key, arena);
        this.#hold = hold;
        this.#emit({
            type: 'gesture.started',
            gestureId: id,
            policyId: KEYBOARD_HOLD_ID,
            operation: 'gesture.grab',
            viewportId,
            nodeId,
            pointerIds: [],
        });
        return shown;
    }
    /** Shows a held node changed; a change the scene refuses leaves it as it was shown. */
    #moveHeld(hold, change) {
        const next = { ...hold.change, ...change };
        const outcome = hold.session.preview([{ type: 'node.patch', id: hold.nodeId, ...next }]);
        if (outcome.status === 'previewed') {
            hold.change = next;
        }
        return outcome;
    }
    #putDown() {
        const hold = this.#hold;
        const running = hold?.arena.running ?? null;
        if (hold === null || running === null) {
            return { status: 'unchanged', reason: 'no window is held' };
        }
        const finish = this.#guard(hold.arena, () => running.handler.finish());
        this.#finished(hold.arena, finish);
        this.#end(hold.arena, finish);
        if (finish.outcome === 'unchanged') {
            return { status: 'unchanged', reason: 'the window was put down where it was' };
        }
        if (hold.outcome === null) {
            throw new Error('a hold finished without its commit');
        }
        return hold.outcome;
    }
    // --- picking and workspace events -------------------------------------------------------
    #projection(view) {
        const module = this.#projections.get(view.projectionId);
        if (module === undefined) {
            throw failure('UNSUPPORTED_CAPABILITY', `viewport "${view.viewportId}" uses projection "${view.projectionId}", which is not registered`);
        }
        return projectionFor(module, view);
    }
    #pickIn(scene, view, x, y, continuity) {
        const started = this.#timer();
        this.#index.sync(scene, (id) => this.#workspace.surfaceGeometry(id));
        const modal = this.#modal === null
            ? null
            : new Set(this.#modal.flatMap((id) => scene.nodes.has(id) ? [id, ...descendantIds(scene.nodes, id)] : []));
        const result = pick({
            scene,
            view,
            projection: this.#projection(view),
            index: this.#index,
            geometry: (id) => this.#workspace.surfaceGeometry(id),
            options: {
                handlePx: this.#settings.handlePx,
                depthTolerance: this.#settings.depthTolerance,
                modal,
                presentation: this.#presentation,
                occlusion: this.#occlusion,
            },
        }, x, y, continuity);
        this.#lastPick = Object.freeze({
            ambiguous: result.kind === 'hit' && result.ambiguous,
            ms: this.#timer() - started,
        });
        return result;
    }
    #onWorkspaceEvent(event) {
        switch (event.type) {
            case 'viewport.deleted': {
                const { viewportId } = event.payload;
                this.#cancelWhere((a) => a.viewportId === viewportId, 'view-disposed');
                return;
            }
            case 'node.deleted':
            case 'node.archived':
            case 'surface.detached':
            case 'surface.moved': {
                const scene = this.#workspace.getState();
                this.#cancelWhere((a) => !targetPresent(a, scene), 'target-detached');
                return;
            }
            case 'preview.cancelled': {
                const { previewId, reason } = event.payload;
                const arena = [...this.#arenas.values()].find((a) => a.running?.previewId === previewId);
                if (arena !== undefined) {
                    const scene = this.#workspace.getState();
                    this.#cancelArena(arena, targetPresent(arena, scene) ? reason : 'target-detached');
                }
                return;
            }
            case 'workspace.disposed':
                this.#cancelWhere(() => true, 'workspace-disposed');
                return;
            default:
                return;
        }
    }
    #emit(event) {
        for (const listener of [...this.#listeners]) {
            try {
                listener(event);
            }
            catch (error) {
                this.#errors.push(`a listener threw while handling ${event.type}: ${messageOf(error)}`);
            }
        }
    }
    /**
     * Throws {@link SwfFailure} (`INVALID_INPUT`) for a key binding of `settings` to a command the
     * router does not have.
     */
    #checkKeymap(settings) {
        const unknown = settings.keymap.find((b) => !this.#commands.has(b.command));
        if (unknown !== undefined) {
            throw failure('INVALID_INPUT', `settings.keymap binds unknown command "${unknown.command}"`);
        }
    }
    #live() {
        if (this.#disposed) {
            throw failure('INVALID_TRANSITION', 'the interaction router is disposed');
        }
    }
}
/** A single character that is neither a letter nor a digit: a sign or punctuation. */
const isSign = (key) => key.length === 1 && !/[\p{L}\p{N}\s]/u.test(key);
/** Commands that act in a viewport: a key binding supplies the key's viewport. */
const VIEWPORT_COMMANDS = new Set(['node.move', 'camera.turn', 'orbit.turn', 'gesture.grab']);
/** The best claim of a kind for a pointer count: highest priority, then lowest policy ID. */
function best(claims, kind, pointers) {
    const eligible = claims.filter((c) => c.claim.kind === kind && c.claim.pointers === pointers);
    eligible.sort((a, b) => b.policy.priority - a.policy.priority ||
        (a.policy.id < b.policy.id ? -1 : a.policy.id > b.policy.id ? 1 : 0));
    return eligible[0] ?? null;
}
/** Whether the arena's target (node, and surface when one was hit) is still active in the scene. */
function targetPresent(arena, scene) {
    const nodeId = arena.running?.nodeId ?? (arena.pick?.kind === 'hit' ? arena.pick.target.nodeId : null);
    if (nodeId !== null && scene.nodes.get(nodeId)?.status !== 'active') {
        return false;
    }
    if (arena.pick?.kind === 'hit' && arena.pick.target.surfaceId !== null) {
        const surface = scene.surfaces.get(arena.pick.target.surfaceId);
        return surface?.ownerNodeId === arena.pick.target.nodeId;
    }
    return true;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function commandResult(name, outcome) {
    return {
        consumed: true,
        route: 'command',
        region: null,
        target: null,
        gestureId: null,
        operation: { name, outcome },
        reason: null,
    };
}
function settled(result) {
    if (isQueued(result)) {
        throw failure('INVALID_TRANSITION', 'input cannot be dispatched from inside a workspace event listener');
    }
    return result;
}
function isQueued(result) {
    return result.status === 'queued';
}
function failure(code, message) {
    return new SwfFailure(makeError(code, message));
}
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
const IDLE = Object.freeze({ kind: 'idle' });
/** Each input region as the gesture model names it. */
const REGIONS = Object.freeze({
    content: 'content',
    chrome: 'chrome',
    'resize-handle': 'resizeHandle',
    background: 'background',
    'modal-overlay': 'modalOverlay',
});
//# sourceMappingURL=router.js.map