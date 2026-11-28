import { SwfFailure } from '@swf/core';
import { describe, expect, it } from 'vitest';
import type { SurfaceAdapter } from '../src/index.js';
import { capabilitiesIssue, createSurfaceRuntime, exceededCapabilities } from '../src/index.js';
import { committed, makeWorkspace, record, settle, surface, window } from './fixtures.js';
import { mockCapabilities, MockOpaqueAdapter, NATIVE_CAPABILITIES } from '@swf/conformance';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof SwfFailure ? error.error.code : `not a SwfFailure: ${String(error)}`;
  }
  return undefined;
}

describe('adapter registration', () => {
  it('registers a versioned adapter and unregisters it with the returned function', () => {
    const runtime = createSurfaceRuntime(makeWorkspace());
    const events = record(runtime);
    const remove = runtime.registerAdapter(new MockOpaqueAdapter());
    remove();
    remove();
    expect(events.map((e) => e.type)).toEqual(['adapter.registered', 'adapter.unregistered']);
    runtime.registerAdapter(new MockOpaqueAdapter());
  });

  it('rejects a second adapter with the same type ID', () => {
    const runtime = createSurfaceRuntime(makeWorkspace());
    runtime.registerAdapter(new MockOpaqueAdapter());
    expect(codeOf(() => runtime.registerAdapter(new MockOpaqueAdapter()))).toBe('INVALID_INPUT');
  });

  it('rejects malformed adapters', () => {
    const runtime = createSurfaceRuntime(makeWorkspace());
    expect(codeOf(() => runtime.registerAdapter(new MockOpaqueAdapter('video')))).toBe(
      'INVALID_INPUT',
    );
    expect(codeOf(() => runtime.registerAdapter(new MockOpaqueAdapter('host.video/0')))).toBe(
      'INVALID_INPUT',
    );
    const noDetach = {
      id: 'host.a/1',
      apiVersion: 1,
      declaredCapabilities: NATIVE_CAPABILITIES,
      resolve: () => Promise.resolve(null),
      capabilities: () => NATIVE_CAPABILITIES,
      attach: () => undefined,
      update: () => undefined,
    } as unknown as SurfaceAdapter;
    expect(codeOf(() => runtime.registerAdapter(noDetach))).toBe('INVALID_INPUT');
  });

  it('rejects an incompatible contract version or contradictory capabilities', () => {
    const runtime = createSurfaceRuntime(makeWorkspace());
    const v2 = Object.assign(new MockOpaqueAdapter('host.v2/1'), { apiVersion: 2 });
    expect(codeOf(() => runtime.registerAdapter(v2))).toBe('UNSUPPORTED_CAPABILITY');
    for (const declared of [
      mockCapabilities({ attachStrategy: 'drawable' }), // native interaction without a native layer
      mockCapabilities({ uvAddressing: false }), // cursor mapping without UV addressing
      mockCapabilities({ safeDetach: false }), // rebinding without safe detachment
      mockCapabilities({
        attachStrategy: 'proxy-only',
        nativeInteraction: 'none',
        transformFidelity: 'exact',
        uvAddressing: false,
        cursorMapping: false,
      }),
      // content that keeps the takeover modifier with no input of its own
      mockCapabilities({
        attachStrategy: 'drawable',
        nativeInteraction: 'none',
        transformFidelity: 'exact',
        takeover: false,
      }),
      { ...NATIVE_CAPABILITIES, teleport: true } as never,
      { ...NATIVE_CAPABILITIES, resize: 'sometimes' } as never,
    ]) {
      expect(
        codeOf(() => runtime.registerAdapter(new MockOpaqueAdapter('host.x/1', declared))),
      ).toBe('UNSUPPORTED_CAPABILITY');
    }
  });
});

