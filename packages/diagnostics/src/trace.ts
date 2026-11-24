import type {
  EventSource,
  Id,
  JsonValue,
  OperationType,
  SwfErrorCode,
  WorkspaceEvent,
  WorkspaceReader,
} from '@swf/core';
import { canonicalJson, makeError, SwfFailure } from '@swf/core';

/**
 * What an export may say besides identifiers, numbers and error codes. Each is off unless the
 * operator chooses it (PRIV-003): labels, binding keys, and the host's data (tags and namespaced
 * metadata); error messages, which can quote any of them; and timings, which differ from run to
 * run and so make two traces of the same operations differ.
 */
export interface Disclosure {
  readonly labels: boolean;
  readonly bindingKeys: boolean;
  readonly hostData: boolean;
  readonly messages: boolean;
  readonly timings: boolean;
}

/** Nothing beyond identifiers, numbers and error codes: the default of every export. */
export const PRIVATE_DISCLOSURE: Disclosure = Object.freeze({
  labels: false,
  bindingKeys: false,
  hostData: false,
  messages: false,
  timings: false,
});

/** One transaction as the trace keeps it. */
export interface TraceEntry {
  /** The entry's place in the trace, from 1. */
  readonly seq: number;
  readonly transactionId: string;
  readonly outcome: 'committed' | 'rejected';
  readonly source: EventSource;
  readonly causeId: string | null;
  /** The revision it committed, or the unchanged one it was refused at. */
  readonly revision: number;
  readonly previousRevision: number;
  readonly commandTypes: readonly OperationType[];
  /** The commands as they were committed: null for a refusal, an undo, a redo or a restore. */
  readonly commands: JsonValue | null;
  /** For an undo or redo: which, and the transaction it reverses or repeats. */
  readonly history: { readonly action: 'undo' | 'redo'; readonly transactionId: string } | null;
  readonly changedNodeIds: readonly Id[];
  readonly changedSurfaceIds: readonly Id[];
  readonly error: {
    readonly code: SwfErrorCode;
    readonly path: string | null;
    readonly message: string;
  } | null;
  readonly timestamp: number;
  readonly durationMs: number;
}

export interface OperationTraceOptions {
  readonly workspace: WorkspaceReader;
  /** How many entries are kept, the newest: at least 1. Default 1000. */
  readonly capacity?: number;
}

/**
 * A workspace's operations in the order they happened, every transaction committed or refused,
 * kept to reproduce interaction bugs (AUD-002). It reads the workspace's events and changes
 * nothing.
 */
export interface OperationTrace {
  entries(): readonly TraceEntry[];
  /** Entries dropped because the trace was full. */
  dropped(): number;
  /**
   * The trace as canonical JSON text: the same operations give the same text. Labels, binding
   * keys, the host's data, error messages and timings are left out unless disclosed: a label
   * becomes `"[label]"`, a binding key a token standing for it (`"binding-1"`, the same key the
   * same token throughout), tags and metadata `"[host data]"`.
   */
  serialize(disclosure?: Partial<Disclosure>): string;
  /** Forgets every entry. */
  clear(): void;
  /** Stops listening. Safe to call twice. */
  dispose(): void;
}

/** Starts tracing. Throws {@link SwfFailure} (`INVALID_INPUT`) for invalid options. */
export function createOperationTrace(options: OperationTraceOptions): OperationTrace {
  const capacity = options.capacity ?? 1000;
  if (!Number.isInteger(capacity) || capacity < 1) {
    throw new SwfFailure(
      makeError('INVALID_INPUT', 'capacity must be a whole number of at least 1', {
        path: 'capacity',
      }),
    );
  }
  const entries: TraceEntry[] = [];
  let seq = 0;
  let dropped = 0;
  const keep = (entry: Omit<TraceEntry, 'seq'>) => {
    seq += 1;
    entries.push(Object.freeze({ seq, ...entry }));
    if (entries.length > capacity) {
      entries.shift();
      dropped += 1;
    }
  };
  let unsubscribe: (() => void) | null = options.workspace.subscribe((event: WorkspaceEvent) => {
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
    } else if (event.type === 'transaction.rejected') {
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
    serialize(disclosure: Partial<Disclosure> = {}) {
      const open = disclosureOf(disclosure);
      const redact = redactor(open);
      const body = {
        trace: 'swf.operation-trace/1',
        workspaceId: options.workspace.id,
        dropped,
        disclosed: open as unknown as JsonValue,
        entries: entries.map((e): JsonValue => ({
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
          error:
            e.error === null
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

/** A disclosure with everything not named left private; throws for a field that is not one. */
export function disclosureOf(disclosure: Partial<Disclosure>): Disclosure {
  const raw: unknown = disclosure;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SwfFailure(makeError('INVALID_INPUT', 'a disclosure must be an object'));
  }
  for (const [key, value] of Object.entries(disclosure)) {
    if (!(key in PRIVATE_DISCLOSURE)) {
      throw new SwfFailure(
        makeError(
          'INVALID_INPUT',
          `disclosure.${key} is not something an export can disclose; it can disclose ${Object.keys(PRIVATE_DISCLOSURE).join(', ')}`,
          { path: `disclosure.${key}` },
        ),
      );
    }
    if (typeof value !== 'boolean') {
      throw new SwfFailure(
        makeError('INVALID_INPUT', `disclosure.${key} must be true or false`, {
          path: `disclosure.${key}`,
        }),
      );
    }
  }
  return Object.freeze({ ...PRIVATE_DISCLOSURE, ...disclosure });
}

/**
 * A function that copies JSON data with what is not disclosed taken out: every `label` (a
 * string or null), every `bindingKey`, every `tags` and `metadata`. Binding keys become tokens,
 * numbered in the order they are first met by this redactor, so one key keeps one token.
 */
export function redactor(disclosure: Disclosure): (value: JsonValue) => JsonValue {
  const tokens = new Map<string, string>();
  const walk = (value: JsonValue, key: string | null): JsonValue => {
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
      return (value as readonly JsonValue[]).map((item) => walk(item, null));
    }
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, JsonValue> = {};
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
function copyCommands(commands: readonly unknown[]): JsonValue {
  return JSON.parse(JSON.stringify(commands)) as JsonValue;
}
