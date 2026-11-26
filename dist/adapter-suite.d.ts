import type { Id } from '@swf/core';
import type { BindingContext, SurfaceAdapter } from '@swf/surfaces';
import type { ConformanceCase } from './harness.js';
/**
 * What the adapter suite needs from an adapter's author: a way to create fresh adapters and the
 * binding keys that exercise them. Optional hooks enable the cases that need them; without them
 * those cases report `not-applicable`.
 */
export interface AdapterFixture<THandle> {
    /**
     * A fresh adapter, with no state shared with any made before: each case registers its own in a
     * workspace and surface runtime of its own.
     */
    create(): SurfaceAdapter<THandle>;
    /** The binding keys the cases bind surfaces with. */
    readonly keys: {
        /** Two distinct keys that resolve to endpoints. */
        readonly valid: readonly [string, string];
        /** A key the adapter does not know: resolve answers null. */
        readonly unknown: string;
        /** A key whose resolution fails. */
        readonly failing?: string;
        /** A key whose resolution does not answer until cancelled (or completed by the fixture). */
        readonly slow?: string;
    };
    /** Makes the adapter answer its oldest pending resolution of `key`, late. */
    readonly completeSlow?: (adapter: SurfaceAdapter<THandle>, key: string) => void;
    /** Makes the adapter announce a capability change through the given binding context. */
    readonly changeCapabilities?: (adapter: SurfaceAdapter<THandle>, context: BindingContext) => void;
    /** The presentation container for a viewport. Default: an empty object. */
    readonly container?: (viewportId: Id) => unknown;
    /** How long a cancelled resolution may take to settle, in milliseconds. Default 1000. */
    readonly settleMs?: number;
}
/**
 * The adapter conformance cases: binding success, unknown keys, failure, timeout, cancellation,
 * late resolution, attach/detach symmetry, safe and unsafe detachment, viewport sharing,
 * replacement with rollback, lifecycle event order and capability changes. Nothing runs until a
 * case's `run` is called; each run creates its own adapter, workspace and surface runtime, and
 * disposes the workspace and runtime however it ends, failing or not.
 */
export declare function adapterConformance<THandle>(fixture: AdapterFixture<THandle>): ConformanceCase[];
//# sourceMappingURL=adapter-suite.d.ts.map