import type { Vec2 } from '@swf/math';

/**
 * Content an adapter supplies for drawing: an image source a canvas can draw, with its size in
 * pixels. The geometry backend draws it; it never reads its pixels back.
 */
export interface Drawable {
  /**
   * What is drawn: an image, a canvas, a video frame or a bitmap. It stays the adapter's; the
   * renderer draws from it each time the layer is drawn.
   */
  readonly source: CanvasImageSource;
  /** The source's width, in its own pixels: positive and finite. */
  readonly width: number;
  /** The source's height, in its own pixels: positive and finite. */
  readonly height: number;
  /**
   * Changes whenever the drawable's pixels change, so the renderer redraws it only then. A
   * drawable without one (live media, say) is redrawn every frame.
   */
  readonly revision?: number;
}

/**
 * Why a value is not a drawable, in words, or null when it is: an object with an object
 * `source`, a positive finite `width` and `height`, and a finite `revision` when it has one.
 */
export function drawableIssue(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) {
    return 'a drawable must be an object { source, width, height }';
  }
  // Drawables come from adapters, which may be plain JavaScript: nothing is assumed.
  const d = value as Readonly<Record<string, unknown>>;
  if (typeof d['source'] !== 'object' || d['source'] === null) {
    return 'a drawable needs an image source';
  }
  for (const key of ['width', 'height'] as const) {
    const v = d[key];
    if (typeof v !== 'number' || !(v > 0) || !Number.isFinite(v)) {
      return `a drawable's ${key} must be a positive finite number`;
    }
  }
  const revision = d['revision'];
  if (revision !== undefined && (typeof revision !== 'number' || !Number.isFinite(revision))) {
    return "a drawable's revision must be a finite number when given";
  }
  return null;
}

/** Traces a closed outline through the points. */
export function outline(ctx: CanvasRenderingContext2D, points: readonly Vec2[]): void {
  const [first, ...rest] = points;
  if (first === undefined) {
    return;
  }
  ctx.beginPath();
  ctx.moveTo(first[0], first[1]);
  for (const [x, y] of rest) {
    ctx.lineTo(x, y);
  }
  ctx.closePath();
}
