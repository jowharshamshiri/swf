import type { EventSource, Id, JsonValue, OperationType, SwfErrorCode, WorkspaceReader } from '@swf/core';
/**
 * What an export may say besides identifiers, numbers and error codes. Each is off unless the
 * operator chooses it (PRIV-003): labels, binding keys, and the host's data (tags and namespaced
 * metadata); error messages, which can quote any of them; and timings, which differ from run to
 * run and so make two traces of the same operations differ.
 */
export interface Disclosure {
    /** Node and surface labels; withheld, a label becomes `"[label]"`. */
    readonly labels: boolean;
    /**
     * Surface binding keys; withheld, each key becomes a token (`binding-1`, `binding-2`, …), one
     * per key within a serialization.
     */
    readonly bindingKeys: boolean;
    /** Node tags and namespaced metadata; withheld, each becomes `"[host data]"`. */
    readonly hostData: boolean;
    /** Error messages, which can quote any of the above; withheld, only codes and paths remain. */
    readonly messages: boolean;
    /** A trace's timestamps and durations; withheld, two traces of the same operations are equal. */
    readonly timings: boolean;
}
/** Nothing beyond identifiers, numbers and error codes: the default of every export. Frozen. */
export declare const PRIVATE_DISCLOSURE: Disclosure;
/**
 * One transaction as the trace keeps it. The entry is frozen; its `commands` are the trace's own
 * copy, which a reader must not change.
 */
export interface TraceEntry {
    /**
     * The entry's place in the trace, from 1. It keeps counting across {@link OperationTrace.clear}
     * and dropped entries, so a gap shows entries are missing.
     */
    readonly seq: number;
    /** The transaction, undo, redo or restore, unique within the workspace. */
    readonly transactionId: string;
    /** Whether it committed or was refused. */
    readonly outcome: 'committed' | 'rejected';
    /** Who originated it. */
    readonly source: EventSource;
    /** The operation that caused it, or null when it was its own cause. */
    readonly causeId: string | null;
    /** The revision it committed, or the unchanged one it was refused at. */
    readonly revision: number;
    /** The revision before it; for a refusal, the same as `revision`. */
    readonly previousRevision: number;
    /**
     * The operations it held, in order: for an undo or redo, those of the transaction reversed or
     * repeated; for a refusal, the recognised ones among the commands given.
     */
    readonly commandTypes: readonly OperationType[];
    /**
     * The commands as they were committed, a JSON copy taken when they were announced: null for a
     * refusal, an undo, a redo or a restore.
     */
    readonly commands: JsonValue | null;
    /** For an undo or redo: which, and the transaction it reverses or repeats; otherwise null. */
    readonly history: {
        /** Which way the history moved. */
        readonly action: 'undo' | 'redo';
        /** The transaction undone or redone. */
        readonly transactionId: string;
    } | null;
    /** Nodes it created, changed or removed, in the order first touched: none for a refusal. */
    readonly changedNodeIds: readonly Id[];
    /** Surfaces it created, changed or removed, in the order first touched: none for a refusal. */
    readonly changedSurfaceIds: readonly Id[];
    /** Why it was refused; null when it committed. */
    readonly error: {
        /** The refusal's error code. */
        readonly code: SwfErrorCode;
        /** The failing field, or null when the error names none. */
        readonly path: string | null;
        /** The error's message; serialized only when messages are disclosed. */
        readonly message: string;
    } | null;
    /**
     * When the workspace announced it, in milliseconds by the workspace's clock; serialized only
     * when timings are disclosed.
     */
    readonly timestamp: number;
    /**
     * How long it took, in milliseconds by the workspace's timer; serialized only when timings are
     * disclosed.
     */
    readonly durationMs: number;
}
/** What an operation trace follows, and how much of it it keeps. */
export interface OperationTraceOptions {
    /**
     * The workspace traced. The trace subscribes to its events and never changes it; only
     * operations from now on are traced.
     */
    readonly workspace: WorkspaceReader;
    /**
     * How many entries are kept, the newest: a whole number from 1. Default 1000. The oldest entry
     * is dropped, and counted in {@link OperationTrace.dropped}, when one more would not fit.
     */
    readonly capacity?: number;
}
/**
 * A workspace's operations in the order they happened, every transaction committed or refused,
 * kept to reproduce interaction bugs (AUD-002). It reads the workspace's events and changes
 * nothing. The caller owns it and calls {@link OperationTrace.dispose} when done.
 */
export interface OperationTrace {
    /** The entries kept, oldest first. A new frozen array on every call; the entries are frozen. */
    entries(): readonly TraceEntry[];
    /** Entries dropped because the trace was full, since it began or was last cleared. */
    dropped(): number;
    /**
     * The trace as canonical JSON text: the same operations give the same text. Labels, binding
     * keys, the host's data, error messages and timings are left out unless disclosed: a label
     * becomes `"[label]"`, a binding key a token standing for it (`"binding-1"`, the same key the
     * same token throughout), tags and metadata `"[host data]"`. Error messages are left out, and
     * timestamps and durations too, so the text of the same operations is the same on every run.
     * The format is `swf.operation-trace/1`, keys sorted and indented by two spaces.
     *
     * @param disclosure - What to disclose; fields left out stay private. Default: nothing.
     * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` for a disclosure that is not an object,
     *   or a field that is not one of {@link Disclosure}'s or not a boolean (naming
     *   `disclosure.<field>`).
     */
    serialize(disclosure?: Partial<Disclosure>): string;
    /** Forgets every entry and resets the dropped count; entry numbers keep counting. */
    clear(): void;
    /**
     * Stops listening to the workspace; the entries kept stay readable and serializable. Safe to
     * call twice.
     */
    dispose(): void;
}
/**
 * Starts tracing a workspace's transactions from now on. The caller owns the returned
 * {@link OperationTrace} and disposes it to stop listening.
 *
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` (naming `capacity`) when `capacity` is
 *   not a whole number of at least 1.
 */
export declare function createOperationTrace(options: OperationTraceOptions): OperationTrace;
/**
 * A complete disclosure from a partial one, with everything not named left private. A new frozen
 * object.
 *
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` for a value that is not an object, or a
 *   field that is not one of {@link Disclosure}'s or not a boolean (naming `disclosure.<field>`).
 */
export declare function disclosureOf(disclosure: Partial<Disclosure>): Disclosure;
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
export declare function redactor(disclosure: Disclosure): (value: JsonValue) => JsonValue;
//# sourceMappingURL=trace.d.ts.map