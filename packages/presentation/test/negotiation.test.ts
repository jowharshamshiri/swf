import {
  MOCK_COMPOSITOR_CAPABILITIES,
  MOCK_RENDERER_CAPABILITIES,
  mockCapabilities,
} from '@swf/conformance';
import type { SurfaceCapabilities } from '@swf/surfaces';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type {
  CompositorCapabilities,
  NegotiationInput,
  PresentationMode,
  ProjectionProfile,
  RendererCapabilities,
} from '../src/index.js';
import {
  compositorCapabilitiesIssue,
  fallbackPolicy,
  negotiate,
  PRESENTATION_MODES,
  projectionProfileIssue,
  rendererCapabilitiesIssue,
} from '../src/index.js';

const PERSPECTIVE: ProjectionProfile = {
  id: 'test.perspective/1',
  seamWrapping: false,
  exactInverse: true,
};
const PANORAMA: ProjectionProfile = {
  id: 'test.panorama/1',
  seamWrapping: true,
  exactInverse: true,
};
const DRAWN = mockCapabilities({
  attachStrategy: 'drawable',
  nativeInteraction: 'none',
  transformFidelity: 'exact',
  viewportSharing: 'shared',
});
const PROXY_ONLY = mockCapabilities({
  attachStrategy: 'proxy-only',
  nativeInteraction: 'none',
  transformFidelity: 'proxy',
  uvAddressing: false,
  cursorMapping: false,
});

function input(over: Partial<NegotiationInput> = {}): NegotiationInput {
  return {
    surfaceId: 's',
    viewportId: 'v',
    surface: mockCapabilities(),
    renderer: { id: 'r/1', capabilities: MOCK_RENDERER_CAPABILITIES },
    compositor: { id: 'c/1', capabilities: MOCK_COMPOSITOR_CAPABILITIES },
    projection: PERSPECTIVE,
    geometry: { kind: 'rect', supported: true, fidelity: 'exact' },
    anchor: 'exact',
    owner: true,
    ...over,
  };
}

const renderer = (over: Partial<RendererCapabilities>) => ({
  id: 'r/1',
  capabilities: { ...MOCK_RENDERER_CAPABILITIES, ...over },
});
const compositor = (over: Partial<CompositorCapabilities>) => ({
  id: 'c/1',
  capabilities: { ...MOCK_COMPOSITOR_CAPABILITIES, ...over },
});

describe('capability descriptors', () => {
  it('accepts the reference descriptors and rejects contradictions, naming the field', () => {
    expect(rendererCapabilitiesIssue(MOCK_RENDERER_CAPABILITIES)).toBeNull();
    expect(compositorCapabilitiesIssue(MOCK_COMPOSITOR_CAPABILITIES)).toBeNull();
    expect(
      rendererCapabilitiesIssue({ ...MOCK_RENDERER_CAPABILITIES, layering: 'raster' }),
    ).toMatch(/native-dom handles need a DOM layer/);
    expect(rendererCapabilitiesIssue({ ...MOCK_RENDERER_CAPABILITIES, layering: 'dom' })).toMatch(
      /drawable handles need a raster layer/,
    );
    // A card is scaled: exact presentation takes transforms that scale, no more.
    expect(
      rendererCapabilitiesIssue({
        ...MOCK_RENDERER_CAPABILITIES,
        handleKinds: { drawable: 'exact' },
        transformMode: 'translate',
      }),
    ).toMatch(/drawable content cannot be exact with translate transforms/);
    expect(
      rendererCapabilitiesIssue({
        ...MOCK_RENDERER_CAPABILITIES,
        handleKinds: { 'native-dom': 'exact' },
        transformMode: 'affine-2d',
      }),
    ).toBeNull();
    expect(
      rendererCapabilitiesIssue({
        ...MOCK_RENDERER_CAPABILITIES,
        handleKinds: { drawable: 'native' },
      }),
    ).toMatch(/only native-dom content/);
    expect(rendererCapabilitiesIssue({ ...MOCK_RENDERER_CAPABILITIES, handleKinds: {} })).toMatch(
      /at least one handle kind/,
    );
    expect(rendererCapabilitiesIssue({ ...MOCK_RENDERER_CAPABILITIES, shaders: true })).toMatch(
      /shaders is not a known capability/,
    );
    expect(
      compositorCapabilitiesIssue({
        ...MOCK_COMPOSITOR_CAPABILITIES,
        layerCategories: ['content-native', 'chrome'],
      }),
    ).toMatch(/must include placeholder/);
    expect(
      compositorCapabilitiesIssue({ ...MOCK_COMPOSITOR_CAPABILITIES, directNative: false }),
    ).toMatch(/content-native layer and direct native/);
    expect(
      compositorCapabilitiesIssue({ ...MOCK_COMPOSITOR_CAPABILITIES, overlays: false }),
    ).toMatch(/overlay layer and overlay support/);
    expect(projectionProfileIssue(PANORAMA)).toBeNull();
    expect(projectionProfileIssue({ ...PANORAMA, id: 'panorama' })).toMatch(/versioned ID/);
  });
});

