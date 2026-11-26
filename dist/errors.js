/** Thrown by operations that cannot report through a result, such as invalid workspace options. */
export class SwfFailure extends Error {
    /** The failure, as the envelope a result would have carried. */
    error;
    /** Wraps `error`; the exception's message is the error's message. */
    constructor(error) {
        super(error.message);
        this.name = 'SwfFailure';
        this.error = error;
    }
}
/**
 * Raised while a transaction is applied; the transaction catches it and reports it as its
 * rejection. It never escapes the kernel.
 */
export class RejectionSignal extends Error {
    code;
    path;
    entityId;
    details;
    constructor(code, message, where = {}) {
        super(message);
        this.name = 'RejectionSignal';
        this.code = code;
        this.path = where.path;
        this.entityId = where.entityId;
        this.details = where.details;
    }
}
/**
 * Builds a frozen {@link SwfError}. The fields are copied shallowly: `details` is kept as given,
 * so pass a value no one changes afterwards.
 *
 * @param fields - The optional fields of the envelope. `retryable` defaults to true for
 *   `CONFLICT` and false for every other code.
 */
export function makeError(code, message, fields = {}) {
    const error = {
        ...fields,
        code,
        message,
        retryable: fields.retryable ?? code === 'CONFLICT',
    };
    return Object.freeze(error);
}
/** What a host callback threw, as text for a rejection's message: an error's message, or the value. */
export function thrownText(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=errors.js.map