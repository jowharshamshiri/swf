import type { JsonValue, SceneSnapshot, SwfError, SwfErrorCode } from '@swf/core';
import {
  canonicalJson,
  jsonValue,
  makeError,
  SCENE_SNAPSHOT_FIELDS,
  SwfFailure,
  validateSceneSnapshot,
  VERSIONED_ID,
} from '@swf/core';
import schema from './schema/swf.workspace-2.schema.json' with { type: 'json' };
import { jsonSyntaxError } from './syntax.js';

/** The snapshot format this package reads and writes. */
export const SNAPSHOT_SCHEMA_ID = 'swf.workspace/2';

/** The engine that writes snapshots, as recorded in each one. */
export const SNAPSHOT_ENGINE = 'swf.persistence/1';

/**
 * The published JSON Schema of {@link SNAPSHOT_SCHEMA_ID} (draft 2020-12), deeply frozen; the same
 * as `@swf/persistence/schema/swf.workspace-2.schema.json`. {@link validateDocument} enforces
 * everything it says, and what a schema cannot: references that hold, unique IDs, a hierarchy
 * without cycles and the size limits.
 */
export const SNAPSHOT_SCHEMA: Readonly<Record<string, unknown>> = deepFreeze(
  schema as Record<string, unknown>,
);

/**
 * A workspace snapshot: the format's ID, the engine that wrote it and when, the scene, the
 * active policies' parameters and the extensions' opaque state. Fields come in a fixed order,
 * entities by ID and object keys sorted, so equal snapshots have identical JSON text.
 */
export interface WorkspaceDocument extends SceneSnapshot {
  /** The format: always {@link SNAPSHOT_SCHEMA_ID}. */
  readonly schema: typeof SNAPSHOT_SCHEMA_ID;
  /**
   * The engine that wrote the snapshot, as a versioned ID `<name>/<version>`;
   * {@link SNAPSHOT_ENGINE} for snapshots this package captures.
   */
  readonly engine: string;
  /** When the snapshot was taken, in milliseconds since the epoch: finite, at least 0. */
  readonly createdAt: number;
  /** Policy parameters, by the policy's versioned ID, as JSON data in canonical form. */
  readonly policies: Readonly<Record<string, JsonValue>>;
  /**
   * Extension state by namespace (`host.<name>` or `ext.<extension-id>`, see {@link NAMESPACE}),
   * with the version of the extension's own format.
   */
  readonly extensions: Readonly<Record<string, ExtensionEntry>>;
}

/** One extension's state in a snapshot: opaque to the framework, which only checks its size. */
export interface ExtensionEntry {
  /** The version of the extension's own payload format: a whole number of at least 1. */
  readonly version: number;
  /**
   * The state, as JSON data in canonical form; at most {@link SnapshotLimits.extensionBytes} of
   * canonical JSON text.
   */
  readonly data: JsonValue;
}

/** Size limits, in UTF-8 bytes, each a whole number of at least 1. */
export interface SnapshotLimits {
  /** A whole snapshot's JSON text. Default 32 MiB. */
  readonly maxBytes: number;
  /** One extension namespace's data. Default 1 MiB. */
  readonly extensionBytes: number;
  /** All extension data together. Default 10 MiB. */
  readonly extensionTotalBytes: number;
}

const MIB = 1024 * 1024;

/** The limits used where none are given: 32 MiB, 1 MiB per namespace, 10 MiB in all. Frozen. */
export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = Object.freeze({
  maxBytes: 32 * MIB,
  extensionBytes: MIB,
  extensionTotalBytes: 10 * MIB,
});

/**
 * What an extension namespace must match: `host.<name>` or `ext.<extension-id>`, with further
 * dot-separated parts, each of ASCII letters, digits, `_` and `-`.
 */
export const NAMESPACE = /^(?:host|ext)\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;

const DOCUMENT_FIELDS = [
  'schema',
  'engine',
  'createdAt',
  ...SCENE_SNAPSHOT_FIELDS,
  'policies',
  'extensions',
] as const;

/**
 * Checks limits a host supplies, filling the rest from {@link DEFAULT_SNAPSHOT_LIMITS}. A new
 * frozen object.
 *
 * @throws {@link @swf/core!SwfFailure} `INVALID_INPUT` naming `limits.<field>` for a field that
 *   is not a limit, or a value that is not a whole number of at least 1.
 */
export function snapshotLimits(limits: Partial<SnapshotLimits> = {}): SnapshotLimits {
  const out = { ...DEFAULT_SNAPSHOT_LIMITS };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(DEFAULT_SNAPSHOT_LIMITS, key)) {
      throw failure('INVALID_INPUT', `limits.${key} is not a limit`, `limits.${key}`);
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw failure(
        'INVALID_INPUT',
        `limits.${key} must be a whole number of bytes`,
        `limits.${key}`,
      );
    }
    out[key as keyof SnapshotLimits] = value;
  }
  return Object.freeze(out);
}