describe('negotiation', () => {
  it('presents a live element natively under a perspective projection', () => {
    expect(negotiate(input())).toMatchObject({
      mode: 'native',
      anchorFidelity: 'exact',
      shapeFidelity: 'exact',
      contentFidelity: 'native',
      interaction: 'full',
      layer: 'content-native',
    });
  });

  it('presents a live element natively in a panorama too: its card is never bent', () => {
    expect(negotiate(input({ projection: PANORAMA }))).toMatchObject({
      mode: 'native',
      anchorFidelity: 'exact',
      shapeFidelity: 'exact',
      contentFidelity: 'native',
      interaction: 'full',
      layer: 'content-native',
    });
  });

  it('approximates a window whose place the card only approximates, saying its anchor is not exact', () => {
    // A window carrying a rotation of its own, drawn on an upright card.
    const result = negotiate(input({ projection: PANORAMA, anchor: 'approximate' }));
    expect(result).toMatchObject({
      mode: 'approximated',
      anchorFidelity: 'approximate',
      shapeFidelity: 'approximate',
      contentFidelity: 'native',
      interaction: 'full',
      layer: 'content-native',
    });
    expect(result.fallback).toMatchObject({
      code: 'PRESENTATION_FALLBACK',
      preferred: 'exact',
      chosen: 'approximated',
      projectionId: PANORAMA.id,
    });
    expect(result.fallback?.gaps).toContainEqual({
      mode: 'native',
      requirement: 'projection',
      detail: 'the projected placement is approximate',
    });
    expect(result.fallback?.message).toMatch(/presented as approximated .* instead of exact/);
  });

  it('draws drawable content exactly on its card with transforms that scale it, approximating it otherwise', () => {
    for (const transformMode of ['affine-2d', 'perspective-3d', 'mesh'] as const) {
      expect(
        negotiate(
          input({ surface: DRAWN, projection: PANORAMA, renderer: renderer({ transformMode }) }),
        ),
      ).toMatchObject({
        mode: 'exact',
        shapeFidelity: 'exact',
        contentFidelity: 'exact',
        layer: 'content-raster',
        interaction: 'none',
        fallback: null,
      });
    }
    const moved = negotiate(
      input({
        surface: DRAWN,
        projection: PANORAMA,
        renderer: renderer({
          transformMode: 'translate',
          handleKinds: { 'native-dom': 'native', drawable: 'approximate', 'proxy-only': 'proxy' },
        }),
      }),
    );
    expect(moved).toMatchObject({
      mode: 'approximated',
      shapeFidelity: 'approximate',
      contentFidelity: 'approximate',
      layer: 'content-raster',
    });
    expect(moved.fallback?.gaps).toContainEqual({
      mode: 'exact',
      requirement: 'renderer',
      detail: 'its translate transforms cannot scale a card',
    });
  });

  it('falls back to a proxy for a secondary fragment or a proxy-only endpoint, and to a placeholder when unbound', () => {
    expect(negotiate(input({ owner: false }))).toMatchObject({
      mode: 'proxy',
      layer: 'proxy',
      contentFidelity: 'proxy',
      interaction: 'none',
    });
    expect(negotiate(input({ owner: false })).fallback?.gaps).toContainEqual(
      expect.objectContaining({ mode: 'native', requirement: 'ownership' }),
    );
    expect(negotiate(input({ surface: PROXY_ONLY }))).toMatchObject({ mode: 'proxy' });
    expect(negotiate(input({ surface: null }))).toMatchObject({
      mode: 'placeholder',
      layer: 'placeholder',
      shapeFidelity: 'none',
      contentFidelity: 'unsupported',
    });
    const noProxy = compositor({
      layerCategories: ['content-native', 'content-raster', 'placeholder', 'chrome', 'overlay'],
    });
    expect(negotiate(input({ surface: PROXY_ONLY, compositor: noProxy }))).toMatchObject({
      mode: 'placeholder',
    });
  });

  it('accounts for geometry, clipping, transparency and an approximate anchor', () => {
    const polygon = { kind: 'polygon', supported: true, fidelity: 'exact' as const };
    expect(negotiate(input({ geometry: polygon })).mode).toBe('native');
    const rectClip = negotiate(
      input({ geometry: polygon, renderer: renderer({ clipping: 'rect' }) }),
    );
    expect(rectClip.mode).toBe('approximated');
    expect(rectClip.fallback?.gaps).toContainEqual({
      mode: 'native',
      requirement: 'renderer',
      detail: 'a polygon needs path clipping',
    });
    expect(
      negotiate(
        input({ geometry: { kind: 'host.sphere', supported: false, fidelity: 'approximate' } }),
      ).mode,
    ).toBe('approximated');
    expect(negotiate(input({ compositor: compositor({ transparency: false }) })).mode).toBe(
      'approximated',
    );
    expect(negotiate(input({ anchor: 'approximate' }))).toMatchObject({
      mode: 'approximated',
      anchorFidelity: 'approximate',
    });
  });

  it('follows a configured policy, which must end with placeholder', () => {
    const noApproximation = fallbackPolicy(['exact', 'native', 'proxy', 'placeholder']);
    expect(negotiate(input({ anchor: 'approximate' }), noApproximation).mode).toBe('proxy');
    expect(negotiate(input(), fallbackPolicy(['proxy', 'placeholder']))).toMatchObject({
      mode: 'proxy',
      fallback: null,
    });
    expect(() => fallbackPolicy(['native', 'proxy'])).toThrow(/must end with placeholder/);
    expect(() => fallbackPolicy(['native', 'native', 'placeholder'])).toThrow(/repeats native/);
    expect(() => fallbackPolicy(['warp' as PresentationMode, 'placeholder'])).toThrow(
      /not a presentation mode/,
    );
    expect(() => fallbackPolicy([])).toThrow(/at least one mode/);
  });

  it('groups identical fallbacks under one key', () => {
    const a = negotiate(input({ surfaceId: 'a', anchor: 'approximate' })).fallback;
    const b = negotiate(input({ surfaceId: 'b', anchor: 'approximate' })).fallback;
    const c = negotiate(input({ surfaceId: 'c', owner: false })).fallback;
    expect(a?.groupKey).toBe(b?.groupKey);
    expect(a?.groupKey).not.toBe(c?.groupKey);
  });
});

