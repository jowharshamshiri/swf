/**
 * SWF's state machines and decision logic. Each is a Lean model in the repository's `models/`
 * project, with its invariants proved there; lungo compiles them into one WebAssembly program
 * (`program/`, generated: never edited by hand), which this module loads once, when it is first
 * imported, so every package calls the models synchronously.
 */
import { BrowserWasi } from 'lungo-ts/wasi.js';
import { load } from '../program/index.js';

export type * from '../program/index.js';
export { ASSURANCE } from '../program/index.js';
export { fromJson, toJson } from './json.js';
export type { JsonInput } from './json.js';

/**
 * The models, ready to call. They run on lungo's minimal WASI in every environment, Node.js
 * included: they use no file, process or network, and one host for all keeps a bundle from
 * reaching for Node's modules.
 */
export const models = await load({ wasi: new BrowserWasi() });
