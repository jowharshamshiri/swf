import { canonicalJson, jsonValue, makeError, SCENE_SNAPSHOT_FIELDS, SwfFailure, VERSIONED_ID, } from '@swf/core';
import { answeredWithPromise, describeAnswer } from './answers.js';
import { errorOf, exportDocument, failure, jsonBytes, NAMESPACE, parseDocument, parseJson, SNAPSHOT_ENGINE, SNAPSHOT_SCHEMA_ID, snapshotLimits, validateDocument, } from './document.js';
import { migrateDocument } from './migrations.js';
/**
 * Creates the persistence of a workspace, subscribed to its commits from now on with a change
 * count of 0. The caller owns it and disposes it.
 *
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` naming `hookTimeoutMs`, `now` or
 *   `limits.<field>` when one is invalid. `migrations` are checked when a restore uses them.
 *
 * @example
 * ```ts
 * const persistence = createPersistence({ workspace: workspace.persistence() });
 * persistence.registerExtension({
 *   namespace: 'ext.notes',
 *   version: 1,
 *   capture: () => notes.state(),
 *   restore: (data) => notes.load(data),
 * });
 * const { document, failures } = await persistence.capture();
 * const text = persistence.export(document);
 * ```
 */
export function createPersistence(options) {
    const timeout = options.hookTimeoutMs ?? 5000;
    if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0) {
        throw failure('INVALID_INPUT', 'hookTimeoutMs must be a positive number', 'hookTimeoutMs');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
        throw failure('INVALID_INPUT', 'now must be a function', 'now');
    }
    return new PersistenceImpl(options, snapshotLimits(options.limits), timeout);
}
class PersistenceImpl {
    limits;
    #workspace;
    #now;
    #timeout;
    #migrations;
    #extensions = new Map();
    #policies = new Map();
    /** The last state known of each namespace and policy, owner registered or not. */
    #knownExtensions = new Map();
    #knownPolicies = new Map();
    /**
     * Namespaces whose owner did not take back its state at the last restore: their state from the
     * snapshot is kept, never overwritten by a capture of what the owner holds instead.
     */
    #held = new Set();
    #listeners = new Set();
    #diagnostics = [];
    #changes = 0;
    #revision;
    #unsubscribe;
    constructor(options, limits, timeout) {
        this.limits = limits;
        this.#workspace = options.workspace;
        this.#now = options.now ?? Date.now;
        this.#timeout = timeout;
        this.#migrations = options.migrations ?? [];
        this.#revision = options.workspace.revision();
        this.#unsubscribe = options.workspace.subscribe(() => {
            // Previews and other notifications leave the committed scene as it was.
            const revision = this.#workspace.revision();
            if (revision !== this.#revision) {
                this.#revision = revision;
                this.#changed();
            }
        });
    }
    registerExtension(extension) {
        const raw = extension;
        if (typeof raw !== 'object' || raw === null) {
            throw failure('INVALID_INPUT', 'an extension must be an object');
        }
        const { namespace, version } = extension;
        if (typeof namespace !== 'string' || !NAMESPACE.test(namespace)) {
            throw failure('INVALID_INPUT', `extension namespace ${JSON.stringify(namespace)} must be "host.<name>" or "ext.<extension-id>"`, 'namespace');
        }
        if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
            throw failure('INVALID_INPUT', `extension "${namespace}": version must be a whole number of at least 1`, 'version');
        }
        for (const hook of ['capture', 'restore']) {
            if (typeof extension[hook] !== 'function') {
                throw failure('INVALID_INPUT', `extension "${namespace}" must implement ${hook}()`, hook);
            }
        }
        for (const hook of ['migrate', 'watch']) {
            if (extension[hook] !== undefined && typeof extension[hook] !== 'function') {
                throw failure('INVALID_INPUT', `extension "${namespace}": ${hook} must be a function`, hook);
            }
        }
        return this.#add(this.#extensions, namespace, 'extension', extension);
    }
    registerPolicy(source) {
        const raw = source;
        if (typeof raw !== 'object' || raw === null) {
            throw failure('INVALID_INPUT', 'a policy source must be an object');
        }
        if (typeof source.id !== 'string' || !VERSIONED_ID.test(source.id)) {
            throw failure('INVALID_INPUT', `policy id ${JSON.stringify(source.id)} must be a versioned ID "<name>/<version>"`, 'id');
        }
        if (typeof source.capture !== 'function') {
            throw failure('INVALID_INPUT', `policy "${source.id}" must implement capture()`, 'capture');
        }
        for (const hook of ['restore', 'watch']) {
            if (source[hook] !== undefined && typeof source[hook] !== 'function') {
                throw failure('INVALID_INPUT', `policy "${source.id}": ${hook} must be a function`, hook);
            }
        }
        return this.#add(this.#policies, source.id, 'policy', source);
    }
    async capture(options = {}) {
        const changes = this.#changes;
        const scene = this.#workspace.serialize();
        const failures = [];
        for (const [id, { source }] of this.#policies) {
            try {
                const parameters = source.capture();
                if (answeredWithPromise(parameters)) {
                    throw failure('INVALID_INPUT', `policy "${id}" could not be captured: capture returned a promise; it gives its parameters synchronously`, `policies.${id}`);
                }
                this.#knownPolicies.set(id, canonicalJson(jsonValue(parameters, `policies.${id}`)));
            }
            catch (error) {
                failures.push({
                    kind: 'policy',
                    id,
                    error: asError(error, `policy "${id}" could not be captured`),
                });
            }
        }
        for (const [namespace, { source }] of this.#extensions) {
            if (this.#held.has(namespace)) {
                failures.push({
                    kind: 'extension',
                    id: namespace,
                    error: errorOf('EXTENSION_FAILED', `extension "${namespace}" did not take back its state when the snapshot was restored, so that state is kept and its current one is not captured`, `extensions.${namespace}`, { reason: 'held' }),
                });
                continue;
            }
            try {
                const data = await this.#run(source, options.signal);
                const bytes = jsonBytes(data);
                if (bytes > this.limits.extensionBytes) {
                    throw failure('QUOTA_EXCEEDED', `extension "${namespace}" captured ${String(bytes)} bytes, over the limit of ${String(this.limits.extensionBytes)} per namespace`, `extensions.${namespace}.data`, { bytes, limit: this.limits.extensionBytes });
                }
                this.#knownExtensions.set(namespace, Object.freeze({ version: source.version, data }));
            }
            catch (error) {
                failures.push({
                    kind: 'extension',
                    id: namespace,
                    error: asError(error, `extension "${namespace}" could not be captured`),
                });
            }
        }
        // Within the total limit, namespaces are kept in order; one that no longer fits is left out.
        const extensions = {};
        let total = 0;
        for (const namespace of [...this.#knownExtensions.keys()].sort()) {
            const entry = this.#knownExtensions.get(namespace);
            if (entry === undefined) {
                continue;
            }
            const bytes = jsonBytes(entry.data);
            if (total + bytes > this.limits.extensionTotalBytes) {
                failures.push({
                    kind: 'extension',
                    id: namespace,
                    error: errorOf('QUOTA_EXCEEDED', `extension "${namespace}" does not fit: the extensions would take ${String(total + bytes)} bytes, over the limit of ${String(this.limits.extensionTotalBytes)} in all`, `extensions.${namespace}.data`, { bytes: total + bytes, limit: this.limits.extensionTotalBytes }),
                });
                continue;
            }
            total += bytes;
            extensions[namespace] = entry;
        }
        const document = validateDocument({
            schema: SNAPSHOT_SCHEMA_ID,
            engine: SNAPSHOT_ENGINE,
            createdAt: this.#now(),
            ...scene,
            policies: Object.fromEntries(this.#knownPolicies),
            extensions,
        }, this.limits);
        return Object.freeze({ document, changes, failures: Object.freeze(failures) });
    }
    retain(document) {
        const valid = validateDocument(document, this.limits);
        for (const [id, value] of Object.entries(valid.policies)) {
            this.#knownPolicies.set(id, value);
        }
        for (const [namespace, entry] of Object.entries(valid.extensions)) {
            this.#knownExtensions.set(namespace, entry);
        }
    }
    changes() {
        return this.#changes;
    }
    subscribe(listener) {
        const entry = () => {
            listener();
        };
        this.#listeners.add(entry);
        return () => {
            this.#listeners.delete(entry);
        };
    }
    getDiagnostics() {
        return Object.freeze([...this.#diagnostics]);
    }
    export(document) {
        return exportDocument(document, this.limits);
    }
    import(text) {
        return parseDocument(text, this.limits);
    }
    async restore(input, options = {}) {
        const rejected = (error) => Object.freeze({ status: 'rejected', error });
        // Phase one: read, migrate and validate, changing nothing.
        let migrated;
        try {
            const value = typeof input === 'string' ? parseJson(input, this.limits) : input;
            migrated = migrateDocument(value, { migrations: this.#migrations, limits: this.limits });
        }
        catch (error) {
            if (error instanceof SwfFailure) {
                return rejected(error.error);
            }
            throw error;
        }
        const { document, sourceVersion } = migrated;
        const warnings = migrated.steps.flatMap((step) => [...step.warnings]);
        const failures = [];
        // Each extension's state at the version its owner reads, migrated on a copy.
        const staged = new Map();
        const unmigrated = [];
        for (const [namespace, entry] of Object.entries(document.extensions)) {
            const owner = this.#extensions.get(namespace)?.source;
            if (owner === undefined) {
                warnings.push(`extension "${namespace}" is not registered: its state is kept as it was`);
                continue;
            }
            try {
                staged.set(namespace, this.#migrateExtension(owner, entry));
                if (entry.version !== owner.version) {
                    warnings.push(`extension "${namespace}" state was migrated from version ${String(entry.version)} to ${String(owner.version)}`);
                }
            }
            catch (error) {
                unmigrated.push(namespace);
                failures.push({
                    kind: 'extension',
                    id: namespace,
                    error: asError(error, `extension "${namespace}" state could not be migrated`),
                });
            }
        }
        // Phase two: the scene, in one revision. If the workspace refuses it, nothing changes.
        const scene = Object.fromEntries(SCENE_SNAPSHOT_FIELDS.map((field) => [field, document[field]]));
        let result = this.#workspace.restore(scene, options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision });
        if (result.status === 'queued') {
            result = await result.completion;
        }
        if (result.status === 'rejected') {
            return rejected({
                ...result.error,
                details: { ...(result.error.details ?? {}), sourceVersion },
            });
        }
        // The replaced layout's state of absent owners goes with it; the snapshot's takes its place.
        for (const namespace of [...this.#knownExtensions.keys()]) {
            if (!this.#extensions.has(namespace)) {
                this.#knownExtensions.delete(namespace);
            }
        }
        for (const id of [...this.#knownPolicies.keys()]) {
            if (!this.#policies.has(id)) {
                this.#knownPolicies.delete(id);
            }
        }
        this.retain(document);
        for (const [namespace, entry] of staged) {
            this.#knownExtensions.set(namespace, entry);
        }
        // An owner that cannot take back its state must not overwrite it with what it holds instead.
        this.#held.clear();
        for (const namespace of unmigrated) {
            this.#held.add(namespace);
        }
        for (const [id, parameters] of Object.entries(document.policies)) {
            const source = this.#policies.get(id)?.source;
            if (source === undefined) {
                warnings.push(`policy "${id}" is not registered: its parameters are kept as they were`);
                continue;
            }
            const restore = source.restore?.bind(source);
            if (restore === undefined) {
                continue;
            }
            try {
                await this.#hook(policyHook(id), options.signal, (signal) => restore(parameters, { id, signal }));
            }
            catch (error) {
                failures.push({
                    kind: 'policy',
                    id,
                    error: asError(error, `policy "${id}" could not take back its parameters`),
                });
            }
        }
        for (const [namespace, entry] of staged) {
            const owner = this.#extensions.get(namespace)?.source;
            if (owner === undefined) {
                continue;
            }
            try {
                await this.#hook(extensionHook(namespace, 'restore'), options.signal, (signal) => owner.restore(entry.data, { namespace, signal }));
            }
            catch (error) {
                this.#held.add(namespace);
                failures.push({
                    kind: 'extension',
                    id: namespace,
                    error: asError(error, `extension "${namespace}" could not take back its state`),
                });
            }
        }
        return Object.freeze({
            status: 'restored',
            revision: result.revision,
            sourceVersion,
            targetVersion: migrated.targetVersion,
            migrations: migrated.steps,
            warnings: Object.freeze(warnings),
            failures: Object.freeze(failures),
        });
    }
    /** An extension's state at the version its owner reads, migrated on a copy when older. */
    #migrateExtension(owner, entry) {
        const namespace = owner.namespace;
        if (entry.version === owner.version) {
            return entry;
        }
        if (entry.version > owner.version || owner.migrate === undefined) {
            throw failure('EXTENSION_FAILED', entry.version > owner.version
                ? `extension "${namespace}" reads version ${String(owner.version)}, but the snapshot holds the newer version ${String(entry.version)}; it is kept as it was`
                : `extension "${namespace}" cannot migrate its state from version ${String(entry.version)} to ${String(owner.version)}; it is kept as it was`, `extensions.${namespace}.version`);
        }
        let migrated;
        try {
            // Its own copy: the snapshot's data stays as it was.
            migrated = owner.migrate(JSON.parse(JSON.stringify(entry.data)), entry.version);
            if (answeredWithPromise(migrated)) {
                throw new Error('migrate returned a promise; it migrates synchronously');
            }
        }
        catch (error) {
            throw failure('MIGRATION_FAILED', `extension "${namespace}" failed to migrate its state from version ${String(entry.version)}: ${error instanceof Error ? error.message : String(error)}`, `extensions.${namespace}.data`);
        }
        const data = canonicalJson(jsonValue(migrated, `extensions.${namespace}.data`));
        const bytes = jsonBytes(data);
        if (bytes > this.limits.extensionBytes) {
            throw failure('QUOTA_EXCEEDED', `extension "${namespace}" migrated its state to ${String(bytes)} bytes, over the limit of ${String(this.limits.extensionBytes)} per namespace`, `extensions.${namespace}.data`, { bytes, limit: this.limits.extensionBytes });
        }
        return Object.freeze({ version: owner.version, data });
    }
    dispose() {
        this.#unsubscribe?.();
        this.#unsubscribe = null;
        for (const registered of [...this.#extensions.values(), ...this.#policies.values()]) {
            registered.unwatch();
        }
        this.#extensions.clear();
        this.#policies.clear();
        this.#listeners.clear();
    }
    /**
     * Registers a policy or an extension and starts its watch. A watch that throws, or answers with
     * something other than what stops it, fails the registration and leaves nothing registered.
     */
    #add(map, id, kind, source) {
        if (this.#unsubscribe === null) {
            throw failure('INVALID_TRANSITION', 'the persistence is disposed');
        }
        if (map.has(id)) {
            throw failure('INVALID_INPUT', `${kind === 'extension' ? 'an extension' : 'a policy'} "${id}" is already registered`);
        }
        const registered = { source, unwatch: () => undefined };
        map.set(id, registered);
        if (source.watch !== undefined) {
            try {
                const stop = source.watch(() => {
                    if (map.get(id) === registered) {
                        this.#changed();
                    }
                });
                if (typeof stop !== 'function') {
                    throw new Error(`watch returned ${describeAnswer(stop)}, not a function that stops it`);
                }
                registered.unwatch = stop;
            }
            catch (error) {
                map.delete(id);
                throw failure('EXTENSION_FAILED', `${kind} "${id}" could not start watching its ${kind === 'extension' ? 'state' : 'parameters'}: ${error instanceof Error ? error.message : String(error)}`, 'watch');
            }
        }
        return () => {
            if (map.get(id) === registered) {
                map.delete(id);
                registered.unwatch();
            }
        };
    }
    /** Runs one capture hook alone: its own copy of the result, its own time limit. */
    async #run(extension, outer) {
        const namespace = extension.namespace;
        const result = await this.#hook(extensionHook(namespace, 'capture'), outer, (signal) => extension.capture({ namespace, signal }));
        return canonicalJson(jsonValue(result, `extensions.${namespace}.data`));
    }
    /**
     * Runs one hook alone, within the hook timeout and the caller's signal: a timeout is
     * `EXTENSION_FAILED`, a cancellation `CANCELLED`, a throw or a rejection `EXTENSION_FAILED` with
     * its reason. The hook is given a signal that aborts when its time is over.
     */
    async #hook(run, outer, call) {
        const controller = new AbortController();
        const cancel = () => {
            stop(failure('CANCELLED', `${run.doing} was cancelled`, run.path));
        };
        let stop = () => undefined;
        const ended = new Promise((_, reject) => {
            stop = (error) => {
                controller.abort(error);
                reject(error);
            };
            const timer = setTimeout(() => {
                stop(failure('EXTENSION_FAILED', `${run.who} did not ${run.task} within ${String(this.#timeout)} ms`, run.path, { reason: 'timeout' }));
            }, this.#timeout);
            controller.signal.addEventListener('abort', () => {
                clearTimeout(timer);
            });
        });
        if (outer?.aborted === true) {
            cancel();
        }
        else {
            outer?.addEventListener('abort', cancel, { once: true });
        }
        try {
            return await Promise.race([Promise.resolve().then(() => call(controller.signal)), ended]);
        }
        catch (error) {
            if (error instanceof SwfFailure) {
                throw error;
            }
            throw failure('EXTENSION_FAILED', `${run.who} failed to ${run.task}: ${error instanceof Error ? error.message : String(error)}`, run.path);
        }
        finally {
            outer?.removeEventListener('abort', cancel);
            if (!controller.signal.aborted) {
                controller.abort(failure('CANCELLED', `${run.doing} is over`, run.path));
            }
            ended.catch(() => undefined);
        }
    }
    #changed() {
        this.#changes += 1;
        for (const listener of [...this.#listeners]) {
            try {
                listener();
            }
            catch (error) {
                this.#diagnostics.push(Object.freeze({
                    code: 'LISTENER_THREW',
                    message: `a listener threw while hearing of change ${String(this.#changes)}: ${error instanceof Error ? error.message : String(error)}`,
                    timestamp: this.#now(),
                }));
                this.#diagnostics.splice(0, Math.max(0, this.#diagnostics.length - 100));
            }
        }
    }
}
function asError(error, context) {
    if (error instanceof SwfFailure) {
        return error.error;
    }
    return makeError('EXTENSION_FAILED', `${context}: ${error instanceof Error ? error.message : String(error)}`);
}
function extensionHook(namespace, verb) {
    return {
        who: `extension "${namespace}"`,
        task: `${verb} its state`,
        doing: `${verb === 'capture' ? 'capturing' : 'restoring'} extension "${namespace}"`,
        path: undefined,
    };
}
function policyHook(id) {
    return {
        who: `policy "${id}"`,
        task: 'take back its parameters',
        doing: `restoring policy "${id}"`,
        path: `policies.${id}`,
    };
}
//# sourceMappingURL=persistence.js.map