describe('negotiation honesty', () => {
  const surface: fc.Arbitrary<SurfaceCapabilities | null> = fc.option(
    fc.constantFrom(
      mockCapabilities(),
      DRAWN,
      PROXY_ONLY,
      mockCapabilities({ transparency: false }),
      {
        ...DRAWN,
        transformFidelity: 'approximate' as const,
      },
    ),
    { nil: null },
  );
  const rendererCaps: fc.Arbitrary<RendererCapabilities> = fc
    .record({
      dom: fc.option(fc.constantFrom('native', 'approximate', 'proxy' as const), {
        nil: undefined,
      }),
      drawn: fc.option(fc.constantFrom('exact', 'approximate', 'proxy' as const), {
        nil: undefined,
      }),
      transformMode: fc.constantFrom('translate', 'affine-2d', 'perspective-3d', 'mesh' as const),
      clipping: fc.constantFrom('none', 'rect', 'path' as const),
    })
    .map(({ dom, drawn, transformMode, clipping }) => ({
      ...MOCK_RENDERER_CAPABILITIES,
      handleKinds: {
        ...(dom === undefined ? {} : { 'native-dom': dom }),
        ...(drawn === undefined ? {} : { drawable: drawn }),
        'proxy-only': 'proxy' as const,
      },
      transformMode,
      clipping,
    }))
    // Translation alone cannot draw anything exactly: such a renderer declares nothing exact.
    .filter((r) => rendererCapabilitiesIssue(r) === null);
  const compositorCaps: fc.Arbitrary<CompositorCapabilities> = fc
    .record({
      direct: fc.boolean(),
      raster: fc.boolean(),
      proxy: fc.boolean(),
      transparency: fc.boolean(),
      clipping: fc.constantFrom('none', 'rect', 'path' as const),
    })
    .map(({ direct, raster, proxy, transparency, clipping }) => ({
      ...MOCK_COMPOSITOR_CAPABILITIES,
      directNative: direct,
      transparency,
      clipping,
      layerCategories: [
        ...(direct ? (['content-native'] as const) : []),
        ...(raster ? (['content-raster'] as const) : []),
        ...(proxy ? (['proxy'] as const) : []),
        'placeholder' as const,
        'chrome' as const,
        'overlay' as const,
      ],
    }));
  const policy = fc
    .subarray(['exact', 'native', 'approximated', 'proxy'] as PresentationMode[])
    .map((modes) => fallbackPolicy([...modes, 'placeholder']));

  it('never labels an approximation exact, and only gives live content to the owner', () => {
    fc.assert(
      fc.property(
        surface,
        rendererCaps,
        compositorCaps,
        fc.constantFrom(PERSPECTIVE, PANORAMA),
        fc.constantFrom('rect', 'polygon', 'host.custom'),
        fc.boolean(),
        fc.constantFrom('exact', 'approximate' as const),
        fc.boolean(),
        policy,
        (s, r, c, projection, kind, supported, anchor, owner, order) => {
          expect(rendererCapabilitiesIssue(r)).toBeNull();
          expect(compositorCapabilitiesIssue(c)).toBeNull();
          const result = negotiate(
            input({
              surface: s,
              renderer: { id: 'r/1', capabilities: r },
              compositor: { id: 'c/1', capabilities: c },
              projection,
              geometry: { kind, supported, fidelity: supported ? 'exact' : 'approximate' },
              anchor,
              owner,
            }),
            order,
          );
          const live =
            result.mode === 'exact' || result.mode === 'native' || result.mode === 'approximated';
          if (result.shapeFidelity === 'exact') {
            expect(['exact', 'native']).toContain(result.mode);
          }
          if (result.contentFidelity === 'exact') {
            expect(result.mode).toBe('exact');
          }
          if (result.mode === 'exact' || result.mode === 'native') {
            // Whatever the projection: only the card's scale and place matter.
            expect(r.transformMode).not.toBe('translate');
            expect(anchor).toBe('exact');
          }
          if (result.mode === 'native') {
            expect(s?.attachStrategy).toBe('native-dom');
            expect(c.directNative).toBe(true);
          }
          if (result.mode === 'exact') {
            expect(s?.attachStrategy).toBe('drawable');
            expect(r.handleKinds.drawable).toBe('exact');
            expect(anchor).toBe('exact');
            expect(supported).toBe(true);
          }
          if (live) {
            expect(owner).toBe(true);
            expect(s).not.toBeNull();
            expect(c.layerCategories).toContain(result.layer);
          }
          if (result.mode !== 'exact' && result.mode !== 'native') {
            expect(result.shapeFidelity).not.toBe('exact');
          }
          if (result.anchorFidelity === 'exact') {
            expect(anchor).toBe('exact');
          }
          expect(c.layerCategories).toContain(result.layer);
          const preferred = order.order[0];
          expect(result.fallback === null).toBe(result.mode === preferred);
          const chosenAt = order.order.indexOf(result.mode);
          for (const gap of result.fallback?.gaps ?? []) {
            expect(order.order.indexOf(gap.mode)).toBeLessThan(chosenAt);
          }
        },
      ),
      { numRuns: 2000 },
    );
  });

  it('lists every mode in the default order, best first', () => {
    expect(PRESENTATION_MODES).toEqual(['exact', 'native', 'approximated', 'proxy', 'placeholder']);
  });
});
