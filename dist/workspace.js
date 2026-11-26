import { models } from '@swf/models';
import { applyCommands } from './apply.js';
import { SCENE_COMMAND_TYPES } from './commands.js';
import { sortConstraints } from './constraints.js';
import { diffScenes } from './diff.js';
import { makeError, RejectionSignal, SwfFailure, thrownText } from './errors.js';
import { describe, describeAnswer } from './json.js';
import { DEFAULT_GEOMETRY_LIMITS, geometryParamsIssue, GeometryRegistry } from './geometry.js';
import { projectionConfigIssue, ProjectionKindRegistry } from './projection-kinds.js';
import { cameraSnapshot, nodeSnapshot, serializeScene, surfaceSnapshot, validateSceneSnapshot, viewportSnapshot, } from './snapshot.js';
import { effectiveState, findNodes, surfaceGeometry } from './query.js';
import { Table } from './table.js';
const EVENT_SOURCES = ['user', 'host', 'policy', 'restore', 'system'];
const OPTION_KEYS = [
    'id',
    'undoCapacity',
    'idempotencyCapacity',
    'diagnosticsCapacity',
    'now',
    'timer',
    'createId',
    'constraints',
    'geometry',
    'geometryLimits',
    'projectionKinds',
    'onDiagnostic',
    'frameBoundary',
];
/**
 * Creates an empty, independent workspace at revision 0. The workspace is the caller's: it holds
 * no global state and touches nothing outside itself, and {@link Workspace.dispose} releases it.
 *
 * @throws {@link SwfFailure} `INVALID_INPUT` for invalid options, naming `options.<field>`: an
 *   unknown option, a blank `id`, a capacity out of range, a callback that is not a function, or
 *   a constraint, geometry provider or projection kind its `register` method would refuse.
 *
 * @example
 * ```ts
 * const workspace = createWorkspace({ id: 'desk' });
 * const stop = workspace.subscribe((event) => {
 *   if (event.type === 'node.created') console.log('created', event.payload.nodeId);
 * });
 * workspace.transaction([
 *   { type: 'node.create', node: { id: 'notes', kind: 'window', bounds: [1.6, 0.9, 0.02] } },
 *   {
 *     type: 'surface.attach',
 *     surface: {
 *       ownerNodeId: 'notes',
 *       bindingKey: 'notes-editor',
 *       adapterTypeId: 'host.view/1',
 *       bounds: [1.6, 0.9, 0.02],
 *     },
 *   },
 * ]);
 * stop();
 * await workspace.dispose();
 * ```
 */
