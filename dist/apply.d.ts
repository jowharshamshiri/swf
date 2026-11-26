import type { EventSource, OperationType } from './commands.js';
import type { Constraint } from './constraints.js';
import type { GeometryLimits, GeometryRegistry } from './geometry.js';
import type { Id, SceneState } from './model.js';
import type { ProjectionKindRegistry } from './projection-kinds.js';
export interface ApplyContext {
    readonly source: EventSource;
    readonly now: number;
    /** Supplies a fresh ID, given a test for IDs in use; the draft rejects one already in use. */
    readonly createId: (inUse: (id: Id) => boolean) => Id;
    /** Sorted constraints to resolve node placements through. */
    readonly constraints: readonly Constraint[];
    readonly geometry: GeometryRegistry;
    readonly geometryLimits: GeometryLimits;
    readonly projectionKinds: ProjectionKindRegistry;
}
/** The scene after applying commands, before the revision is advanced. */
export interface ApplyOutcome {
    readonly nodes: SceneState['nodes'];
    readonly surfaces: SceneState['surfaces'];
    readonly cameras: SceneState['cameras'];
    readonly viewports: SceneState['viewports'];
    readonly orbitRootId: Id | null;
    readonly rootIds: readonly Id[];
    readonly selection: readonly Id[];
    readonly focusedId: Id | null;
    readonly commandTypes: readonly OperationType[];
    /** Nodes created, changed or removed, in the order they were first touched. */
    readonly touched: readonly Id[];
    /** Surfaces created, changed or removed, in the order they were first touched. */
    readonly touchedSurfaces: readonly Id[];
    /** Cameras and viewports created, changed or removed: view state, not layout. */
    readonly touchedCameras: readonly Id[];
    readonly touchedViewports: readonly Id[];
    readonly createdIds: readonly Id[];
}
/**
 * Applies `commands` to `base` as one unit: every command is validated against the scene as the
 * earlier commands left it, then the placements they proposed are resolved through the
 * constraints. Throws a {@link RejectionSignal} on the first failure; `base` is never modified.
 */
export declare function applyCommands(base: SceneState, commands: unknown, ctx: ApplyContext): ApplyOutcome;
//# sourceMappingURL=apply.d.ts.map