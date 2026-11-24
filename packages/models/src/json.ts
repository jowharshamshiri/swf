import type { Json } from '../program/index.js';

/** A JavaScript value as the models' JSON value. */
export type JsonInput =
  null | boolean | number | string | readonly JsonInput[] | { readonly [key: string]: JsonInput };

/**
 * A JavaScript value as the models' JSON value, for a model to decide on. Every number crosses as
 * it is, non-finite ones too, so the model is the one that refuses them. Anything JSON has no
 * value for (undefined, a function, a symbol, a bigint, a cycle) throws a TypeError naming where
 * it is.
 */
export function toJson(value: unknown, path = 'value'): Json {
  return encode(value, path, new Set());
}

function encode(value: unknown, path: string, open: Set<object>): Json {
  if (value === null) {
    return { kind: 'null' };
  }
  switch (typeof value) {
    case 'boolean':
      return { kind: 'bool', value };
    case 'number':
      return { kind: 'num', value };
    case 'string':
      return { kind: 'str', value };
    case 'object':
      break;
    default:
      throw new TypeError(`${path} has no JSON value (it is ${typeof value})`);
  }
  if (open.has(value)) {
    throw new TypeError(`${path} has no JSON value (it contains itself)`);
  }
  open.add(value);
  try {
    if (Array.isArray(value)) {
      return { kind: 'arr', items: value.map((item, i) => encode(item, `${path}[${i}]`, open)) };
    }
    return {
      kind: 'obj',
      members: Object.entries(value).map(([key, member]): [string, Json] => [
        key,
        encode(member, `${path}.${key}`, open),
      ]),
    };
  } finally {
    open.delete(value);
  }
}

/** The models' JSON value as a frozen JavaScript value. */
export function fromJson(json: Json): JsonInput {
  switch (json.kind) {
    case 'null':
      return null;
    case 'bool':
    case 'num':
    case 'str':
      return json.value;
    case 'arr':
      return Object.freeze(json.items.map(fromJson));
    case 'obj':
      return Object.freeze(
        Object.fromEntries(json.members.map(([key, member]) => [key, fromJson(member)])),
      );
  }
}