export function createWorkspace(options) {
    return new WorkspaceImpl(options);
}
class WorkspaceImpl {
    id;
    /**
     * The lifecycle, revision and history counts, as the kernel model (`Swf.Kernel`) keeps them:
     * every admission, commit, undo, redo and disposal step is its decision.
     */
    #ledger;
    #state;
    #diagnosticsCapacity;
    #now;
    #timer;
    #timerOption;
    #createId;
    #onDiagnostic;
    #frameBoundary;
    /** Preview events held for the next frame boundary, by preview, in the order first held. */
    #held = new Map();
    #flushRequested = false;
    /** The committed scene with every open preview applied, cached until either changes. */
    #presented = null;
    #constraints = new Map();
    #sortedConstraints = [];
    #geometry = new GeometryRegistry();
    #geometryLimits;
    #projectionKinds = new ProjectionKindRegistry();
    #listeners = new Set();
    #outbox = [];
    #queue = [];
    #delivering = false;
    #undo = [];
    #redo = [];
    #idempotency = new Map();
    #previews = new Map();
    #diagnostics = [];
    #txSeq = 0;
    #eventSeq = 0;
    #idSeq = 0;
    #disposed = null;
    #resolveDisposed = null;
    /** When `dispose` was called, by the clock: the time of the disposal's events. */
    #disposedAt = 0;
    constructor(options) {
        const record = checkOptions(options);
        this.id = record.id;
        this.#ledger = models.initial(BigInt(record.undoCapacity), BigInt(record.idempotencyCapacity));
        this.#diagnosticsCapacity = record.diagnosticsCapacity;
        this.#now = record.now;
        this.#timer = record.timer;
        this.#timerOption = record.timerOption;
        const hostCreateId = record.createId;
        this.#createId =
            hostCreateId === undefined
                ? (inUse) => {
                    let id;
                    do {
                        this.#idSeq += 1;
                        id = `node-${String(this.#idSeq)}`;
                    } while (inUse(id));
                    return id;
                }
                : () => hostCreateId();
        this.#onDiagnostic = record.onDiagnostic;
        this.#frameBoundary = record.frameBoundary;
        this.#geometryLimits = record.geometryLimits;
        for (const constraint of record.constraints) {
            this.#addConstraint(constraint);
        }
        for (const kind of record.projectionKinds) {
            this.#addProjectionKind(kind);
        }
        for (const provider of record.geometry) {
            this.#addGeometry(provider);
        }
        this.#state = Object.freeze({
            workspaceId: this.id,
            revision: 0,
            rootIds: Object.freeze([]),
            nodes: Table.empty(),
            surfaces: Table.empty(),
            cameras: Table.empty(),
            viewports: Table.empty(),
            orbitRootId: null,
            selection: Object.freeze([]),
            focusedId: null,
        });
    }
    get lifecycle() {
        return this.#ledger.lifecycle.kind;
    }
    /** Whether the workspace admits an operation now. */
    #ready() {
        return models.admits(this.#ledger.lifecycle);
    }
    /**
     * Reads one of the host's clocks. One that throws or reads as anything but a finite number is
     * reported as the rejection `INVALID_INPUT` at the workspace option it came from.
     */
    #read(clock) {
        const option = clock === 'now' ? 'now' : this.#timerOption;
        const path = `options.${option}`;
        let value;
        try {
            value = clock === 'now' ? this.#now() : this.#timer();
        }
        catch (error) {
            throw new RejectionSignal('INVALID_INPUT', `${path}: the workspace's ${option} clock threw: ${thrownText(error)}`, { path });
        }
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            throw new RejectionSignal('INVALID_INPUT', `${path}: the workspace's ${option} clock returned ${describeAnswer(value)}, not a finite number`, { path });
        }
        return value;
    }
    /** The clocks read once as an operation begins; every event it sends carries this time. */
    #clocks() {
        return { started: this.#read('timer'), timestamp: this.#read('now') };
    }
    /** How long the operation of `meta` has taken so far, by the timer. */
    #elapsed(meta) {
        return this.#read('timer') - meta.started;
    }
    /**
     * Reads the `now` clock for an operation that reports no rejection: a failing clock is the
     * {@link SwfFailure} the caller receives.
     */
    #readNowOrFail() {
        try {
            return this.#read('now');
        }
        catch (error) {
            if (!(error instanceof RejectionSignal)) {
                throw error;
            }
            throw new SwfFailure(makeError(error.code, error.message, {
                workspaceId: this.id,
                ...(error.path === undefined ? {} : { path: error.path }),
            }));
        }
    }
    getState() {
        return this.#state;
    }
    serialize() {
        return serializeScene(this.#state);
    }
    getPreview(previewId) {
        return this.#previews.get(previewId)?.state;
    }
    findNodes(query) {
        return findNodes(this.#state, query);
    }
    history() {
        return this.#undo.map((record) => record.entry);
    }
    surfaceGeometry(surfaceId) {
        return surfaceGeometry(this.#state, surfaceId, this.#geometry);
    }
    getPresented() {
        return this.#combined();
    }
    presentedGeometry(surfaceId) {
        return surfaceGeometry(this.#combined(), surfaceId, this.#geometry);
    }
    canUndo() {
        return models.canTravel(this.#ledger, UNDO);
    }
    canRedo() {
        return models.canTravel(this.#ledger, REDO);
    }
    getDiagnostics() {
        return [...this.#diagnostics];
    }
    reader() {
        return Object.freeze({
            id: this.id,
            getState: () => this.getState(),
            getPreview: (previewId) => this.getPreview(previewId),
            subscribe: (listener) => this.subscribe(listener),
            watch: (selector, listener, equals) => this.watch(selector, listener, equals),
            findNodes: (query) => this.findNodes(query),
            history: () => this.history(),
            surfaceGeometry: (surfaceId) => this.surfaceGeometry(surfaceId),
            getPresented: () => this.getPresented(),
            presentedGeometry: (surfaceId) => this.presentedGeometry(surfaceId),
        });
    }
    mutator() {
        return Object.freeze({
            id: this.id,
            transaction: (commands, options) => this.transaction(commands, options),
            dispatch: (command, options) => this.dispatch(command, options),
            preview: (previewId, commands, options) => this.preview(previewId, commands, options),
            cancelPreview: (previewId, reason) => this.cancelPreview(previewId, reason),
            undo: (options) => this.undo(options),
            redo: (options) => this.redo(options),
            canUndo: () => this.canUndo(),
            canRedo: () => this.canRedo(),
            registerConstraint: (constraint) => this.registerConstraint(constraint),
            registerGeometry: (provider) => this.registerGeometry(provider),
            registerProjectionKind: (kind) => this.registerProjectionKind(kind),
        });
    }
    persistence() {
        return Object.freeze({
            id: this.id,
            revision: () => this.#state.revision,
            serialize: () => this.serialize(),
            restore: (snapshot, options) => this.restore(snapshot, options),
            subscribe: (listener) => this.subscribe(listener),
        });
    }
    // --- subscription -----------------------------------------------------------------------
    subscribe(listener) {
        if (typeof listener !== 'function') {
            throw this.#failure('INVALID_INPUT', `listener must be a function (got ${describe(listener)})`);
        }
        if (!this.#ready()) {
            throw this.#failure('WORKSPACE_DISPOSED', `workspace "${this.id}" is ${this.lifecycle}`);
        }
        // Each subscription is its own entry, so subscribing one function twice delivers twice.
        const entry = (event) => {
            listener(event);
        };
        this.#listeners.add(entry);
        return () => {
            this.#listeners.delete(entry);
        };
    }
    watch(selector, listener, equals = Object.is) {
        let current = selector(this.#state);
        return this.subscribe((event) => {
            if (event.type !== 'transaction.committed') {
                return;
            }
            const next = selector(this.#state);
            if (!equals(current, next)) {
                current = next;
                listener(next, event.revision);
            }
        });
    }
    // --- constraints ------------------------------------------------------------------------
    registerConstraint(constraint) {
        if (!this.#ready()) {
            throw this.#failure('WORKSPACE_DISPOSED', `workspace "${this.id}" is ${this.lifecycle}`);
        }
        this.#addConstraint(constraint);
        return () => {
            if (this.#constraints.get(constraint.id) === constraint) {
                this.#constraints.delete(constraint.id);
                this.#sortedConstraints = sortConstraints(this.#constraints.values());
            }
        };
    }
    registerProjectionKind(kind) {
        if (!this.#ready()) {
            throw this.#failure('WORKSPACE_DISPOSED', `workspace "${this.id}" is ${this.lifecycle}`);
        }
        return this.#addProjectionKind(kind);
    }
    #addProjectionKind(kind) {
        try {
            return this.#projectionKinds.register(kind);
        }
        catch (error) {
            throw this.#failure('INVALID_INPUT', error instanceof Error ? error.message : String(error));
        }
    }
    registerGeometry(provider) {
        if (!this.#ready()) {
            throw this.#failure('WORKSPACE_DISPOSED', `workspace "${this.id}" is ${this.lifecycle}`);
        }
        return this.#addGeometry(provider);
    }
    #addGeometry(provider) {
        try {
            return this.#geometry.register(provider);
        }
        catch (error) {
            throw this.#failure('INVALID_INPUT', error instanceof Error ? error.message : String(error));
        }
    }
    #addConstraint(constraint) {
        checkConstraint(constraint, this.id);
        if (this.#constraints.has(constraint.id)) {
            throw this.#failure('INVALID_INPUT', `a constraint "${constraint.id}" is already registered`);
        }
        this.#constraints.set(constraint.id, constraint);
        this.#sortedConstraints = sortConstraints(this.#constraints.values());
    }
    // --- operations -------------------------------------------------------------------------
    transaction(commands, options = {}) {
        return this.#schedule(() => this.#transaction(commands, options));
    }
    dispatch(command, options = {}) {
        return this.transaction([command], options);
    }
    preview(previewId, commands, options = {}) {
        return this.#schedule(() => this.#preview(previewId, commands, options));
    }
    cancelPreview(previewId, reason) {
        return this.#schedule(() => {
            const record = this.#previews.get(previewId);
            if (record === undefined || !this.#ready()) {
                return false;
            }
            const timestamp = this.#readNowOrFail();
            this.#previews.delete(previewId);
            this.#emit('preview.cancelled', { previewId, reason }, {
                source: record.source,
                causeId: record.causeId ?? previewId,
                phase: 'cancelled',
                timestamp,
            });
            this.#keepCombinable(timestamp);
            return true;
        });
    }
    undo(options = {}) {
        return this.#schedule(() => this.#travel('undo', options));
    }
    restore(snapshot, options = {}) {
        return this.#schedule(() => this.#restore(snapshot, options));
    }
    redo(options = {}) {
        return this.#schedule(() => this.#travel('redo', options));
    }
    dispose() {
        if (this.#disposed !== null) {
            return this.#disposed;
        }
        try {
            this.#disposedAt = this.#readNowOrFail();
        }
        catch (error) {
            return Promise.reject(asError(error));
        }
        this.#disposed = new Promise((resolve) => {
            this.#resolveDisposed = resolve;
        });
        this.#ledger = models.dispose(this.#ledger);
        this.#drain();
        return this.#disposed;
    }
    // --- internals --------------------------------------------------------------------------
    #transaction(commands, rawOptions) {
        const transactionId = this.#nextTransactionId();
        let clocks;
        try {
            clocks = this.#clocks();
        }
        catch (error) {
            return this.#reject(transactionId, error, null);
        }
        let options;
        try {
            options = checkTxOptions(rawOptions);
        }
        catch (error) {
            return this.#reject(transactionId, error, {
                source: 'host',
                causeId: null,
                commands,
                ...clocks,
            });
        }
        const meta = {
            transactionId,
            source: options.source,
            causeId: options.causeId,
            ...clocks,
        };
        const settle = (outcome) => {
            const previewId = options.previewId;
            const committing = previewId === null ? undefined : this.#previews.get(previewId);
            if (previewId === null || committing === undefined) {
                return outcome;
            }
            this.#previews.delete(previewId);
            if (outcome.status === 'rejected') {
                this.#emit('preview.cancelled', {
                    previewId,
                    reason: outcome.error.code === 'CONSTRAINT_REJECTED'
                        ? 'constraint-rejected'
                        : 'commit-rejected',
                }, {
                    source: options.source,
                    causeId: committing.causeId ?? previewId,
                    phase: 'cancelled',
                    timestamp: meta.timestamp,
                });
                this.#keepCombinable(meta.timestamp);
            }
            return outcome;
        };
        const key = this.#ready() ? options.idempotencyKey : null;
        const fingerprint = key === null ? null : fingerprintOf(commands, options);
        const known = key === null ? undefined : this.#idempotency.get(key);
        const gate = models.gate(this.#ledger, {
            known: known === undefined ? null : known.fingerprint === fingerprint,
            expected: options.expectedRevision === null ? null : BigInt(options.expectedRevision),
        });
        switch (gate.kind) {
            case 'refuseDisposed':
                return settle(this.#reject(transactionId, this.#disposedSignal(), { ...meta, commands }));
            case 'replay':
                if (known === undefined) {
                    throw new Error('the kernel model replayed an idempotency key the workspace does not know');
                }
                return settle({ ...known.result, replayed: true });
            case 'refuseKeyReused':
                return settle(this.#reject(transactionId, new RejectionSignal('INVALID_INPUT', `options.idempotencyKey "${String(key)}" was already used for different commands`, { path: 'options.idempotencyKey' }), { ...meta, commands }));
            case 'refuseStale':
                return settle(this.#reject(transactionId, this.#staleSignal(options), { ...meta, commands }));
            case 'proceed':
                break;
        }
        let outcome;
        let durationMs;
        try {
            outcome = applyCommands(this.#state, commands, this.#applyContext(options.source, meta.timestamp));
            durationMs = this.#elapsed(meta);
        }
        catch (error) {
            return settle(this.#reject(transactionId, error, { ...meta, commands }));
        }
        if (options.previewId !== null) {
            this.#previews.delete(options.previewId);
        }
        const decision = models.commit(this.#ledger, {
            kind: 'commands',
            layout: layoutChanged(this.#state, outcome),
            keyed: key !== null,
        });
        const result = this.#commit(outcome, meta, durationMs, decision, {
            idempotencyKey: options.idempotencyKey,
            previewId: options.previewId,
            history: null,
            // Validated by applying them.
            commands: commands,
        });
        if (key !== null && fingerprint !== null) {
            this.#idempotency.set(key, { fingerprint, result });
            // The oldest keys first: the one just remembered is the newest.
            let evict = Number(decision.evictKeys);
            for (const old of this.#idempotency.keys()) {
                if (evict === 0) {
                    break;
                }
                this.#idempotency.delete(old);
                evict -= 1;
            }
        }
        return result;
    }
    #restore(snapshot, rawOptions) {
        const transactionId = this.#nextTransactionId();
        const commands = [{ type: 'scene.restore' }];
        let clocks;
        try {
            clocks = this.#clocks();
        }
        catch (error) {
            return this.#reject(transactionId, error, null);
        }
        let options;
        try {
            options = checkTxOptions(rawOptions, ['expectedRevision', 'source', 'causeId']);
        }
        catch (error) {
            return this.#reject(transactionId, error, {
                source: 'restore',
                causeId: null,
                commands,
                ...clocks,
            });
        }
        const source = rawOptions.source === undefined ? 'restore' : options.source;
        const meta = {
            transactionId,
            source,
            causeId: options.causeId,
            ...clocks,
        };
        const gate = models.gate(this.#ledger, {
            known: null,
            expected: options.expectedRevision === null ? null : BigInt(options.expectedRevision),
        });
        if (gate.kind === 'refuseDisposed') {
            return this.#reject(transactionId, this.#disposedSignal(), { ...meta, commands });
        }
        if (gate.kind === 'refuseStale') {
            return this.#reject(transactionId, this.#staleSignal(options), { ...meta, commands });
        }
        if (gate.kind !== 'proceed') {
            throw new Error(`the kernel model answered a restore with ${gate.kind}`);
        }
        const before = this.#state;
        let scene;
        let durationMs;
        try {
            scene = validateSceneSnapshot(snapshot);
            this.#checkUsable(scene, snapshot);
            durationMs = this.#elapsed(meta);
        }
        catch (error) {
            const signal = error instanceof SwfFailure
                ? new RejectionSignal(error.error.code, error.message, {
                    ...(error.error.path === undefined ? {} : { path: error.error.path }),
                })
                : error;
            return this.#reject(transactionId, signal, { ...meta, commands });
        }
        const nodes = replaceRecords(before.nodes, scene.nodes, nodeSnapshot);
        const surfaces = replaceRecords(before.surfaces, scene.surfaces, surfaceSnapshot);
        const cameras = replaceRecords(before.cameras, scene.cameras, cameraSnapshot);
        const viewports = replaceRecords(before.viewports, scene.viewports, viewportSnapshot);
        const selectable = (id) => effectiveState(nodes.table, id)?.selectable === true;
        const sameRoots = before.rootIds.length === scene.rootIds.length &&
            before.rootIds.every((id, i) => scene.rootIds[i] === id);
        const outcome = {
            nodes: nodes.table,
            surfaces: surfaces.table,
            cameras: cameras.table,
            viewports: viewports.table,
            orbitRootId: scene.orbitRootId,
            rootIds: sameRoots ? before.rootIds : scene.rootIds,
            selection: Object.freeze(scene.selection.filter(selectable)),
            focusedId: scene.focusedId !== null && selectable(scene.focusedId) ? scene.focusedId : null,
            commandTypes: Object.freeze(['scene.restore']),
            touched: nodes.changed,
            touchedSurfaces: surfaces.changed,
            touchedCameras: cameras.changed,
            touchedViewports: viewports.changed,
            createdIds: Object.freeze([]),
        };
        // The revision never goes back, and a restored scene is never older than its snapshot.
        const decision = models.commit(this.#ledger, {
            kind: 'restore',
            layout: layoutChanged(before, outcome),
            snapshotRevision: BigInt(scene.revision),
        });
        return this.#commit(outcome, meta, durationMs, decision, {
            idempotencyKey: null,
            previewId: null,
            history: null,
            commands: null,
        });
    }
    /**
     * Throws `SNAPSHOT_INVALID` when the snapshot names a geometry or projection kind this
     * workspace does not have, or parameters the kind refuses. Paths name the snapshot as given.
     */
    #checkUsable(scene, raw) {
        const at = (list, id) => {
            const items = raw[list];
            const index = Array.isArray(items)
                ? items.findIndex((item) => item?.id === id)
                : -1;
            return index;
        };
        const fail = (path, message) => new RejectionSignal('SNAPSHOT_INVALID', `${path} ${message}`, { path });
        for (const surface of scene.surfaces) {
            const path = `surfaces[${String(at('surfaces', surface.id))}].geometry`;
            const { kind, params } = surface.geometry;
            const provider = this.#geometry.get(kind);
            if (provider === undefined) {
                throw fail(`${path}.kind`, `names geometry kind "${kind}", which is not registered here`);
            }
            const issue = geometryParamsIssue(provider, params, surface.bounds, this.#geometryLimits);
            if (issue !== null) {
                throw fail(`${path}.params`, `is invalid: ${issue}`);
            }
        }
        for (const viewport of scene.viewports) {
            const path = `viewports[${String(at('viewports', viewport.id))}].projection`;
            const { id, config } = viewport.projection;
            const kind = this.#projectionKinds.get(id);
            if (kind === undefined) {
                throw fail(`${path}.id`, `names projection "${id}", which is not registered here`);
            }
            const issue = projectionConfigIssue(kind, config);
            if (issue !== null) {
                throw fail(`${path}.config`, `is invalid: ${issue}`);
            }
        }
    }
    #applyContext(source, now) {
        return {
            source,
            now,
            createId: this.#createId,
            constraints: this.#sortedConstraints,
            geometry: this.#geometry,
            geometryLimits: this.#geometryLimits,
            projectionKinds: this.#projectionKinds,
        };
    }
    #commit(outcome, meta, 
    /** How long the operation took, read before anything is changed. */
    durationMs, 
    /** What the kernel model decided the commit does to the revision and the history. */
    decision, extra) {
        const before = this.#state;
        const after = Object.freeze({
            workspaceId: this.id,
            revision: Number(decision.next.revision),
            rootIds: outcome.rootIds,
            nodes: outcome.nodes,
            surfaces: outcome.surfaces,
            cameras: outcome.cameras,
            viewports: outcome.viewports,
            orbitRootId: outcome.orbitRootId,
            selection: outcome.selection,
            focusedId: outcome.focusedId,
        });
        this.#state = after;
        this.#ledger = decision.next;
        if (decision.clearRedo) {
            this.#redo.length = 0;
        }
        if (decision.push) {
            this.#record(before, after, outcome, meta);
        }
        if (decision.dropOldest) {
            this.#undo.shift();
        }
        // Every event of the commit, its entity events and its transaction.committed, carries the
        // host's cause, or the transaction's own ID when the host gave none.
        const how = {
            source: meta.source,
            causeId: meta.causeId ?? meta.transactionId,
            phase: 'committed',
            timestamp: meta.timestamp,
        };
        for (const event of diffScenes(before, after, {
            nodes: outcome.touched,
            surfaces: outcome.touchedSurfaces,
            cameras: outcome.touchedCameras,
            viewports: outcome.touchedViewports,
        })) {
            this.#emitPending(event, how);
        }
        this.#emit('transaction.committed', {
            transactionId: meta.transactionId,
            previousRevision: before.revision,
            commandTypes: outcome.commandTypes,
            changedNodeIds: outcome.touched,
            changedSurfaceIds: outcome.touchedSurfaces,
            createdIds: outcome.createdIds,
            idempotencyKey: extra.idempotencyKey,
            previewId: extra.previewId,
            history: extra.history,
            commands: extra.commands,
            durationMs,
        }, how);
        this.#refreshPreviews(meta.timestamp);
        return Object.freeze({
            status: 'committed',
            transactionId: meta.transactionId,
            revision: after.revision,
            previousRevision: before.revision,
            createdIds: outcome.createdIds,
            changedNodeIds: outcome.touched,
            changedSurfaceIds: outcome.touchedSurfaces,
            replayed: false,
        });
    }
    #record(before, after, outcome, meta) {
        this.#undo.push({
            entry: Object.freeze({
                transactionId: meta.transactionId,
                timestamp: meta.timestamp,
                source: meta.source,
                previousRevision: before.revision,
                revision: after.revision,
                commandTypes: outcome.commandTypes,
                changedNodeIds: outcome.touched,
                changedSurfaceIds: outcome.touchedSurfaces,
            }),
            nodesBefore: snapshotOf(before.nodes, outcome.touched),
            nodesAfter: snapshotOf(after.nodes, outcome.touched),
            surfacesBefore: snapshotOf(before.surfaces, outcome.touchedSurfaces),
            surfacesAfter: snapshotOf(after.surfaces, outcome.touchedSurfaces),
            rootsBefore: before.rootIds,
            rootsAfter: after.rootIds,
        });
    }
    /**
     * Undo or redo: restores the recorded records exactly, as a new commit. If anything recorded
     * has changed since (a later transaction outside history touched it), the step is rejected with
     * CONFLICT and history is left as it was.
     */
    #travel(action, rawOptions) {
        const transactionId = this.#nextTransactionId();
        let clocks;
        try {
            clocks = this.#clocks();
        }
        catch (error) {
            return this.#reject(transactionId, error, null);
        }
        let options;
        try {
            options = checkTxOptions(rawOptions, ['source', 'causeId']);
        }
        catch (error) {
            return this.#reject(transactionId, error, {
                source: 'host',
                causeId: null,
                commands: [],
                ...clocks,
            });
        }
        const meta = {
            transactionId,
            source: options.source,
            causeId: options.causeId,
            ...clocks,
        };
        const undoing = action === 'undo';
        const stack = undoing ? this.#undo : this.#redo;
        const record = stack.at(-1);
        const state = this.#state;
        // What the step would restore that has changed since it was recorded, if there is a step.
        let stale = null;
        if (record !== undefined) {
            const nodesExpected = undoing ? record.nodesAfter : record.nodesBefore;
            const surfacesExpected = undoing ? record.surfacesAfter : record.surfacesBefore;
            const rootsExpected = undoing ? record.rootsAfter : record.rootsBefore;
            const rootsTarget = undoing ? record.rootsBefore : record.rootsAfter;
            const staleNode = [...nodesExpected].find(([id, value]) => state.nodes.get(id) !== value);
            const staleSurface = [...surfacesExpected].find(([id, value]) => state.surfaces.get(id) !== value);
            if (staleNode !== undefined) {
                stale = { what: `node "${staleNode[0]}"`, entityId: staleNode[0] };
            }
            else if (staleSurface !== undefined) {
                stale = { what: `surface "${staleSurface[0]}"`, entityId: staleSurface[0] };
            }
            else if (rootsExpected !== rootsTarget && state.rootIds !== rootsExpected) {
                stale = { what: 'the root order', entityId: undefined };
            }
        }
        const travel = models.travel(this.#ledger, undoing ? UNDO : REDO, stale !== null);
        switch (travel.kind) {
            case 'refuseDisposed':
                return this.#reject(transactionId, this.#disposedSignal(), { ...meta, commands: [] });
            case 'refuseEmpty':
                return this.#reject(transactionId, new RejectionSignal('INVALID_INPUT', `there is nothing to ${action}`), { ...meta, commands: [] });
            case 'refuseStale':
                if (record === undefined || stale === null) {
                    throw new Error(`the kernel model refused an ${action} the workspace has no record of`);
                }
                return this.#reject(transactionId, new RejectionSignal('CONFLICT', `cannot ${action} transaction ${record.entry.transactionId}: ${stale.what} has changed since`, {
                    ...(stale.entityId === undefined ? {} : { entityId: stale.entityId }),
                    details: { currentRevision: state.revision },
                }), { ...meta, commands: [] });
            case 'commit':
                break;
        }
        if (record === undefined) {
            throw new Error(`the kernel model took an ${action} the workspace has no record of`);
        }
        let durationMs;
        try {
            durationMs = this.#elapsed(meta);
        }
        catch (error) {
            return this.#reject(transactionId, error, { ...meta, commands: [] });
        }
        const nodesTarget = undoing ? record.nodesBefore : record.nodesAfter;
        const surfacesTarget = undoing ? record.surfacesBefore : record.surfacesAfter;
        const rootsTarget = undoing ? record.rootsBefore : record.rootsAfter;
        const restored = restoreRecords(state.nodes, nodesTarget);
        const selectable = (id) => effectiveState(restored, id)?.selectable === true;
        const selection = state.selection.filter(selectable);
        stack.pop();
        (undoing ? this.#redo : this.#undo).push(record);
        return this.#commit({
            nodes: restored,
            surfaces: restoreRecords(state.surfaces, surfacesTarget),
            // Cameras and viewports are view state: undo and redo leave them as they are.
            cameras: state.cameras,
            viewports: state.viewports,
            orbitRootId: state.orbitRootId !== null && restored.has(state.orbitRootId) ? state.orbitRootId : null,
            rootIds: rootsTarget,
            selection: selection.length === state.selection.length ? state.selection : Object.freeze(selection),
            focusedId: state.focusedId !== null && selectable(state.focusedId) ? state.focusedId : null,
            commandTypes: record.entry.commandTypes,
            touched: record.entry.changedNodeIds,
            touchedSurfaces: record.entry.changedSurfaceIds,
            touchedCameras: Object.freeze([]),
            touchedViewports: Object.freeze([]),
            createdIds: Object.freeze([]),
        }, meta, durationMs, { next: travel.next, clearRedo: false, push: false, dropOldest: false }, {
            idempotencyKey: null,
            previewId: null,
            history: { action, transactionId: record.entry.transactionId },
            commands: null,
        });
    }
    #preview(previewId, commands, rawOptions) {
        const transactionId = this.#nextTransactionId();
        let timestamp;
        try {
            timestamp = this.#read('now');
        }
        catch (error) {
            return this.#reject(transactionId, error, null);
        }
        let options;
        try {
            if (typeof previewId !== 'string' || previewId.trim() === '') {
                throw new RejectionSignal('INVALID_INPUT', 'previewId must be a non-blank string', {
                    path: 'previewId',
                });
            }
            options = checkTxOptions(rawOptions, ['source', 'causeId']);
        }
        catch (error) {
            return this.#reject(transactionId, error, null);
        }
        if (!this.#ready()) {
            return this.#reject(transactionId, this.#disposedSignal(), null);
        }
        let preview;
        try {
            preview = this.#applyOnto(this.#state, commands, options.source, timestamp);
        }
        catch (error) {
            return this.#reject(transactionId, error, null);
        }
        const previous = this.#previews.get(previewId);
        this.#previews.set(previewId, {
            commands: commands,
            source: options.source,
            causeId: options.causeId,
            timestamp,
            state: preview.state,
        });
        // Open previews are presented together; one that cannot join the others is refused.
        try {
            this.#combined();
        }
        catch (error) {
            if (previous === undefined) {
                this.#previews.delete(previewId);
            }
            else {
                this.#previews.set(previewId, previous);
            }
            return this.#reject(transactionId, error, null);
        }
        const changed = {
            changedNodeIds: preview.changedNodeIds,
            changedSurfaceIds: preview.changedSurfaceIds,
        };
        this.#emit('transform.preview', { previewId, ...changed }, {
            source: options.source,
            causeId: options.causeId ?? previewId,
            phase: 'preview',
            timestamp,
        });
        return Object.freeze({ status: 'previewed', previewId, ...changed });
    }
    /**
     * `commands` applied to `base` as a preview, at `timestamp`: a scene at the committed revision.
     */
    #applyOnto(base, commands, source, timestamp) {
        const outcome = applyCommands(base, commands, this.#applyContext(source, timestamp));
        const state = Object.freeze({
            workspaceId: this.id,
            revision: this.#state.revision,
            rootIds: outcome.rootIds,
            nodes: outcome.nodes,
            surfaces: outcome.surfaces,
            cameras: outcome.cameras,
            viewports: outcome.viewports,
            orbitRootId: outcome.orbitRootId,
            selection: outcome.selection,
            focusedId: outcome.focusedId,
        });
        return {
            state,
            changedNodeIds: outcome.touched,
            changedSurfaceIds: outcome.touchedSurfaces,
        };
    }
    /**
     * Re-applies open previews to the newly committed scene, at the commit's `timestamp`, ending
     * those that no longer apply.
     */
    #refreshPreviews(timestamp) {
        for (const [previewId, record] of [...this.#previews]) {
            try {
                const preview = this.#applyOnto(this.#state, record.commands, record.source, timestamp);
                record.state = preview.state;
                record.timestamp = timestamp;
                this.#emit('transform.preview', {
                    previewId,
                    changedNodeIds: preview.changedNodeIds,
                    changedSurfaceIds: preview.changedSurfaceIds,
                }, {
                    source: record.source,
                    causeId: record.causeId ?? previewId,
                    phase: 'preview',
                    timestamp,
                });
            }
            catch (error) {
                this.#previews.delete(previewId);
                const code = error instanceof RejectionSignal ? error.code : null;
                this.#emit('preview.cancelled', {
                    previewId,
                    reason: code === 'UNKNOWN_ENTITY'
                        ? 'target-detached'
                        : code === 'CONSTRAINT_REJECTED'
                            ? 'constraint-rejected'
                            : 'invalidated',
                }, {
                    source: record.source,
                    causeId: record.causeId ?? previewId,
                    phase: 'cancelled',
                    timestamp,
                });
            }
        }
        this.#keepCombinable(timestamp);
    }
    /**
     * Keeps the open previews presentable together: while they do not apply together, the newest is
     * ended as invalidated (at `timestamp`). Run whenever the committed scene or the set of open
     * previews changes, so presenting them never applies anything.
     */
    #keepCombinable(timestamp) {
        for (;;) {
            try {
                this.#combined();
                return;
            }
            catch (error) {
                const newest = [...this.#previews.entries()].at(-1);
                if (newest === undefined) {
                    // With no preview open the committed scene itself is presented, which cannot fail.
                    throw new Error('the committed scene failed to present', { cause: error });
                }
                const [previewId, record] = newest;
                this.#previews.delete(previewId);
                this.#emit('preview.cancelled', { previewId, reason: 'invalidated' }, {
                    source: record.source,
                    causeId: record.causeId ?? previewId,
                    phase: 'cancelled',
                    timestamp,
                });
            }
        }
    }
    /**
     * The committed scene with every open preview applied, in the order they were opened. Throws
     * the rejection when they do not apply together.
     */
    #combined() {
        const records = [...this.#previews.values()];
        if (records.length === 0) {
            return this.#state;
        }
        const cached = this.#presented;
        if (cached !== null &&
            cached.state === this.#state &&
            cached.previews.length === records.length &&
            cached.previews.every((r, i) => r === records[i])) {
            return cached.result;
        }
        let state = this.#state;
        for (const record of records) {
            state = this.#applyOnto(state, record.commands, record.source, record.timestamp).state;
        }
        this.#presented = { state: this.#state, previews: records, result: state };
        return state;
    }
    /**
     * Reports `error` as the operation's rejection, sending `transaction.rejected` when `meta` is
     * given and the workspace is ready. A rejection whose duration cannot be timed, because the
     * timer fails, is reported as the timer's failure instead, and sent nowhere: no event can be
     * made without the clock.
     */
    #reject(transactionId, error, meta) {
        if (!(error instanceof RejectionSignal)) {
            throw error;
        }
        let durationMs = 0;
        if (meta !== null && this.#ready()) {
            try {
                durationMs = this.#elapsed(meta);
            }
            catch (clockError) {
                return this.#reject(transactionId, clockError, null);
            }
        }
        const swfError = makeError(error.code, error.message, {
            workspaceId: this.id,
            causeId: transactionId,
            ...(error.entityId === undefined ? {} : { entityId: error.entityId }),
            ...(error.path === undefined ? {} : { path: error.path }),
            ...(error.details === undefined ? {} : { details: error.details }),
        });
        if (meta !== null && this.#ready()) {
            this.#emit('transaction.rejected', {
                transactionId,
                commandTypes: commandTypesOf(meta.commands),
                error: swfError,
                durationMs,
            }, {
                source: meta.source,
                causeId: meta.causeId ?? transactionId,
                phase: 'rejected',
                timestamp: meta.timestamp,
            });
        }
        return Object.freeze({
            status: 'rejected',
            transactionId,
            error: swfError,
            revision: this.#state.revision,
        });
    }
    #disposedSignal() {
        return new RejectionSignal('WORKSPACE_DISPOSED', `workspace "${this.id}" is ${this.lifecycle}`);
    }
    /** The scene is not at the revision a transaction expected. */
    #staleSignal(options) {
        const revision = this.#state.revision;
        return new RejectionSignal('CONFLICT', `the scene is at revision ${revision}, not the expected ${String(options.expectedRevision)}`, { path: 'options.expectedRevision', details: { currentRevision: revision } });
    }
    #failure(code, message) {
        return new SwfFailure(makeError(code, message, { workspaceId: this.id }));
    }
    #nextTransactionId() {
        this.#txSeq += 1;
        return `${this.id}/tx-${String(this.#txSeq)}`;
    }
    // --- delivery ---------------------------------------------------------------------------
    #emit(type, payload, how) {
        this.#emitPending({ type, payload }, how);
    }
    #emitPending(event, how) {
        this.#eventSeq += 1;
        const built = Object.freeze({
            id: `${this.id}/ev-${String(this.#eventSeq)}`,
            type: event.type,
            workspaceId: this.id,
            revision: this.#state.revision,
            timestamp: how.timestamp,
            source: how.source,
            causationId: how.causeId,
            phase: how.phase,
            payload: event.payload,
        });
        if (this.#frameBoundary !== undefined && built.type === 'transform.preview') {
            this.#hold(built);
            return;
        }
        // Held previews go first: events keep the order they happened in.
        this.#releaseHeld();
        this.#outbox.push(built);
    }
    /** Holds a preview event for the next frame boundary, merging it with one already held. */
    #hold(event) {
        const previewId = event.payload.previewId;
        const held = this.#held.get(previewId);
        if (held?.type === 'transform.preview') {
            const union = (a, b) => Object.freeze([...new Set([...a, ...b])]);
            this.#held.set(previewId, Object.freeze({
                ...event,
                payload: Object.freeze({
                    previewId,
                    changedNodeIds: union(held.payload.changedNodeIds, event.payload.changedNodeIds),
                    changedSurfaceIds: union(held.payload.changedSurfaceIds, event.payload.changedSurfaceIds),
                }),
            }));
        }
        else {
            this.#held.set(previewId, event);
        }
        if (!this.#flushRequested && this.#frameBoundary !== undefined) {
            this.#flushRequested = true;
            try {
                this.#frameBoundary(() => {
                    this.#flushRequested = false;
                    if (this.#held.size > 0 && models.delivers(this.#ledger.lifecycle)) {
                        this.#releaseHeld();
                        this.#drain();
                    }
                });
            }
            catch (error) {
                // No boundary will come: what is held goes out with the operation's other events.
                this.#flushRequested = false;
                this.#releaseHeld();
                this.#diagnose({
                    code: 'FRAME_BOUNDARY_THREW',
                    message: `frameBoundary threw: ${thrownText(error)}; the held preview events were delivered at once`,
                    timestamp: event.timestamp,
                    details: { eventId: event.id, eventType: event.type },
                });
            }
        }
    }
    /** Moves held preview events into the outbox, in the order they were first held. */
    #releaseHeld() {
        for (const event of this.#held.values()) {
            this.#outbox.push(event);
        }
        this.#held.clear();
    }
    /**
     * Runs `op` now, or, when called from inside an event listener, after the current delivery
     * finishes: a listener never changes the scene in the middle of another change's notification.
     */
    #schedule(op) {
        if (this.#delivering) {
            let run = () => undefined;
            const completion = new Promise((resolve, reject) => {
                run = () => {
                    let result;
                    try {
                        result = op();
                    }
                    catch (error) {
                        // Settled either way: the queue goes on with the next operation.
                        reject(asError(error));
                        return;
                    }
                    resolve(result);
                };
            });
            this.#queue.push(run);
            return Object.freeze({ status: 'queued', completion });
        }
        try {
            return op();
        }
        finally {
            this.#drain();
        }
    }
    #drain() {
        if (this.#delivering) {
            return;
        }
        this.#delivering = true;
        try {
            for (;;) {
                const event = this.#outbox.shift();
                if (event !== undefined) {
                    this.#deliver(event);
                    continue;
                }
                const op = this.#queue.shift();
                if (op !== undefined) {
                    op();
                    continue;
                }
                const step = models.idle(this.#ledger);
                if (step.kind === 'announce') {
                    this.#ledger = step.next;
                    this.#announceDisposal();
                    continue;
                }
                break;
            }
        }
        finally {
            this.#delivering = false;
        }
        const step = models.idle(this.#ledger);
        if (step.kind === 'finish') {
            this.#ledger = step.next;
            this.#finishDisposal();
        }
    }
    #deliver(event) {
        for (const listener of [...this.#listeners]) {
            try {
                listener(event);
            }
            catch (error) {
                this.#diagnose({
                    code: 'LISTENER_THREW',
                    message: `a listener threw while handling ${event.type}: ${thrownText(error)}`,
                    timestamp: event.timestamp,
                    details: { eventId: event.id, eventType: event.type },
                });
            }
        }
    }
    #diagnose(diagnostic) {
        this.#diagnostics.push(Object.freeze(diagnostic));
        if (this.#diagnostics.length > this.#diagnosticsCapacity) {
            this.#diagnostics.shift();
        }
        try {
            this.#onDiagnostic?.(diagnostic);
        }
        catch {
            // A failing diagnostics sink must not interrupt the workspace.
        }
    }
    #announceDisposal() {
        for (const [previewId, record] of this.#previews) {
            this.#emit('preview.cancelled', { previewId, reason: 'workspace-disposed' }, {
                source: 'system',
                causeId: record.causeId ?? previewId,
                phase: 'cancelled',
                timestamp: this.#disposedAt,
            });
        }
        this.#previews.clear();
        this.#emit('workspace.disposed', {}, { source: 'system', causeId: null, phase: 'committed', timestamp: this.#disposedAt });
    }
    #finishDisposal() {
        this.#listeners.clear();
        this.#undo.length = 0;
        this.#redo.length = 0;
        this.#idempotency.clear();
        this.#constraints.clear();
        this.#sortedConstraints = [];
        this.#resolveDisposed?.();
        this.#resolveDisposed = null;
    }
}
/** What was thrown, as an Error: itself when it is one, else an Error carrying it as `cause`. */
function asError(thrown) {
    return thrown instanceof Error
        ? thrown
        : new Error(`the operation threw ${describeAnswer(thrown)}`, { cause: thrown });
}
const UNDO = Object.freeze({ kind: 'undo' });
const REDO = Object.freeze({ kind: 'redo' });
/** Whether an outcome changes the layout: any node, any surface or the root order. Only such a
 * commit is recorded for undo. */
