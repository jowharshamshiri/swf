import { makeError, surfaceEffectiveState, SwfFailure } from '@swf/core';
import { surfaceCondition } from './conditions.js';
import { createViewOutput, viewGeometryOf } from './fragments.js';
import { representationPolicyIssue } from './representation.js';
import { planFrame } from './stages.js';
import { models } from '@swf/models';
/**
 * Creates a presenter. Throws {@link SwfFailure} (`INVALID_INPUT`) for invalid options: options
 * that are not an object, `frames` without `request()`, `showDegraded` or `now` that is not a
 * function, or a `budgetMs` that is not a positive finite number. The presenter subscribes to
 * the workspace, the runtime and the registry at once; call {@link Presenter.dispose} to let go of
 * them and release every viewport's backend.
 *
 * @example
 * ```ts
 * const presenter = createPresenter({
 *   workspace: workspace.reader(),
 *   runtime,
 *   registry,
 *   frames: animationFrames(window), // from @swf/backend-dom
 *   showDegraded: (container, error) => {
 *     const note = document.createElement('p');
 *     note.textContent = error.message;
 *     (container as HTMLElement).append(note);
 *     return () => note.remove();
 *   },
 * });
 * const viewport = await presenter.open({
 *   viewportId: 'main',
 *   container: element,
 *   backends: [{ renderer: 'swf.dom-renderer/1', compositor: 'swf.dom-compositor/1' }],
 * });
 * // …
 * await presenter.dispose();
 * ```
 */
