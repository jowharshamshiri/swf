// The few platform facilities the binding runtime uses. Browsers, workers and Node.js all provide
// them; they are declared here so the package does not pull in the whole DOM library and stays
// free of DOM dependencies. Published declarations refer to the host's own global types.

interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
}

declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

declare function setTimeout(handler: () => void, timeout: number): unknown;
declare function clearTimeout(handle: unknown): void;