function layoutChanged(before, outcome) {
    return (outcome.touched.length > 0 ||
        outcome.touchedSurfaces.length > 0 ||
        before.rootIds !== outcome.rootIds);
}
const TX_OPTION_KEYS = ['expectedRevision', 'idempotencyKey', 'source', 'causeId', 'previewId'];
function checkTxOptions(raw, allowed = TX_OPTION_KEYS) {
    const fail = (key, message) => new RejectionSignal('INVALID_INPUT', `options.${key} ${message}`, { path: `options.${key}` });
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new RejectionSignal('INVALID_INPUT', `options must be an object (got ${describe(raw)})`, {
            path: 'options',
        });
    }
    const record = raw;
    for (const key of Object.keys(record)) {
        if (!allowed.includes(key)) {
            throw fail(key, `is not a known option (expected one of ${allowed.join(', ')})`);
        }
    }
    const text = (key) => {
        const value = record[key];
        if (value === undefined) {
            return null;
        }
        if (typeof value !== 'string' || value.trim() === '') {
            throw fail(key, 'must be a non-blank string');
        }
        return value;
    };
    const expected = record['expectedRevision'];
    if (expected !== undefined &&
        (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0)) {
        throw fail('expectedRevision', 'must be a non-negative integer');
    }
    const source = record['source'] ?? 'host';
    if (!EVENT_SOURCES.includes(source)) {
        throw fail('source', `must be one of ${EVENT_SOURCES.join(', ')}`);
    }
    return {
        expectedRevision: expected ?? null,
        idempotencyKey: text('idempotencyKey'),
        source: source,
        causeId: text('causeId'),
        previewId: text('previewId'),
    };
}
/** Checks options passed from JavaScript, where the declared types are not enforced. */
function checkOptions(options) {
    const fail = (field, message) => new SwfFailure(makeError('INVALID_INPUT', `options.${field} ${message}`, { path: `options.${field}` }));
    const raw = options;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new SwfFailure(makeError('INVALID_INPUT', `workspace options must be an object (got ${describe(raw)})`));
    }
    const record = raw;
    for (const key of Object.keys(record)) {
        if (!OPTION_KEYS.includes(key)) {
            throw fail(key, `is not a known option (expected one of ${OPTION_KEYS.join(', ')})`);
        }
    }
    const id = record['id'];
    if (typeof id !== 'string' || id.trim() === '') {
        throw fail('id', 'must be a non-blank string');
    }
    const integer = (key, fallback, min, max) => {
        const value = record[key] ?? fallback;
        if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
            throw fail(key, `must be an integer from ${min} to ${max}`);
        }
        return value;
    };
    for (const key of ['now', 'timer', 'createId', 'onDiagnostic', 'frameBoundary']) {
        if (record[key] !== undefined && typeof record[key] !== 'function') {
            throw fail(key, 'must be a function');
        }
    }
    for (const key of ['constraints', 'geometry', 'projectionKinds']) {
        if (record[key] !== undefined && !Array.isArray(record[key])) {
            throw fail(key, 'must be an array');
        }
    }
    const limits = record['geometryLimits'] ?? {};
    if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) {
        throw fail('geometryLimits', 'must be an object');
    }
    const limitRecord = limits;
    for (const key of Object.keys(limitRecord)) {
        if (!Object.hasOwn(DEFAULT_GEOMETRY_LIMITS, key)) {
            throw fail(`geometryLimits.${key}`, 'is not a known limit');
        }
    }
    const limit = (key) => {
        const value = limitRecord[key] ?? DEFAULT_GEOMETRY_LIMITS[key];
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
            throw fail(`geometryLimits.${key}`, 'must be a positive integer');
        }
        return value;
    };
    return {
        id,
        undoCapacity: integer('undoCapacity', 100, 0, 10_000),
        idempotencyCapacity: integer('idempotencyCapacity', 1024, 1, Number.MAX_SAFE_INTEGER),
        diagnosticsCapacity: integer('diagnosticsCapacity', 100, 1, Number.MAX_SAFE_INTEGER),
        now: options.now ?? Date.now,
        timer: options.timer ?? options.now ?? Date.now,
        timerOption: options.timer === undefined ? 'now' : 'timer',
        createId: options.createId,
        constraints: options.constraints ?? [],
        geometry: options.geometry ?? [],
        projectionKinds: options.projectionKinds ?? [],
        geometryLimits: Object.freeze({
            maxParamsBytes: limit('maxParamsBytes'),
            maxPolygonVertices: limit('maxPolygonVertices'),
        }),
        onDiagnostic: options.onDiagnostic,
        frameBoundary: options.frameBoundary,
    };
}
/** The records with the given IDs (undefined where absent), for undo. */
function snapshotOf(table, ids) {
    return new Map(ids.map((id) => [id, table.get(id)]));
}
/**
 * A table holding exactly `records`, keeping each current record whose canonical form equals the
 * new one, so unchanged entities stay the same objects and report no change. Returns the IDs whose
 * record was added, removed or replaced.
 */
