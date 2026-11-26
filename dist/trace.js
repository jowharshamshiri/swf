import { canonicalJson, makeError, SwfFailure } from '@swf/core';
/** Nothing beyond identifiers, numbers and error codes: the default of every export. Frozen. */
export const PRIVATE_DISCLOSURE = Object.freeze({
    labels: false,
    bindingKeys: false,
    hostData: false,
    messages: false,
    timings: false,
});
/**
 * Starts tracing a workspace's transactions from now on. The caller owns the returned
 * {@link OperationTrace} and disposes it to stop listening.
 *
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` (naming `capacity`) when `capacity` is
 *   not a whole number of at least 1.
 */
export function createOperationTrace(options) {
    const capacity = options.capacity ?? 1000;
    if (!Number.isInteger(capacity) || capacity < 1) {
        throw new SwfFailure(makeError('INVALID_INPUT', 'capacity must be a whole number of at least 1', {
            path: 'capacity',
        }));
    }
    const entries = [];
    let seq = 0;
    let dropped = 0;
    const keep = (entry) => {
        seq += 1;
        entries.push(Object.freeze({ seq, ...entry }));
        if (entries.length > capacity) {
            entries.shift();
            dropped += 1;
        }
    };
    let unsubscribe = options.workspace.subscribe((event) => {
        if (event.type === 'transaction.committed') {
            const p = event.payload;
            keep({
                transactionId: p.transactionId,
                outcome: 'committed',
                source: event.source,
                causeId: event.causationId === p.transactionId ? null : event.causationId,
                revision: event.revision,
                previousRevision: p.previousRevision,
                commandTypes: p.commandTypes,
                commands: p.commands === null ? null : copyCommands(p.commands),
                history: p.history,
                changedNodeIds: p.changedNodeIds,
                changedSurfaceIds: p.changedSurfaceIds,
                error: null,
                timestamp: event.timestamp,
                durationMs: p.durationMs,
            });
        }
        else if (event.type === 'transaction.rejected') {
            const p = event.payload;
            keep({
                transactionId: p.transactionId,
                outcome: 'rejected',
                source: event.source,
                causeId: event.causationId === p.transactionId ? null : event.causationId,
                revision: event.revision,
                previousRevision: event.revision,
                commandTypes: p.commandTypes,
                commands: null,
                history: null,
                changedNodeIds: [],
                changedSurfaceIds: [],
                error: Object.freeze({
                    code: p.error.code,
                    path: p.error.path ?? null,
                    message: p.error.message,
                }),
                timestamp: event.timestamp,
                durationMs: p.durationMs,
            });
        }
    });
    return Object.freeze({
        entries: () => Object.freeze([...entries]),
        dropped: () => dropped,
        serialize(disclosure = {}) {
            const open = disclosureOf(disclosure);
            const redact = redactor(open);
            const body = {
                trace: 'swf.operation-trace/1',
                workspaceId: options.workspace.id,
                dropped,
                disclosed: open,
                entries: entries.map((e) => ({
                    seq: e.seq,
                    transactionId: e.transactionId,
                    outcome: e.outcome,
                    source: e.source,
                    causeId: e.causeId,
                    revision: e.revision,
                    previousRevision: e.previousRevision,
                    commandTypes: [...e.commandTypes],
                    commands: e.commands === null ? null : redact(e.commands),
                    history: e.history === null ? null : { ...e.history },
                    changedNodeIds: [...e.changedNodeIds],
                    changedSurfaceIds: [...e.changedSurfaceIds],
                    error: e.error === null
                        ? null
                        : {
                            code: e.error.code,
                            path: e.error.path,
                            ...(open.messages ? { message: e.error.message } : {}),
                        },
                    ...(open.timings ? { timestamp: e.timestamp, durationMs: e.durationMs } : {}),
                })),
            };
            return JSON.stringify(canonicalJson(body), null, 2);
        },
        clear() {
            entries.length = 0;
            dropped = 0;
        },
        dispose() {
            unsubscribe?.();
            unsubscribe = null;
        },
    });
}
/**
 * A complete disclosure from a partial one, with everything not named left private. A new frozen
 * object.
 *
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` for a value that is not an object, or a
 *   field that is not one of {@link Disclosure}'s or not a boolean (naming `disclosure.<field>`).
 */
export function disclosureOf(disclosure) {
    const raw = disclosure;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new SwfFailure(makeError('INVALID_INPUT', 'a disclosure must be an object'));
    }
    for (const [key, value] of Object.entries(disclosure)) {
        if (!Object.hasOwn(PRIVATE_DISCLOSURE, key)) {
            throw new SwfFailure(makeError('INVALID_INPUT', `disclosure.${key} is not something an export can disclose; it can disclose ${Object.keys(PRIVATE_DISCLOSURE).join(', ')}`, { path: `disclosure.${key}` }));
        }
        if (typeof value !== 'boolean') {
            throw new SwfFailure(makeError('INVALID_INPUT', `disclosure.${key} must be true or false`, {
                path: `disclosure.${key}`,
            }));
        }
    }
    return Object.freeze({ ...PRIVATE_DISCLOSURE, ...disclosure });
}
/**
 * A function that copies JSON data with what is not disclosed taken out. Fields are found by name
 * at any depth: a string `label` becomes `"[label]"` (a null one stays null), a string
 * `bindingKey` a token, and any `tags` or `metadata` that is not null `"[host data]"`; what the
 * disclosure allows, and everything else, is copied unchanged. The input is never changed.
 *
 * Binding keys become tokens (`binding-1`, `binding-2`, …), numbered in the order they are first
 * met by this redactor, so one key keeps one token across every value it copies. Each redactor
 * numbers its own tokens.
 *
 * @param disclosure - A complete disclosure, such as {@link disclosureOf} gives; it is not
 *   checked.
 */
export function redactor(disclosure) {
    const tokens = new Map();
    const walk = (value, key) => {
        if (key === 'label' && !disclosure.labels && typeof value === 'string') {
            return '[label]';
        }
        if (key === 'bindingKey' && !disclosure.bindingKeys && typeof value === 'string') {
            let token = tokens.get(value);
            if (token === undefined) {
                token = `binding-${String(tokens.size + 1)}`;
                tokens.set(value, token);
            }
            return token;
        }
        if ((key === 'tags' || key === 'metadata') && !disclosure.hostData && value !== null) {
            return '[host data]';
        }
        if (Array.isArray(value)) {
            return value.map((item) => walk(item, null));
        }
        if (typeof value === 'object' && value !== null) {
            const out = {};
            for (const [k, v] of Object.entries(value)) {
                out[k] = walk(v, k);
            }
            return out;
        }
        return value;
    };
    return (value) => walk(value, null);
}
/**
 * A JSON copy of committed commands, taken as they are announced: the caller's objects may change
 * later. Values JSON cannot hold (an omitted optional field given as undefined) are left out.
 */
function copyCommands(commands) {
    return JSON.parse(JSON.stringify(commands));
}
//# sourceMappingURL=trace.js.map