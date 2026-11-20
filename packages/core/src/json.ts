import { RejectionSignal } from './errors.js';

/** A JSON-compatible value with finite numbers only. */
export type JsonValue =
  null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Namespaced descriptive data on an entity. Keys are `host.<name>` or `ext.<extension-id>.<name>`. */
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
export function copyJson(value: unknown, path: string, depth = 0): JsonValue {
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
  if (Array.isArray(value)) {
    return Object.freeze(value.map((item, i) => copyJson(item, `${path}[${i}]`, depth + 1)));
  }
  if (typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new RejectionSignal('INVALID_INPUT', `${path} must not use the key "${key}"`, {
          path: `${path}.${key}`,
        });
      }
      Object.defineProperty(out, key, {
        value: copyJson(item, `${path}.${key}`, depth + 1),
        enumerable: true,
      });
    }
    return Object.freeze(out);
  }
  throw new RejectionSignal('INVALID_INPUT', `${path} must be JSON data (got ${describe(value)})`, {
    path,
  });
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
