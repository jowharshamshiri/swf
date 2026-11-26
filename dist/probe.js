/**
 * Counts what code running in a window holds of the browser: event listeners, observations by
 * resize, mutation and intersection observers, requested animation frames and pending timers. It
 * wraps the window's own registration functions, so it sees every registration made after it is
 * installed, by any code, and the counts compare a moment before a workspace is created with a
 * moment after it is disposed (NFR-010, AN-008).
 *
 * A listener counts while its target is the window, the document, or an element in the document:
 * one on an element that was removed and dropped goes with the element, and holds nothing. The
 * probe holds what it follows only weakly, so it keeps no target, listener or observer alive that
 * the page has let go.
 */
/** Whether a target still holds what is registered on it: it is reachable from the page. */
function live(view, target) {
    if (target === undefined) {
        return false;
    }
    if (target === view || target === view.document) {
        return true;
    }
    return target instanceof view.Node ? target.isConnected : true;
}
const captureOf = (options) => typeof options === 'boolean' ? options : options?.capture === true;
/**
 * Installs a probe in a window: it replaces the window's `addEventListener` and
 * `removeEventListener` (on `EventTarget.prototype`), its `ResizeObserver`, `MutationObserver`
 * and `IntersectionObserver` (those it has), `requestAnimationFrame`, `cancelAnimationFrame`,
 * `setTimeout`, `clearTimeout`, `setInterval` and `clearInterval` with versions that count
 * and then call the originals. While installed, `setTimeout` takes only a function and throws
 * `TypeError` for code given as text. The caller owns the probe and disposes it.
 *
 * @throws `Error` when one is installed there already: two would count each registration twice.
 */
