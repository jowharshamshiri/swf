/** Stable error codes. Callers branch on the code; the message is safe to show an operator. */
export type SwfErrorCode =
  | 'INVALID_INPUT'
  | 'UNKNOWN_ENTITY'
  | 'CONFLICT'
  | 'LOCKED'
  | 'CONSTRAINT_REJECTED'
  | 'ADAPTER_UNAVAILABLE'
  | 'UNSUPPORTED_CAPABILITY'
  | 'BIND_FAILED'
  | 'BACKEND_SWITCH_FAILED'
  | 'SNAPSHOT_INVALID'
  | 'MIGRATION_FAILED'
  | 'CANCELLED'
  | 'WORKSPACE_DISPOSED';

/** The error envelope every framework failure is reported in. */
export interface SwfError {
  readonly code: SwfErrorCode;
  readonly message: string;
  readonly workspaceId?: string;
  /** The node, surface or viewport the failure concerns. */
  readonly entityId?: string;
  /** Where in the input the failure is, such as `commands[2].node.transform.rotation`. */
  readonly path?: string;
  /** The transaction or operation the failure belongs to. */
  readonly causeId?: string;
  /** Whether repeating the same operation can succeed without changing it (after a refresh). */
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Thrown by operations that cannot report through a result, such as invalid workspace options. */
export class SwfFailure extends Error {
  readonly error: SwfError;

  constructor(error: SwfError) {
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
  readonly code: SwfErrorCode;
  readonly path: string | undefined;
  readonly entityId: string | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: SwfErrorCode,
    message: string,
    where: { path?: string; entityId?: string; details?: Readonly<Record<string, unknown>> } = {},
  ) {
    super(message);
    this.name = 'RejectionSignal';
    this.code = code;
    this.path = where.path;
    this.entityId = where.entityId;
    this.details = where.details;
  }
}

export function makeError(
  code: SwfErrorCode,
  message: string,
  fields: Omit<SwfError, 'code' | 'message' | 'retryable'> & { retryable?: boolean } = {},
): SwfError {
  const error: SwfError = {
    ...fields,
    code,
    message,
    retryable: fields.retryable ?? code === 'CONFLICT',
  };
  return Object.freeze(error);
}
