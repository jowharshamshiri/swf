// The few platform facilities the binding runtime and its adapters use. Browsers, workers and
// Node.js all provide them; they are declared here so the packages do not pull in the whole DOM
// library and stay free of DOM dependencies. Published declarations that name them refer to the
// host's own global types; the adapter contract instead states the part of AbortSignal it relies
// on as its own exported BindingSignal, so it reads the same on every host.

interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
}

declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

declare function setTimeout(handler: () => void, timeout: number): unknown;
declare function clearTimeout(handle: unknown): void;
