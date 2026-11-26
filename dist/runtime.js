import { makeError, surfaceEffectiveState, SwfFailure } from '@swf/core';
import { models } from '@swf/models';
import { adapterIssue } from './adapter.js';
import { capabilitiesIssue, exceededCapabilities, freezeCapabilities } from './capabilities.js';
/**
 * Creates the surface runtime of a workspace. It subscribes to the workspace and starts tracking
 * every surface in the scene at once, binding each that can bind when `autoBind` is on (as soon as
 * an adapter of its type is registered).
 *
 * The runtime is the caller's: dispose it with {@link SurfaceRuntime.dispose} to release every
 * attachment and unsubscribe from the workspace; disposing the workspace disposes it too. Neither
 * stops a host's producer or disposes an endpoint.
 *
 * @throws A {@link SwfFailure}: `INVALID_INPUT` for invalid options, naming `options.<field>`, and
 *   `WORKSPACE_DISPOSED` when the workspace is not `ready`.
 *
 * @example
 * ```ts
 * const surfaces = createSurfaceRuntime(workspace, { bindingTimeoutMs: 5000 });
 * const unregister = surfaces.registerAdapter(videoAdapter);
 * const unsubscribe = surfaces.subscribe((event) => {
 *   if (event.type === 'presentation.stateChanged') console.log(event.payload.to);
 * });
 * // ...
 * unsubscribe();
 * unregister();
 * await surfaces.dispose();
 * ```
 */
