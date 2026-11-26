import type { CameraRecord, Id, NodeRecord, SceneState, SurfaceRecord, ViewportRecord } from './model.js';
/**
 * A workspace's committed scene as plain, canonical JSON data: every node, surface, camera and
 * viewport with all its fields, the hierarchy, the orbit root, the selection and focus. Entities
 * are ordered by ID, record fields in a fixed order and metadata keys sorted, so two snapshots of
 * the same scene are identical. It holds no runtime handle, element, callback or content: those
 * are never part of the scene.
 */
export interface SceneSnapshot {
    /**
     * The workspace the scene was taken from. A restore does not require it to match the restoring
     * workspace.
     */
    readonly workspaceId: Id;
    /** The revision the scene was at: a whole number of at least 0. */
    readonly revision: number;
    /** Root nodes in presentation order. */
    readonly rootIds: readonly Id[];
    /** Every node, archived ones included, ordered by ID. */
    readonly nodes: readonly NodeRecord[];
    /** Every surface association, ordered by ID. */
    readonly surfaces: readonly SurfaceRecord[];
    /** Every camera, ordered by ID. */
    readonly cameras: readonly CameraRecord[];
    /** Every viewport, ordered by ID. */
    readonly viewports: readonly ViewportRecord[];
    /** The node that workspace orbit rotates, or null. */
    readonly orbitRootId: Id | null;
    /** Selected nodes in selection order. */
    readonly selection: readonly Id[];
    /** The focused node, or null. */
    readonly focusedId: Id | null;
}
/** The fields of a scene snapshot, in canonical order. */
export declare const SCENE_SNAPSHOT_FIELDS: readonly ["workspaceId", "revision", "rootIds", "nodes", "surfaces", "cameras", "viewports", "orbitRootId", "selection", "focusedId"];
/**
 * The canonical snapshot of a scene state: a new, deeply frozen copy that shares nothing mutable
 * with the scene and can be stored or sent as JSON as it is.
 */
export declare function serializeScene(state: SceneState): SceneSnapshot;
/**
 * Checks that `value` is a scene snapshot whose references all hold, and returns its canonical,
 * frozen copy. Entities may come in any order; everything else must be exactly as a workspace
 * produces it. Throws {@link SwfFailure} (`SNAPSHOT_INVALID`) naming the first failing path, such
 * as `nodes[2].transform.rotation`: a malformed or non-finite field, an unknown field, a duplicate
 * ID, a missing or inconsistent reference, or a cycle in the hierarchy. Geometry and projection
 * settings are checked for shape here and against the registered kinds when a scene is restored.
 */
export declare function validateSceneSnapshot(value: unknown): SceneSnapshot;
export declare function nodeSnapshot(node: NodeRecord): NodeRecord;
export declare function surfaceSnapshot(surface: SurfaceRecord): SurfaceRecord;
export declare function cameraSnapshot(camera: CameraRecord): CameraRecord;
export declare function viewportSnapshot(viewport: ViewportRecord): ViewportRecord;
//# sourceMappingURL=snapshot.d.ts.map