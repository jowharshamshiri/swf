import type { EventPayload, WorkspaceEventType } from './events.js';
import type { Id, SceneState } from './model.js';
export interface PendingEvent<T extends WorkspaceEventType = WorkspaceEventType> {
    readonly type: T;
    readonly payload: EventPayload<T>;
}
/** The records a change may have touched, by kind, in the order it first touched them. */
export interface Touched {
    readonly nodes: readonly Id[];
    readonly surfaces: readonly Id[];
    readonly cameras: readonly Id[];
    readonly viewports: readonly Id[];
}
/**
 * The entity events that describe the change from `before` to `after`, derived from the records
 * themselves so a commit, an undo and a redo report the same way. Order: node events, surface
 * events, camera and viewport events, child and surface order changes, the orbit root, selection,
 * focus.
 */
export declare function diffScenes(before: SceneState, after: SceneState, touched: Touched): PendingEvent[];
export declare function sameList<T>(a: readonly T[], b: readonly T[]): boolean;
//# sourceMappingURL=diff.d.ts.map