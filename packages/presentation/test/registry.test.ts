import { MOCK_RENDERER_CAPABILITIES, MockCompositor, MockRenderer } from '@swf/conformance';
import { createWorkspace, SwfFailure } from '@swf/core';
import { createSurfaceRuntime } from '@swf/surfaces';
import { describe, expect, it } from 'vitest';
import type { RendererBackend, RendererCapabilities, ViewProjector } from '../src/index.js';
import { createPresentationRegistry } from '../src/index.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof SwfFailure ? error.error.code : `not a SwfFailure: ${String(error)}`;
  }
  return undefined;
}

const projector: ViewProjector = {
  profile: { id: 'test.panorama/1', mapping: 'nonlinear', seamWrapping: true, exactInverse: true },
  project: () => [],
};

describe('presentation registry', () => {
  it('registers renderers, compositors and projectors, and unregisters them', () => {
    const registry = createPresentationRegistry();
    const removeRenderer = registry.registerRenderer(new MockRenderer());
    registry.registerCompositor(new MockCompositor());
    registry.registerProjector(projector);
    expect(registry.rendererIds()).toEqual(['mock.renderer/1']);
    expect(registry.compositorIds()).toEqual(['mock.compositor/1']);
    expect(registry.projector('test.panorama/1')?.capabilities.mapping).toBe('nonlinear');
    removeRenderer();
    removeRenderer();
    expect(registry.rendererIds()).toEqual([]);
  });

  it('tells its listeners of every registration and unregistration, in order', () => {
    const registry = createPresentationRegistry();
    const heard: string[] = [];
    const stop = registry.subscribe((c) => {
      heard.push(`${c.registered ? '+' : '-'}${c.kind}:${c.id}`);
    });
    registry.subscribe(() => {
      throw new Error('listener bug');
    });
    const removeRenderer = registry.registerRenderer(new MockRenderer());
    registry.registerProjector(projector);
    removeRenderer();
    removeRenderer();
    // A refused registration changes nothing, so nobody hears of it.
    expect(() => registry.registerProjector(projector)).toThrow(SwfFailure);
    stop();
    stop();
    registry.registerCompositor(new MockCompositor());
    expect(heard).toEqual([
      '+renderer:mock.renderer/1',
      '+projector:test.panorama/1',
      '-renderer:mock.renderer/1',
    ]);
    // The throwing listener stopped nothing; its failures are kept.
    expect(registry.rendererIds()).toEqual([]);
    expect(registry.compositorIds()).toEqual(['mock.compositor/1']);
    expect(registry.getDiagnostics()).toHaveLength(4);
    expect(registry.getDiagnostics()[0]).toEqual({
      code: 'LISTENER_THREW',
      message: 'a listener threw while handling the registration of renderer "mock.renderer/1"',
      details: { reason: 'listener bug' },
    });
  });

  it('rejects collisions, malformed modules, other contract versions and invalid capabilities', () => {
    const registry = createPresentationRegistry();
    registry.registerRenderer(new MockRenderer());
    expect(codeOf(() => registry.registerRenderer(new MockRenderer()))).toBe('INVALID_INPUT');
    expect(codeOf(() => registry.registerRenderer(new MockRenderer('renderer')))).toBe(
      'INVALID_INPUT',
    );
    expect(
      codeOf(() =>
        registry.registerRenderer({ id: 'x/1', apiVersion: 1 } as unknown as RendererBackend),
      ),
    ).toBe('INVALID_INPUT');
    expect(
      codeOf(() =>
        registry.registerRenderer(Object.assign(new MockRenderer('old/1'), { apiVersion: 0 })),
      ),
    ).toBe('UNSUPPORTED_CAPABILITY');
    expect(
      codeOf(() =>
        registry.registerRenderer(
          new MockRenderer('bad/1', { ...MOCK_RENDERER_CAPABILITIES, layering: 'raster' }),
        ),
      ),
    ).toBe('UNSUPPORTED_CAPABILITY');
    expect(
      codeOf(() =>
        registry.registerProjector({
          ...projector,
          profile: { ...projector.profile, mapping: 'curved' as never },
        }),
      ),
    ).toBe('UNSUPPORTED_CAPABILITY');
    const throwing = Object.assign(new MockRenderer('throws/1'), {
      capabilities: () => {
        throw new Error('no caps');
      },
    });
    expect(codeOf(() => registry.registerRenderer(throwing))).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('keeps the capabilities declared at registration, unaffected by later changes to the source', () => {
    const registry = createPresentationRegistry();
    const mutable: { -readonly [K in keyof RendererCapabilities]: RendererCapabilities[K] } = {
      ...MOCK_RENDERER_CAPABILITIES,
      handleKinds: { ...MOCK_RENDERER_CAPABILITIES.handleKinds },
    };
    registry.registerRenderer(new MockRenderer('m/1', mutable));
    mutable.transformMode = 'translate';
    expect(registry.renderer('m/1')?.capabilities.transformMode).toBe('mesh');
    expect(Object.isFrozen(registry.renderer('m/1')?.capabilities.handleKinds)).toBe(true);
  });
});

describe('capability-scoped handles', () => {
  it('offers each scope only its own operations', async () => {
    const registry = createPresentationRegistry();
    const registrar = registry.registrar();
    expect(Object.keys(registrar).sort()).toEqual([
      'registerCompositor',
      'registerProjector',
      'registerRenderer',
    ]);
    registrar.registerRenderer(new MockRenderer());
    expect(registry.rendererIds()).toEqual(['mock.renderer/1']);

    const workspace = createWorkspace({ id: 'ws' });
    const reader = workspace.reader();
    const mutator = workspace.mutator();
    expect(Object.keys(reader).sort()).toEqual([
      'findNodes',
      'getPresented',
      'getPreview',
      'getState',
      'history',
      'id',
      'presentedGeometry',
      'subscribe',
      'surfaceGeometry',
      'watch',
    ]);
    expect(Object.keys(mutator).sort()).toEqual([
      'canRedo',
      'canUndo',
      'cancelPreview',
      'dispatch',
      'id',
      'preview',
      'redo',
      'registerConstraint',
      'registerGeometry',
      'registerProjectionKind',
      'transaction',
      'undo',
    ]);
    const committed = mutator.dispatch({
      type: 'node.create',
      node: { id: 'w', kind: 'window', bounds: [1, 1, 1] },
    });
    expect(committed.status).toBe('committed');
    expect(reader.getState().nodes.has('w')).toBe(true);
    for (const scope of [reader, mutator, registrar]) {
      expect(Object.isFrozen(scope)).toBe(true);
    }

    const runtime = createSurfaceRuntime(workspace);
    const binder = runtime.binder();
    expect(Object.keys(binder).sort()).toEqual([
      'bind',
      'get',
      'list',
      'registerAdapter',
      'replaceBinding',
      'subscribe',
      'unbind',
      'workspaceId',
    ]);
    expect('present' in binder).toBe(false);
    await runtime.dispose();
  });
});
