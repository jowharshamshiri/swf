/** Stable error codes. Callers branch on the code; the message is safe to show an operator. */
export type SwfErrorCode = 
/**
 * The input is malformed or refused by a rule: a wrong type, an unknown field, a non-finite
 * number, an ID already in use, a hierarchy cycle. `path` names the failing field.
 */
'INVALID_INPUT'
/** The input names a node, surface, camera or viewport the workspace does not have. */
 | 'UNKNOWN_ENTITY'
/**
 * The scene is not at the revision the operation expected, or an undo or redo would overwrite a
 * later change. Retryable: read the current state and try again.
 */
 | 'CONFLICT'
/** An operator (`user`) change that a locked entity refuses: see {@link EntityFlags.locked}. */
 | 'LOCKED'
/** A required constraint refused a proposed placement; `details.constraintId` names it. */
 | 'CONSTRAINT_REJECTED'
/** No adapter is registered for the adapter type a surface names. */
 | 'ADAPTER_UNAVAILABLE'
/** The renderer, compositor or browser cannot do what was asked of it. */
 | 'UNSUPPORTED_CAPABILITY'
/** An adapter could not resolve, attach or detach a surface's endpoint. */
 | 'BIND_FAILED'
/** A viewport could not change to the renderer and compositor chosen for it. */
 | 'BACKEND_SWITCH_FAILED'
/** An extension's persistence hook threw, timed out or returned what cannot be stored. */
 | 'EXTENSION_FAILED'
/** A size limit was reached: a snapshot, an extension's state or a store's capacity. */
 | 'QUOTA_EXCEEDED'
/** A store could not load, save or delete; what it held before is unchanged. */
 | 'STORAGE_FAILED'
/** A scene snapshot is malformed, inconsistent or names kinds the workspace does not have. */
 | 'SNAPSHOT_INVALID'
/** A stored document could not be migrated to the current format. */
 | 'MIGRATION_FAILED'
/** The operation was abandoned before it finished, because what it worked on changed or ended. */
 | 'CANCELLED'
/** An operation that the entity's current lifecycle state does not allow. */
 | 'INVALID_TRANSITION'
/** The workspace is disposing or disposed and admits no further operation. */
 | 'WORKSPACE_DISPOSED';
/**
 * The error envelope every framework failure is reported in. It is frozen when made by
 * {@link makeError}, so it can be passed on and kept without copying.
 */
export interface SwfError {
    /** What kind of failure it is; callers branch on this, never on `message`. */
    readonly code: SwfErrorCode;
    /** A human-readable explanation, safe to show an operator. Its wording is not stable. */
    readonly message: string;
    /** The workspace the failure belongs to, when it belongs to one. */
    readonly workspaceId?: string;
    /** The node, surface or viewport the failure concerns. */
    readonly entityId?: string;
    /** Where in the input the failure is, such as `commands[2].node.transform.rotation`. */
    readonly path?: string;
    /** The transaction or operation the failure belongs to. */
    readonly causeId?: string;
    /** Whether repeating the same operation can succeed without changing it (after a refresh). */
    readonly retryable: boolean;
    /**
     * Further facts about the failure, by code: `constraintId` for `CONSTRAINT_REJECTED`,
     * `currentRevision` for a `CONFLICT`. Absent when there are none.
     */
    readonly details?: Readonly<Record<string, unknown>>;
}
/** Thrown by operations that cannot report through a result, such as invalid workspace options. */
export declare class SwfFailure extends Error {
    /** The failure, as the envelope a result would have carried. */
    readonly error: SwfError;
    /** Wraps `error`; the exception's message is the error's message. */
    constructor(error: SwfError);
}
/**
 * Raised while a transaction is applied; the transaction catches it and reports it as its
 * rejection. It never escapes the kernel.
 */
export declare class RejectionSignal extends Error {
    readonly code: SwfErrorCode;
    readonly path: string | undefined;
    readonly entityId: string | undefined;
    readonly details: Readonly<Record<string, unknown>> | undefined;
    constructor(code: SwfErrorCode, message: string, where?: {
        path?: string;
        entityId?: string;
        details?: Readonly<Record<string, unknown>>;
    });
}
/**
 * Builds a frozen {@link SwfError}. The fields are copied shallowly: `details` is kept as given,
 * so pass a value no one changes afterwards.
 *
 * @param fields - The optional fields of the envelope. `retryable` defaults to true for
 *   `CONFLICT` and false for every other code.
 */
export declare function makeError(code: SwfErrorCode, message: string, fields?: Omit<SwfError, 'code' | 'message' | 'retryable'> & {
    retryable?: boolean;
}): SwfError;
/** What a host callback threw, as text for a rejection's message: an error's message, or the value. */
export declare function thrownText(error: unknown): string;
//# sourceMappingURL=errors.d.ts.map