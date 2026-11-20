import type {
  ComposedFrame,
  Compositor,
  RenderedFrame,
  RendererBackend,
  RendererSession,
  RenderFrame,
} from '@swf/presentation';
import { describe, expect, it } from 'vitest';
import type { BackendFixture } from '../src/index.js';
import {
  backendConformance,
  MOCK_COMPOSITOR_CAPABILITIES,
  MOCK_RENDERER_CAPABILITIES,
  MockCompositor,
  MockRenderer,
  runConformance,
} from '../src/index.js';

/** A renderer whose sessions post-process what the reference renderer produced. */
function brokenRenderer(
  change: (frame: RenderedFrame, call: number) => RenderedFrame,
  options: { renderAfterRelease?: boolean } = {},
): RendererBackend {
  const inner = new MockRenderer();
  return {
    id: inner.id,
    apiVersion: inner.apiVersion,
    capabilities: () => inner.capabilities(),
    async prepare(scene, view) {
      const session = await inner.prepare(scene, view);
      let calls = 0;
      let released = false;
      const wrapped: RendererSession = {
        rendererId: session.rendererId,
        viewportId: session.viewportId,
        render(frame: RenderFrame) {
          if (released && options.renderAfterRelease === true) {
            return { viewportId: frame.viewportId, sceneRevision: frame.sceneRevision, layers: [] };
          }
          calls += 1;
          return change(session.render(frame), calls);
        },
        release() {
          released = true;
          return session.release();
        },
      };
      return wrapped;
    },
  };
}

function brokenCompositor(change: (frame: ComposedFrame) => ComposedFrame): Compositor {
  const inner = new MockCompositor();
  return {
    id: inner.id,
    apiVersion: inner.apiVersion,
    capabilities: () => inner.capabilities(),
    async prepare(target, renderer) {
      const session = await inner.prepare(target, renderer);
      return {
        compositorId: session.compositorId,
        viewportId: session.viewportId,
        compose: (frame: RenderedFrame) => change(session.compose(frame)),
        release: () => session.release(),
      };
    },
  };
}

function fixture(
  renderer: () => RendererBackend,
  compositor: () => Compositor = () => new MockCompositor(),
): BackendFixture {
  return { renderer, compositor };
}

async function failed(f: BackendFixture): Promise<string[]> {
  return (await runConformance(backendConformance(f)))
    .filter((r) => r.outcome === 'failed')
    .map((r) => `${r.name} :: ${String(r.message)}`);
}

describe('backend conformance suite', () => {
  it('passes the reference renderer and compositor, at full and at limited capabilities', async () => {
    const domOnly = {
      ...MOCK_RENDERER_CAPABILITIES,
      handleKinds: { 'native-dom': 'approximate' as const },
      layering: 'dom' as const,
      transformMode: 'perspective-3d' as const,
      clipping: 'rect' as const,
    };
    const noNative = {
      ...MOCK_COMPOSITOR_CAPABILITIES,
      directNative: false,
      layerCategories: ['content-raster', 'proxy', 'placeholder', 'chrome', 'overlay'] as const,
    };
    for (const f of [
      fixture(() => new MockRenderer()),
      fixture(() => new MockRenderer('dom.renderer/1', domOnly)),
      fixture(
        () => new MockRenderer(),
        () => new MockCompositor('raster.compositor/1', noNative),
      ),
    ]) {
      const results = await runConformance(backendConformance(f));
      expect(results).toHaveLength(8);
      expect(results.filter((r) => r.outcome !== 'passed')).toEqual([]);
    }
  });

  it('catches a renderer that drops a fragment', async () => {
    const f = fixture(() =>
      brokenRenderer((frame) => ({ ...frame, layers: frame.layers.slice(1) })),
    );
    expect(await failed(f)).toContainEqual(
      expect.stringMatching(
        /^realizes every planned fragment exactly once.* :: fragment ".*" was realized 0 times/,
      ),
    );
  });

  it('catches a renderer that mounts every fragment as live content', async () => {
    const f = fixture(() =>
      brokenRenderer((frame) => ({
        ...frame,
        layers: frame.layers.map((l) => ({ ...l, category: 'content-native' as const })),
      })),
    );
    const messages = await failed(f);
    expect(messages).toContainEqual(
      expect.stringMatching(
        /^realizes every planned fragment .* went in a content-native layer, but negotiation chose/,
      ),
    );
    expect(messages).toContainEqual(
      expect.stringMatching(
        /^never mounts one surface’s live element twice :: a surface has more than one native content layer/,
      ),
    );
  });

  it('catches a renderer whose order does not follow the plan, or changes between renders', async () => {
    const reversed = fixture(() =>
      brokenRenderer((frame) => ({ ...frame, layers: [...frame.layers].reverse() })),
    );
    expect(await failed(reversed)).toEqual([
      expect.stringMatching(
        /^orders layers by the plan.* :: content layers do not follow the plan order/,
      ),
    ]);
    const unstable = fixture(() =>
      brokenRenderer((frame, call) => ({
        ...frame,
        layers: call % 2 === 0 ? [...frame.layers].reverse() : frame.layers,
      })),
    );
    expect(await failed(unstable)).toContainEqual(
      expect.stringMatching(/^orders layers by the plan.* :: the same frame rendered differently/),
    );
  });

  it('catches a renderer that names the wrong surface for a fragment', async () => {
    const f = fixture(() =>
      brokenRenderer((frame) => ({
        ...frame,
        layers: frame.layers.map((l) => ({ ...l, surfaceId: 'live' })),
      })),
    );
    expect(await failed(f)).toContainEqual(
      expect.stringMatching(
        /^realizes every planned fragment .* :: the layer of fragment ".*" names surface "live"/,
      ),
    );
  });

  it('catches a renderer session that still renders after release', async () => {
    const f = fixture(() => brokenRenderer((frame) => frame, { renderAfterRelease: true }));
    expect(await failed(f)).toEqual([
      expect.stringMatching(
        /^releases sessions more than once safely .* :: a released renderer session still rendered/,
      ),
    ]);
  });

  it('catches a compositor that reorders while declaring explicit ordering, or drops a layer', async () => {
    const reorders = fixture(
      () => new MockRenderer(),
      () => brokenCompositor((c) => ({ ...c, order: [...c.order].reverse() })),
    );
    expect(await failed(reorders)).toEqual([
      expect.stringMatching(
        /^composes every layer once.* :: an explicit-ordering compositor changed the order/,
      ),
    ]);
    const drops = fixture(
      () => new MockRenderer(),
      () => brokenCompositor((c) => ({ ...c, order: c.order.slice(1) })),
    );
    expect(await failed(drops)).toEqual([
      expect.stringMatching(
        /^composes every layer once.* :: the composed frame does not hold each rendered layer exactly once/,
      ),
    ]);
  });

  it('catches a renderer that declares impossible capabilities', async () => {
    const f = fixture(
      () =>
        new MockRenderer('bad.renderer/1', { ...MOCK_RENDERER_CAPABILITIES, layering: 'raster' }),
    );
    expect((await failed(f))[0]).toMatch(
      /^registers a renderer and a compositor.* :: .*native-dom handles need a DOM layer/,
    );
  });
});
