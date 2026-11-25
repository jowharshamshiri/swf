import {
  ManualFrames,
  MOCK_COMPOSITOR_CAPABILITIES,
  MockCompositor,
  MockOpaqueAdapter,
  MockRenderer,
} from '@swf/conformance';
import type { SceneCommand, SwfError } from '@swf/core';
import { createWorkspace, SwfFailure, surfaceEffectiveState } from '@swf/core';
import type { ProjectedFragment, ViewProjector } from '@swf/presentation';
import { createPresentationRegistry, createPresenter, fragmentId } from '@swf/presentation';
import { createSurfaceRuntime } from '@swf/surfaces';
import { describe, expect, it } from 'vitest';
import { createDiagnostics } from '../src/index.js';

/** A flat projection: a window at x shows as a 100×60 box, 100 px per unit from the centre. */
const flat: ViewProjector = {
  profile: { id: 'test.flat/1', mapping: 'affine', seamWrapping: false, exactInverse: true },
  project(scene, view) {
    const out: ProjectedFragment[] = [];
    for (const surface of scene.surfaces.values()) {
      const node = scene.nodes.get(surface.ownerNodeId);
      if (node === undefined || surfaceEffectiveState(scene, surface.id)?.visible !== true) {
        continue;
      }
      const left = view.width / 2 + node.transform.position[0] * 100 - 50;
      if (left + 100 <= 0 || left >= view.width) {
        continue;
      }
      out.push({
        id: fragmentId(view.viewportId, surface.id, 0),
        surfaceId: surface.id,
        viewportId: view.viewportId,
        ordinal: 0,
        bounds: [Math.max(0, left), 170, Math.min(view.width, left + 100) - Math.max(0, left), 60],
        corners: null,
        depth: 3,
        geometricFidelity: 'exact',
        nativeOwner: true,
      });
    }
    return out;
  },
};

function windowAt(id: string, x: number, adapterTypeId = 'test.view/1'): SceneCommand[] {
  return [
    {
      type: 'node.create',
      node: {
        id,
        kind: 'window',
        bounds: [1, 0.6, 0.01],
        transform: { position: [x, 0, -3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
    },
    {
      type: 'surface.attach',
      surface: {
        id: `${id}-s`,
        ownerNodeId: id,
        bindingKey: `key-${id}`,
        adapterTypeId,
        bounds: [1, 0.6, 0.01],
      },
    },
  ];
}

const settle = () =>
  new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve();
    }, 0);
  });

async function rig() {
  const clock = { now: 1000 };
  const ws = createWorkspace({
    id: 'ws',
    projectionKinds: [{ id: 'test.flat/1', configIssue: () => null }],
  });
  const result = ws.transaction([
    { type: 'camera.create', camera: { id: 'cam' } },
    {
      type: 'viewport.create',
      viewport: {
        id: 'v',
        cameraId: 'cam',
        projection: { id: 'test.flat/1', config: {} },
        size: { width: 800, height: 400, devicePixelRatio: 1 },
      },
    },
    ...windowAt('a', -2),
    ...windowAt('b', 0),
    ...windowAt('c', 2, 'test.other/1'),
  ]);
  if (result.status !== 'committed') {
    throw new Error('fixture failed');
  }
  const runtime = createSurfaceRuntime(ws, { now: () => clock.now, autoBind: false });
  const adapter = new MockOpaqueAdapter('test.view/1');
  const other = new MockOpaqueAdapter('test.other/1');
  adapter.holding.add('key-a');
  runtime.registerAdapter(adapter);
  runtime.registerAdapter(other);
  const registry = createPresentationRegistry();
  registry.registerProjector(flat);
  const renderer = new MockRenderer();
  registry.registerRenderer(renderer);
  registry.registerCompositor(new MockCompositor());
  // A compositor without direct native presentation: live content falls back to a proxy.
  registry.registerCompositor(
    new MockCompositor('raster.compositor/1', {
      ...MOCK_COMPOSITOR_CAPABILITIES,
      directNative: false,
      layerCategories: ['content-raster', 'proxy', 'placeholder', 'chrome', 'overlay'],
    }),
  );
  const frames = new ManualFrames();
  const presenter = createPresenter({
    workspace: ws,
    runtime,
    registry,
    frames,
    now: () => clock.now,
    showDegraded: () => () => undefined,
  });
  const diagnostics = createDiagnostics({
    workspace: ws,
    runtime,
    presenter,
    registry,
    now: () => clock.now,
  });
  // Binding a takes 40 ms on the clock; b and c, bound after it, are immediate.
  const a = runtime.bind('a-s');
  await settle();
  clock.now += 40;
  adapter.release('key-a');
  await a;
  await runtime.bind('b-s');
  await runtime.bind('c-s');
  return { clock, ws, runtime, adapter, other, registry, renderer, frames, presenter, diagnostics };
}

