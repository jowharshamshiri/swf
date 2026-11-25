import { makeError, RejectionSignal, SwfFailure } from './errors.js';

/**
 * A JSON-compatible value with finite numbers only. Values the scene stores are deep, frozen
 * copies of plain data: no functions, symbols, class instances, cycles, the keys `__proto__`,
 * `constructor` or `prototype`, or nesting deeper than 64 levels.
 */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * Namespaced descriptive data on an entity. Keys are `host.<name>` or `ext.<extension-id>.<name>`;
 * keys under `swf.` are reserved for the framework and rejected (`INVALID_INPUT`). Values are
 * {@link JsonValue} data. The map the scene holds is frozen.
 */
export type Metadata = Readonly<Record<string, JsonValue>>;

const MAX_DEPTH = 64;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const METADATA_KEY = /^(?:host\.\S+|ext\.[A-Za-z0-9_-]+\.\S+)$/;

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A deep, frozen copy of `value` as JSON data. Rejects functions, symbols, class instances,
 * non-finite numbers, cycles, prototype-polluting keys and nesting deeper than 64 levels, naming the
 * failing path.
 */
export function copyJson(
  value: unknown,
  path: string,
  depth = 0,
  ancestors = new WeakSet<object>(),
): JsonValue {
  if (depth > MAX_DEPTH) {
    throw new RejectionSignal('INVALID_INPUT', `${path} nests deeper than ${MAX_DEPTH} levels`, {
      path,
    });
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RejectionSignal('INVALID_INPUT', `${path} must be a finite number`, { path });
    }
    return value;
  }
  if (typeof value === 'object' && ancestors.has(value)) {
    throw new RejectionSignal('INVALID_INPUT', `${path} contains itself (a cycle)`, { path });
  }
  if (Array.isArray(value)) {
    ancestors.add(value);
    const out = value.map((item, i) => copyJson(item, `${path}[${i}]`, depth + 1, ancestors));
    ancestors.delete(value);
    return Object.freeze(out);
  }
  if (typeof value === 'object' && isPlainObject(value)) {
    ancestors.add(value);
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new RejectionSignal('INVALID_INPUT', `${path} must not use the key "${key}"`, {
          path: `${path}.${key}`,
        });
      }
      Object.defineProperty(out, key, {
        value: copyJson(item, `${path}.${key}`, depth + 1, ancestors),
        enumerable: true,
      });
    }
    ancestors.delete(value);
    return Object.freeze(out);
  }
  throw new RejectionSignal('INVALID_INPUT', `${path} must be JSON data (got ${describe(value)})`, {
    path,
  });
}

/**
 * A deep, frozen copy of `value` as JSON data, by the same rules the scene applies to metadata and
 * configurations. Throws {@link SwfFailure} (`INVALID_INPUT`) naming the failing path.
 */
export function jsonValue(value: unknown, path: string): JsonValue {
  try {
    return copyJson(value, path);
  } catch (error) {
    if (error instanceof RejectionSignal) {
      throw new SwfFailure(
        makeError(error.code, error.message, error.path === undefined ? {} : { path: error.path }),
      );
    }
    throw error;
  }
}

/**
 * A frozen copy of JSON data in canonical form: object keys sorted, arrays in their order. Two
 * equal values have identical canonical forms, so their JSON texts compare equal.
 */
export function canonicalJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return Object.freeze((value as readonly JsonValue[]).map(canonicalJson));
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      Object.defineProperty(out, key, {
        value: canonicalJson((value as Readonly<Record<string, JsonValue>>)[key] ?? null),
        enumerable: true,
      });
    }
    return Object.freeze(out);
  }
  return value;
}

/** Validates and copies a metadata map: namespaced keys and JSON values. */
export function copyMetadata(value: unknown, path: string): Metadata {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !isPlainObject(value)
  ) {
    throw new RejectionSignal('INVALID_INPUT', `${path} must be a plain object`, { path });
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    checkMetadataKey(key, `${path}.${key}`);
    Object.defineProperty(out, key, {
      value: copyJson(item, `${path}.${key}`, 1),
      enumerable: true,
    });
  }
  return Object.freeze(out);
}

export function checkMetadataKey(key: string, path: string): void {
  if (key.startsWith('swf.')) {
    throw new RejectionSignal(
      'INVALID_INPUT',
      `${path}: metadata keys under "swf." are reserved for the framework`,
      { path },
    );
  }
  if (!METADATA_KEY.test(key)) {
    throw new RejectionSignal(
      'INVALID_INPUT',
      `${path}: metadata key "${key}" must be namespaced as "host.<name>" or "ext.<extension-id>.<name>"`,
      { path },
    );
  }
}

export function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  if (typeof value === 'object') {
    const ctor = (value as { constructor?: { name?: unknown } }).constructor;
    return typeof ctor?.name === 'string' && ctor.name !== 'Object'
      ? `a ${ctor.name}`
      : 'an object';
  }
  return typeof value;
}

/**
 * What a host callback answered, for a rejection's message: a number or boolean as itself, any
 * other value by its kind.
 */
export function describeAnswer(value: unknown): string {
  switch (typeof value) {
    case 'number':
    case 'boolean':
      return String(value);
    case 'undefined':
      return 'undefined';
    case 'string':
    case 'bigint':
    case 'symbol':
    case 'function':
      return `a ${typeof value}`;
    default:
      return describe(value);
  }
}