export function createPresenter(options) {
    const raw = options;
    if (typeof raw !== 'object' || raw === null) {
        throw invalid('presenter options must be an object');
    }
    const frames = options.frames;
    if (typeof frames?.request !== 'function') {
        throw invalid('frames must be a frame source with request()');
    }
    if (typeof options.showDegraded !== 'function') {
        throw invalid('showDegraded must be a function');
    }
    const budget = options.budgetMs ?? 8;
    if (typeof budget !== 'number' || !(budget > 0) || !Number.isFinite(budget)) {
        throw invalid('budgetMs must be a positive finite number');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
        throw invalid('now must be a function');
    }
    return new PresenterImpl(options, budget);
}
function invalid(message) {
    return new SwfFailure(makeError('INVALID_INPUT', message));
}
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
const BOUND_STATES = new Set(['ready', 'presented', 'hidden']);
const sameChoice = (a, b) => a.renderer === b.renderer && a.compositor === b.compositor;
/** Why a viewport began a handoff on its own, as its `BACKGROUND_FAILED` diagnostic says it. */
const BACKGROUND_WORK = Object.freeze({
    lost: 'the loss of its backend’s resources',
    unavailable: 'its backend being unregistered',
    restored: 'a preferred backend being registered again',
});
class PresenterImpl {
    options;
    budget;
    now;
    #viewports = new Map();
    #listeners = new Set();
    #diagnostics = [];
    #unsubscribe;
    #cancelFrame = null;
    #ticking = false;
    #disposed = null;
    constructor(options, budget) {
        this.options = options;
        this.budget = budget;
        this.now = options.now ?? Date.now;
        this.#unsubscribe = [
            options.workspace.subscribe(() => {
                this.request();
            }),
            options.runtime.subscribe((event) => {
                // A viewport's own attachments change while it presents; other viewports may care
                // (a single-owner endpoint becomes free), and changes of binding concern every one.
                switch (event.type) {
                    case 'presentation.viewportChanged':
                        this.#markSurfaces((v) => v.viewportId !== event.payload.viewportId);
                        break;
                    case 'presentation.stateChanged':
                        if (BOUND_STATES.has(event.payload.from ?? '') !== BOUND_STATES.has(event.payload.to)) {
                            this.#markSurfaces(() => true);
                        }
                        break;
                    default:
                        this.#markSurfaces(() => true);
                }
            }),
            options.registry.subscribe((change) => {
                for (const viewport of this.#viewports.values()) {
                    viewport.registryChanged(change);
                }
            }),
        ];
    }
    async open(options) {
        if (this.#disposed !== null) {
            throw new SwfFailure(makeError('INVALID_TRANSITION', 'the presenter is disposed'));
        }
        const checked = checkViewportOptions(options);
        const slot = this.#viewports.get(checked.viewportId)?.slot ?? ABSENT;
        const opening = models.slotStep(slot, { kind: 'open' });
        if (opening === null) {
            throw invalid(`viewport "${checked.viewportId}" is already ${slot.kind}`);
        }
        // Throws UNKNOWN_ENTITY for a viewport the scene does not have.
        viewGeometryOf(this.options.workspace.getState(), checked.viewportId);
        const viewport = new ViewportImpl(this, checked, opening);
        this.#viewports.set(checked.viewportId, viewport);
        try {
            await viewport.start();
        }
        catch (error) {
            // A viewport that cannot start is disposed, which frees its ID.
            try {
                await viewport.dispose();
            }
            catch (cleanup) {
                throw new AggregateError([error, cleanup], `viewport "${checked.viewportId}" failed to start (${describe(error)}), and disposing it failed too (${describe(cleanup)})`, { cause: cleanup });
            }
            throw error;
        }
        return viewport;
    }
    viewport(viewportId) {
        const viewport = this.#viewports.get(viewportId);
        return viewport !== undefined && models.slotListed(viewport.slot) ? viewport : undefined;
    }
    viewports() {
        return [...this.#viewports.values()].filter((v) => models.slotListed(v.slot));
    }
    subscribe(listener) {
        const entry = (event) => {
            listener(event);
        };
        this.#listeners.add(entry);
        return () => {
            this.#listeners.delete(entry);
        };
    }
    getDiagnostics() {
        return Object.freeze([...this.#diagnostics]);
    }
    resources() {
        const viewports = [...this.#viewports.values()];
        const held = viewports.filter((v) => v.backend !== null).length;
        return Object.freeze({
            viewports: viewports.length,
            sessions: held * 2,
            listeners: this.#listeners.size,
            subscriptions: this.#unsubscribe.length + held * 2,
            frameRequested: this.#cancelFrame !== null,
        });
    }
    dispose() {
        this.#disposed ??= (async () => {
            this.#cancelFrame?.();
            this.#cancelFrame = null;
            for (const unsubscribe of this.#unsubscribe.splice(0)) {
                unsubscribe();
            }
            for (const viewport of [...this.#viewports.values()]) {
                await viewport.dispose();
            }
            this.#listeners.clear();
        })();
        return this.#disposed;
    }
    emit(event) {
        const frozen = Object.freeze(event);
        for (const listener of [...this.#listeners]) {
            try {
                listener(frozen);
            }
            catch (error) {
                // Presentation goes on, and the other listeners still hear the event.
                this.diagnose('LISTENER_THREW', `a listener threw while handling ${event.type}`, {
                    reason: describe(error),
                });
            }
        }
    }
    /** Keeps a failure presentation went on past, with the last 100 kept. */
    diagnose(code, message, details) {
        this.#diagnostics.push(Object.freeze({
            code,
            message,
            timestamp: this.now(),
            details: Object.freeze({ ...details }),
        }));
        this.#diagnostics.splice(0, this.#diagnostics.length - 100);
    }
    /**
     * Moves a viewport's ID as the presenter model decides on `event`, and lets go of the viewport
     * once its ID is free; an event out of order is a defect.
     */
    step(viewport, event) {
        const next = models.slotStep(viewport.slot, { kind: event });
        if (next === null || this.#viewports.get(viewport.viewportId) !== viewport) {
            throw new Error(`viewport "${viewport.viewportId}" cannot take ${event} while ${viewport.slot.kind}`);
        }
        viewport.slot = next;
        if (next.kind === 'absent') {
            this.#viewports.delete(viewport.viewportId);
        }
    }
    /** Asks the frame source for one frame, unless one is already coming. */
    request() {
        if (this.#cancelFrame !== null || this.#ticking || this.#disposed !== null) {
            return;
        }
        this.#cancelFrame = this.options.frames.request(() => {
            this.#cancelFrame = null;
            return this.#tick();
        });
    }
    #markSurfaces(which) {
        for (const viewport of this.#viewports.values()) {
            if (which(viewport)) {
                viewport.mark('surfaces');
            }
        }
        this.request();
    }
    /**
     * One frame: every due interactive viewport is presented, then background ones while the
     * budget lasts (always at least one viewport, so every one gets its turn). Those left over wait
     * for the next frame with their latest state; nothing queues up behind them.
     */
    async #tick() {
        this.#ticking = true;
        try {
            const started = this.now();
            const due = [...this.#viewports.values()]
                .map((viewport) => ({ viewport, flags: viewport.due() }))
                .filter((d) => d.flags !== null)
                .sort((a, b) => Number(a.viewport.priority === 'background') -
                Number(b.viewport.priority === 'background') ||
                a.viewport.skipped - b.viewport.skipped);
            let presented = 0;
            for (const { viewport, flags } of due) {
                const late = viewport.priority === 'background' &&
                    presented > 0 &&
                    this.now() - started >= this.budget;
                if (late) {
                    viewport.skipped += 1;
                    continue;
                }
                presented += 1;
                await viewport.scheduled(flags);
            }
        }
        finally {
            this.#ticking = false;
        }
        if ([...this.#viewports.values()].some((v) => v.due() !== null)) {
            this.request();
        }
    }
}
function checkViewportOptions(options) {
    const raw = options;
    if (typeof raw !== 'object' || raw === null) {
        throw invalid('viewport options must be an object');
    }
    if (typeof options.viewportId !== 'string' || options.viewportId.trim() === '') {
        throw invalid('viewportId must be a non-blank string');
    }
    const backends = options.backends;
    if (!Array.isArray(backends) || backends.length === 0) {
        throw invalid(`viewport "${options.viewportId}": backends must be a non-empty array`);
    }
    backends.forEach((b, i) => {
        const choice = b;
        if (typeof choice !== 'object' ||
            choice === null ||
            typeof choice.renderer !== 'string' ||
            typeof choice.compositor !== 'string') {
            throw invalid(`viewport "${options.viewportId}": backends[${String(i)}] must name a renderer and a compositor`);
        }
    });
    if (options.priority !== undefined && !['interactive', 'background'].includes(options.priority)) {
        throw invalid(`viewport "${options.viewportId}": priority must be "interactive" or "background"`);
    }
    const maxLive = options.maxLive;
    if (maxLive !== undefined &&
        !(maxLive === Infinity || (Number.isInteger(maxLive) && maxLive >= 0))) {
        throw invalid(`viewport "${options.viewportId}": maxLive must be a whole number or Infinity`);
    }
    if (options.release !== undefined && typeof options.release !== 'boolean') {
        throw invalid(`viewport "${options.viewportId}": release must be a boolean`);
    }
    return Object.freeze({
        ...options,
        backends: Object.freeze(backends.map((b) => Object.freeze({ ...b }))),
    });
}
class ViewportImpl {
    viewportId;
    priority;
    skipped = 0;
    /** Where its ID is in the presenter: opening until it started, then open. */
    slot;
    #presenter;
    #options;
    #state = STATES[models.viewportOpened().kind];
    #backend = null;
    #degradedBy = null;
    #hideDegraded = null;
    /** Backends that lost their resources here, by renderer and compositor; not tried again until restored. */
    #lost = new Set();
    #flags = new Set();
    #seen = null;
    #representation = null;
    #live = new Set();
    #last = null;
    #queue = Promise.resolve();
    #disposed = null;
    constructor(presenter, options, slot) {
        this.slot = slot;
        this.#presenter = presenter;
        this.#options = options;
        this.viewportId = options.viewportId;
        this.priority = options.priority ?? 'interactive';
    }
    get state() {
        return this.#state;
    }
    get backend() {
        return this.#backend?.choice ?? null;
    }
    get capabilities() {
        const backend = this.#backend;
        return backend === null
            ? null
            : Object.freeze({
                renderer: backend.renderer.capabilities,
                compositor: backend.compositor.capabilities,
            });
    }
    get degradedBy() {
        return this.#degradedBy;
    }
    /**
     * Activates the first preferred backend that works, or opens degraded; then the presenter lists
     * it. A failure leaves it opening, for the presenter to dispose.
     */
    async start() {
        await this.#serial(async () => {
            await this.#activate(this.#options.backends, 'opened', false);
            this.#presenter.step(this, 'started');
        });
    }
    invalidate() {
        this.mark('requested');
    }
    mark(flag) {
        this.#flags.add(flag);
        this.#presenter.request();
    }
    update() {
        return this.#serial(() => this.#present([...(this.due() ?? []), 'requested']));
    }
    /** A frame at a frame boundary; a failure is reported, not thrown. */
    scheduled(flags) {
        return this.#serial(async () => {
            if (!models.viewportPresents(leanState(this.#state))) {
                return;
            }
            try {
                await this.#present(flags);
            }
            catch (error) {
                this.#presenter.emit({
                    type: 'frame.failed',
                    viewportId: this.viewportId,
                    error: error instanceof SwfFailure
                        ? error.error
                        : makeError('INVALID_INPUT', `frame of viewport "${this.viewportId}" failed: ${describe(error)}`, {
                            entityId: this.viewportId,
                        }),
                });
            }
        });
    }
    presentation(surfaceId) {
        return this.#live.has(surfaceId) ? 'live' : 'proxy';
    }
    setRepresentation(policy) {
        if (policy !== null) {
            const issue = representationPolicyIssue(policy);
            if (issue !== null) {
                throw invalid(`viewport "${this.viewportId}": ${issue}`);
            }
        }
        if (policy === this.#representation) {
            return;
        }
        this.#representation = policy;
        this.mark('representation');
    }
    representation() {
        return this.#representation;
    }
    switchBackend(backend) {
        const checked = checkViewportOptions({ ...this.#options, backends: [backend] }).backends;
        return this.#serial(() => this.#activate(checked, 'requested', this.#backend !== null));
    }
    restore() {
        return this.#serial(() => {
            this.#lost.clear();
            return this.#activate(this.#ahead(), 'restored', this.#backend !== null);
        });
    }
    lastFrame() {
        return this.#last;
    }
    dispose() {
        this.#disposed ??= this.#serial(() => this.#dispose());
        return this.#disposed;
    }
    /**
     * The dirt that makes a frame due, or null when there is none. The presented scene is compared
     * by what this viewport reads of it, so another viewport's camera, say, leaves this one be.
     */
    due() {
        if (!models.viewportPresents(leanState(this.#state))) {
            return null;
        }
        const flags = new Set(this.#flags);
        const seen = this.#seen;
        if (seen === null) {
            flags.add('scene');
        }
        else {
            const scene = this.#presenter.options.workspace.getPresented();
            if (scene !== seen.scene) {
                if (!sameContent(scene, seen.scene)) {
                    flags.add('scene');
                }
                if (viewKey(viewGeometryOf(scene, this.viewportId)) !== seen.view) {
                    flags.add('view');
                }
            }
        }
        return flags.size === 0 ? null : [...flags];
    }
    /** A registration changed: a backend in use may be gone, or a preferred one back. */
    registryChanged(change) {
        if (change.kind === 'projector') {
            this.mark('view');
            return;
        }
        const uses = (choice) => change.kind === 'renderer' ? choice.renderer === change.id : choice.compositor === change.id;
        if (!change.registered) {
            const current = this.#backend;
            if (current !== null && uses(current.choice)) {
                this.#background('unavailable', async () => {
                    if (this.#backend?.choice === current.choice) {
                        await this.#activate(this.#fallbacks(current.choice), 'unavailable', false);
                    }
                });
            }
            return;
        }
        // A module registered afresh has not lost anything yet.
        for (const key of [...this.#lost]) {
            const [renderer, compositor] = JSON.parse(key);
            if (uses({ renderer, compositor })) {
                this.#lost.delete(key);
            }
        }
        if (this.#ahead().some(uses)) {
            this.#background('restored', () => this.#activate(this.#ahead(), 'restored', this.#backend !== null));
        }
    }
    /**
     * Queues a handoff the viewport begins on its own, after the work queued before it. Nobody
     * waits for it, so its failure is kept as a `BACKGROUND_FAILED` diagnostic; once the viewport
     * is disposed it has nothing left to do and does nothing.
     */
    #background(work, run) {
        const next = this.#queue.then(() => models.viewportAdmits(leanState(this.#state)) ? run() : undefined);
        this.#queue = next.catch(() => undefined);
        next.catch((error) => {
            this.#presenter.diagnose('BACKGROUND_FAILED', `viewport "${this.viewportId}" failed to finish handling ${BACKGROUND_WORK[work]}`, { viewportId: this.viewportId, work, reason: describe(error) });
        });
    }
    #serial(work) {
        const next = this.#queue.then(() => {
            if (!models.viewportAdmits(leanState(this.#state))) {
                throw new SwfFailure(makeError('INVALID_TRANSITION', `viewport "${this.viewportId}" is disposed`, {
                    entityId: this.viewportId,
                }));
            }
            return work();
        });
        this.#queue = next.catch(() => undefined);
        return next;
    }
    /** The preferred backends ahead of the current one: all of them when there is none. */
    #ahead() {
        const current = this.#backend?.choice;
        const all = this.#options.backends;
        const at = current === undefined ? -1 : all.findIndex((b) => sameChoice(b, current));
        return [...(at < 0 ? all : all.slice(0, at))];
    }
    /** The fallbacks for a backend that went away: the preferences in order, without it. */
    #fallbacks(gone) {
        return this.#options.backends.filter((b) => !sameChoice(b, gone));
    }
    // --- frames --------------------------------------------------------------------------------
    async #present(dirty) {
        const backend = this.#backend;
        if (models.viewportDegraded(leanState(this.#state), backend !== null) || backend === null) {
            return Object.freeze({
                status: 'degraded',
                viewportId: this.viewportId,
                error: this.#degradedBy ?? this.#noBackend(),
            });
        }
        const { runtime } = this.#presenter.options;
        const started = this.#presenter.now();
        const skipped = this.skipped;
        this.skipped = 0;
        this.#flags.clear();
        // Stage 4: project the presented scene.
        const scene = this.#presenter.options.workspace.getPresented();
        const view = viewGeometryOf(scene, this.viewportId);
        const output = this.#project(scene, view);
        const notHere = this.#virtualized(scene, output);
        const refused = [];
        const presented = [];
        // Each refusal shows that surface as a proxy and plans again; refusals only grow, so this ends.
        for (;;) {
            // Stages 6 and 7: plan, render and compose.
            const frame = this.#plan(scene, view, output, backend, notHere);
            const rendered = backend.rendererSession.render(frame);
            const composed = backend.compositorSession.compose(rendered);
            const live = liveIn(rendered);
            let replan = false;
            for (const surfaceId of live) {
                const here = attachmentHere(runtime, surfaceId, this.viewportId);
                if (here?.visible === true) {
                    continue;
                }
                const outcome = await runtime.present(surfaceId, this.viewportId, this.#target(backend, surfaceId));
                if (outcome.status === 'ok') {
                    presented.push(surfaceId);
                }
                else {
                    refused.push({ surfaceId, error: outcome.error });
                    notHere.add(surfaceId);
                    replan = true;
                }
            }
            if (replan) {
                continue;
            }
            const { hidden, refused: hiding } = await this.#hideAllBut(live, this.#options.release === true);
            const [unhidden] = hiding;
            if (unhidden !== undefined) {
                throw new SwfFailure(unhidden);
            }
            this.#live = new Set(live);
            // Stage 5: the hints, once the attachments have settled.
            const hinted = this.#hint(scene, view, frame);
            const metrics = Object.freeze({
                viewportId: this.viewportId,
                rendererId: backend.choice.renderer,
                compositorId: backend.choice.compositor,
                sceneRevision: scene.revision,
                durationMs: this.#presenter.now() - started,
                skipped,
                dirty: Object.freeze([...new Set(dirty)]),
                fragments: frame.planned.length,
                live: live.length,
                writes: rendered.writes + composed.writes,
                hints: hinted.delivered,
            });
            const result = Object.freeze({
                status: 'presented',
                viewportId: this.viewportId,
                frame,
                rendered,
                composed,
                presented: Object.freeze(presented),
                hidden: Object.freeze(hidden),
                refused: Object.freeze(refused),
                hints: hinted.hints,
                metrics,
            });
            this.#last = result;
            // Stage 8: publish.
            this.#presenter.emit({
                type: 'frame',
                viewportId: this.viewportId,
                metrics,
                fallbacks: frame.fallbacks,
            });
            return result;
        }
    }
    /** Stage 4, cached: the fragments only change when what this viewport reads changes. */
    #project(scene, view) {
        const projector = this.#presenter.options.registry.projector(view.projectionId);
        if (projector === undefined) {
            throw new SwfFailure(makeError('UNSUPPORTED_CAPABILITY', `viewport "${this.viewportId}" uses projection "${view.projectionId}", which is not registered`, { entityId: this.viewportId }));
        }
        const key = viewKey(view);
        const seen = this.#seen;
        // The same view keeps what it projected: all of it while the scene shows the same, and what
        // stands where it stood otherwise.
        const sameView = seen !== null && seen.view === key && seen.projectorId === view.projectionId;
        const fragments = sameView && sameContent(scene, seen.scene)
            ? seen.fragments
            : projector.module.project(scene, view, (id) => this.#presenter.options.workspace.presentedGeometry(id), sameView ? { scene: seen.scene, fragments: seen.fragments } : undefined);
        this.#seen = { scene, view: key, fragments, projectorId: view.projectionId };
        return createViewOutput(scene, this.viewportId, fragments);
    }
    /** Stage 6. */
    #plan(scene, view, output, backend, notHere) {
        const { runtime, registry, workspace, policy } = this.#presenter.options;
        const projector = registry.projector(view.projectionId);
        if (projector === undefined) {
            throw new SwfFailure(makeError('UNSUPPORTED_CAPABILITY', `viewport "${this.viewportId}" uses projection "${view.projectionId}", which is not registered`, { entityId: this.viewportId }));
        }
        const attachedElsewhere = (id) => runtime.get(id)?.viewports.some((v) => v.viewportId !== this.viewportId) ?? false;
        const condition = (id) => surfaceCondition(runtime.get(id), attachedElsewhere(id));
        return planFrame({
            scene,
            view,
            output,
            renderer: { id: backend.choice.renderer, capabilities: backend.renderer.capabilities },
            compositor: { id: backend.choice.compositor, capabilities: backend.compositor.capabilities },
            projection: projector.capabilities,
            ...(policy === undefined ? {} : { policy }),
            ...(this.#representation === null ? {} : { representation: this.#representation }),
            condition,
            // A single-owner handle presented in another viewport stays there; this one shows a proxy.
            viewportOwns: (id) => {
                if (notHere.has(id)) {
                    return false;
                }
                const now = condition(id);
                return !(now.kind === 'bound' && now.presentedElsewhere);
            },
            geometry: (id) => workspace.presentedGeometry(id),
        });
    }
    /**
     * The surfaces beyond `maxLive` that are shown as proxies here: the focused window's first, then
     * the selection's in order, then the largest on screen.
     */
    #virtualized(scene, output) {
        const max = this.#options.maxLive ?? Infinity;
        const owners = output.fragments.filter((f) => f.nativeOwner);
        if (owners.length <= max) {
            return new Set();
        }
        const ownerOf = (id) => scene.surfaces.get(id)?.ownerNodeId;
        const rank = (f) => {
            const owner = ownerOf(f.surfaceId);
            if (owner !== undefined && owner === scene.focusedId) {
                return -1;
            }
            const selected = owner === undefined ? -1 : scene.selection.indexOf(owner);
            return selected < 0 ? scene.selection.length : selected;
        };
        const ordered = [...owners].sort((a, b) => rank(a) - rank(b) ||
            area(b.bounds) - area(a.bounds) ||
            (a.surfaceId < b.surfaceId ? -1 : a.surfaceId > b.surfaceId ? 1 : 0));
        return new Set(ordered.slice(max).map((f) => f.surfaceId));
    }
    /** Where a surface's live content goes in this backend's last render. */
    #target(backend, surfaceId) {
        const target = backend.rendererSession.targetOf(surfaceId);
        if (target === undefined) {
            throw new Error(`surface "${surfaceId}" is live in viewport "${this.viewportId}" without a target`);
        }
        return target;
    }
    /**
     * Hides here every surface shown here that is not in `live`. With `release`, attachments are
     * released where the endpoint declares safe detachment, hidden ones included; the others stay
     * attached, hidden, and the endpoint stays the host's. A refusal leaves that surface as it is
     * and the others are hidden all the same; returns the surfaces hidden and every refusal.
     */
    async #hideAllBut(live, release) {
        const { runtime } = this.#presenter.options;
        const hidden = [];
        const refused = [];
        for (const presentation of runtime.list()) {
            const here = presentation.viewports.find((v) => v.viewportId === this.viewportId);
            if (here === undefined || live.includes(presentation.surfaceId)) {
                continue;
            }
            const releasable = release && presentation.capabilities?.safeDetach === true;
            if (!here.visible && !releasable) {
                continue;
            }
            const outcome = await runtime.hide(presentation.surfaceId, this.viewportId, { release });
            if (outcome.status === 'rejected') {
                refused.push(outcome.error);
            }
            else if (here.visible) {
                hidden.push(presentation.surfaceId);
            }
        }
        return { hidden, refused };
    }
    /**
     * Stage 5: one advisory hint per surface attached here, built from this frame. Visibility,
     * mounting, the scene's own flag, intersection, occlusion and attention are kept apart.
     * Repeats are coalesced away by the runtime; returns how many hints were delivered.
     */
    #hint(scene, view, frame) {
        const { runtime } = this.#presenter.options;
        const hints = [];
        let delivered = 0;
        for (const presentation of runtime.list()) {
            const here = presentation.viewports.find((v) => v.viewportId === this.viewportId);
            if (here === undefined) {
                continue;
            }
            const hint = hintFor(scene, view, frame, presentation.surfaceId, this.#live);
            if (hint === null) {
                continue;
            }
            hints.push(hint);
            const outcome = runtime.deliverHint(hint);
            if (outcome.status === 'ok' && outcome.delivered) {
                delivered += 1;
            }
        }
        return { hints: Object.freeze(hints), delivered };
    }
    // --- handoff -------------------------------------------------------------------------------
    /**
     * Hands over to the first of `candidates` that works. When none does, the previous backend
     * stays when it still works (`usable`); otherwise the viewport degrades.
     */
    async #activate(candidates, reason, usable) {
        const old = this.#backend;
        let error = null;
        // The surfaces a failed rollback could not put back, until a later rollback puts them back.
        const unrestored = new Map();
        for (const choice of candidates) {
            if (old !== null && usable && sameChoice(old.choice, choice)) {
                return Object.freeze({ status: 'switched', backend: old.choice });
            }
            const failure = await this.#handoff(choice, old, usable, reason, unrestored);
            if (failure === null) {
                return Object.freeze({ status: 'switched', backend: choice });
            }
            // Everything the candidate did is undone: the viewport is back on the previous backend,
            // active when it still works and degraded otherwise, before the next candidate is begun.
            this.#advance({ kind: 'failed', oldUsable: old !== null && usable });
            error = failure;
            this.#presenter.emit({
                type: 'backend.failed',
                viewportId: this.viewportId,
                backend: choice,
                error: failure,
            });
        }
        // Every candidate tried set `error`: none is set only when there was nothing to try.
        const settlement = models.settle(error === null ? { kind: 'untried' } : { kind: 'failed', restored: unrestored.size === 0 }, old !== null && usable);
        const state = STATES[models.settledState(settlement).kind];
        switch (settlement.kind) {
            case 'switched':
                if (old === null) {
                    throw new Error(`the handoff model settled viewport "${this.viewportId}" as switched without a backend`);
                }
                this.#state = state;
                return Object.freeze({ status: 'switched', backend: old.choice });
            case 'kept':
                if (old === null || error === null) {
                    throw new Error(`the handoff model kept viewport "${this.viewportId}" without a backend or a failure`);
                }
                this.#state = state;
                return Object.freeze({
                    status: 'kept',
                    backend: old.choice,
                    error,
                    unrestored: Object.freeze([...unrestored].map(([surfaceId, why]) => Object.freeze({ surfaceId, error: why }))),
                });
            case 'degraded': {
                const why = error ?? this.#noBackend();
                await this.#degrade(why, state);
                return Object.freeze({ status: 'degraded', error: why });
            }
        }
    }
    /**
     * Prepares `choice`, negotiates the scene with it, rebuilds the view in it and moves the live
     * content over, then watches it for loss, activates it and releases `old`. Returns null on
     * success; on failure, every session it prepared is released and every step it carried out is
     * undone, so the previous backend is as it was, but for the surfaces an undo step could not put
     * back: those are kept in `unrestored`, and a surface put back is taken out of it.
     */
    async #handoff(choice, old, usable, reason, unrestored) {
        const { registry, workspace, runtime } = this.#presenter.options;
        const fail = (phase, message, cause, left = []) => makeError('BACKEND_SWITCH_FAILED', `viewport "${this.viewportId}" cannot switch to renderer "${choice.renderer}" with compositor "${choice.compositor}": ${message}`, {
            entityId: this.viewportId,
            retryable: true,
            details: {
                phase,
                renderer: choice.renderer,
                compositor: choice.compositor,
                ...(cause === undefined ? {} : { reason: describe(cause) }),
                ...(left.length === 0 ? {} : { unrestored: Object.freeze([...left]) }),
            },
        });
        this.#advance({ kind: 'begin' });
        const renderer = registry.renderer(choice.renderer);
        const compositor = registry.compositor(choice.compositor);
        if (renderer === undefined) {
            return fail('preparing', 'the renderer is not registered');
        }
        if (compositor === undefined) {
            return fail('preparing', 'the compositor is not registered');
        }
        if (this.#lost.has(lostKey(choice))) {
            return fail('preparing', 'it lost its resources in this viewport and was not restored');
        }
        const scene = workspace.getPresented();
        let view;
        let rendererSession = null;
        let compositorSession = null;
        try {
            view = viewGeometryOf(scene, this.viewportId);
            rendererSession = await renderer.module.prepare(scene, view);
            compositorSession = await compositor.module.prepare({ viewportId: this.viewportId, container: this.#options.container }, rendererSession);
        }
        catch (error) {
            await this.#releaseQuietly(choice, compositorSession, rendererSession);
            return fail('preparing', 'it could not be prepared', error);
        }
        const candidate = {
            choice,
            renderer,
            compositor,
            rendererSession,
            compositorSession,
            watches: [],
        };
        const abandon = async (error) => {
            await this.#releaseQuietly(choice, candidate.compositorSession, candidate.rendererSession);
            return error;
        };
        // Validating: the scene negotiated with the new capabilities, and the live content movable.
        this.#advance({ kind: 'prepared' });
        const stranded = new Set();
        for (const presentation of runtime.list()) {
            const surfaceId = presentation.surfaceId;
            if (attachmentHere(runtime, surfaceId, this.viewportId) === undefined) {
                continue;
            }
            const validation = models.validateSurface(usable, presentation.capabilities?.safeDetach === true);
            if (validation.kind === 'movable') {
                continue;
            }
            if (validation.kind === 'refuse') {
                return abandon(fail('validating', `surface "${surfaceId}" is attached here and its endpoint does not allow safe detachment, so it cannot move`));
            }
            // The old backend is gone: what cannot move is shown as a proxy, attached but hidden.
            stranded.add(surfaceId);
        }
        let frame;
        try {
            const output = createViewOutput(scene, this.viewportId, this.#projectFresh(scene, view));
            frame = this.#plan(scene, view, output, candidate, stranded);
        }
        catch (error) {
            return abandon(fail('validating', 'the scene cannot be planned with it', error));
        }
        // Swapping: rebuild the view in the new resources and move the live content into them.
        this.#advance({ kind: 'validated' });
        let live;
        try {
            const rendered = candidate.rendererSession.render(frame);
            candidate.compositorSession.compose(rendered);
            live = liveIn(rendered);
        }
        catch (error) {
            return abandon(fail('swapping', 'it could not render the view', error));
        }
        const undo = [];
        // Every undo step is carried out, latest first, whether or not one before it failed: a
        // surface not put back is kept in `unrestored`, and one put back is taken out of it.
        const rollback = async (phase, message, cause) => {
            const left = [];
            for (const step of undo.reverse()) {
                const outcome = await step.run();
                if (outcome.status === 'ok') {
                    unrestored.delete(step.surfaceId);
                }
                else {
                    unrestored.set(step.surfaceId, outcome.error);
                    left.push(step.surfaceId);
                }
            }
            return abandon(fail(phase, message, cause, left));
        };
        // Attachments here move into the new resources when they stay live, and leave the old ones
        // (released where the endpoint allows) when they do not. Newly live content is attached by
        // the next frame, like any other.
        for (const presentation of runtime.list()) {
            const surfaceId = presentation.surfaceId;
            const here = presentation.viewports.find((v) => v.viewportId === this.viewportId);
            if (here === undefined) {
                continue;
            }
            const from = old?.rendererSession.targetOf(surfaceId);
            const action = models.swapSurface(live.includes(surfaceId), stranded.has(surfaceId));
            let outcome;
            if (action.kind === 'move') {
                const target = candidate.rendererSession.targetOf(surfaceId);
                if (target === undefined) {
                    return rollback('swapping', `surface "${surfaceId}" is live without a target`);
                }
                outcome = await runtime.move(surfaceId, this.viewportId, target);
            }
            else {
                // A surface kept hidden cannot leave without safe detachment: it stays attached, hidden,
                // and the host's.
                outcome = await runtime.hide(surfaceId, this.viewportId, {
                    release: action.kind === 'release',
                });
            }
            const step = models.swapStep(action, outcome.status === 'ok', here.visible, from !== undefined);
            if (step.kind === 'rollback') {
                return rollback('swapping', `surface "${surfaceId}" could not be ${SWAP_VERBS[action.kind]}`, outcome.status === 'rejected' ? outcome.error.message : undefined);
            }
            const back = this.#undoStep(step.undo, surfaceId, from, here.visible);
            if (back !== null) {
                undo.push({ surfaceId, run: back });
            }
        }
        // A backend whose loss cannot be watched cannot be used: watching is the last step that can
        // fail, before the previous backend is let go.
        try {
            this.#watch(candidate);
        }
        catch (error) {
            return rollback('swapping', 'its loss could not be watched', error);
        }
        // Activate at once, then release the previous backend.
        this.#backend = candidate;
        this.#live = new Set(live.filter((id) => attachmentHere(runtime, id, this.viewportId)?.visible === true));
        this.#advance({ kind: 'swapped' });
        this.#degradedBy = null;
        this.#takeDegradedAway();
        if (old !== null) {
            this.#unwatch(old);
            await this.#releaseQuietly(old.choice, old.compositorSession, old.rendererSession);
        }
        this.#presenter.emit({
            type: 'backend.switched',
            viewportId: this.viewportId,
            from: old?.choice ?? null,
            to: choice,
            reason,
            capabilities: Object.freeze({
                renderer: renderer.capabilities,
                compositor: compositor.capabilities,
            }),
        });
        this.mark('backend');
        return null;
    }
    /**
     * What a rollback does for a surface whose swap step was carried out, as the handoff model
     * decided: move it back into `from`, present it there again (hidden again when it was hidden),
     * show it again where it stayed attached, or nothing. Each resolves to the runtime's outcome:
     * the first refusal, or the last step's success.
     */
    #undoStep(undo, surfaceId, from, visible) {
        const { runtime } = this.#presenter.options;
        switch (undo.kind) {
            case 'nothing':
                return null;
            case 'moveBack':
                return () => runtime.move(surfaceId, this.viewportId, from);
            case 'represent':
                return async () => {
                    const presented = await runtime.present(surfaceId, this.viewportId, from);
                    return presented.status === 'ok' && !visible
                        ? runtime.hide(surfaceId, this.viewportId)
                        : presented;
                };
            case 'reveal':
                // Still attached: presenting it again shows it where it is.
                return () => runtime.present(surfaceId, this.viewportId, from);
        }
    }
    /** Moves the viewport as the handoff model decides on `event`; an event out of order is a defect. */
    #advance(event) {
        const next = models.handoffStep(leanState(this.#state), event);
        if (next === null) {
            throw new Error(`viewport "${this.viewportId}" cannot take ${event.kind} while ${this.#state}`);
        }
        this.#state = STATES[next.kind];
    }
    /** Projects without the cache: a new backend validates against a fresh projection. */
    #projectFresh(scene, view) {
        const projector = this.#presenter.options.registry.projector(view.projectionId);
        if (projector === undefined) {
            throw new Error(`projection "${view.projectionId}" is not registered`);
        }
        return projector.module.project(scene, view, (id) => this.#presenter.options.workspace.presentedGeometry(id));
    }
    /**
     * Listens for the backend losing its resources, keeping what stops listening in its `watches`.
     * When a session's `watchLoss` throws, the watches already made are stopped and it rethrows.
     */
    #watch(backend) {
        const lost = (reason) => {
            this.#background('lost', async () => {
                if (this.#backend !== backend) {
                    return;
                }
                this.#lost.add(lostKey(backend.choice));
                this.#presenter.emit({
                    type: 'backend.lost',
                    viewportId: this.viewportId,
                    backend: backend.choice,
                    reason,
                });
                await this.#activate(this.#fallbacks(backend.choice), 'lost', false);
            });
        };
        try {
            backend.watches.push({ session: 'renderer', stop: backend.rendererSession.watchLoss(lost) });
            backend.watches.push({
                session: 'compositor',
                stop: backend.compositorSession.watchLoss(lost),
            });
        }
        catch (error) {
            this.#unwatch(backend);
            throw error;
        }
    }
    /**
     * Stops every watch on the backend's sessions for loss. A stop that throws is reported as a
     * `backend.failed` event of the `releasing` phase, and the others are stopped all the same.
     */
    #unwatch(backend) {
        for (const watch of backend.watches.splice(0)) {
            try {
                watch.stop();
            }
            catch (error) {
                const id = watch.session === 'renderer' ? backend.choice.renderer : backend.choice.compositor;
                this.#presenter.emit({
                    type: 'backend.failed',
                    viewportId: this.viewportId,
                    backend: backend.choice,
                    error: makeError('BACKEND_SWITCH_FAILED', `viewport "${this.viewportId}": stopping the loss watch of ${watch.session} "${id}" failed`, { entityId: this.viewportId, details: { phase: 'releasing', reason: describe(error) } }),
                });
            }
        }
    }
    /**
     * Takes away what shows that the viewport is degraded, if anything does. The host's function
     * that throws is kept as a `HOST_THREW` diagnostic, and is never called again.
     */
    #takeDegradedAway() {
        const hide = this.#hideDegraded;
        this.#hideDegraded = null;
        if (hide === null) {
            return;
        }
        try {
            hide();
        }
        catch (error) {
            this.#presenter.diagnose('HOST_THREW', `viewport "${this.viewportId}": taking away what showed that it was degraded threw`, { viewportId: this.viewportId, hook: 'showDegraded', reason: describe(error) });
        }
    }
    /**
     * No backend works: the live content leaves the old resources (released where the endpoint
     * allows), they are released, and the container shows that the viewport is degraded. The
     * viewport is degraded, its old backend released and `viewport.degraded` sent even when hiding
     * a surface is refused or `showDegraded` throws; then it throws what failed: that failure, or
     * an `AggregateError` of them all.
     */
    async #degrade(error, state) {
        const old = this.#backend;
        this.#backend = null;
        this.#live = new Set();
        this.#state = state;
        this.#degradedBy = error;
        const failures = [];
        if (old !== null) {
            this.#unwatch(old);
            try {
                const { refused } = await this.#hideAllBut([], true);
                failures.push(...refused.map((r) => new SwfFailure(r)));
            }
            finally {
                await this.#releaseQuietly(old.choice, old.compositorSession, old.rendererSession);
            }
        }
        this.#takeDegradedAway();
        try {
            this.#hideDegraded = this.#presenter.options.showDegraded(this.#options.container, error);
        }
        catch (thrown) {
            failures.push(thrown);
        }
        this.#presenter.emit({ type: 'viewport.degraded', viewportId: this.viewportId, error });
        if (failures.length === 1) {
            throw failures[0];
        }
        if (failures.length > 1) {
            throw new AggregateError(failures, `viewport "${this.viewportId}" degraded, but ${failures.map(describe).join('; ')}`);
        }
    }
    async #releaseQuietly(choice, compositor, renderer) {
        for (const [phase, session] of [
            ['releasing the compositor', compositor],
            ['releasing the renderer', renderer],
        ]) {
            if (session === null) {
                continue;
            }
            try {
                await session.release();
            }
            catch (error) {
                this.#presenter.emit({
                    type: 'backend.failed',
                    viewportId: this.viewportId,
                    backend: choice,
                    error: makeError('BACKEND_SWITCH_FAILED', `viewport "${this.viewportId}": ${phase} "${phase.endsWith('compositor') ? choice.compositor : choice.renderer}" failed`, {
                        entityId: this.viewportId,
                        details: { phase: 'releasing', reason: describe(error) },
                    }),
                });
            }
        }
    }
    #noBackend() {
        return makeError('BACKEND_SWITCH_FAILED', `viewport "${this.viewportId}" has no backend that works`, { entityId: this.viewportId, retryable: true, details: { phase: 'preparing' } });
    }
    async #dispose() {
        const { runtime } = this.#presenter.options;
        const old = this.#backend;
        this.#backend = null;
        this.#live = new Set();
        this.#advance({ kind: 'dispose' });
        const retained = [];
        try {
            for (const presentation of runtime.list()) {
                if (!presentation.viewports.some((v) => v.viewportId === this.viewportId)) {
                    continue;
                }
                const outcome = await runtime.hide(presentation.surfaceId, this.viewportId, {
                    release: true,
                });
                const still = attachmentHere(runtime, presentation.surfaceId, this.viewportId);
                if (outcome.status === 'rejected' || still !== undefined) {
                    retained.push(presentation.surfaceId);
                }
            }
            if (old !== null) {
                this.#unwatch(old);
                await this.#releaseQuietly(old.choice, old.compositorSession, old.rendererSession);
            }
            const hideDegraded = this.#hideDegraded;
            this.#hideDegraded = null;
            hideDegraded?.();
        }
        finally {
            // A disposed viewport frees its ID, even when the host's hook threw.
            this.#presenter.step(this, 'closed');
        }
        return Object.freeze({ retained: Object.freeze(retained) });
    }
}
function lostKey(choice) {
    return JSON.stringify([choice.renderer, choice.compositor]);
}
function attachmentHere(runtime, surfaceId, viewportId) {
    return runtime.get(surfaceId)?.viewports.find((v) => v.viewportId === viewportId);
}
function liveIn(rendered) {
    return rendered.layers.flatMap((l) => l.category === 'content-native' && l.surfaceId !== null ? [l.surfaceId] : []);
}
/** What a viewport reads of a view, as a key: equal keys mean the same view. */
function viewKey(view) {
    return JSON.stringify(view);
}
/**
 * Whether two scenes agree on everything a view presents: the same node and surface records
 * (records are immutable, so the same object means unchanged), selection and focus.
 */
