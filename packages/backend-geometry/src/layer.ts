/** Marks a layer's content as drawing commands of the geometry renderer. */
export const GEOMETRY_LAYER = 'swf.geometry-layer';

/**
 * A drawn layer: commands that draw it into a 2D canvas context set up in viewport CSS pixels.
 * Drawing is all it does: it reads nothing back and changes nothing else.
 */
export interface GeometryLayer {
  readonly kind: typeof GEOMETRY_LAYER;
  /**
   * For a layer of no fragment of its own (chrome, indicators): the planned fragment it stacks
   * right after, or null to stack above everything.
   */
  readonly after: string | null;
  draw(ctx: CanvasRenderingContext2D): void;
}

export function isGeometryLayer(content: unknown): content is GeometryLayer {
  return (
    typeof content === 'object' &&
    content !== null &&
    (content as { kind?: unknown }).kind === GEOMETRY_LAYER
  );
}
