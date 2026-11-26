import type { Id } from '@swf/core';
import type { Compositor, CompositorSession, RendererBackend, RendererSession } from '@swf/presentation';
import type { ConformanceCase } from './harness.js';
/** What the handoff suite needs: the backend under test, and how it loses its resources. */
export interface HandoffFixture {
    /**
     * A fresh renderer under test, registered beside the reference mocks in each case's own
     * presentation registry.
     */
    renderer(): RendererBackend;
    /** A fresh compositor under test, to pair with the renderer. */
    compositor(): Compositor;
    /** The host container of a viewport. Default: an empty object. */
    container?(viewportId: Id): unknown;
    /**
     * Makes prepared sessions of the backend lose their resources the way they would in use (a
     * lost graphics context). Omit it for a backend that holds nothing it can lose: the loss case
     * is then not applicable.
     */
    loseContext?(sessions: {
        readonly renderer: RendererSession;
        readonly compositor: CompositorSession;
    }): void;
}
/**
 * The runtime cases of renderer and compositor conformance (QA-005): a backend handoff that
 * succeeds, one that fails and rolls back, the loss of a graphics context, and the fallback a
 * running viewport chose, visible, or the viewport visibly degraded when nothing works. Each
 * case runs a presenter over the backend under test with the reference mocks beside it, made when
 * the case runs and disposed when it ends.
 */
export declare function handoffConformance(fixture: HandoffFixture): ConformanceCase[];
//# sourceMappingURL=handoff-suite.d.ts.map