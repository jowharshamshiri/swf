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
import schema from './schema/swf.workspace-1.schema.json' with { type: 'json' };

/** The snapshot format this package reads and writes. */
export const SNAPSHOT_SCHEMA_ID = 'swf.workspace/1';

/** The engine that writes snapshots, as recorded in each one. */
export const SNAPSHOT_ENGINE = 'swf.persistence/1';

/** The published JSON Schema of {@link SNAPSHOT_SCHEMA_ID} (draft 2020-12). */
export const SNAPSHOT_SCHEMA: Readonly<Record<string, unknown>> = deepFreeze(
  schema as Record<string, unknown>,
);

/**
 * A workspace snapshot: the format's ID, the engine that wrote it and when, the scene, the
 * active policies' parameters and the extensions' opaque state. Fields come in a fixed order,
 * entities by ID and object keys sorted, so equal snapshots have identical JSON text.
 */
export interface WorkspaceDocument extends SceneSnapshot {
  readonly schema: typeof SNAPSHOT_SCHEMA_ID;
  readonly engine: string;
  /** When the snapshot was taken, in milliseconds. */
  readonly createdAt: number;
  /** Policy parameters, by the policy's versioned ID. */
  readonly policies: Readonly<Record<string, JsonValue>>;
  /** Extension state by namespace, with the version of the extension's own format. */
  readonly extensions: Readonly<Record<string, ExtensionEntry>>;
}

export interface ExtensionEntry {
  readonly version: number;
  readonly data: JsonValue;
}

/** Size limits, in UTF-8 bytes. */
export interface SnapshotLimits {
  /** A whole snapshot's JSON text. Default 32 MiB. */
  readonly maxBytes: number;
  /** One extension namespace's data. Default 1 MiB. */
  readonly extensionBytes: number;
  /** All extension data together. Default 10 MiB. */
  readonly extensionTotalBytes: number;
}

const MIB = 1024 * 1024;

export const DEFAULT_SNAPSHOT_LIMITS: SnapshotLimits = Object.freeze({
  maxBytes: 32 * MIB,
  extensionBytes: MIB,
  extensionTotalBytes: 10 * MIB,
});

/** `host.<name>` or `ext.<extension-id>`, with further dot-separated parts. */
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
 * Checks limits a host supplies, filling the rest with defaults. Throws {@link SwfFailure}
 * (`INVALID_INPUT`) naming the field.
 */
export function snapshotLimits(limits: Partial<SnapshotLimits> = {}): SnapshotLimits {
  const out = { ...DEFAULT_SNAPSHOT_LIMITS };
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in DEFAULT_SNAPSHOT_LIMITS)) {
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
 * Validates a snapshot and returns its canonical, frozen copy. Throws {@link SwfFailure}
 * (`SNAPSHOT_INVALID`) naming the first failing path: a format other than
 * {@link SNAPSHOT_SCHEMA_ID}, a malformed, unknown, missing or non-finite field, a key that could
 * reach an object's prototype, a cycle (in data or in the hierarchy), a broken reference, or an
 * extension over its size limit. Nothing in a snapshot is ever run.
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
 * {@link validateDocument} does. Throws {@link SwfFailure} (`SNAPSHOT_INVALID`).
 */
export function parseDocument(
  text: unknown,
  limits: SnapshotLimits = DEFAULT_SNAPSHOT_LIMITS,
): WorkspaceDocument {
  return validateDocument(parseJson(text, limits), limits);
}

/**
 * JSON text read safely: its UTF-8 size is checked against `limits.maxBytes` before it is parsed.
 * Throws {@link SwfFailure} (`SNAPSHOT_INVALID`) for text over the limit or not JSON.
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
    throw invalidSnapshot(
      `the snapshot is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
    );
  }
}

/**
 * The snapshot's canonical JSON text, UTF-8 ready. It is validated first, so only a valid snapshot
 * is ever written. Throws {@link SwfFailure}: `SNAPSHOT_INVALID` for an invalid snapshot,
 * `QUOTA_EXCEEDED` when its text is over `limits.maxBytes`.
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

/** The size of a string encoded as UTF-8, in bytes. */
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
