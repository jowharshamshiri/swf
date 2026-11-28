/** A slider's scale: its usual range and its step. */
export interface SliderScale {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

/**
 * A slider's range for a value: its scale's range, reaching past either end to the step's grid line
 * beyond the value where the value lies outside it, so the value is always within the range. A
 * value measured from the scene (a distance taken back from a world position) can lie a rounding
 * past an end its place keeps to; the grid line is taken past it whatever the division of the
 * value by the step rounds to.
 */
export function sliderRange(
  value: number,
  { min, max, step }: SliderScale,
): { min: number; max: number } {
  const decimals = String(step).split('.')[1]?.length ?? 0;
  const grid = (n: number) => Number((n * step).toFixed(decimals));
  let below = Math.floor(value / step);
  while (grid(below) > value) {
    below -= 1;
  }
  let above = Math.ceil(value / step);
  while (grid(above) < value) {
    above += 1;
  }
  return { min: Math.min(min, grid(below)), max: Math.max(max, grid(above)) };
}
