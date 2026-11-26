import { makeError, SwfFailure } from '@swf/core';
import { compositorCapabilitiesIssue, isVersionedId, projectionProfileIssue, rendererCapabilitiesIssue, } from './capabilities.js';
import { PRESENTATION_API_VERSION } from './contracts.js';
/**
 * An empty presentation registry. It holds the modules registered with it, and nothing else: it
 * prepares no sessions and has nothing to dispose.
 *
 * @example
 * ```ts
 * const registry = createPresentationRegistry();
 * const unregister = registry.registerRenderer(renderer);
 * registry.registerCompositor(compositor);
 * ```
 */
export function createPresentationRegistry() {
    return new Registry();
}
function moduleIssue(value, kind, methods) {
    if (typeof value !== 'object' || value === null) {
        return { code: 'INVALID_INPUT', message: `${kind} must be an object` };
    }
    const m = value;
    if (!isVersionedId(m['id'])) {
        return {
            code: 'INVALID_INPUT',
            message: `${kind} id ${JSON.stringify(m['id'])} must be a versioned ID "<name>/<version>"`,
        };
    }
    const missing = methods.find((name) => typeof m[name] !== 'function');
    if (missing !== undefined) {
        return { code: 'INVALID_INPUT', message: `${kind} "${m['id']}" must implement ${missing}()` };
    }
    if (m['apiVersion'] !== PRESENTATION_API_VERSION) {
        return {
            code: 'UNSUPPORTED_CAPABILITY',
            message: `${kind} "${m['id']}" implements contract version ${JSON.stringify(m['apiVersion'])}, not ${String(PRESENTATION_API_VERSION)}`,
        };
    }
    return null;
}
class Registry {
    #renderers = new Map();
    #compositors = new Map();
    #projectors = new Map();
    #listeners = new Set();
    #diagnostics = [];
    renderer(id) {
        return this.#renderers.get(id);
    }
    compositor(id) {
        return this.#compositors.get(id);
    }
    projector(id) {
        return this.#projectors.get(id);
    }
    rendererIds() {
        return [...this.#renderers.keys()];
    }
    compositorIds() {
        return [...this.#compositors.keys()];
    }
    projectorIds() {
        return [...this.#projectors.keys()];
    }
    registerRenderer(renderer) {
        this.#check(moduleIssue(renderer, 'renderer', ['capabilities', 'prepare']));
        const capabilities = this.#declared(renderer, 'renderer', rendererCapabilitiesIssue);
        return this.#add(this.#renderers, renderer.id, 'renderer', {
            module: renderer,
            capabilities,
        });
    }
    registerCompositor(compositor) {
        this.#check(moduleIssue(compositor, 'compositor', ['capabilities', 'prepare']));
        const capabilities = this.#declared(compositor, 'compositor', compositorCapabilitiesIssue);
        return this.#add(this.#compositors, compositor.id, 'compositor', {
            module: compositor,
            capabilities,
        });
    }
    registerProjector(projector) {
        const raw = projector;
        if (typeof raw !== 'object' || raw === null) {
            this.#check({ code: 'INVALID_INPUT', message: 'projector must be an object' });
        }
        if (typeof projector.project !== 'function') {
            this.#check({ code: 'INVALID_INPUT', message: 'projector must implement project()' });
        }
        const issue = projectionProfileIssue(projector.profile);
        if (issue !== null) {
            this.#check({ code: 'UNSUPPORTED_CAPABILITY', message: issue });
        }
        const profile = Object.freeze({ ...projector.profile });
        return this.#add(this.#projectors, profile.id, 'projector', {
            module: projector,
            capabilities: profile,
        });
    }
    subscribe(listener) {
        // Each subscription is its own entry, so subscribing one function twice needs two removals.
        const entry = (change) => {
            listener(change);
        };
        this.#listeners.add(entry);
        return () => {
            this.#listeners.delete(entry);
        };
    }
    getDiagnostics() {
        return Object.freeze([...this.#diagnostics]);
    }
    registrar() {
        return Object.freeze({
            registerRenderer: (renderer) => this.registerRenderer(renderer),
            registerCompositor: (compositor) => this.registerCompositor(compositor),
            registerProjector: (projector) => this.registerProjector(projector),
        });
    }
    #declared(module, kind, issueOf) {
        let declared;
        try {
            declared = module.capabilities();
        }
        catch (error) {
            this.#check({
                code: 'UNSUPPORTED_CAPABILITY',
                message: `${kind} "${module.id}" failed to report its capabilities: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
        const issue = issueOf(declared);
        if (issue !== null) {
            this.#check({ code: 'UNSUPPORTED_CAPABILITY', message: `${kind} "${module.id}": ${issue}` });
        }
        return deepFreeze(structuredCopy(declared));
    }
    #add(map, id, kind, entry) {
        if (map.has(id)) {
            this.#check({ code: 'INVALID_INPUT', message: `a ${kind} "${id}" is already registered` });
        }
        map.set(id, entry);
        this.#notify({ kind, id, registered: true });
        return () => {
            if (map.get(id) === entry) {
                map.delete(id);
                this.#notify({ kind, id, registered: false });
            }
        };
    }
    #notify(change) {
        const frozen = Object.freeze(change);
        for (const listener of [...this.#listeners]) {
            try {
                listener(frozen);
            }
            catch (error) {
                // The registration stands and the other listeners still hear of it.
                this.#diagnostics.push(Object.freeze({
                    code: 'LISTENER_THREW',
                    message: `a listener threw while handling the ${frozen.registered ? 'registration' : 'unregistration'} of ${frozen.kind} "${frozen.id}"`,
                    details: Object.freeze({
                        reason: error instanceof Error ? error.message : String(error),
                    }),
                }));
                this.#diagnostics.splice(0, this.#diagnostics.length - 100);
            }
        }
    }
    #check(issue) {
        if (issue !== null) {
            throw new SwfFailure(makeError(issue.code, issue.message));
        }
    }
}
/** A copy of plain capability data, so the declaring module cannot change it afterwards. */
function structuredCopy(value) {
    if (Array.isArray(value)) {
        return value.map(structuredCopy);
    }
    if (typeof value === 'object' && value !== null) {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, structuredCopy(v)]));
    }
    return value;
}
function deepFreeze(value) {
    if (typeof value === 'object' && value !== null) {
        for (const item of Object.values(value)) {
            deepFreeze(item);
        }
        Object.freeze(value);
    }
    return value;
}
//# sourceMappingURL=registry.js.map