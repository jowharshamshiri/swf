/**
 * A capable native endpoint that cannot be shared between viewports: native DOM, fully
 * interactive, transparent, safely detachable and rebindable. Frozen.
 */
export const NATIVE_CAPABILITIES = Object.freeze({
    attachStrategy: 'native-dom',
    nativeInteraction: 'full',
    uvAddressing: true,
    transformFidelity: 'approximate',
    transparency: true,
    clipping: true,
    cursorMapping: true,
    resize: 'intrinsic',
    viewportSharing: 'single-owner',
    safeDetach: true,
    rebinding: true,
    placeholder: false,
    snapshotHooks: false,
});
/** {@link NATIVE_CAPABILITIES} with some fields changed: a new frozen object, not validated. */
export function mockCapabilities(over = {}) {
    return Object.freeze({ ...NATIVE_CAPABILITIES, ...over });
}
/**
 * A reference adapter for opaque endpoints, for testing hosts, runtimes and backends without any
 * real content. Keys resolve at once to a fresh handle unless they are held (`holding`), unknown
 * (`unknown`) or failing (`failing`). Held resolutions settle when `release` is called, or reject
 * when their abort signal fires, as a well-behaved adapter must. Every call is recorded. It also
 * carries a producer control, `stopProducer`, that the framework must never call.
 */
export class MockOpaqueAdapter {
    /** The adapter type ID it registers as. */
    id;
    /** The adapter API version it implements. */
    apiVersion = 1;
    /** The capabilities it declares at registration. */
    declaredCapabilities;
    /** When true, the runtime does not time its bindings out. */
    untimedBinding;
    /**
     * When true, held resolutions keep waiting after their abort signal fires: an ill-behaved
     * adapter, for checking that late answers are still discarded.
     */
    ignoresAbort;
    /** Every call the framework made, oldest first; a test may read and clear it. */
    calls = [];
    /** The held resolutions of each key, oldest first; {@link MockOpaqueAdapter.release} settles. */
    held = new Map();
    /** Keys whose resolutions are held until released or aborted; the test adds and removes them. */
    holding = new Set();
    /** Keys that resolve to null: endpoints the adapter does not know. */
    unknown = new Set();
    /** Keys whose resolutions reject with `Error`. */
    failing = new Set();
    /** Keys whose handles' `attach` rejects with `Error`. */
    attachFailing = new Set();
    /**
     * The held attachments of each key, oldest first: calling one completes that `attach`. They
     * are never removed by the adapter.
     */
    attachHeld = new Map();
    /** Keys whose handles' `attach` waits until the test completes it from {@link attachHeld}. */
    holdingAttach = new Set();
    /** The abort signal of every resolution, in call order. */
    signals = [];
    /** The binding context of every resolution, in call order. */
    contexts = [];
    /** What `capabilities` answers for a handle; default the declared capabilities. Replaceable. */
    handleCapabilities;
    /** When true, `update` throws `Error`. Default false. */
    updateThrows = false;
    /** How many times {@link MockOpaqueAdapter.stopProducer} was called: it must stay 0. */
    producerTouched = 0;
    #serial = 0;
    /**
     * @param id - The adapter type ID. Default `host.view/1`.
     * @param declared - The capabilities declared, and answered for every handle unless
     *   `options.handleCapabilities` says otherwise. Default {@link NATIVE_CAPABILITIES}.
     * @param options - `untimedBinding` and `ignoresAbort` (default false), and
     *   `handleCapabilities`.
     */
    constructor(id = 'host.view/1', declared = NATIVE_CAPABILITIES, options = {}) {
        this.id = id;
        this.declaredCapabilities = declared;
        this.untimedBinding = options.untimedBinding ?? false;
        this.ignoresAbort = options.ignoresAbort ?? false;
        this.handleCapabilities = options.handleCapabilities ?? (() => declared);
    }
    /**
     * Resolves `key`, recording the call, its signal and its context: rejects when `signal` is
     * already aborted (unless the adapter ignores aborts) or the key is failing, answers null for an
     * unknown key, waits for a held one, and otherwise answers a fresh handle at once.
     */
    resolve(key, signal, context) {
        this.calls.push({ method: 'resolve', key });
        this.signals.push(signal);
        this.contexts.push(context);
        if (signal.aborted && !this.ignoresAbort) {
            return Promise.reject(new Error('aborted before it started'));
        }
        if (this.failing.has(key)) {
            return Promise.reject(new Error(`cannot open ${key}`));
        }
        if (this.unknown.has(key)) {
            return Promise.resolve(null);
        }
        if (this.holding.has(key)) {
            return new Promise((resolve, reject) => {
                const list = this.held.get(key) ?? [];
                const deferred = { resolve, reject };
                list.push(deferred);
                this.held.set(key, list);
                if (this.ignoresAbort) {
                    return;
                }
                // A well-behaved adapter stops waiting once its binding is cancelled.
                signal.addEventListener('abort', () => {
                    const index = list.indexOf(deferred);
                    if (index >= 0) {
                        list.splice(index, 1);
                        reject(new Error('aborted'));
                    }
                }, { once: true });
            });
        }
        return Promise.resolve(this.#handle(key));
    }
    /**
     * Completes the oldest held resolution of `key` with a fresh handle, null, or an error, and
     * returns the handle given (null for `null` and `error`).
     *
     * @throws `Error` when no resolution of `key` is held.
     */
    release(key, outcome = 'handle') {
        const deferred = this.held.get(key)?.shift();
        if (deferred === undefined) {
            throw new Error(`no held resolution for ${key}`);
        }
        if (outcome === 'error') {
            deferred.reject(new Error('late failure'));
            return null;
        }
        const handle = outcome === 'null' ? null : this.#handle(key);
        deferred.resolve(handle);
        return handle;
    }
    /** Records the call and answers {@link MockOpaqueAdapter.handleCapabilities} for the handle. */
    capabilities(handle) {
        this.calls.push({ method: 'capabilities', handle });
        return this.handleCapabilities(handle);
    }
    /**
     * Records the call; rejects for a key in {@link attachFailing}, waits for one in
     * {@link holdingAttach}, and otherwise resolves at once. It mounts nothing.
     */
    attach(handle, target) {
        this.calls.push({ method: 'attach', handle, viewportId: target.viewportId, target });
        if (this.attachFailing.has(handle.key)) {
            return Promise.reject(new Error('mount failed'));
        }
        if (this.holdingAttach.has(handle.key)) {
            return new Promise((resolve) => {
                const list = this.attachHeld.get(handle.key) ?? [];
                list.push(resolve);
                this.attachHeld.set(handle.key, list);
            });
        }
        return Promise.resolve();
    }
    /** Records the hint; throws `Error` while {@link updateThrows} is set. */
    update(handle, hint) {
        this.calls.push({ method: 'update', handle, hint });
        if (this.updateThrows) {
            throw new Error('cannot take hints');
        }
    }
    /** Records the call and resolves at once. */
    detach(handle, target) {
        this.calls.push({ method: 'detach', handle, viewportId: target.viewportId, target });
        return Promise.resolve();
    }
    /** What a producer control looks like. The framework must never call it. */
    stopProducer() {
        this.producerTouched += 1;
    }
    /** The method of every recorded call, oldest first: a new array. */
    methods() {
        return this.calls.map((c) => c.method);
    }
    #handle(key) {
        this.#serial += 1;
        return Object.freeze({ key, serial: this.#serial });
    }
}
//# sourceMappingURL=mock-adapter.js.map