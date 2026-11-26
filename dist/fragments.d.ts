import type { Id, JsonValue, SceneState } from '@swf/core';
import type { Mat4 } from '@swf/math';
/**
 * [x, y, width, height] in viewport CSS pixels, from the top-left corner with y down; width and
 * height are never negative.
 */
export type ScreenRect = readonly [number, number, number, number];
/** [x, y] in viewport CSS pixels, from the top-left corner with y down. */
export type ScreenPoint = readonly [number, number];
/**
 * The view a viewport shows: its size, pixel density, camera placement and depth range, and its
 * projection with that projection's configuration.
 */
export interface ViewGeometry {
    /** The viewport shown; a non-blank string. */
    readonly viewportId: Id;
    /** Width in CSS pixels, positive and finite. */
    readonly width: number;
    /** Height in CSS pixels, positive and finite. */
    readonly height: number;
    /** Device pixels per CSS pixel, positive and finite. */
    readonly devicePixelRatio: number;
    /**
     * The camera's local-to-world placement (rotation and position, no scale), as 16 finite numbers.
     * The world is right-handed with +Y up, and the camera looks along its local -Z.
     */
    readonly camera: Mat4;
    /** Nearest distance shown, positive. */
    readonly near: number;
    /** Farthest distance shown, or null for no limit. */
    readonly far: number | null;
    /** The projection's versioned ID. */
    readonly projectionId: string;
    /** The projection's configuration, as the viewport's projection setting holds it. */
    readonly projectionConfig: JsonValue;
}
/**
 * One visible piece of a surface in one viewport. A surface may show as several fragments (for
 * example on both sides of a panorama seam); all of them refer to the same Surface ID, which stays
 * the single target for focus, selection and undo.
 */
export interface ProjectedFragment {
    /** The presentation fragment ID, derived by {@link fragmentId}. */
    readonly id: string;
    /** The one surface the fragment shows; input aimed at any fragment goes to it. */
    readonly surfaceId: Id;
    /** The viewport the fragment is in. */
    readonly viewportId: Id;
    /** The fragment's number among its surface's fragments in this viewport, from 0. */
    readonly ordinal: number;
    /** The visible part of the fragment, finite and never negative in size. */
    readonly bounds: ScreenRect;
    /**
     * The projected corners of the whole surface on this fragment's branch (top-left, top-right,
     * bottom-right, bottom-left), possibly beyond the viewport, or null when the projection cannot
     * give them; `bounds` is the visible part.
     */
    readonly corners: readonly [ScreenPoint, ScreenPoint, ScreenPoint, ScreenPoint] | null;
    /** Distance from the camera; larger is farther. */
    readonly depth: number;
    /** Whether the fragment's placement follows the projection exactly or approximates it. */
    readonly geometricFidelity: 'exact' | 'approximate';
    /**
     * The fragment that owns native interaction for its surface. At most one fragment per surface
     * and viewport owns it; the others are presentation proxies routing to the same surface.
     */
    readonly nativeOwner: boolean;
}
/**
 * A viewport's projected fragments for one scene revision, in presentation order (back to front),
 * with the mapping from each fragment to its one surface.
 */
export interface ViewOutput {
    /** The viewport the fragments are in. */
    readonly viewportId: Id;
    /** The revision of the scene the fragments were validated against. */
    readonly sceneRevision: number;
    /** Every fragment, back to front; the array and each fragment are frozen. */
    readonly fragments: readonly ProjectedFragment[];
    /** The surface a fragment shows, by the fragment's ID; undefined for an ID not in the output. */
    surfaceOf(fragmentId: string): Id | undefined;
    /** A surface's fragments, back to front; frozen, and empty for a surface with none here. */
    fragmentsOf(surfaceId: Id): readonly ProjectedFragment[];
}
/**
 * The presentation fragment ID of a surface's `ordinal`th fragment in a viewport: the three parts
 * joined by `/`, each URI-encoded, so IDs containing separators can never collide. It checks
 * nothing; {@link createViewOutput} refuses a fragment whose ID is not the one derived here.
 */
export declare function fragmentId(viewportId: Id, surfaceId: Id, ordinal: number): string;
/**
 * Validates fragments and orders them deterministically: back to front by depth, then by the
 * presentation priority of the surface and its owner (lower first), then by scene order (the
 * owner's place in the hierarchy and the surface's slot), then by ordinal and fragment ID. The
 * result depends only on the scene revision and the fragments themselves, never on the order they
 * were supplied in. Throws {@link SwfFailure} (`INVALID_INPUT`) naming the first problem: a
 * fragment of another viewport or of a surface not in the scene, an ID not derived by
 * {@link fragmentId}, a repeated ID, ordinals of a surface not running 0, 1, 2…, more than one
 * native owner per surface, or bounds, corners or depth that are not finite. The output is
 * frozen and holds a frozen shallow copy of each fragment; the array given is not changed.
 */
export declare function createViewOutput(scene: SceneState, viewportId: Id, fragments: readonly ProjectedFragment[]): ViewOutput;
/**
 * Why a view geometry is invalid, or null when it is valid: the first problem, naming the field
 * (`viewportId`, `width`, `height`, `devicePixelRatio`, `camera`, `near` or `far`). It never
 * throws, and does not check the projection's ID or configuration.
 */
export declare function viewGeometryIssue(view: ViewGeometry): string | null;
/**
 * The view a viewport shows in a scene: its size, its camera's placement and depth range, and its
 * projection setting. Throws {@link SwfFailure} (`UNKNOWN_ENTITY`) when the viewport, or its
 * camera, is not in the scene. The view is a new frozen value built from the scene's records; its
 * camera matrix has no scale.
 */
export declare function viewGeometryOf(scene: SceneState, viewportId: Id): ViewGeometry;
//# sourceMappingURL=fragments.d.ts.map