function replaceRecords(table, records, canonical) {
    const draft = Table.empty().edit();
    const changed = [];
    for (const record of records) {
        const current = table.get(record.id);
        const same = current !== undefined && JSON.stringify(canonical(current)) === JSON.stringify(record);
        draft.set(record.id, same ? current : record);
        if (!same) {
            changed.push(record.id);
        }
    }
    for (const id of table.ids()) {
        if (!draft.has(id)) {
            changed.push(id);
        }
    }
    return { table: changed.length === 0 ? table : draft.freeze(), changed: Object.freeze(changed) };
}
/** `table` with the recorded records put back (an undefined record is removed). */
function restoreRecords(table, records) {
    const draft = table.edit();
    for (const [id, value] of records) {
        if (value === undefined) {
            draft.delete(id);
        }
        else {
            draft.set(id, value);
        }
    }
    return draft.freeze();
}
function checkConstraint(constraint, workspaceId) {
    const fail = (message) => new SwfFailure(makeError('INVALID_INPUT', `constraint ${message}`, { workspaceId }));
    if (typeof constraint !== 'object' || constraint === null) {
        throw fail(`must be an object (got ${describe(constraint)})`);
    }
    const c = constraint;
    if (typeof c['id'] !== 'string' || c['id'].trim() === '') {
        throw fail('id must be a non-blank string');
    }
    if (typeof c['order'] !== 'number' || !Number.isFinite(c['order'])) {
        throw fail(`"${c['id']}" order must be a finite number`);
    }
    if (typeof c['required'] !== 'boolean') {
        throw fail(`"${c['id']}" required must be a boolean`);
    }
    if (typeof c['resolve'] !== 'function') {
        throw fail(`"${c['id']}" resolve must be a function`);
    }
    if (c['appliesTo'] !== undefined && typeof c['appliesTo'] !== 'function') {
        throw fail(`"${c['id']}" appliesTo must be a function`);
    }
}
function commandTypesOf(commands) {
    if (!Array.isArray(commands)) {
        return [];
    }
    return commands.flatMap((command) => {
        const type = typeof command === 'object' && command !== null
            ? command.type
            : undefined;
        return [...SCENE_COMMAND_TYPES, 'scene.restore'].filter((known) => known === type);
    });
}
/** A canonical rendering of a request, for recognizing a repeated idempotency key. */
function fingerprintOf(commands, options) {
    return JSON.stringify({
        commands,
        expectedRevision: options.expectedRevision,
        source: options.source,
        previewId: options.previewId,
    }, (_key, value) => typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : value);
}
//# sourceMappingURL=workspace.js.map