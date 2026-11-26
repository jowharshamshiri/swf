import { makeError, SwfFailure } from '@swf/core';
import { groupFallbacks } from '@swf/presentation';
/**
 * Starts collecting diagnostics of a workspace, its surface runtime and its presenter, from now on:
 * nothing that happened before is counted. The caller owns the returned {@link Diagnostics} and
 * disposes it to stop listening.
 *
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT`, naming the option in its message and
 *   its `path`, when `errorCapacity` is not a whole number of at least 1 or `now` is not a
 *   function. The four sources are not checked: they are used as given.
 *
 * @example
 * ```ts
 * const diagnostics = createDiagnostics({ workspace, runtime, presenter, registry });
 * const { frames, errors } = diagnostics.read();
 * diagnostics.dispose();
 * ```
 */
export function createDiagnostics(options) {
    const capacity = options.errorCapacity ?? 50;
    if (!Number.isInteger(capacity) || capacity < 1) {
        throw new SwfFailure(makeError('INVALID_INPUT', 'errorCapacity must be a whole number of at least 1', {
            path: 'errorCapacity',
        }));
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
        throw new SwfFailure(makeError('INVALID_INPUT', 'now must be a function', { path: 'now' }));
    }
    return new Collector(options, capacity);
}
const BOUND = new Set(['ready', 'presented', 'hidden']);
class Collector {
    #options;
    #capacity;
    #now;
    #frames = new Map();
    #adapters = new Map();
    #operations = new Map();
    /** When each surface's current binding attempt began. */
    #binding = new Map();
    #errors = [];
    #unsubscribe;
    constructor(options, capacity) {
        this.#options = options;
        this.#capacity = capacity;
        this.#now = options.now ?? Date.now;
        this.#unsubscribe = [
            options.presenter.subscribe((event) => {
                this.#presenterEvent(event);
            }),
            options.runtime.subscribe((event) => {
                this.#runtimeEvent(event);
            }),
            options.workspace.subscribe((event) => {
                this.#workspaceEvent(event);
            }),
        ];
    }
    read() {
        const { presenter, runtime, workspace, registry } = this.#options;
        const viewports = presenter.viewports();
        const scene = workspace.getState();
        const presentations = runtime.list();
        const adapterOf = (surfaceId) => scene.surfaces.get(surfaceId)?.adapterTypeId ?? null;
        const adapters = new Map();
        for (const presentation of presentations) {
            const type = adapterOf(presentation.surfaceId);
            if (type === null) {
                continue;
            }
            const entry = adapters.get(type) ?? { bound: 0, presented: 0 };
            entry.bound += BOUND.has(presentation.state) ? 1 : 0;
            entry.presented += presentation.viewports.some((v) => v.visible) ? 1 : 0;
            adapters.set(type, entry);
        }
        for (const type of this.#adapters.keys()) {
            if (!adapters.has(type)) {
                adapters.set(type, { bound: 0, presented: 0 });
            }
        }
        const fallbacksByType = new Map();
        for (const totals of this.#frames.values()) {
            for (const fallback of totals.fallbacks) {
                const type = adapterOf(fallback.surfaceId);
                if (type === null) {
                    continue;
                }
                const counts = fallbacksByType.get(type) ?? {};
                counts[fallback.chosen] = (counts[fallback.chosen] ?? 0) + 1;
                fallbacksByType.set(type, counts);
            }
        }
        return deepFreeze({
            backends: viewports.map((v) => ({
                viewportId: v.viewportId,
                state: v.state,
                backend: v.backend,
                capabilities: v.capabilities,
                degradedBy: v.degradedBy,
            })),
            fallbacks: [...this.#frames].flatMap(([viewportId, totals]) => groupFallbacks(totals.fallbacks).map((group) => ({ viewportId, ...group }))),
            frames: [...this.#frames].map(([viewportId, totals]) => ({
                viewportId,
                rendererId: totals.rendererId,
                compositorId: totals.compositorId,
                frames: totals.frames,
                skipped: totals.skipped,
                lastDurationMs: totals.lastDurationMs,
                maxDurationMs: totals.maxDurationMs,
                lastDirty: totals.lastDirty,
                fragments: totals.fragments,
                writes: totals.writes,
            })),
            attachments: [...adapters]
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([adapterTypeId, counts]) => ({
                adapterTypeId,
                bound: counts.bound,
                presented: counts.presented,
                failed: this.#adapters.get(adapterTypeId)?.failed ?? 0,
                bindMs: this.#adapters.get(adapterTypeId)?.bindMs ?? null,
                fallbacks: fallbacksByType.get(adapterTypeId) ?? {},
            })),
            density: {
                nodes: scene.nodes.size,
                surfaces: scene.surfaces.size,
                viewports: viewports.map((v) => {
                    const frame = v.lastFrame();
                    const candidates = new Set(frame?.frame.output.fragments.map((f) => f.surfaceId) ?? [])
                        .size;
                    return {
                        viewportId: v.viewportId,
                        candidates,
                        mounted: presentations.filter((p) => p.viewports.some((a) => a.viewportId === v.viewportId && a.visible)).length,
                        culled: scene.surfaces.size - candidates,
                    };
                }),
            },
            operations: [...this.#operations]
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([commandType, totals]) => ({ commandType, ...totals })),
            resources: {
                presenter: presenter.resources(),
                subscriptions: this.#unsubscribe.length,
                handoffs: viewports.filter((v) => ['preparing', 'validating', 'swapping'].includes(v.state))
                    .length,
            },
            errors: [...this.#errors],
            listenerFailures: presenter.getDiagnostics().length + registry.getDiagnostics().length,
        });
    }
    dispose() {
        for (const unsubscribe of this.#unsubscribe.splice(0)) {
            unsubscribe();
        }
    }
    #presenterEvent(event) {
        switch (event.type) {
            case 'frame': {
                const m = event.metrics;
                const totals = this.#frames.get(event.viewportId);
                this.#frames.set(event.viewportId, {
                    rendererId: m.rendererId,
                    compositorId: m.compositorId,
                    frames: (totals?.frames ?? 0) + 1,
                    skipped: (totals?.skipped ?? 0) + m.skipped,
                    lastDurationMs: m.durationMs,
                    maxDurationMs: Math.max(totals?.maxDurationMs ?? 0, m.durationMs),
                    lastDirty: m.dirty,
                    fragments: m.fragments,
                    writes: m.writes,
                    fallbacks: event.fallbacks,
                });
                const refused = this.#options.presenter.viewport(event.viewportId)?.lastFrame()?.refused;
                for (const { error } of refused ?? []) {
                    this.#error('presentation', error);
                }
                break;
            }
            case 'frame.failed':
            case 'backend.failed':
            case 'viewport.degraded':
                this.#error('presentation', event.error);
                break;
            case 'backend.switched':
            case 'backend.lost':
                break;
        }
    }
    #runtimeEvent(event) {
        if (event.type !== 'presentation.stateChanged') {
            return;
        }
        const { surfaceId, from, to, error, binding } = event.payload;
        if (to === 'binding') {
            this.#binding.set(surfaceId, event.timestamp);
            return;
        }
        const type = binding.adapterTypeId;
        const started = this.#binding.get(surfaceId);
        if (from === 'binding') {
            this.#binding.delete(surfaceId);
        }
        if (to === 'ready' && from === 'binding' && started !== undefined) {
            const totals = this.#totals(type);
            const took = event.timestamp - started;
            totals.bindMs = { last: took, max: Math.max(totals.bindMs?.max ?? 0, took) };
        }
        if (to === 'error' && error !== null) {
            this.#totals(type).failed += 1;
            this.#error('surfaces', error);
        }
    }
    #workspaceEvent(event) {
        if (event.type !== 'transaction.committed' && event.type !== 'transaction.rejected') {
            return;
        }
        const p = event.payload;
        for (const type of new Set(p.commandTypes)) {
            const totals = this.#operations.get(type) ?? {
                committed: 0,
                rejected: 0,
                affectedNodes: 0,
                lastRevision: 0,
                lastDurationMs: 0,
                maxDurationMs: 0,
                totalDurationMs: 0,
            };
            if (event.type === 'transaction.committed') {
                totals.committed += 1;
                totals.affectedNodes += event.payload.changedNodeIds.length;
            }
            else {
                totals.rejected += 1;
            }
            totals.lastRevision = event.revision;
            totals.lastDurationMs = p.durationMs;
            totals.maxDurationMs = Math.max(totals.maxDurationMs, p.durationMs);
            totals.totalDurationMs += p.durationMs;
            this.#operations.set(type, totals);
        }
    }
    #totals(adapterTypeId) {
        let totals = this.#adapters.get(adapterTypeId);
        if (totals === undefined) {
            totals = { failed: 0, bindMs: null };
            this.#adapters.set(adapterTypeId, totals);
        }
        return totals;
    }
    #error(source, error) {
        this.#errors.push(Object.freeze({ at: this.#now(), source, error }));
        this.#errors.splice(0, Math.max(0, this.#errors.length - this.#capacity));
    }
}
function deepFreeze(value) {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
        for (const item of Object.values(value)) {
            deepFreeze(item);
        }
        Object.freeze(value);
    }
    return value;
}
//# sourceMappingURL=diagnostics.js.map