describe('capability descriptors', () => {
  it('names the capabilities a handle claims beyond its declaration', () => {
    expect(exceededCapabilities(NATIVE_CAPABILITIES, NATIVE_CAPABILITIES)).toEqual([]);
    expect(
      exceededCapabilities(
        mockCapabilities({ viewportSharing: 'single-owner' }),
        mockCapabilities({ viewportSharing: 'shared' }),
      ),
    ).toEqual(['viewportSharing']);
    expect(
      exceededCapabilities(
        mockCapabilities({ transformFidelity: 'approximate' }),
        mockCapabilities({ transformFidelity: 'exact' }),
      ),
    ).toEqual(['transformFidelity']);
    expect(
      exceededCapabilities(
        mockCapabilities({ placeholder: false }),
        mockCapabilities({ placeholder: true }),
      ),
    ).toEqual(['placeholder']);
    expect(
      exceededCapabilities(
        NATIVE_CAPABILITIES,
        mockCapabilities({ nativeInteraction: 'partial', resize: 'spatial' }),
      ),
    ).toEqual([]);
    // An adapter that declares its content keeps the takeover modifier has no handle that does not.
    expect(
      exceededCapabilities(mockCapabilities({ takeover: false }), mockCapabilities({})),
    ).toEqual(['takeover']);
    expect(
      exceededCapabilities(NATIVE_CAPABILITIES, mockCapabilities({ takeover: false })),
    ).toEqual([]);
    expect(capabilitiesIssue({ ...NATIVE_CAPABILITIES, takeover: undefined })).toBe(
      'capabilities.takeover must be a boolean',
    );
    expect(
      capabilitiesIssue(
        mockCapabilities({
          attachStrategy: 'drawable',
          nativeInteraction: 'none',
          transformFidelity: 'exact',
          takeover: false,
        }),
      ),
    ).toBe('content that keeps the takeover modifier requires native interaction');
  });

  it('accepts a consistent proxy-only descriptor', () => {
    expect(
      capabilitiesIssue(
        mockCapabilities({
          attachStrategy: 'proxy-only',
          nativeInteraction: 'none',
          transformFidelity: 'proxy',
          uvAddressing: false,
          cursorMapping: false,
        }),
      ),
    ).toBeNull();
  });
});

describe('runtime setup', () => {
  it('validates its options and refuses a disposed workspace', async () => {
    const ws = makeWorkspace();
    expect(codeOf(() => createSurfaceRuntime(ws, { bindingTimeoutMs: 0 }))).toBe('INVALID_INPUT');
    expect(codeOf(() => createSurfaceRuntime(ws, { retry: true } as never))).toBe('INVALID_INPUT');
    await ws.dispose();
    expect(codeOf(() => createSurfaceRuntime(ws))).toBe('WORKSPACE_DISPOSED');
  });

  it('tracks surfaces that exist before the runtime is created', async () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('w'), surface('s', 'w', 'k')]));
    const runtime = createSurfaceRuntime(ws);
    expect(runtime.get('s')).toMatchObject({
      state: 'unbound',
      unboundReason: 'adapter-unavailable',
    });
    runtime.registerAdapter(new MockOpaqueAdapter());
    await settle();
    expect(runtime.get('s')?.state).toBe('ready');
  });

  it('releases what an adapter bound when it is unregistered, keeping the placeholder', async () => {
    const ws = makeWorkspace();
    const runtime = createSurfaceRuntime(ws);
    const adapter = new MockOpaqueAdapter();
    const remove = runtime.registerAdapter(adapter);
    committed(ws.transaction([window('w'), surface('s', 'w', 'k')]));
    await settle();
    await runtime.present('s', 'v1', {});
    remove();
    await settle();
    expect(runtime.get('s')).toMatchObject({
      state: 'unbound',
      unboundReason: 'adapter-unavailable',
      viewports: [],
    });
    expect(adapter.methods()).toEqual(['resolve', 'capabilities', 'attach', 'detach']);
    expect(ws.getState().surfaces.has('s')).toBe(true);
  });
});