export function createResourceProbe(view) {
    const marker = '__swfResourceProbe';
    const flagged = view;
    if (flagged[marker] === true) {
        throw new Error('a resource probe is installed in this window already');
    }
    flagged[marker] = true;
    const registrations = new Set();
    // A registration whose target is collected holds nothing: it is forgotten with the target.
    const forgetRegistration = new FinalizationRegistry((r) => {
        registrations.delete(r);
    });
    const drop = (r) => {
        registrations.delete(r);
        forgetRegistration.unregister(r);
    };
    const find = (target, type, listener, capture) => {
        for (const r of registrations) {
            if (r.type === type &&
                r.listener.deref() === listener &&
                r.capture === capture &&
                r.target.deref() === target) {
                return r;
            }
        }
        return undefined;
    };
    const proto = view.EventTarget.prototype;
    // The window's own functions, taken as values to call on their targets and to put back.
    const add = Reflect.get(proto, 'addEventListener');
    const remove = Reflect.get(proto, 'removeEventListener');
    proto.addEventListener = function (type, listener, options) {
        add.call(this, type, listener, options);
        if (listener === null) {
            return;
        }
        const capture = captureOf(options);
        if (find(this, type, listener, capture) !== undefined) {
            return; // the browser ignores a second identical registration
        }
        const registration = {
            target: new WeakRef(this),
            type,
            listener: new WeakRef(listener),
            capture,
        };
        const signal = typeof options === 'object' ? options.signal : undefined;
        if (signal?.aborted === true) {
            return;
        }
        registrations.add(registration);
        forgetRegistration.register(this, registration, registration);
        if (typeof options === 'object' && options.once === true) {
            // A listener added once is removed by the browser as it runs: wrapped, it is seen to run.
            add.call(this, type, () => {
                drop(registration);
            }, { once: true, capture });
        }
        signal?.addEventListener('abort', () => {
            drop(registration);
        }, { once: true });
    };
    proto.removeEventListener = function (type, listener, options) {
        remove.call(this, type, listener, options);
        if (listener === null) {
            return;
        }
        const found = find(this, type, listener, captureOf(options));
        if (found !== undefined) {
            drop(found);
        }
    };
    /**
     * What each observer observing something observes, held apart from the observer: an observer
     * that observes nothing, or is collected, leaves.
     */
    const observing = new Set();
    const forgetObservation = new FinalizationRegistry((o) => {
        observing.delete(o);
    });
    const restoreObservers = [];
    const wrapObserver = (name) => {
        const Original = view[name];
        if (typeof Original !== 'function') {
            return;
        }
        class Probed extends Original {
            #observation = { targets: new Set() };
            constructor(...args) {
                super(...args);
                forgetObservation.register(this, this.#observation);
            }
            observe(target, options) {
                super.observe(target, options);
                const { targets } = this.#observation;
                if (![...targets].some((t) => t.deref() === target)) {
                    targets.add(new WeakRef(target));
                }
                observing.add(this.#observation);
            }
            unobserve(target) {
                super.unobserve?.(target);
                const { targets } = this.#observation;
                for (const t of targets) {
                    if (t.deref() === target) {
                        targets.delete(t);
                    }
                }
                if (targets.size === 0) {
                    observing.delete(this.#observation);
                }
            }
            disconnect() {
                super.disconnect();
                this.#observation.targets.clear();
                observing.delete(this.#observation);
            }
        }
        Object.defineProperty(view, name, { value: Probed, configurable: true, writable: true });
        restoreObservers.push(() => {
            Object.defineProperty(view, name, { value: Original, configurable: true, writable: true });
        });
    };
    wrapObserver('ResizeObserver');
    wrapObserver('MutationObserver');
    wrapObserver('IntersectionObserver');
    const frames = new Set();
    const request = Reflect.get(view, 'requestAnimationFrame');
    const cancel = Reflect.get(view, 'cancelAnimationFrame');
    view.requestAnimationFrame = (callback) => {
        const id = request.call(view, (time) => {
            frames.delete(id);
            callback(time);
        });
        frames.add(id);
        return id;
    };
    view.cancelAnimationFrame = (id) => {
        frames.delete(id);
        cancel.call(view, id);
    };
    const timers = new Set();
    const setTimer = Reflect.get(view, 'setTimeout');
    const clearTimer = Reflect.get(view, 'clearTimeout');
    const setRepeat = Reflect.get(view, 'setInterval');
    const clearRepeat = Reflect.get(view, 'clearInterval');
    view.setTimeout = ((handler, timeout, ...args) => {
        if (typeof handler !== 'function') {
            throw new TypeError('the resource probe takes only function timers, never code as text');
        }
        const run = handler;
        const id = setTimer.call(view, (...a) => {
            timers.delete(id);
            run(...a);
        }, timeout, ...args);
        timers.add(id);
        return id;
    });
    view.clearTimeout = (id) => {
        if (id !== undefined) {
            timers.delete(id);
        }
        clearTimer.call(view, id);
    };
    view.setInterval = ((handler, timeout, ...args) => {
        const id = setRepeat.call(view, handler, timeout, ...args);
        timers.add(id);
        return id;
    });
    view.clearInterval = (id) => {
        if (id !== undefined) {
            timers.delete(id);
        }
        clearRepeat.call(view, id);
    };
    let disposed = false;
    return Object.freeze({
        counts() {
            let listeners = 0;
            for (const r of registrations) {
                if (live(view, r.target.deref())) {
                    listeners += 1;
                }
            }
            let observations = 0;
            for (const { targets } of observing) {
                for (const t of targets) {
                    if (live(view, t.deref())) {
                        observations += 1;
                    }
                }
            }
            return Object.freeze({ listeners, observations, frames: frames.size, timers: timers.size });
        },
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            proto.addEventListener = add;
            proto.removeEventListener = remove;
            for (const restore of restoreObservers) {
                restore();
            }
            view.requestAnimationFrame = request;
            view.cancelAnimationFrame = cancel;
            view.setTimeout = setTimer;
            view.clearTimeout = clearTimer;
            view.setInterval = setRepeat;
            view.clearInterval = clearRepeat;
            Reflect.deleteProperty(flagged, marker);
        },
    });
}
//# sourceMappingURL=probe.js.map