function sameContent(a, b) {
    if (a === b) {
        return true;
    }
    if (a.nodes.size !== b.nodes.size ||
        a.surfaces.size !== b.surfaces.size ||
        a.focusedId !== b.focusedId ||
        a.selection.length !== b.selection.length ||
        a.selection.some((id, i) => b.selection[i] !== id)) {
        return false;
    }
    for (const node of a.nodes.values()) {
        if (b.nodes.get(node.id) !== node) {
            return false;
        }
    }
    for (const surface of a.surfaces.values()) {
        if (b.surfaces.get(surface.id) !== surface) {
            return false;
        }
    }
    return true;
}
function area(rect) {
    return Math.max(0, rect[2]) * Math.max(0, rect[3]);
}
function overlap(a, b) {
    const w = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
    const h = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
    return w > 0 && h > 0 ? w * h : 0;
}
/** The area of a projected quadrilateral, by the shoelace formula. */
function quadArea(corners) {
    let sum = 0;
    for (let i = 0; i < 4; i++) {
        const [x0, y0] = corners[i] ?? [0, 0];
        const [x1, y1] = corners[(i + 1) % 4] ?? [0, 0];
        sum += x0 * y1 - x1 * y0;
    }
    return Math.abs(sum) / 2;
}
/**
 * A surface's hint in a frame, or null when the scene no longer has it. `visible` is whether the
 * frame shows it at all (live, drawn or as a proxy); `mounted` whether its own content is attached
 * and shown here; `sceneVisible` the scene's own flag; the intersection is the share of the
 * projected surface inside the view; the occlusion is estimated from the bounds of what is drawn
 * in front (exactly zero when nothing in front overlaps them, unknown when it is not shown).
 */
