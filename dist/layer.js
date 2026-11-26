/** Marks a layer's content as drawing commands of the geometry renderer: its `kind`. */
export const GEOMETRY_LAYER = 'swf.geometry-layer';
/**
 * Whether a layer's content is a {@link GeometryLayer}: an object whose `kind` is
 * {@link GEOMETRY_LAYER}. Its `draw` and `after` are not checked.
 */
export function isGeometryLayer(content) {
    return (typeof content === 'object' &&
        content !== null &&
        content.kind === GEOMETRY_LAYER);
}
//# sourceMappingURL=layer.js.map