/**
 * Validates a snapshot and returns its canonical, deeply frozen copy; the input is never changed.
 * Nothing in a snapshot is ever run.
 *
 * @param value - The snapshot, as parsed JSON or a document; anything else is refused.
 * @param limits - The size limits its extension state is held to. Default
 *   {@link DEFAULT_SNAPSHOT_LIMITS}.
 * @throws {@link @swf/core!SwfFailure} `SNAPSHOT_INVALID` naming the first failing path: a format
 *   other than {@link SNAPSHOT_SCHEMA_ID} (with `details.sourceVersion`), a malformed, unknown,
 *   missing or non-finite field, a key that could reach an object's prototype, a cycle (in data
 *   or in the hierarchy), a broken reference, or an extension over its size limit
 *   (`details.bytes`, `details.limit`).
 */
export function validateDocument(
  value: unknown,
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): WorkspaceDocument {
  if (!isPlainObject(value)) {
    throw invalidSnapshot('the snapshot must be a plain object', undefined);
  }
  const unknown = Object.keys(value).find(
    (key) => !(DOCUMENT_FIELDS as readonly string[]).includes(key),
  );
  if (unknown !== undefined) {
    throw invalidSnapshot(`${unknown} is not a known field`, unknown);
  }
  const missing = DOCUMENT_FIELDS.find((field) => !Object.hasOwn(value, field));
  if (missing !== undefined) {
    throw invalidSnapshot(`${missing} is missing`, missing);
  }
  if (value['schema'] !== SNAPSHOT_SCHEMA_ID) {
    throw invalidSnapshot(
      `schema ${JSON.stringify(value['schema'])} is not supported; this engine reads "${SNAPSHOT_SCHEMA_ID}"`,
      'schema',
      { sourceVersion: typeof value['schema'] === 'string' ? value['schema'] : null },
    );
  }
  const engine = value['engine'];
  if (typeof engine !== 'string' || !VERSIONED_ID.test(engine)) {
    throw invalidSnapshot('engine must be a versioned ID "<name>/<version>"', 'engine');
  }
  const createdAt = value['createdAt'];
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) {
    throw invalidSnapshot('createdAt must be a finite time of at least 0', 'createdAt');
  }
  const scene = validateSceneSnapshot(
    Object.fromEntries(SCENE_SNAPSHOT_FIELDS.map((field) => [field, value[field]])),
  );
  return deepFreeze({
    schema: SNAPSHOT_SCHEMA_ID,
    engine,
    createdAt,
    ...scene,
    policies: checkPolicies(value['policies']),
    extensions: checkExtensions(value['extensions'], limits),
  });
}

/**
 * Reads a snapshot from its JSON text: checks its size before parsing, then validates it as
 * {@link validateDocument} does. It reads only the current format; {@link migrateDocument} brings
 * older ones forward.
 *
 * @throws {@link @swf/core!SwfFailure} `SNAPSHOT_INVALID`, as {@link parseJson} and
 *   {@link validateDocument} do.
 */
export function parseDocument(
  text: unknown,
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): WorkspaceDocument {
  return validateDocument(parseJson(text, limits), limits);
}

/**
 * JSON text read safely: its UTF-8 size is checked against `limits.maxBytes` before it is parsed.
 * The value is parsed only, not validated.
 *
 * @throws {@link @swf/core!SwfFailure} `SNAPSHOT_INVALID` for a value that is not a string, text
 *   over the limit (`details.bytes`, `details.limit`), or text that is not JSON, saying where it
 *   breaks and what was expected there (`details.line`, `details.column`, `details.offset`;
 *   see {@link jsonSyntaxError}).
 */
