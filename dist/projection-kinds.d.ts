import type { JsonValue } from './json.js';
/**
 * What the scene needs to know of a projection to accept a viewport that uses it: its versioned ID
 * and how to check a configuration. The projection itself (its mapping and inverse) lives outside
 * the scene kernel.
 */
export interface ProjectionKind {
    /** A versioned ID, `<name>/<version>`, such as `equirectangular/1`. */
    readonly id: string;
    /**
     * Why `config` is invalid for this projection, or null when it is valid. It must be
     * deterministic and free of side effects; when it throws or answers anything but text or null,
     * the configuration is refused with `INVALID_INPUT` (or `SNAPSHOT_INVALID` on a restore), naming
     * the projection and quoting what it threw or answered.
     */
    configIssue(config: JsonValue): string | null;
}
/**
 * What `kind.configIssue` finds wrong with `config`, or null when it is valid. A configIssue that
 * throws or answers anything but text or null is reported as the issue, naming the projection.
 */
export declare function projectionConfigIssue(kind: ProjectionKind, config: JsonValue): string | null;
/** The projection kinds a workspace accepts viewports for. */
export declare class ProjectionKindRegistry {
    #private;
    get(id: string): ProjectionKind | undefined;
    /**
     * Adds a kind; throws a TypeError naming the problem when it is malformed or its ID is taken.
     * The returned function removes it (safe to call twice); viewports already using it keep their
     * settings, and new ones cannot choose it.
     */
    register(kind: ProjectionKind): () => void;
}
//# sourceMappingURL=projection-kinds.d.ts.map