function hintFor(scene, view, frame, surfaceId, live) {
    const surface = scene.surfaces.get(surfaceId);
    if (surface === undefined) {
        return null;
    }
    const order = frame.output.fragments;
    const own = order.filter((f) => f.surfaceId === surfaceId);
    const visible = own.length > 0;
    const mine = frame.planned.filter((p) => p.fragment.surfaceId === surfaceId);
    const layers = mine.map((p) => p.negotiation.layer);
    const representation = mine[0]?.representation ?? 'full';
    const shown = own.reduce((sum, f) => sum + area(f.bounds), 0);
    const whole = own.find((f) => f.corners !== null)?.corners ?? null;
    const intersectionRatio = !visible
        ? 0
        : whole === null
            ? 1
            : Math.min(1, quadArea(whole) > 0 ? shown / quadArea(whole) : 1);
    let occlusion;
    if (!visible || shown === 0) {
        occlusion = { value: null, confidence: 'unknown' };
    }
    else {
        let covered = 0;
        for (const fragment of own) {
            const at = order.indexOf(fragment);
            for (const front of order.slice(at + 1)) {
                if (front.surfaceId !== surfaceId) {
                    covered += overlap(fragment.bounds, front.bounds);
                }
            }
        }
        occlusion =
            covered === 0
                ? { value: 0, confidence: 'exact' }
                : { value: Math.min(1, covered / shown), confidence: 'estimated' };
    }
    const anchor = own.find((f) => f.nativeOwner) ?? own[0];
    const focused = scene.focusedId !== null && scene.focusedId === surface.ownerNodeId;
    return {
        surfaceId,
        viewportId: view.viewportId,
        sceneRevision: scene.revision,
        visible,
        mounted: live.has(surfaceId),
        sceneVisible: surfaceEffectiveState(scene, surfaceId)?.visible === true,
        intersectionRatio,
        occlusion: Object.freeze(occlusion),
        projectedBounds: anchor === undefined ? null : anchor.bounds,
        tier: !visible
            ? 'hidden'
            : layers.some((l) => l === 'content-native' || l === 'content-raster')
                ? 'full'
                : representation === 'compact'
                    ? 'compact'
                    : 'proxy',
        attention: focused ? 'active' : visible ? 'context' : 'background',
        spatialBounds: surface.bounds,
        requestedIntrinsicSize: null,
    };
}
/** Each viewport state as the handoff model names it, and back. */
const LEAN_STATES = Object.freeze({
    preparing: 'preparing',
    validating: 'validating',
    swapping: 'swapping',
    active: 'active',
    'presentation-degraded': 'degraded',
    disposed: 'disposed',
});
/** A viewport ID no viewport holds. */
const ABSENT = Object.freeze({ kind: 'absent' });
/** What a refused swap step failed to do, by its action. */
const SWAP_VERBS = Object.freeze({
    move: 'moved into it',
    keepHidden: 'hidden',
    release: 'released',
});
const STATES = Object.freeze({
    preparing: 'preparing',
    validating: 'validating',
    swapping: 'swapping',
    active: 'active',
    degraded: 'presentation-degraded',
    disposed: 'disposed',
});
function leanState(state) {
    return { kind: LEAN_STATES[state] };
}
//# sourceMappingURL=presenter.js.map