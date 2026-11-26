import type { Workspace } from '@swf/core';
import type { DispatchResult, InputIntent, InteractionRouter } from '@swf/interaction';
import type { PresentedViewport, Presenter } from '@swf/presentation';
import type { ProjectionRegistry } from '@swf/projections';
import type { SurfaceRuntime } from '@swf/surfaces';
import type { Fixture, FixtureViewport } from './fixture.js';
/** One of the fixture's viewports, presented in its own element. */
export interface HostViewport {
    /** The fixture's viewport it presents. */
    readonly fixture: FixtureViewport;
    /** The caller's element it is presented in. */
    readonly container: HTMLElement;
    /** The presenter's viewport, owned by the host's presenter. */
    readonly viewport: PresentedViewport;
}
/**
 * The framework presenting a fixture, as a host composes it. It owns the workspace, runtime,
 * presenter and router it made, and releases them in {@link BenchmarkHost.dispose}; the
 * containers stay the caller's. Frozen.
 */
export interface BenchmarkHost {
    /** The fixture presented. */
    readonly fixture: Fixture;
    /**
     * The workspace holding the fixture's scene, its announcements paced by the window's animation
     * frames and its operations timed by `performance.now`.
     */
    readonly workspace: Workspace;
    /** The surface runtime binding the fixture's live and drawn content. */
    readonly runtime: SurfaceRuntime;
    /** The projection registry, with the equirectangular projection registered. */
    readonly projections: ProjectionRegistry;
    /** The presenter of the viewports, on the DOM renderer and compositor. */
    readonly presenter: Presenter;
    /** Routes input taken over the first viewport. */
    readonly router: InteractionRouter;
    /** The fixture's viewports, in the fixture's order. */
    readonly viewports: readonly HostViewport[];
    /**
     * Calls `listener` with every input intent dispatched and its result, synchronously as the
     * router returns; returns what stops it. A listener that throws is not isolated: the throw
     * reaches the input device.
     */
    observeInput(listener: (intent: InputIntent, result: DispatchResult) => void): () => void;
    /**
     * Resolves once every surface has bound and every viewport has presented a frame. Rejects with
     * `Error` when a viewport is degraded.
     */
    settled(): Promise<void>;
    /**
     * Stops observing input and disposes the router, presenter, runtime and workspace, in that
     * order, each even when one before it fails. The containers stay in place, holding nothing of
     * the framework's. The same promise on every call.
     *
     * @throws As a disposal fails (as a rejection); an `AggregateError` holding each failure, in
     *   order, when more than one does.
     */
    dispose(): Promise<void>;
}
/** What a benchmark host presents, and where. */
export interface BenchmarkHostOptions {
    /** The fixture to make and present, as {@link planFixture} gives it. */
    readonly fixture: Fixture;
    /**
     * The elements the fixture's viewports are presented in, one for each, in the fixture's order:
     * the caller's, as a host's own page is ({@link layoutViewports} makes them). Disposing the host
     * leaves them in place, holding nothing of the framework's.
     */
    readonly containers: readonly HTMLElement[];
}
/**
 * Lays out an element for each of a fixture's viewports in `parent`, where the fixture places it
 * on the page, and returns them in the fixture's order. The elements are absolutely positioned,
 * in CSS pixels, and are the caller's to remove.
 */
export declare function layoutViewports(parent: HTMLElement, fixture: Fixture): HTMLElement[];
/**
 * Presents a fixture with the framework's DOM backend, on the parent's window's animation frames:
 * a workspace with the equirectangular projection, the fixture's scene committed as one
 * transaction, its content bound through two adapters, each viewport presented in its own element,
 * and input over the first taken by the interaction router with its built-in policies. The caller
 * owns the host and disposes it.
 *
 * When a step fails, everything made before it is disposed, in reverse order, and the failure
 * passed on: the containers are left holding nothing of the framework's.
 *
 * @throws `Error` (as a rejection) when the containers are not one per viewport or not in a
 *   window, or the fixture's scene cannot be committed. A viewport that cannot open rejects as
 *   the presenter does. When disposing what was made also fails, it rejects with an
 *   `AggregateError` holding the step's failure, then each disposal's.
 *
 * @example
 * ```ts
 * const fixture = planFixture(STANDARD, 1);
 * const host = await createBenchmarkHost({
 *   fixture,
 *   containers: layoutViewports(document.body, fixture),
 * });
 * await host.settled();
 * const frames = recordFrames(window);
 * // ... run the scenario ...
 * const analysis = analyseFrames(frames.stop());
 * await host.dispose();
 * ```
 */
export declare function createBenchmarkHost(options: BenchmarkHostOptions): Promise<BenchmarkHost>;
//# sourceMappingURL=host.d.ts.map