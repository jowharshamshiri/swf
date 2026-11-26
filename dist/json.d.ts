/**
 * A JSON-compatible value with finite numbers only. Values the scene stores are deep, frozen
 * copies of plain data: no functions, symbols, class instances, cycles, the keys `__proto__`,
 * `constructor` or `prototype`, or nesting deeper than 64 levels.
 */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | {
    readonly [key: string]: JsonValue;
};
/**
 * Namespaced descriptive data on an entity. Keys are `host.<name>` or `ext.<extension-id>.<name>`;
 * keys under `swf.` are reserved for the framework and rejected (`INVALID_INPUT`). Values are
 * {@link JsonValue} data. The map the scene holds is frozen.
 */
export type Metadata = Readonly<Record<string, JsonValue>>;
/**
 * A deep, frozen copy of `value` as JSON data. Rejects functions, symbols, class instances,
 * non-finite numbers, cycles, prototype-polluting keys and nesting deeper than 64 levels, naming the
 * failing path.
 */
export declare function copyJson(value: unknown, path: string, depth?: number, ancestors?: WeakSet<object>): JsonValue;
/**
 * A deep, frozen copy of `value` as JSON data, by the same rules the scene applies to metadata and
 * configurations. Throws {@link SwfFailure} (`INVALID_INPUT`) naming the failing path.
 */
export declare function jsonValue(value: unknown, path: string): JsonValue;
/**
 * A frozen copy of JSON data in canonical form: object keys sorted, arrays in their order. Two
 * equal values have identical canonical forms, so their JSON texts compare equal.
 */
export declare function canonicalJson(value: JsonValue): JsonValue;
/** Validates and copies a metadata map: namespaced keys and JSON values. */
export declare function copyMetadata(value: unknown, path: string): Metadata;
export declare function checkMetadataKey(key: string, path: string): void;
export declare function describe(value: unknown): string;
/**
 * What a host callback answered, for a rejection's message: a number or boolean as itself, any
 * other value by its kind.
 */
export declare function describeAnswer(value: unknown): string;
//# sourceMappingURL=json.d.ts.map