export function parseJson(
  text: unknown,
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): unknown {
  if (typeof text !== 'string') {
    throw invalidSnapshot('a snapshot must be JSON text', undefined);
  }
  const bytes = utf8Length(text);
  if (bytes > limits.maxBytes) {
    throw invalidSnapshot(
      `the snapshot is ${String(bytes)} bytes, over the limit of ${String(limits.maxBytes)}`,
      undefined,
      { bytes, limit: limits.maxBytes },
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    // Engines say where differently, or not at all: the line and column are found the same way
    // everywhere.
    const where = jsonSyntaxError(text);
    if (where === null) {
      throw invalidSnapshot(
        `the snapshot is not JSON: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
      );
    }
    throw invalidSnapshot(
      `the snapshot is not JSON: at line ${String(where.line)}, column ${String(where.column)}, ${where.expected} was expected`,
      undefined,
      { line: where.line, column: where.column, offset: where.offset },
    );
  }
}

/**
 * The snapshot's canonical JSON text, UTF-8 ready, without indentation: equal snapshots give
 * identical text. It is validated first, so only a valid snapshot is ever written.
 *
 * @throws {@link @swf/core!SwfFailure} `SNAPSHOT_INVALID` for an invalid snapshot, as
 *   {@link validateDocument} says; `QUOTA_EXCEEDED` when its text is over `limits.maxBytes`
 *   (`details.bytes`, `details.limit`).
 */
export function exportDocument(
  document: WorkspaceDocument,
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): string {
  const text = JSON.stringify(validateDocument(document, limits));
  const bytes = utf8Length(text);
  if (bytes > limits.maxBytes) {
    throw failure(
      'QUOTA_EXCEEDED',
      `the snapshot is ${String(bytes)} bytes, over the limit of ${String(limits.maxBytes)}`,
      undefined,
      { bytes, limit: limits.maxBytes },
    );
  }
  return text;
}

/**
 * The size of a string encoded as UTF-8, in bytes, without encoding it. A lone surrogate counts as
 * the three bytes of the replacement character it is encoded as.
 */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** The UTF-8 size of a JSON value's canonical text. */
export function jsonBytes(value: JsonValue): number {
  return utf8Length(JSON.stringify(canonicalJson(value)));
}

function checkPolicies(value: unknown): Readonly<Record<string, JsonValue>> {
  if (!isPlainObject(value)) {
    throw invalidSnapshot('policies must be a plain object', 'policies');
  }
  const out: Record<string, JsonValue> = {};
  for (const id of Object.keys(value).sort()) {
    const path = `policies.${id}`;
    if (!VERSIONED_ID.test(id)) {
      throw invalidSnapshot(
        `${path}: a policy is named by a versioned ID "<name>/<version>"`,
        path,
      );
    }
    Object.defineProperty(out, id, { value: asJson(value[id], path), enumerable: true });
  }
  return out;
}

function checkExtensions(
  value: unknown,
  limits: SnapshotLimits,
): Readonly<Record<string, ExtensionEntry>> {
  if (!isPlainObject(value)) {
    throw invalidSnapshot('extensions must be a plain object', 'extensions');
  }
  const out: Record<string, ExtensionEntry> = {};
  let total = 0;
  for (const namespace of Object.keys(value).sort()) {
    const path = `extensions.${namespace}`;
    if (!NAMESPACE.test(namespace)) {
      throw invalidSnapshot(`${path}: a namespace is "host.<name>" or "ext.<extension-id>"`, path);
    }
    const entry = value[namespace];
    if (!isPlainObject(entry)) {
      throw invalidSnapshot(`${path} must be a plain object`, path);
    }
    const extra = Object.keys(entry).find((key) => key !== 'version' && key !== 'data');
    if (extra !== undefined) {
      throw invalidSnapshot(`${path}.${extra} is not a known field`, `${path}.${extra}`);
    }
    const version = entry['version'];
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
      throw invalidSnapshot(
        `${path}.version must be a whole number of at least 1`,
        `${path}.version`,
      );
    }
    if (!Object.hasOwn(entry, 'data')) {
      throw invalidSnapshot(`${path}.data is missing`, `${path}.data`);
    }
    const data = asJson(entry['data'], `${path}.data`);
    const bytes = jsonBytes(data);
    if (bytes > limits.extensionBytes) {
      throw invalidSnapshot(
        `${path}.data is ${String(bytes)} bytes, over the limit of ${String(limits.extensionBytes)} per namespace`,
        `${path}.data`,
        { bytes, limit: limits.extensionBytes },
      );
    }
    total += bytes;
    if (total > limits.extensionTotalBytes) {
      throw invalidSnapshot(
        `${path}.data brings the extensions to ${String(total)} bytes, over the limit of ${String(limits.extensionTotalBytes)} in all`,
        `${path}.data`,
        { bytes: total, limit: limits.extensionTotalBytes },
      );
    }
    Object.defineProperty(out, namespace, {
      value: { version, data },
      enumerable: true,
    });
  }
  return out;
}

/** A canonical copy of JSON data, or `SNAPSHOT_INVALID` naming the path. */
function asJson(value: unknown, path: string): JsonValue {
  try {
    return canonicalJson(jsonValue(value, path));
  } catch (error) {
    if (error instanceof SwfFailure) {
      throw invalidSnapshot(error.message, error.error.path ?? path);
    }
    throw error;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function invalidSnapshot(
  message: string,
  path: string | undefined,
  details?: Readonly<Record<string, unknown>>,
): SwfFailure {
  return failure('SNAPSHOT_INVALID', message, path, details);
}

export function failure(
  code: SwfErrorCode,
  message: string,
  path?: string,
  details?: Readonly<Record<string, unknown>>,
): SwfFailure {
  return new SwfFailure(errorOf(code, message, path, details));
}

export function errorOf(
  code: SwfErrorCode,
  message: string,
  path?: string,
  details?: Readonly<Record<string, unknown>>,
): SwfError {
  return makeError(code, message, {
    ...(path === undefined ? {} : { path }),
    ...(details === undefined ? {} : { details }),
  });
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}
