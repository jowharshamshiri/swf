import type { Json } from '../program/index.js';
/** A JavaScript value as the models' JSON value. */
export type JsonInput = null | boolean | number | string | readonly JsonInput[] | {
    readonly [key: string]: JsonInput;
};
/**
 * A JavaScript value as the models' JSON value, for a model to decide on. Every number crosses as
 * it is, non-finite ones too, so the model is the one that refuses them. Anything JSON has no
 * value for (undefined, a function, a symbol, a bigint, a cycle) throws a TypeError naming where
 * it is.
 */
export declare function toJson(value: unknown, path?: string): Json;
/** The models' JSON value as a frozen JavaScript value. */
export declare function fromJson(json: Json): JsonInput;
//# sourceMappingURL=json.d.ts.map