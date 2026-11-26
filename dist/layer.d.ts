/** Marks a layer's content as drawing commands of the geometry renderer: its `kind`. */
export declare const GEOMETRY_LAYER = "swf.geometry-layer";
/**
 * A drawn layer: commands that draw it into a 2D canvas context set up in viewport CSS pixels.
 * Drawing is all it does: it reads nothing back and changes nothing else.
 */
export interface GeometryLayer {
    /** Always {@link GEOMETRY_LAYER}, by which {@link isGeometryLayer} tells it apart. */
    readonly kind: typeof GEOMETRY_LAYER;
    /**
     * For a layer of no fragment of its own (chrome, indicators): the planned fragment it stacks
     * right after, or null to stack above everything.
     */
    readonly after: string | null;
    /**
     * Draws the layer into `ctx`, whose transform maps viewport CSS pixels to the canvas's device
     * pixels. The caller saves and restores the context's state around it.
     */
    draw(ctx: CanvasRenderingContext2D): void;
}
/**
 * Whether a layer's content is a {@link GeometryLayer}: an object whose `kind` is
 * {@link GEOMETRY_LAYER}. Its `draw` and `after` are not checked.
 */
export declare function isGeometryLayer(content: unknown): content is GeometryLayer;
//# sourceMappingURL=layer.d.ts.map