describe('diagnostics (API-013, AN-001, AN-003, AN-005, AN-008)', () => {
  it('reports each viewport’s backend with its capabilities, and its frame measures', async () => {
    const r = await rig();
    const v = await r.presenter.open({
      viewportId: 'v',
      container: {},
      backends: [{ renderer: 'mock.renderer/1', compositor: 'mock.compositor/1' }],
    });
    await r.frames.flush();
    r.ws.dispatch({
      type: 'node.patch',
      id: 'a',
      transform: { position: [-1, 0, -3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    });
    await r.frames.flush();
    v.invalidate();
    await r.frames.flush();
    const report = r.diagnostics.read();
    expect(report.backends).toEqual([
      {
        viewportId: 'v',
        state: 'active',
        backend: { renderer: 'mock.renderer/1', compositor: 'mock.compositor/1' },
        capabilities: {
          renderer: r.renderer.capabilities(),
          compositor: MOCK_COMPOSITOR_CAPABILITIES,
        },
        degradedBy: null,
      },
    ]);
    expect(report.frames).toEqual([
      {
        viewportId: 'v',
        rendererId: 'mock.renderer/1',
        compositorId: 'mock.compositor/1',
        frames: 3,
        skipped: 0,
        lastDurationMs: 0,
        maxDurationMs: 0,
        lastDirty: ['requested'],
        fragments: 3,
        writes: 0,
      },
    ]);
    expect(Object.isFrozen(report.frames[0])).toBe(true);
  });

  it('reports fallbacks with their reasons, by viewport and by adapter type', async () => {
    const r = await rig();
    await r.presenter.open({
      viewportId: 'v',
      container: {},
      backends: [{ renderer: 'mock.renderer/1', compositor: 'raster.compositor/1' }],
    });
    await r.frames.flush();
    const report = r.diagnostics.read();
    expect(report.fallbacks).toHaveLength(1);
    expect(report.fallbacks[0]).toMatchObject({
      viewportId: 'v',
      count: 3,
      surfaceIds: ['a-s', 'b-s', 'c-s'],
      example: { preferred: 'exact', compositorId: 'raster.compositor/1' },
    });
    expect(report.fallbacks[0]?.example.gaps.length).toBeGreaterThan(0);
    const chosen = report.fallbacks[0]?.example.chosen ?? 'none';
    expect(report.attachments.map((a) => [a.adapterTypeId, a.fallbacks])).toEqual([
      ['test.other/1', { [chosen]: 1 }],
      ['test.view/1', { [chosen]: 2 }],
    ]);
  });

  it('reports attachments, density, resources and the last typed errors', async () => {
    const r = await rig();
    const v = await r.presenter.open({
      viewportId: 'v',
      container: {},
      backends: [{ renderer: 'mock.renderer/1', compositor: 'mock.compositor/1' }],
    });
    await r.frames.flush();
    // One window leaves the view; another's endpoint fails to attach when it returns.
    r.ws.dispatch({
      type: 'node.patch',
      id: 'c',
      transform: { position: [9, 0, -3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    });
    await r.frames.flush();
    expect(
      await v.switchBackend({ renderer: 'missing.renderer/1', compositor: 'mock.compositor/1' }),
    ).toMatchObject({ status: 'kept' });
    r.adapter.attachFailing.add('key-b');
    await r.runtime.hide('b-s', 'v', { release: true });
    v.invalidate();
    await r.frames.flush();
    await settle();
    const report = r.diagnostics.read();
    expect(report.attachments).toEqual([
      expect.objectContaining({ adapterTypeId: 'test.other/1', bound: 1, presented: 0, failed: 0 }),
      expect.objectContaining({
        adapterTypeId: 'test.view/1',
        bound: 1,
        presented: 1,
        failed: 1,
        bindMs: { last: 0, max: 40 },
      }),
    ]);
    expect(report.density).toEqual({
      nodes: 3,
      surfaces: 3,
      viewports: [{ viewportId: 'v', candidates: 2, mounted: 1, culled: 1 }],
    });
    expect(report.resources).toMatchObject({
      presenter: { viewports: 1, sessions: 2 },
      subscriptions: 3,
      handoffs: 0,
    });
    expect(report.errors.map((e) => [e.source, e.error.code])).toEqual([
      ['presentation', 'BACKEND_SWITCH_FAILED'],
      ['surfaces', 'BIND_FAILED'],
      ['presentation', 'BIND_FAILED'],
    ]);
    r.diagnostics.dispose();
    r.diagnostics.dispose();
    expect(r.diagnostics.read().resources.subscriptions).toBe(0);
    await r.presenter.dispose();
    await r.runtime.dispose();
  });

  it('keeps only as many errors as asked, newest last', async () => {
    const r = await rig();
    const small = createDiagnostics({
      workspace: r.ws,
      runtime: r.runtime,
      presenter: r.presenter,
      registry: r.registry,
      errorCapacity: 2,
    });
    const v = await r.presenter.open({
      viewportId: 'v',
      container: {},
      backends: [{ renderer: 'mock.renderer/1', compositor: 'mock.compositor/1' }],
    });
    for (const id of ['x', 'y', 'z']) {
      await v.switchBackend({ renderer: `${id}.renderer/1`, compositor: 'mock.compositor/1' });
    }
    expect(small.read().errors.map((e) => e.error.details?.['renderer'])).toEqual([
      'y.renderer/1',
      'z.renderer/1',
    ]);
  });

  it('refuses invalid options, naming the field in the error and its path', async () => {
    const r = await rig();
    const sources = {
      workspace: r.ws,
      runtime: r.runtime,
      presenter: r.presenter,
      registry: r.registry,
    };
    const refusal = (options: Partial<Parameters<typeof createDiagnostics>[0]>): SwfError => {
      try {
        createDiagnostics({ ...sources, ...options });
      } catch (error) {
        if (error instanceof SwfFailure) {
          return error.error;
        }
        throw error;
      }
      throw new Error('the options were accepted');
    };
    for (const errorCapacity of [0, 1.5, Number.NaN]) {
      const error = refusal({ errorCapacity });
      expect([error.code, error.path]).toEqual(['INVALID_INPUT', 'errorCapacity']);
      expect(error.message).toMatch(/errorCapacity/);
    }
    const error = refusal({ now: 5 as unknown as () => number });
    expect([error.code, error.path]).toEqual(['INVALID_INPUT', 'now']);
    expect(error.message).toMatch(/now/);
    r.diagnostics.dispose();
    await r.presenter.dispose();
    await r.runtime.dispose();
    await r.ws.dispose();
  });
});
