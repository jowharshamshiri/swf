export type * from '../program/index.js';
export { ASSURANCE } from '../program/index.js';
export { fromJson, toJson } from './json.js';
export type { JsonInput } from './json.js';
/**
 * The models, ready to call. They run on lungo's minimal WASI in every environment, Node.js
 * included: they use no file, process or network, and one host for all keeps a bundle from
 * reaching for Node's modules.
 */
export declare const models: import("../program/index.js").SwfModels;
//# sourceMappingURL=index.d.ts.map