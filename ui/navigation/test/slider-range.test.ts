import { describe, expect, it } from 'vitest';
import { sliderRange } from '../src/slider-range.js';

describe('a pose slider’s range', () => {
  const distance = { min: 2, max: 13.5, step: 0.1 };

  it('is its scale’s range while the value lies within it', () => {
    expect(sliderRange(6.3, distance)).toEqual({ min: 2, max: 13.5 });
    expect(sliderRange(13.5, distance)).toEqual({ min: 2, max: 13.5 });
  });

  it('reaches a value measured a rounding past its end, on the step’s grid', () => {
    // A distance measured back from a window's world position at the far wall: 13.5 and a hair.
    // Divided by the step it rounds to exactly 135, so the step it lies on is the next one.
    const past = 13.500000000000002;
    expect(past / distance.step).toBe(135);
    const range = sliderRange(past, distance);
    expect(range.max).toBe(13.6);
    expect(past).toBeLessThanOrEqual(range.max);
    const below = 1.9999999999999998;
    const low = sliderRange(below, distance);
    expect(low.min).toBe(1.9);
    expect(below).toBeGreaterThanOrEqual(low.min);
  });

  it('reaches a value beyond its scale to the step past it', () => {
    expect(sliderRange(15.23, distance)).toEqual({ min: 2, max: 15.3 });
    expect(sliderRange(-0.37, { min: 0.1, max: 8, step: 0.05 })).toEqual({ min: -0.4, max: 8 });
  });
});
