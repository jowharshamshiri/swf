import type { ProjectionKind } from '@swf/core';
import type { ViewProjector } from '@swf/presentation';
import type { ProjectionModule } from './contract.js';
/**
 * Where a registered projection goes: the scene's projection kinds and the host's projectors.
 * The registry holds both only to register and withdraw; it never uses them otherwise.
 */
export interface ProjectionTargets {
    /** The scene side: a workspace, or its mutator. */
    readonly kinds: {
        /**
         * Lets the scene accept viewports using `kind`; throws when it refuses it. The returned
         * function withdraws it again.
         */
        registerProjectionKind(kind: ProjectionKind): () => void;
    };
    /** The presentation side: a presentation registry, or its registrar. */
    readonly projectors: {
        /**
         * Makes `projector` available for viewports using its profile's ID; throws when it refuses
         * it. The returned function withdraws it again.
         */
        registerProjector(projector: ViewProjector): () => void;
    };
}
/** The projection modules a host offers its viewports. */
export interface ProjectionRegistry {
    /** The registered module with this versioned ID, or undefined. */
    get(id: string): ProjectionModule | undefined;
    /** The registered modules' IDs, sorted; a new array on each call. */
    ids(): string[];
    /**
     * Validates a module and makes it available: the scene then accepts viewports using it, and the
     * host can project them. Returns a function that withdraws it from both. Throws
     * {@link SwfFailure}: `INVALID_INPUT` for a malformed module or a taken ID,
     * `UNSUPPORTED_CAPABILITY` for another contract version, a domain or profile that is invalid
     * or contradicts itself, or a projection that fails its probes. A target that refuses the
     * module throws its own error, and whatever was registered before it is withdrawn. The
     * returned function is safe to call twice; viewports already using the projection keep their
     * settings, and new ones cannot choose it.
     */
    register(module: ProjectionModule): () => void;
}
/**
 * A registry of projection modules that registers each one with both `targets`, the scene's
 * projection kinds and the host's projectors, and withdraws it from both. It starts empty, and
 * holds the modules it is given as they are (not copied).
 *
 * @example
 * ```ts
 * const projections = createProjectionRegistry({ kinds: workspace, projectors: registry });
 * const withdraw = projections.register(equirectangular);
 * ```
 */
export declare function createProjectionRegistry(targets: ProjectionTargets): ProjectionRegistry;
/**
 * Checks that a projection module is complete and behaves as it declares: its shape and contract
 * version, its profile, a projection created from its default configuration, that projection's
 * domain, and a round trip through the centre of a probe view. Throws {@link SwfFailure} naming
 * the first problem.
 */
export declare function validateProjectionModule(module: ProjectionModule): void;
//# sourceMappingURL=registry.d.ts.map