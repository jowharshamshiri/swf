import type { Id } from '@swf/core';
import type { Compositor, RendererBackend } from '@swf/presentation';
import type { ConformanceCase } from './harness.js';
/** What the backend suite needs: fresh renderers and compositors, and a container per viewport. */
export interface BackendFixture {
    /** A fresh renderer under test; the cases prepare sessions of it and release them. */
    renderer(): RendererBackend;
    /** A fresh compositor under test, to pair with the renderer. */
    compositor(): Compositor;
    /** The presentation container for a viewport. Default: an empty object. */
    container?(viewportId: Id): unknown;
}
/**
 * The renderer and compositor conformance cases that the contracts fix: valid registration,
 * sessions bound to their viewport, every planned fragment realized exactly once in the layer its
 * negotiation chose (so fragment IDs map back to one surface), no live element mounted twice, a
 * deterministic order that follows the plan, composition that keeps that order, an unchanged
 * scene, and idempotent release. Nothing runs until a case's `run` is called; each run takes
 * fresh backends from the fixture, and releases every session it prepared and disposes the
 * workspace it made however it ends, failing or not.
 */
export declare function backendConformance(fixture: BackendFixture): ConformanceCase[];
//# sourceMappingURL=backend-suite.d.ts.map