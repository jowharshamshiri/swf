/**
 * How faithfully a surface's placement follows its projected geometry, best first: placed by the
 * platform itself (`native`), matched exactly, approximated, shown only as a proxy, or not at all.
 * {@link FIDELITY_ORDER} ranks them.
 */
export type Fidelity = 'native' | 'exact' | 'approximate' | 'proxy' | 'unsupported';
/**
 * How an adapter's endpoint is attached: as a live browser element in a native layer, as a
 * drawable resource a geometry backend can render, or only as a representational proxy.
 */
export type AttachStrategy = 'native-dom' | 'drawable' | 'proxy-only';
/**
 * How much of the endpoint's own interaction stays native: all of it, some of it, or none.
 * {@link INTERACTION_ORDER} ranks them.
 */
export type InteractionSupport = 'full' | 'partial' | 'none';
/**
 * What resizing the adapter handles: none, spatial bounds only, or also a requested intrinsic
 * presentation size.
 */
export type ResizeHandling = 'none' | 'spatial' | 'intrinsic';
/** Whether one handle may be shown in several viewports at once, or has a single owner. */
export type ViewportSharing = 'shared' | 'single-owner';
/**
 * What an adapter can do with an endpoint, each capability advertised independently. An adapter
 * declares the most it offers at registration; each resolved handle reports its own, which must
 * not exceed the declaration ({@link exceededCapabilities}). Every field is required, and a
 * descriptor must not contradict itself: {@link capabilitiesIssue} states the rules. The runtime
 * keeps a frozen copy of every descriptor it accepts.
 */
export interface SurfaceCapabilities {
    /**
     * How the endpoint is attached. A handle's strategy must equal its adapter's declared one, and
     * only `native-dom` may claim native interaction or native transform fidelity.
     */
    readonly attachStrategy: AttachStrategy;
    /** How much of the endpoint's own input stays native; above `none` needs `native-dom`. */
    readonly nativeInteraction: InteractionSupport;
    /**
     * Pointer positions can be addressed as surface UV coordinates. A `proxy-only` endpoint cannot
     * offer it.
     */
    readonly uvAddressing: boolean;
    /**
     * How faithfully the attachment follows the projected geometry. `native` needs `native-dom`; a
     * `proxy-only` endpoint offers at best `proxy`.
     */
    readonly transformFidelity: Fidelity;
    /** The endpoint's content may be transparent, so what lies behind it can show through. */
    readonly transparency: boolean;
    /** The attachment can be clipped to a region of the surface. */
    readonly clipping: boolean;
    /** The adapter maps the cursor's position and shape onto the endpoint; needs `uvAddressing`. */
    readonly cursorMapping: boolean;
    /** Which sizes the adapter follows when they change. */
    readonly resize: ResizeHandling;
    /**
     * Whether the handle may be shown in several viewports at once. A `single-owner` handle is
     * presented in one viewport at a time, and its endpoint by one surface at a time.
     */
    readonly viewportSharing: ViewportSharing;
    /** The presentation attachment can be released while hidden without harming the endpoint. */
    readonly safeDetach: boolean;
    /** A released attachment can be attached again later; needs `safeDetach`. */
    readonly rebinding: boolean;
    /** The adapter can supply its own placeholder while unbound. */
    readonly placeholder: boolean;
    /** The adapter takes part in workspace snapshots through extension hooks. */
    readonly snapshotHooks: boolean;
}
/** Fidelity levels, worst first; frozen. */
export declare const FIDELITY_ORDER: readonly Fidelity[];
/** Interaction support levels, least first; frozen. */
export declare const INTERACTION_ORDER: readonly InteractionSupport[];
/** Every attach strategy, in no rank order: none is better than another; frozen. */
export declare const ATTACH_STRATEGIES: readonly AttachStrategy[];
/**
 * Why a capability descriptor is malformed or self-contradictory, or null when it is valid.
 * Every field is required; unknown fields are rejected. The reason names the field, as
 * `capabilities.<field> ...`, or states the contradiction: native interaction or native fidelity
 * without `native-dom`; a `proxy-only` endpoint claiming better than proxy fidelity or UV
 * addressing; cursor mapping without UV addressing; rebinding without safe detachment.
 */
export declare function capabilitiesIssue(value: unknown): string | null;
/**
 * The capabilities in `actual` that exceed `declared`, by field name, in the order of
 * {@link SurfaceCapabilities}' fields. Empty when `actual` stays within the declaration: the same
 * attach strategy, no ranked capability better than declared (`single-owner` ranks below
 * `shared`), and no boolean capability true that the declaration leaves false. Both descriptors
 * are taken to be valid. Returns a fresh array.
 */
export declare function exceededCapabilities(declared: SurfaceCapabilities, actual: SurfaceCapabilities): string[];
/** A frozen copy of a valid descriptor, so later mutation by its author cannot change it. */
export declare function freezeCapabilities(c: SurfaceCapabilities): SurfaceCapabilities;
//# sourceMappingURL=capabilities.d.ts.map