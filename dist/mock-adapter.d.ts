import type { BindingContext, PresentationHint, PresentationTarget, SurfaceAdapter, SurfaceCapabilities } from '@swf/surfaces';
/**
 * A capable native endpoint that cannot be shared between viewports: native DOM, fully
 * interactive, transparent, safely detachable and rebindable. Frozen.
 */
export declare const NATIVE_CAPABILITIES: SurfaceCapabilities;
/** {@link NATIVE_CAPABILITIES} with some fields changed: a new frozen object, not validated. */
export declare function mockCapabilities(over?: Partial<SurfaceCapabilities>): SurfaceCapabilities;
/** An opaque handle the mock hands out: the framework must treat it as a black box. Frozen. */
export interface MockHandle {
    /** The binding key it was resolved from. */
    readonly key: string;
    /** Which handle of the adapter it is, from 1: each resolution makes a fresh one. */
    readonly serial: number;
}
/** One call the framework made to a {@link MockOpaqueAdapter}, as it recorded it. */
export interface MockCall {
    /** The adapter method called. */
    readonly method: 'resolve' | 'capabilities' | 'attach' | 'update' | 'detach';
    /** The binding key, for `resolve`. */
    readonly key?: string;
    /** The handle, for `capabilities`, `attach`, `update` and `detach`. */
    readonly handle?: MockHandle;
    /** The target's viewport, for `attach` and `detach`. */
    readonly viewportId?: string;
    /** The presentation target, for `attach` and `detach`. */
    readonly target?: PresentationTarget;
    /** The presentation hint, for `update`. */
    readonly hint?: PresentationHint;
}
/** A resolution a {@link MockOpaqueAdapter} holds back until the test settles it. */
export interface Deferred {
    /** Settles the resolution with a handle, or with null for an unknown key. */
    resolve(handle: MockHandle | null): void;
    /** Fails the resolution with `error`. */
    reject(error: Error): void;
}
/**
 * A reference adapter for opaque endpoints, for testing hosts, runtimes and backends without any
 * real content. Keys resolve at once to a fresh handle unless they are held (`holding`), unknown
 * (`unknown`) or failing (`failing`). Held resolutions settle when `release` is called, or reject
 * when their abort signal fires, as a well-behaved adapter must. Every call is recorded. It also
 * carries a producer control, `stopProducer`, that the framework must never call.
 */
export declare class MockOpaqueAdapter implements SurfaceAdapter<MockHandle> {
    #private;
    /** The adapter type ID it registers as. */
    readonly id: string;
    /** The adapter API version it implements. */
    readonly apiVersion = 1;
    /** The capabilities it declares at registration. */
    readonly declaredCapabilities: SurfaceCapabilities;
    /** When true, the runtime does not time its bindings out. */
    readonly untimedBinding: boolean;
    /**
     * When true, held resolutions keep waiting after their abort signal fires: an ill-behaved
     * adapter, for checking that late answers are still discarded.
     */
    readonly ignoresAbort: boolean;
    /** Every call the framework made, oldest first; a test may read and clear it. */
    readonly calls: MockCall[];
    /** The held resolutions of each key, oldest first; {@link MockOpaqueAdapter.release} settles. */
    readonly held: Map<string, Deferred[]>;
    /** Keys whose resolutions are held until released or aborted; the test adds and removes them. */
    readonly holding: Set<string>;
    /** Keys that resolve to null: endpoints the adapter does not know. */
    readonly unknown: Set<string>;
    /** Keys whose resolutions reject with `Error`. */
    readonly failing: Set<string>;
    /** Keys whose handles' `attach` rejects with `Error`. */
    readonly attachFailing: Set<string>;
    /**
     * The held attachments of each key, oldest first: calling one completes that `attach`. They
     * are never removed by the adapter.
     */
    readonly attachHeld: Map<string, (() => void)[]>;
    /** Keys whose handles' `attach` waits until the test completes it from {@link attachHeld}. */
    readonly holdingAttach: Set<string>;
    /** The abort signal of every resolution, in call order. */
    readonly signals: AbortSignal[];
    /** The binding context of every resolution, in call order. */
    readonly contexts: BindingContext[];
    /** What `capabilities` answers for a handle; default the declared capabilities. Replaceable. */
    handleCapabilities: (handle: MockHandle) => SurfaceCapabilities;
    /** When true, `update` throws `Error`. Default false. */
    updateThrows: boolean;
    /** How many times {@link MockOpaqueAdapter.stopProducer} was called: it must stay 0. */
    producerTouched: number;
    /**
     * @param id - The adapter type ID. Default `host.view/1`.
     * @param declared - The capabilities declared, and answered for every handle unless
     *   `options.handleCapabilities` says otherwise. Default {@link NATIVE_CAPABILITIES}.
     * @param options - `untimedBinding` and `ignoresAbort` (default false), and
     *   `handleCapabilities`.
     */
    constructor(id?: string, declared?: SurfaceCapabilities, options?: {
        untimedBinding?: boolean;
        ignoresAbort?: boolean;
        handleCapabilities?: (handle: MockHandle) => SurfaceCapabilities;
    });
    /**
     * Resolves `key`, recording the call, its signal and its context: rejects when `signal` is
     * already aborted (unless the adapter ignores aborts) or the key is failing, answers null for an
     * unknown key, waits for a held one, and otherwise answers a fresh handle at once.
     */
    resolve(key: string, signal: AbortSignal, context: BindingContext): Promise<MockHandle | null>;
    /**
     * Completes the oldest held resolution of `key` with a fresh handle, null, or an error, and
     * returns the handle given (null for `null` and `error`).
     *
     * @throws `Error` when no resolution of `key` is held.
     */
    release(key: string, outcome?: 'handle' | 'null' | 'error'): MockHandle | null;
    /** Records the call and answers {@link MockOpaqueAdapter.handleCapabilities} for the handle. */
    capabilities(handle: MockHandle): SurfaceCapabilities;
    /**
     * Records the call; rejects for a key in {@link attachFailing}, waits for one in
     * {@link holdingAttach}, and otherwise resolves at once. It mounts nothing.
     */
    attach(handle: MockHandle, target: PresentationTarget): Promise<void>;
    /** Records the hint; throws `Error` while {@link updateThrows} is set. */
    update(handle: MockHandle, hint: PresentationHint): void;
    /** Records the call and resolves at once. */
    detach(handle: MockHandle, target: PresentationTarget): Promise<void>;
    /** What a producer control looks like. The framework must never call it. */
    stopProducer(): void;
    /** The method of every recorded call, oldest first: a new array. */
    methods(): string[];
}
//# sourceMappingURL=mock-adapter.d.ts.map