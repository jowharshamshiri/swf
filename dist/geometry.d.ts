import type { Aabb, Mat4, Vec3 } from '@swf/math';
import type { JsonValue } from './json.js';
/**
 * Describes a surface's presentation geometry, independently of what it shows. `params` is
 * JSON metadata interpreted by the provider registered for `kind`; the built-in kinds are `rect`
 * (no params) and `polygon` (`{ points: [[x, y], ...] }` in the surface's local frame).
 */
export interface GeometryDescriptor {
    /** The geometry kind: `rect`, `polygon`, or a registered `host.` or `ext.` kind. */
    readonly kind: string;
    /**
     * The kind's parameters as JSON (null when it takes none), within the workspace's
     * `maxParamsBytes` limit.
     */
    readonly params: JsonValue;
}
/** The default geometry: a `rect` filling the surface's bounds. The object is frozen. */
export declare const RECT_GEOMETRY: GeometryDescriptor;
/** Bounds on descriptor complexity, so a malformed or hostile descriptor cannot stall the page. */
export interface GeometryLimits {
    /** Largest UTF-8 size of a descriptor's params as JSON. Default 65536. */
    readonly maxParamsBytes: number;
    /** Most vertices a polygon may have. Default 1024. */
    readonly maxPolygonVertices: number;
}
/** The limits a workspace applies unless its options override them. The object is frozen. */
export declare const DEFAULT_GEOMETRY_LIMITS: GeometryLimits;
/**
 * How faithfully a geometry's intersection and UV mapping follow what is presented: `exact` when
 * they are the presented shape, `approximate` when they stand in for it.
 */
export type GeometryFidelity = 'exact' | 'approximate';
/** A ray in a surface's local frame. Its direction need not be unit length. */
export interface LocalRay {
    /** Where the ray starts, in the surface's local frame. */
    readonly origin: Vec3;
    /** Which way it goes, in the surface's local frame; non-zero. */
    readonly direction: Vec3;
}
/** Where a local ray meets a geometry: `t` is the ray parameter, `uv` has its origin top-left. */
export interface LocalHit {
    /** The ray parameter of the hit: `origin + t * direction` is the point; at least 0. */
    readonly t: number;
    /** The hit point in the surface's local frame. */
    readonly point: Vec3;
    /**
     * Where on the surface the hit is, in UV space with its origin top-left. The built-in kinds map
     * the surface rectangle to (0, 0) top-left through (1, 1) bottom-right.
     */
    readonly uv: readonly [number, number];
}
/**
 * Interprets one geometry kind. It sees only the descriptor and the surface's bounds, never the
 * surface's content. Every method must be deterministic and free of side effects.
 */
export interface GeometryProvider {
    /**
     * `host.<name>` or `ext.<extension-id>.<name>`; `rect` and `polygon` are built in. Registering a
     * kind that is not namespaced or is taken throws {@link SwfFailure} (`INVALID_INPUT`).
     */
    readonly kind: string;
    /** Whether intersection and UV mapping follow the presented shape exactly. */
    readonly fidelity: GeometryFidelity;
    /**
     * Why `params` are invalid for a surface of `bounds`, or null when they are valid. When it
     * throws or answers anything but text or null, the params are refused with `INVALID_INPUT` (or
     * `SNAPSHOT_INVALID` on a restore), naming the provider and quoting what it threw or answered.
     */
    validate(params: JsonValue, bounds: Vec3, limits: GeometryLimits): string | null;
    /** The geometry's box in the surface's local frame. */
    localBounds(params: JsonValue, bounds: Vec3): Aabb;
    /** The front normal in the local frame, or null when it varies across the geometry. */
    normal(params: JsonValue, bounds: Vec3): Vec3 | null;
    /** The nearest hit in front of the ray origin (t >= 0), or null. */
    intersect(params: JsonValue, bounds: Vec3, ray: LocalRay): LocalHit | null;
}
/**
 * A planar rectangle filling the surface's width and height, facing local +Z. It takes no params
 * (null).
 */
export declare const rectGeometry: GeometryProvider;
/**
 * A planar polygon on the surface, facing local +Z. Its UV space is the surface rectangle, so the
 * polygon masks part of what the surface shows rather than remapping it. Its params are exactly
 * `{ points }`: at least 3 and at most `maxPolygonVertices` `[x, y]` pairs in the local z = 0
 * plane (+Y up), each within the surface's bounds, enclosing a non-zero area with no two
 * non-adjacent edges touching.
 */
export declare const polygonGeometry: GeometryProvider;
/** The geometry kinds a workspace knows: the built-ins plus those the host registers. */
export declare class GeometryRegistry {
    #private;
    get(kind: string): GeometryProvider | undefined;
    /**
     * Adds a provider; throws a TypeError naming the problem when its kind is not namespaced, is
     * taken, or the provider is malformed. The returned function removes it (safe to call twice).
     */
    register(provider: GeometryProvider): () => void;
}
/** A surface's presentation geometry placed in the world, as rendering and picking must use it. */
export interface ResolvedGeometry {
    /** The surface placed (for a node frame, the node). */
    readonly surfaceId: string;
    /** The descriptor's kind, even when no provider is registered for it. */
    readonly kind: string;
    /**
     * False when no provider is registered for the kind: the geometry then falls back to the
     * surface rectangle and its fidelity is `approximate`, never claimed exact.
     */
    readonly supported: boolean;
    /** The provider's fidelity, or `approximate` when the kind is unsupported. */
    readonly fidelity: GeometryFidelity;
    /** Surface-local to world matrix: the owner's world matrix times the surface's transform. */
    readonly world: Mat4;
    /** The geometry's box in the surface's local frame. */
    readonly localBounds: Aabb;
    /** The world-aligned box enclosing `localBounds` placed in the world. */
    readonly worldBounds: Aabb;
    /** The front normal in world space, or null when it varies across the geometry. */
    readonly normal: Vec3 | null;
    /** The nearest hit of a world ray (unit direction) in front of its origin, or null. */
    intersect(ray: {
        readonly origin: Vec3;
        readonly direction: Vec3;
    }): WorldHit | null;
}
/** Where a world ray meets a placed geometry. */
export interface WorldHit {
    /**
     * Distance along the world ray: the ray parameter, a distance in world units when the ray's
     * direction is unit length.
     */
    readonly distance: number;
    /** The hit point in world coordinates. */
    readonly point: Vec3;
    /** The hit point in the surface's local frame. */
    readonly localPoint: Vec3;
    /** The hit's UV coordinates, as the geometry's provider maps them (origin top-left). */
    readonly uv: readonly [number, number];
}
/**
 * What is wrong with `params` for a surface of `bounds`, or null when they are valid: params over
 * the `maxParamsBytes` limit, or what `provider.validate` finds. A validate that throws or answers
 * anything but text or null is reported as the issue, naming the provider. Transactions and
 * restore both hold geometry to this one check.
 */
export declare function geometryParamsIssue(provider: GeometryProvider, params: JsonValue, bounds: Vec3, limits: GeometryLimits): string | null;
/** Places a descriptor in the world through `world`, the surface-local to world matrix. */
export declare function resolveGeometry(surfaceId: string, descriptor: GeometryDescriptor, bounds: Vec3, world: Mat4, registry: GeometryRegistry): ResolvedGeometry;
/** The size of a JSON value's text in UTF-8 bytes. */
export declare function jsonByteLength(value: JsonValue): number;
//# sourceMappingURL=geometry.d.ts.map