export function createSurfaceRuntime(workspace, options = {}) {
    return new Runtime(workspace, options);
}
const OPTION_KEYS = ['bindingTimeoutMs', 'autoBind', 'now', 'diagnosticsCapacity', 'onDiagnostic'];
class Runtime {
    workspaceId;
    #workspace;
    #timeoutMs;
    #autoBind;
    #now;
    #diagnosticsCapacity;
    #onDiagnostic;
    #adapters = new Map();
    #entries = new Map();
    #listeners = new Set();
    #outbox = [];
    #delivering = false;
    #diagnostics = [];
    #eventSeq = 0;
    #disposed = null;
    #unsubscribe;
    constructor(workspace, options) {
        const checked = checkOptions(options, workspace.id);
        if (workspace.lifecycle !== 'ready') {
            throw failure('WORKSPACE_DISPOSED', `workspace "${workspace.id}" is ${workspace.lifecycle}`, workspace.id);
        }
        this.workspaceId = workspace.id;
        this.#workspace = workspace;
        this.#timeoutMs = checked.bindingTimeoutMs;
        this.#autoBind = checked.autoBind;
        this.#now = checked.now;
        this.#diagnosticsCapacity = checked.diagnosticsCapacity;
        this.#onDiagnostic = checked.onDiagnostic;
        this.#unsubscribe = workspace.subscribe((event) => {
            this.#onWorkspaceEvent(event);
        });
        for (const surface of workspace.getState().surfaces) {
            this.#track(surface);
        }
    }
    get disposed() {
        return this.#disposed !== null;
    }
    // --- queries ----------------------------------------------------------------------------
    get(surfaceId) {
        const entry = this.#entries.get(surfaceId);
        return entry === undefined ? undefined : snapshot(entry);
    }
    list() {
        return [...this.#entries.values()].map(snapshot);
    }
    handleOf(surfaceId) {
        const entry = this.#entries.get(surfaceId);
        return entry === undefined || entry.capabilities === null ? undefined : entry.handle;
    }
    getDiagnostics() {
        return [...this.#diagnostics];
    }
    subscribe(listener) {
        if (typeof listener !== 'function') {
            throw failure('INVALID_INPUT', 'listener must be a function', this.workspaceId);
        }
        this.#assertLive();
        const entry = (event) => {
            listener(event);
        };
        this.#listeners.add(entry);
        return () => {
            this.#listeners.delete(entry);
        };
    }
    // --- adapters ---------------------------------------------------------------------------
    registerAdapter(adapter) {
        this.#assertLive();
        const issue = adapterIssue(adapter);
        if (issue !== null) {
            throw failure(issue.code, issue.message, this.workspaceId);
        }
        if (this.#adapters.has(adapter.id)) {
            throw failure('INVALID_INPUT', `an adapter "${adapter.id}" is already registered`, this.workspaceId);
        }
        const registered = Object.freeze({
            id: adapter.id,
            apiVersion: adapter.apiVersion,
            declaredCapabilities: freezeCapabilities(adapter.declaredCapabilities),
            untimedBinding: adapter.untimedBinding ?? false,
            resolve: (key, signal, context) => adapter.resolve(key, signal, context),
            capabilities: (handle) => adapter.capabilities(handle),
            attach: (handle, target) => adapter.attach(handle, target),
            update: (handle, hint) => {
                adapter.update(handle, hint);
            },
            detach: (handle, target) => adapter.detach(handle, target),
        });
        this.#adapters.set(adapter.id, registered);
        this.#emit('adapter.registered', { adapterId: adapter.id });
        if (this.#autoBind) {
            for (const entry of this.#entries.values()) {
                if (entry.binding.adapterTypeId === adapter.id &&
                    models.bindsOnAdapter(presentationOf(entry))) {
                    this.#startBinding(entry);
                }
            }
        }
        return () => {
            if (this.#adapters.get(adapter.id) !== registered) {
                return;
            }
            this.#adapters.delete(adapter.id);
            for (const entry of this.#entries.values()) {
                if (entry.binding.adapterTypeId === adapter.id &&
                    models.holdsBinding(presentationOf(entry))) {
                    void this.#release(entry, 'unbound', 'adapter-unavailable');
                }
            }
            this.#emit('adapter.unregistered', { adapterId: adapter.id });
        };
    }
    // --- lifecycle operations ---------------------------------------------------------------
    bind(surfaceId) {
        const entry = this.#entries.get(surfaceId);
        if (entry === undefined) {
            return this.#rejected(this.#unknown(surfaceId));
        }
        const refused = models.bindGate(this.#disposed !== null, presentationOf(entry));
        if (refused !== null) {
            return this.#rejected(this.#refusal(entry, refused, 'bind'));
        }
        this.#startBinding(entry);
        return entry.settled.then(() => this.#ok(entry));
    }
    unbind(surfaceId) {
        const entry = this.#entries.get(surfaceId);
        if (entry === undefined) {
            return this.#rejected(this.#unknown(surfaceId));
        }
        const gate = models.unbindGate(presentationOf(entry), entry.replacing !== null);
        if (gate.kind === 'refuse') {
            return this.#rejected(this.#refusal(entry, gate.why, 'unbind'));
        }
        if (gate.kind === 'done') {
            return Promise.resolve(this.#ok(entry));
        }
        return this.#release(entry, 'unbound', 'released').then(() => this.#ok(entry));
    }
    async present(surfaceId, viewportId, container) {
        const entry = this.#entries.get(surfaceId);
        if (entry === undefined) {
            return this.#rejected(this.#unknown(surfaceId));
        }
        const blocked = this.#presentBlocker(entry, viewportId);
        if (blocked !== null) {
            return this.#rejected(blocked);
        }
        const existing = entry.attachments.get(viewportId);
        if (existing !== undefined) {
            // Hidden but still attached: reveal it, with no new attachment.
            existing.visible = true;
            this.#emit('presentation.viewportChanged', {
                surfaceId,
                viewportId,
                attached: true,
                visible: true,
            });
            this.#settleVisibility(entry);
            return this.#ok(entry);
        }
        const adapter = entry.adapter;
        const geometry = this.#workspace.surfaceGeometry(surfaceId);
        if (adapter === null || geometry === undefined) {
            return this.#rejected(this.#unknown(surfaceId));
        }
        const target = Object.freeze({
            surfaceId,
            viewportId,
            container,
            geometry,
        });
        const generation = entry.generation;
        const handle = entry.handle;
        entry.pending.add(viewportId);
        try {
            await adapter.attach(handle, target);
        }
        catch (error) {
            entry.pending.delete(viewportId);
            if (entry.generation !== generation || entry.removed) {
                return this.#rejected(this.#changedWhile(surfaceId, 'attaching'));
            }
            const failed = this.#error('BIND_FAILED', `adapter "${adapter.id}" could not attach surface "${surfaceId}" in viewport "${viewportId}"`, surfaceId, { retryable: true, details: { phase: 'attach', reason: describeError(error) } });
            await this.#fail(entry, failed);
            return this.#rejected(failed);
        }
        entry.pending.delete(viewportId);
        if (entry.generation !== generation || entry.removed) {
            // The surface was removed, rebound or unbound meanwhile: release only this attachment.
            this.#diagnose('STALE_COMPLETION', `an attachment of surface "${surfaceId}" completed after the surface changed; released`, surfaceId, { phase: 'attach' });
            await this.#detachQuietly(adapter, handle, target, surfaceId);
            return this.#rejected(this.#changedWhile(surfaceId, 'attaching'));
        }
        entry.attachments.set(viewportId, { target, visible: true, lastHint: null });
        this.#emit('presentation.viewportChanged', {
            surfaceId,
            viewportId,
            attached: true,
            visible: true,
        });
        this.#settleVisibility(entry);
        return this.#ok(entry);
    }
    async move(surfaceId, viewportId, container) {
        const entry = this.#entries.get(surfaceId);
        if (entry === undefined) {
            return this.#rejected(this.#unknown(surfaceId));
        }
        const attachment = entry.attachments.get(viewportId);
        const adapter = entry.adapter;
        const refused = models.moveGate(this.#disposed !== null, attachment !== undefined && adapter !== null && !entry.pending.has(viewportId), entry.replacing !== null);
        if (refused !== null) {
            return this.#rejected(this.#refusal(entry, refused, 'move', { viewportId }));
        }
        if (attachment === undefined || adapter === null) {
            throw new Error(`the presentation model moved surface "${surfaceId}", which is not attached`);
        }
        if (attachment.target.container === container) {
            return this.#ok(entry);
        }
        const geometry = this.#workspace.surfaceGeometry(surfaceId);
        if (geometry === undefined) {
            return this.#rejected(this.#unknown(surfaceId));
        }
        if (entry.capabilities?.safeDetach !== true) {
            return this.#rejected(this.#error('UNSUPPORTED_CAPABILITY', `surface "${surfaceId}" cannot move to another container in viewport "${viewportId}": its endpoint does not allow safe detachment`, surfaceId));
        }
        const previous = attachment.target;
        const target = Object.freeze({
            surfaceId,
            viewportId,
            container,
            geometry,
        });
        const generation = entry.generation;
        const handle = entry.handle;
        entry.pending.add(viewportId);
        let failure = null;
        try {
            await this.#detachQuietly(adapter, handle, previous, surfaceId);
            try {
                await adapter.attach(handle, target);
            }
            catch (error) {
                failure = error;
            }
        }
        finally {
            entry.pending.delete(viewportId);
        }
        if (entry.generation !== generation || entry.removed) {
            if (failure === null) {
                await this.#detachQuietly(adapter, handle, target, surfaceId);
            }
            return this.#rejected(this.#changedWhile(surfaceId, 'moving'));
        }
        if (failure !== null) {
            const failed = this.#error('BIND_FAILED', `adapter "${adapter.id}" could not move surface "${surfaceId}" to another container in viewport "${viewportId}"`, surfaceId, { retryable: true, details: { phase: 'move', reason: describeError(failure) } });
            try {
                await adapter.attach(handle, previous);
            }
            catch (error) {
                await this.#fail(entry, this.#error('BIND_FAILED', `adapter "${adapter.id}" could not put surface "${surfaceId}" back in viewport "${viewportId}" after a failed move`, surfaceId, { retryable: true, details: { phase: 'move', reason: describeError(error) } }));
            }
            return this.#rejected(failed);
        }
        entry.attachments.set(viewportId, { target, visible: attachment.visible, lastHint: null });
        return this.#ok(entry);
    }
    async hide(surfaceId, viewportId, options = {}) {
        const entry = this.#entries.get(surfaceId);
        if (entry === undefined) {
            return this.#rejected(this.#unknown(surfaceId));
        }
        const attachment = entry.attachments.get(viewportId);
        const adapter = entry.adapter;
        const refused = models.hideGate(attachment !== undefined && adapter !== null, entry.replacing !== null);
        if (refused !== null) {
            return this.#rejected(this.#refusal(entry, refused, 'hide', { viewportId }));
        }
        if (attachment === undefined || adapter === null) {
            throw new Error(`the presentation model hid surface "${surfaceId}", which is not attached`);
        }
        // Releasing is only safe when the handle says so; otherwise the attachment stays, hidden.
        const release = models.hideReleases(options.release === true, entry.capabilities?.safeDetach === true);
        if (!attachment.visible && !release) {
            return this.#ok(entry);
        }
        if (attachment.visible) {
            attachment.visible = false;
            this.#deliver(entry, adapter, hiddenHint(attachment, this.#workspace, surfaceId, viewportId));
        }
        if (release) {
            entry.attachments.delete(viewportId);
            await this.#detachQuietly(adapter, entry.handle, attachment.target, surfaceId);
        }
        this.#emit('presentation.viewportChanged', {
            surfaceId,
            viewportId,
            attached: !release,
            visible: false,
        });
        this.#settleVisibility(entry);
        return this.#ok(entry);
    }
    deliverHint(hint) {
        const entry = this.#entries.get(hint.surfaceId);
        if (entry === undefined) {
            return { status: 'rejected', error: this.#unknown(hint.surfaceId) };
        }
        const attachment = entry.attachments.get(hint.viewportId);
        if (attachment === undefined || entry.adapter === null) {
            return {
                status: 'rejected',
                error: this.#error('INVALID_TRANSITION', `surface "${hint.surfaceId}" is not attached in viewport "${hint.viewportId}"`, hint.surfaceId),
            };
        }
        if (attachment.lastHint !== null && sameHint(attachment.lastHint, hint)) {
            return { status: 'ok', delivered: false };
        }
        attachment.lastHint = hint;
        this.#deliver(entry, entry.adapter, hint);
        return { status: 'ok', delivered: true };
    }
    async replaceBinding(surfaceId, binding, options = {}) {
        const entry = this.#entries.get(surfaceId);
        if (entry === undefined) {
            return this.#rejected(this.#unknown(surfaceId));
        }
        const refused = models.replaceGate(this.#disposed !== null, presentationOf(entry), entry.replacing !== null, entry.adapter !== null, entry.pending.size > 0);
        if (refused !== null) {
            return this.#rejected(this.#refusal(entry, refused, 'replace'));
        }
        if (typeof binding.bindingKey !== 'string' || binding.bindingKey.trim() === '') {
            return this.#rejected(this.#error('INVALID_INPUT', 'bindingKey must be a non-blank string', surfaceId));
        }
        const next = Object.freeze({
            bindingKey: binding.bindingKey,
            adapterTypeId: binding.adapterTypeId ?? entry.binding.adapterTypeId,
        });
        const adapter = this.#adapters.get(next.adapterTypeId);
        if (adapter === undefined) {
            return this.#rejected(this.#error('ADAPTER_UNAVAILABLE', `no adapter "${next.adapterTypeId}" is registered`, surfaceId));
        }
        const oldAdapter = entry.adapter;
        if (oldAdapter === null) {
            throw new Error(`the presentation model handed over surface "${surfaceId}", which has no adapter`);
        }
        const oldHandle = entry.handle;
        const previous = entry.binding;
        const generation = entry.generation;
        // The generation the new binding has once the handoff commits; a change before then cancels it.
        const nextGeneration = generation + 1;
        entry.replacing = next;
        const attempt = newAttempt();
        const cancelled = () => entry.removed || entry.generation !== generation;
        const attached = [];
        const giveUp = async (error, handle) => {
            if (entry.replacing === next) {
                entry.replacing = null;
            }
            attempt.cancel();
            for (const target of attached) {
                await this.#detachQuietly(adapter, handle, target, surfaceId);
            }
            return Object.freeze({ status: 'rejected', error });
        };
        const resolution = await this.#resolve(adapter, next, entry, attempt, nextGeneration);
        if (cancelled()) {
            return giveUp(this.#changedWhile(surfaceId, 'replacing its binding'));
        }
        if (resolution.kind === 'cancelled') {
            return giveUp(this.#changedWhile(surfaceId, 'replacing its binding'));
        }
        if (resolution.kind === 'unknown-key') {
            return giveUp(this.#error('BIND_FAILED', `adapter "${adapter.id}" does not know the new binding key`, surfaceId, {
                retryable: true,
                details: { phase: 'resolve', reason: 'unknown binding key' },
            }));
        }
        if (resolution.kind === 'failed') {
            return giveUp(resolution.error);
        }
        const handle = resolution.handle;
        const singleOwner = resolution.capabilities.viewportSharing === 'single-owner';
        const other = singleOwner ? this.#endpointPresenter(entry, next) : undefined;
        const overlap = models.handoverGate({
            singleOwner,
            severalViewports: entry.attachments.size > 1,
            endpointElsewhere: other !== undefined,
        });
        if (overlap !== null) {
            return giveUp(this.#refusal(entry, overlap, 'replace', {
                ...(other === undefined ? {} : { other: other.surfaceId }),
            }), handle);
        }
        for (const [viewportId, attachment] of entry.attachments) {
            const geometry = this.#workspace.surfaceGeometry(surfaceId);
            if (geometry === undefined) {
                return giveUp(this.#unknown(surfaceId), handle);
            }
            const target = Object.freeze({
                surfaceId,
                viewportId,
                container: attachment.target.container,
                geometry,
            });
            try {
                await adapter.attach(handle, target);
            }
            catch (error) {
                attached.push(target);
                return giveUp(this.#error('BIND_FAILED', `adapter "${adapter.id}" could not attach the new endpoint of surface "${surfaceId}"`, surfaceId, { retryable: true, details: { phase: 'attach', reason: describeError(error) } }), handle);
            }
            attached.push(target);
            if (cancelled()) {
                return giveUp(this.#changedWhile(surfaceId, 'replacing its binding'), handle);
            }
        }
        const committed = await settleTx(this.#workspace.dispatch({
            type: 'surface.rebind',
            id: surfaceId,
            bindingKey: next.bindingKey,
            adapterTypeId: next.adapterTypeId,
        }, { source: options.source ?? 'host' }));
        if (committed.status === 'rejected') {
            return giveUp(committed.error, handle);
        }
        // Committed: hand off. The new attachments take the old ones' places; the old are released.
        const oldTargets = [...entry.attachments.values()].map((a) => a.target);
        const previousCapabilities = entry.capabilities;
        entry.replacing = null;
        entry.generation = nextGeneration;
        entry.attempt = attempt;
        entry.binding = next;
        entry.adapter = adapter;
        entry.handle = handle;
        entry.capabilities = resolution.capabilities;
        for (const target of attached) {
            const attachment = entry.attachments.get(target.viewportId);
            if (attachment !== undefined) {
                attachment.target = target;
                attachment.lastHint = null;
            }
        }
        for (const target of oldTargets) {
            await this.#detachQuietly(oldAdapter, oldHandle, target, surfaceId);
        }
        this.#emit('presentation.replaced', { surfaceId, previous, binding: next });
        if (previousCapabilities !== null &&
            !sameCapabilities(previousCapabilities, resolution.capabilities)) {
            this.#emit('presentation.capabilitiesChanged', {
                surfaceId,
                previous: previousCapabilities,
                capabilities: resolution.capabilities,
            });
        }
        return this.#ok(entry);
    }
    binder() {
        return Object.freeze({
            workspaceId: this.workspaceId,
            registerAdapter: (adapter) => this.registerAdapter(adapter),
            get: (surfaceId) => this.get(surfaceId),
            list: () => this.list(),
            bind: (surfaceId) => this.bind(surfaceId),
            unbind: (surfaceId) => this.unbind(surfaceId),
            replaceBinding: (surfaceId, binding, options) => this.replaceBinding(surfaceId, binding, options),
            subscribe: (listener) => this.subscribe(listener),
        });
    }
    dispose() {
        if (this.#disposed !== null) {
            return this.#disposed;
        }
        this.#unsubscribe();
        this.#disposed = (async () => {
            for (const entry of [...this.#entries.values()]) {
                await this.#remove(entry);
            }
            this.#adapters.clear();
            this.#listeners.clear();
        })();
        return this.#disposed;
    }
    // --- workspace events -------------------------------------------------------------------
    #onWorkspaceEvent(event) {
        switch (event.type) {
            case 'surface.attached': {
                const surface = this.#workspace.getState().surfaces.get(event.payload.surfaceId);
                if (surface !== undefined) {
                    this.#track(surface);
                }
                return;
            }
            case 'surface.detached': {
                const entry = this.#entries.get(event.payload.surfaceId);
                if (entry !== undefined) {
                    void this.#remove(entry);
                }
                return;
            }
            case 'surface.rebound': {
                const entry = this.#entries.get(event.payload.surfaceId);
                if (entry === undefined) {
                    return;
                }
                const binding = event.payload.binding;
                if (entry.replacing?.bindingKey === binding.bindingKey &&
                    entry.replacing.adapterTypeId === binding.adapterTypeId) {
                    return; // The replacement in progress committed this and completes the handoff itself.
                }
                void this.#rebound(entry, binding);
                return;
            }
            case 'surface.updated': {
                const entry = this.#entries.get(event.payload.surfaceId);
                if (entry !== undefined && event.payload.fields.includes('bounds')) {
                    this.#resendHints(entry);
                }
                return;
            }
            case 'workspace.disposed':
                void this.dispose();
                return;
            default:
                return;
        }
    }
    #track(surface) {
        const entry = {
            surfaceId: surface.id,
            state: 'unbound',
            generation: 0,
            binding: Object.freeze({
                bindingKey: surface.bindingKey,
                adapterTypeId: surface.adapterTypeId,
            }),
            adapter: null,
            handle: undefined,
            capabilities: null,
            unboundReason: null,
            error: null,
            attachments: new Map(),
            pending: new Set(),
            attempt: null,
            settled: Promise.resolve(),
            replacing: null,
            removed: false,
        };
        this.#entries.set(surface.id, entry);
        entry.unboundReason = this.#unboundReasonFor(entry);
        this.#emitState(entry, null);
        if (this.#autoBind && entry.unboundReason === 'released') {
            this.#startBinding(entry);
        }
    }
    async #rebound(entry, binding) {
        if (models.holdsBinding(presentationOf(entry))) {
            await this.#release(entry, 'unbound', 'released');
        }
        if (entry.removed) {
            return;
        }
        entry.binding = Object.freeze({ ...binding });
        const reason = this.#unboundReasonFor(entry);
        const step = this.#decide(entry, { kind: 'rebound', reason: leanReason(reason) });
        if (step.announce) {
            entry.error = null;
        }
        this.#apply(entry, step);
        if (this.#autoBind && reason === 'released') {
            this.#startBinding(entry);
        }
    }
    /** The placeholder reason a surface would show now, or `released` when it could bind. */
    #unboundReasonFor(entry) {
        if (entry.binding.bindingKey === null) {
            return 'no-binding-key';
        }
        return this.#adapters.has(entry.binding.adapterTypeId) ? 'released' : 'adapter-unavailable';
    }
    async #remove(entry) {
        if (entry.removed) {
            return;
        }
        entry.removed = true;
        await this.#release(entry, 'detached', null);
        this.#entries.delete(entry.surfaceId);
    }
    // --- binding ----------------------------------------------------------------------------
    #startBinding(entry) {
        const reason = this.#unboundReasonFor(entry);
        const step = this.#decide(entry, { kind: 'bindingStarts', reason: leanReason(reason) });
        entry.error = null;
        if (step.next.kind !== 'binding') {
            this.#apply(entry, step);
            entry.settled = Promise.resolve();
            return;
        }
        const adapter = this.#adapters.get(entry.binding.adapterTypeId);
        if (adapter === undefined) {
            throw new Error(`surface "${entry.surfaceId}" started binding with no adapter registered`);
        }
        entry.generation += 1;
        const generation = entry.generation;
        const attempt = newAttempt();
        entry.attempt = attempt;
        entry.adapter = adapter;
        this.#apply(entry, step);
        entry.settled = this.#resolve(adapter, entry.binding, entry, attempt, generation).then((resolution) => {
            if (entry.removed || entry.generation !== generation) {
                if (resolution.kind === 'bound') {
                    // Never attached, so there is nothing of ours to release: the handle is dropped.
                    this.#diagnose('STALE_COMPLETION', `a binding of surface "${entry.surfaceId}" completed after the surface changed; discarded`, entry.surfaceId, { phase: 'resolve' });
                }
                return;
            }
            switch (resolution.kind) {
                case 'bound':
                    entry.handle = resolution.handle;
                    entry.capabilities = resolution.capabilities;
                    this.#step(entry, { kind: 'resolved', r: { kind: 'bound' } });
                    return;
                case 'unknown-key':
                    entry.attempt = null;
                    entry.adapter = null;
                    this.#step(entry, { kind: 'resolved', r: { kind: 'unknownKey' } });
                    return;
                case 'failed':
                    entry.attempt = null;
                    entry.adapter = null;
                    entry.error = resolution.error;
                    this.#step(entry, { kind: 'resolved', r: { kind: 'failed' } });
                    return;
                case 'cancelled':
                    return;
            }
        });
    }
    /**
     * Resolves a binding through its adapter, with the attempt's abort signal and the timeout, and
     * negotiates the handle's capabilities against the adapter's declaration. The binding context
     * it hands the adapter carries `generation`, the one the binding has once it holds, and acts
     * only while `attempt` is the surface's current attempt.
     */
    async #resolve(adapter, binding, entry, attempt, generation) {
        const surfaceId = entry.surfaceId;
        const current = () => entry.attempt === attempt && !entry.removed;
        const context = Object.freeze({
            surfaceId,
            generation,
            announceCapabilities: (capabilities) => {
                if (current() && entry.capabilities !== null) {
                    void this.#capabilitiesChanged(entry, adapter, capabilities);
                }
            },
            reportUnavailable: (reason) => {
                if (current() && entry.capabilities !== null) {
                    void this.#fail(entry, this.#error('BIND_FAILED', `the endpoint of surface "${surfaceId}" became unavailable`, surfaceId, 
                    // Adapters are often plain JavaScript: describe whatever they pass as text.
                    {
                        retryable: true,
                        details: { phase: 'presentation', reason: describeError(reason) },
                    }));
                }
            },
        });
        let stopTimer = () => undefined;
        const timedOut = new Promise((resolve) => {
            if (adapter.untimedBinding !== true) {
                const timer = setTimeout(() => {
                    resolve('timeout');
                }, this.#timeoutMs);
                stopTimer = () => {
                    clearTimeout(timer);
                };
            }
        });
        let outcome;
        try {
            outcome = await Promise.race([
                // An attempt cancelled before it starts never reaches the adapter.
                Promise.resolve().then(() => attempt.controller.signal.aborted
                    ? attempt.cancelled
                    : adapter.resolve(binding.bindingKey ?? '', attempt.controller.signal, context)),
                timedOut,
                attempt.cancelled,
            ]);
        }
        catch (error) {
            return {
                kind: 'failed',
                error: this.#error('BIND_FAILED', `adapter "${adapter.id}" failed to resolve the binding of surface "${surfaceId}"`, surfaceId, { retryable: true, details: { phase: 'resolve', reason: describeError(error) } }),
            };
        }
        finally {
            stopTimer();
        }
        if (outcome === 'cancelled') {
            return { kind: 'cancelled' };
        }
        if (outcome === 'timeout') {
            attempt.controller.abort('timeout');
            return {
                kind: 'failed',
                error: this.#error('BIND_FAILED', `the binding of surface "${surfaceId}" timed out after ${String(this.#timeoutMs)} ms`, surfaceId, { retryable: true, details: { phase: 'resolve', reason: 'timeout' } }),
            };
        }
        if (outcome === null) {
            return { kind: 'unknown-key' };
        }
        let capabilities;
        try {
            capabilities = adapter.capabilities(outcome);
        }
        catch (error) {
            return {
                kind: 'failed',
                error: this.#error('BIND_FAILED', `adapter "${adapter.id}" failed to report capabilities for surface "${surfaceId}"`, surfaceId, { retryable: true, details: { phase: 'capabilities', reason: describeError(error) } }),
            };
        }
        const issue = capabilitiesIssue(capabilities) ??
            exceeding(adapter.declaredCapabilities, capabilities);
        if (issue !== null) {
            return {
                kind: 'failed',
                error: this.#error('UNSUPPORTED_CAPABILITY', `adapter "${adapter.id}" reported unusable capabilities for surface "${surfaceId}": ${issue}`, surfaceId),
            };
        }
        return {
            kind: 'bound',
            handle: outcome,
            capabilities: freezeCapabilities(capabilities),
        };
    }
    async #capabilitiesChanged(entry, adapter, raw) {
        const previous = entry.capabilities;
        if (previous === null) {
            return;
        }
        const issue = capabilitiesIssue(raw) ?? exceeding(adapter.declaredCapabilities, raw);
        if (issue !== null) {
            await this.#fail(entry, this.#error('UNSUPPORTED_CAPABILITY', `adapter "${adapter.id}" announced unusable capabilities for surface "${entry.surfaceId}": ${issue}`, entry.surfaceId));
            return;
        }
        const capabilities = freezeCapabilities(raw);
        entry.capabilities = capabilities;
        this.#diagnose('CAPABILITIES_CHANGED', `the capabilities of surface "${entry.surfaceId}" changed`, entry.surfaceId, { adapterId: adapter.id });
        this.#emit('presentation.capabilitiesChanged', {
            surfaceId: entry.surfaceId,
            previous,
            capabilities,
        });
        // A handle that can no longer be shared keeps only its first attachment.
        if (capabilities.viewportSharing === 'single-owner' && entry.attachments.size > 1) {
            const [, ...extra] = [...entry.attachments];
            for (const [viewportId, attachment] of extra) {
                entry.attachments.delete(viewportId);
                await this.#detachQuietly(adapter, entry.handle, attachment.target, entry.surfaceId);
                this.#emit('presentation.viewportChanged', {
                    surfaceId: entry.surfaceId,
                    viewportId,
                    attached: false,
                    visible: false,
                });
            }
            this.#settleVisibility(entry);
        }
    }
    /** Releases the surface's attachments and handle and records a typed error. */
    async #fail(entry, error) {
        entry.generation += 1;
        entry.attempt?.cancel();
        entry.attempt = null;
        await this.#releaseAttachments(entry);
        if (entry.removed) {
            return;
        }
        entry.error = error;
        entry.handle = undefined;
        entry.capabilities = null;
        entry.adapter = null;
        this.#step(entry, { kind: 'fails' });
    }
    /**
     * Ends the surface's binding: supersedes any attempt in flight, releases every presentation
     * attachment through the adapter (never touching the endpoint itself), and leaves the surface
     * `unbound` (association kept) or `detached` (association removed).
     */
    async #release(entry, final, reason) {
        entry.generation += 1;
        entry.attempt?.cancel();
        entry.attempt = null;
        entry.replacing = null;
        // Announced only when it held or was acquiring a binding: then there is something to release.
        if (this.#step(entry, { kind: 'releaseStarts' }).announce) {
            await this.#releaseAttachments(entry);
        }
        entry.error = null;
        entry.handle = undefined;
        entry.capabilities = null;
        entry.adapter = null;
        entry.settled = Promise.resolve();
        this.#step(entry, {
            kind: 'releaseEnds',
            final: final === 'detached'
                ? { kind: 'detached' }
                : { kind: 'unbound', reason: leanReason(reasonOf(entry, reason)) },
        });
    }
    async #releaseAttachments(entry) {
        const adapter = entry.adapter;
        const attachments = [...entry.attachments];
        entry.attachments.clear();
        for (const [viewportId, attachment] of attachments) {
            if (adapter !== null) {
                await this.#detachQuietly(adapter, entry.handle, attachment.target, entry.surfaceId);
            }
            this.#emit('presentation.viewportChanged', {
                surfaceId: entry.surfaceId,
                viewportId,
                attached: false,
                visible: false,
            });
        }
    }
    async #detachQuietly(adapter, handle, target, surfaceId) {
        try {
            await adapter.detach(handle, target);
        }
        catch (error) {
            this.#diagnose('ADAPTER_THREW', `adapter "${adapter.id}" failed to detach surface "${surfaceId}"`, surfaceId, { phase: 'detach', reason: describeError(error) });
        }
    }
    /**
     * Why the surface cannot be presented in the viewport now, or null: the presentation model
     * decides, from the surface's state and attachments and the single-owner endpoint's.
     */
    #presentBlocker(entry, viewportId) {
        const valid = typeof viewportId === 'string' && viewportId.trim() !== '';
        const existing = valid ? entry.attachments.get(viewportId) : undefined;
        const singleOwner = entry.capabilities?.viewportSharing === 'single-owner';
        const other = singleOwner ? this.#endpointPresenter(entry, entry.binding) : undefined;
        const refused = models.presentGate({
            disposed: this.#disposed !== null,
            viewportValid: valid,
            replacing: entry.replacing !== null,
            phase: presentationOf(entry),
            existing: existing === undefined ? null : existing.visible,
            pending: valid && entry.pending.has(viewportId),
            singleOwner,
            attachedAnywhere: entry.attachments.size > 0 || entry.pending.size > 0,
            endpointElsewhere: other !== undefined,
        });
        return refused === null
            ? null
            : this.#refusal(entry, refused, 'present', {
                viewportId: String(viewportId),
                ...(other === undefined ? {} : { other: other.surfaceId }),
            });
    }
    /**
     * Another surface than `entry` presenting, attaching or handing over to `endpoint` through the
     * same adapter: one attached or attaching somewhere whose binding, or the binding it is handing
     * over to, is that endpoint.
     */
    #endpointPresenter(entry, endpoint) {
        const same = (ref) => ref !== null &&
            ref.bindingKey === endpoint.bindingKey &&
            ref.adapterTypeId === endpoint.adapterTypeId;
        for (const other of this.#entries.values()) {
            if (other !== entry &&
                (same(other.binding) || same(other.replacing)) &&
                (other.attachments.size > 0 || other.pending.size > 0)) {
                return other;
            }
        }
        return undefined;
    }
    /** The error a refusal of the presentation model stands for. */
    #refusal(entry, why, request, at = {}) {
        const id = entry.surfaceId;
        const transition = (message) => this.#error('INVALID_TRANSITION', message, id);
        const handOff = 'a replacement hands off from a bound surface (use surface.rebind otherwise)';
        switch (why.kind) {
            case 'disposed':
                return this.#disposedError();
            case 'invalidViewport':
                return this.#error('INVALID_INPUT', 'viewportId must be a non-blank string', id);
            case 'notUnboundOrFailed':
                return transition(`surface "${id}" is ${entry.state}; only an unbound or failed surface can bind`);
            case 'detaching':
                return transition(`surface "${id}" is detaching`);
            case 'replacing':
                return request === 'replace'
                    ? transition(`surface "${id}" is already replacing its binding; ${handOff}`)
                    : transition(`surface "${id}" is replacing its binding`);
            case 'notBound':
                return request === 'replace'
                    ? transition(`surface "${id}" is ${entry.state}; ${handOff}`)
                    : transition(`surface "${id}" is ${entry.state}; only a bound surface can be presented`);
            case 'alreadyPresented':
                return transition(`surface "${id}" is already presented in viewport "${String(at.viewportId)}"`);
            case 'singleOwnerElsewhere':
                return this.#error('UNSUPPORTED_CAPABILITY', request === 'replace'
                    ? `the new endpoint of surface "${id}" has a single owner and cannot be shown in the ${String(entry.attachments.size)} viewports it is attached in`
                    : `surface "${id}" has a single-owner handle already presented in another viewport; show a proxy there`, id);
            case 'endpointPresented':
                return this.#error('UNSUPPORTED_CAPABILITY', `the ${request === 'replace' ? 'new ' : ''}single-owner endpoint of surface "${id}" is already presented by surface "${String(at.other)}"`, id);
            case 'notAttached':
                return transition(`surface "${id}" is not attached in viewport "${String(at.viewportId)}"`);
        }
    }
    /** The presentation model's step for an event, not yet applied. */
    #decide(entry, event) {
        return models.surfaceStep(presentationOf(entry), event);
    }
    /** Puts the surface in the state a step decided, announcing the change when it says so. */
    #apply(entry, step) {
        const from = entry.state;
        setPresentation(entry, step.next);
        if (step.announce) {
            this.#emitState(entry, from);
        }
        return step;
    }
    /** Moves the surface as the presentation model decides on `event`. */
    #step(entry, event) {
        return this.#apply(entry, this.#decide(entry, event));
    }
    /** Sets presented, hidden or ready from the surface's attachments. */
    #settleVisibility(entry) {
        const attachments = [...entry.attachments.values()];
        this.#step(entry, {
            kind: 'attachmentsChanged',
            visible: attachments.some((a) => a.visible),
            attached: attachments.length > 0,
        });
    }
    /** After the surface's spatial bounds change, re-sends each viewport's last hint with them. */
    #resendHints(entry) {
        const surface = this.#workspace.getState().surfaces.get(entry.surfaceId);
        if (surface === undefined || entry.adapter === null) {
            return;
        }
        for (const attachment of entry.attachments.values()) {
            if (attachment.lastHint !== null) {
                attachment.lastHint = {
                    ...attachment.lastHint,
                    spatialBounds: surface.bounds,
                    sceneRevision: this.#workspace.getState().revision,
                };
                this.#deliver(entry, entry.adapter, attachment.lastHint);
            }
        }
    }
    #deliver(entry, adapter, hint) {
        try {
            adapter.update(entry.handle, hint);
        }
        catch (error) {
            // Hints are advisory: an adapter that cannot take one leaves the surface as it is.
            this.#diagnose('HINT_IGNORED', `adapter "${adapter.id}" threw on a hint for surface "${entry.surfaceId}"`, entry.surfaceId, { reason: describeError(error) });
        }
    }
    // --- events and errors ------------------------------------------------------------------
    #emitState(entry, from) {
        this.#emit('presentation.stateChanged', {
            surfaceId: entry.surfaceId,
            from,
            to: entry.state,
            generation: entry.generation,
            binding: entry.binding,
            unboundReason: entry.state === 'unbound' ? entry.unboundReason : null,
            error: entry.state === 'error' ? entry.error : null,
        });
    }
    #emit(type, payload) {
        this.#eventSeq += 1;
        this.#outbox.push(Object.freeze({
            id: `${this.workspaceId}/surfaces/ev-${String(this.#eventSeq)}`,
            type,
            workspaceId: this.workspaceId,
            revision: this.#workspace.getState().revision,
            timestamp: this.#now(),
            payload,
        }));
        if (this.#delivering) {
            return; // Delivered after the event in progress, in order.
        }
        this.#delivering = true;
        try {
            for (let event = this.#outbox.shift(); event !== undefined; event = this.#outbox.shift()) {
                for (const listener of [...this.#listeners]) {
                    try {
                        listener(event);
                    }
                    catch (error) {
                        this.#diagnose('LISTENER_THREW', `a listener threw while handling ${event.type}`, null, {
                            eventId: event.id,
                            reason: describeError(error),
                        });
                    }
                }
            }
        }
        finally {
            this.#delivering = false;
        }
    }
    #diagnose(code, message, surfaceId, details) {
        const diagnostic = Object.freeze({
            code,
            message,
            timestamp: this.#now(),
            surfaceId,
            details: Object.freeze(details),
        });
        this.#diagnostics.push(diagnostic);
        if (this.#diagnostics.length > this.#diagnosticsCapacity) {
            this.#diagnostics.shift();
        }
        try {
            this.#onDiagnostic?.(diagnostic);
        }
        catch {
            // A failing diagnostics sink must not interrupt the runtime.
        }
    }
    #error(code, message, surfaceId, extra = {}) {
        return makeError(code, message, {
            workspaceId: this.workspaceId,
            entityId: surfaceId,
            ...(extra.retryable === undefined ? {} : { retryable: extra.retryable }),
            ...(extra.details === undefined ? {} : { details: Object.freeze(extra.details) }),
        });
    }
    #changedWhile(surfaceId, doing) {
        return this.#error('CANCELLED', `surface "${surfaceId}" changed while ${doing}`, surfaceId);
    }
    #unknown(surfaceId) {
        return this.#error('UNKNOWN_ENTITY', `no surface "${surfaceId}" in workspace "${this.workspaceId}"`, surfaceId);
    }
    #disposedError() {
        return makeError('WORKSPACE_DISPOSED', `the surface runtime of workspace "${this.workspaceId}" is disposed`, { workspaceId: this.workspaceId });
    }
    #assertLive() {
        if (this.#disposed !== null) {
            throw new SwfFailure(this.#disposedError());
        }
    }
    #ok(entry) {
        return Object.freeze({ status: 'ok', presentation: snapshot(entry) });
    }
    #rejected(error) {
        return Promise.resolve(Object.freeze({ status: 'rejected', error }));
    }
}
function newAttempt() {
    const controller = new AbortController();
    let settle = () => undefined;
    const cancelled = new Promise((resolve) => {
        settle = () => {
            resolve('cancelled');
        };
    });
    return {
        controller,
        cancelled,
        cancel() {
            if (!controller.signal.aborted) {
                controller.abort('released');
            }
            settle();
        },
    };
}
function snapshot(entry) {
    return Object.freeze({
        surfaceId: entry.surfaceId,
        state: entry.state,
        generation: entry.generation,
        binding: entry.binding,
        capabilities: entry.capabilities,
        unboundReason: entry.state === 'unbound' ? entry.unboundReason : null,
        error: entry.state === 'error' ? entry.error : null,
        viewports: Object.freeze([...entry.attachments].map(([viewportId, a]) => Object.freeze({ viewportId, visible: a.visible }))),
        replacing: entry.replacing !== null,
    });
}
function exceeding(declared, actual) {
    const exceeded = exceededCapabilities(declared, actual);
    return exceeded.length === 0
        ? null
        : `they exceed the declared capabilities (${exceeded.join(', ')})`;
}
function sameCapabilities(a, b) {
    return Object.keys(a).every((key) => a[key] === b[key]);
}
function hiddenHint(attachment, workspace, surfaceId, viewportId) {
    const surface = workspace.getState().surfaces.get(surfaceId);
    if (attachment.lastHint === null && surface === undefined) {
        throw new Error(`surface "${surfaceId}" is attached but missing from the scene`);
    }
    const hint = {
        ...(attachment.lastHint ?? {
            surfaceId,
            viewportId,
            sceneRevision: workspace.getState().revision,
            occlusion: { value: null, confidence: 'unknown' },
            projectedBounds: null,
            spatialBounds: surface?.bounds ?? [1, 1, 1],
            requestedIntrinsicSize: null,
        }),
        visible: false,
        mounted: false,
        sceneVisible: surfaceEffectiveState(workspace.getState(), surfaceId)?.visible === true,
        intersectionRatio: 0,
        tier: 'hidden',
        attention: 'background',
    };
    attachment.lastHint = hint;
    return hint;
}
function sameHint(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}
function describeError(error) {
    return error instanceof Error ? error.message : String(error);
}
function failure(code, message, workspaceId) {
    return new SwfFailure(makeError(code, message, { workspaceId }));
}
async function settleTx(result) {
    return result.status === 'queued' ? result.completion : result;
}
function checkOptions(options, workspaceId) {
    const fail = (field, message) => new SwfFailure(makeError('INVALID_INPUT', `options.${field} ${message}`, {
        workspaceId,
        path: `options.${field}`,
    }));
    const raw = options;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new SwfFailure(makeError('INVALID_INPUT', 'surface runtime options must be an object', { workspaceId }));
    }
    const record = raw;
    for (const key of Object.keys(record)) {
        if (!OPTION_KEYS.includes(key)) {
            throw fail(key, `is not a known option (expected one of ${OPTION_KEYS.join(', ')})`);
        }
    }
    const timeout = record['bindingTimeoutMs'] ?? 15_000;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
        throw fail('bindingTimeoutMs', 'must be a positive number of milliseconds');
    }
    const autoBind = record['autoBind'] ?? true;
    if (typeof autoBind !== 'boolean') {
        throw fail('autoBind', 'must be a boolean');
    }
    const capacity = record['diagnosticsCapacity'] ?? 100;
    if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1) {
        throw fail('diagnosticsCapacity', 'must be a positive integer');
    }
    for (const key of ['now', 'onDiagnostic']) {
        if (record[key] !== undefined && typeof record[key] !== 'function') {
            throw fail(key, 'must be a function');
        }
    }
    return {
        bindingTimeoutMs: timeout,
        autoBind,
        now: options.now ?? Date.now,
        diagnosticsCapacity: capacity,
        onDiagnostic: options.onDiagnostic,
    };
}
/** Each unbound reason as the presentation model names it. */
const LEAN_REASONS = Object.freeze({
    'no-binding-key': 'noBindingKey',
    'adapter-unavailable': 'adapterUnavailable',
    'unknown-binding-key': 'unknownBindingKey',
    released: 'released',
});
const REASONS = Object.freeze({
    noBindingKey: 'no-binding-key',
    adapterUnavailable: 'adapter-unavailable',
    unknownBindingKey: 'unknown-binding-key',
    released: 'released',
});
function leanReason(reason) {
    return { kind: LEAN_REASONS[reason] };
}
/** An unbound surface always shows why. */
function reasonOf(entry, reason) {
    if (reason === null) {
        throw new Error(`surface "${entry.surfaceId}" would be unbound with no reason`);
    }
    return reason;
}
/** The surface's state as the presentation model takes it. */
function presentationOf(entry) {
    return entry.state === 'unbound'
        ? { kind: 'unbound', reason: leanReason(reasonOf(entry, entry.unboundReason)) }
        : { kind: entry.state };
}
/** Puts the surface in a state the presentation model decided. */
function setPresentation(entry, next) {
    if (next.kind === 'unbound') {
        entry.state = 'unbound';
        entry.unboundReason = REASONS[next.reason.kind];
    }
    else {
        entry.state = next.kind;
        entry.unboundReason = null;
    }
}
//# sourceMappingURL=runtime.js.map