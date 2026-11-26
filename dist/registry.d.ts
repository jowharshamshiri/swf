import type { CompositorCapabilities, ProjectionProfile, RendererCapabilities } from './capabilities.js';
import type { Compositor, RendererBackend } from './contracts.js';
import type { ViewProjector } from './stages.js';
/** A registered module with the capabilities it declared when it was registered. */
export interface Registered<T, C> {
    /** The module as registered: the same object, not a copy. */
    readonly module: T;
    /**
     * What it declared, validated, copied and deeply frozen at registration; the module cannot
     * change it afterwards.
     */
    readonly capabilities: C;
}
/** Registration only: what a module that installs backends may do, and nothing else. */
export interface BackendRegistrar {
    /**
     * Registers a renderer under its ID: its capabilities are asked for once, checked by
     * {@link rendererCapabilitiesIssue} and kept as a frozen copy. Throws {@link SwfFailure}:
     * `INVALID_INPUT` for a malformed module or a taken ID, `UNSUPPORTED_CAPABILITY` for an
     * incompatible contract version or capabilities that are invalid or cannot be read. The
     * returned function unregisters (safe to call twice).
     */
    registerRenderer(renderer: RendererBackend): () => void;
    /**
     * Registers a compositor under its ID: its capabilities are asked for once, checked by
     * {@link compositorCapabilitiesIssue} and kept as a frozen copy. Throws {@link SwfFailure}:
     * `INVALID_INPUT` for a malformed module or a taken ID, `UNSUPPORTED_CAPABILITY` for another
     * contract version or capabilities that are invalid or cannot be read. The returned function
     * unregisters (safe to call twice).
     */
    registerCompositor(compositor: Compositor): () => void;
    /**
     * Registers a projector under its profile's ID, the projection ID views name. Throws
     * {@link SwfFailure}: `INVALID_INPUT` for a non-object, one without `project()` or a taken ID,
     * `UNSUPPORTED_CAPABILITY` for a profile {@link projectionProfileIssue} faults. The profile is
     * kept as a frozen copy. The returned function unregisters (safe to call twice).
     */
    registerProjector(projector: ViewProjector): () => void;
}
/** A listener that threw: the change it was told of stands, and the other listeners heard it. */
export interface RegistryDiagnostic {
    /** Always `LISTENER_THREW`. */
    readonly code: 'LISTENER_THREW';
    /** What the listener was handling: the registration or unregistration, of which module. */
    readonly message: string;
    /** `reason`: what the listener threw, as a message. */
    readonly details: Readonly<Record<string, string>>;
}
/** A module registered or unregistered. */
export interface RegistryChange {
    /** Which kind of module changed. */
    readonly kind: 'renderer' | 'compositor' | 'projector';
    /** Its ID: a projector's is its profile's ID. */
    readonly id: string;
    /** True for a registration, false for an unregistration. */
    readonly registered: boolean;
}
/**
 * The renderers, compositors and projectors available to a host's viewports. Each kind has its
 * own IDs, so a renderer and a compositor may share one. Unregistering never stops or releases
 * what a module already prepared: a presenter's viewports move off a backend that goes away.
 */
export interface PresentationRegistry extends BackendRegistrar {
    /** The renderer registered under `id`, with its declared capabilities, or undefined. */
    renderer(id: string): Registered<RendererBackend, RendererCapabilities> | undefined;
    /** The compositor registered under `id`, with its declared capabilities, or undefined. */
    compositor(id: string): Registered<Compositor, CompositorCapabilities> | undefined;
    /** The projector registered under projection ID `id`, with its profile, or undefined. */
    projector(id: string): Registered<ViewProjector, ProjectionProfile> | undefined;
    /** The registered renderers' IDs, in registration order; a new array on each call. */
    rendererIds(): string[];
    /** The registered compositors' IDs, in registration order; a new array on each call. */
    compositorIds(): string[];
    /** The registered projectors' IDs, in registration order; a new array on each call. */
    projectorIds(): string[];
    /** A handle that can register and unregister backends but not read or use them. */
    registrar(): BackendRegistrar;
    /**
     * Calls `listener` after every registration and unregistration, in order. A listener that
     * throws does not stop the others; its failure is kept in {@link getDiagnostics}. Returns a
     * function that stops listening (safe to call twice).
     */
    subscribe(listener: (change: RegistryChange) => void): () => void;
    /** The last 100 listener failures, oldest first. */
    getDiagnostics(): readonly RegistryDiagnostic[];
}
/**
 * An empty presentation registry. It holds the modules registered with it, and nothing else: it
 * prepares no sessions and has nothing to dispose.
 *
 * @example
 * ```ts
 * const registry = createPresentationRegistry();
 * const unregister = registry.registerRenderer(renderer);
 * registry.registerCompositor(compositor);
 * ```
 */
export declare function createPresentationRegistry(): PresentationRegistry;
//# sourceMappingURL=registry.d.ts.map