/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest';

// Every package's source, as text.
const sources = import.meta.glob<string>('../../*/src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Ways of reading rendered pixels back to the CPU. None may be part of presenting a frame. */
const READBACK: readonly [string, RegExp][] = [
  ['getImageData', /\bgetImageData\b/],
  ['readPixels', /\breadPixels\b/],
  ['toDataURL', /\btoDataURL\b/],
  ['toBlob', /\btoBlob\b/],
  ['convertToBlob', /\bconvertToBlob\b/],
  ['copyExternalImageToTexture readback', /\bmapAsync\b/],
];

describe('no CPU framebuffer readback (ARCH-014)', () => {
  it('appears nowhere in the framework', () => {
    const files = Object.entries(sources);
    expect(files.length).toBeGreaterThan(40);
    expect(
      files.flatMap(([path, text]) =>
        READBACK.flatMap(([name, pattern]) => (pattern.test(text) ? [`${path}: ${name}`] : [])),
      ),
    ).toEqual([]);
  });

  it('would be caught in each form', () => {
    const samples = [
      'ctx.getImageData(0, 0, 1, 1)',
      'gl.readPixels(0, 0, 1, 1, f, t, b)',
      'canvas.toDataURL()',
      'canvas.toBlob(cb)',
      'offscreen.convertToBlob()',
      'buffer.mapAsync(GPUMapMode.READ)',
    ];
    samples.forEach((sample, i) => {
      expect(READBACK[i]?.[1].test(sample)).toBe(true);
    });
  });
});
