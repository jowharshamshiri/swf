import { SwfFailure } from '@swf/core';
import { describe, expect, it } from 'vitest';
import type { SurfaceAdapter } from '../src/index.js';
import { capabilitiesIssue, createSurfaceRuntime, exceededCapabilities } from '../src/index.js';
import {
  caps,
  committed,
  MockAdapter,
  makeWorkspace,
  NATIVE,
  record,
  settle,
  surface,
  window,
} from './fixtures.js';

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
    const remove = runtime.registerAdapter(new MockAdapter());
    remove();
    remove();
    expect(events.map((e) => e.type)).toEqual(['adapter.registered', 'adapter.unregistered']);
    runtime.registerAdapter(new MockAdapter());
  });

  it('rejects a second adapter with the same type ID', () => {
    const runtime = createSurfaceRuntime(makeWorkspace());
    runtime.registerAdapter(new MockAdapter());
    expect(codeOf(() => runtime.registerAdapter(new MockAdapter()))).toBe('INVALID_INPUT');
  });

  it('rejects malformed adapters', () => {
    const runtime = createSurfaceRuntime(makeWorkspace());
    expect(codeOf(() => runtime.registerAdapter(new MockAdapter('video')))).toBe('INVALID_INPUT');
    expect(codeOf(() => runtime.registerAdapter(new MockAdapter('host.video/0')))).toBe(
      'INVALID_INPUT',
    );
    const noDetach = {
      id: 'host.a/1',
      apiVersion: 1,
      declaredCapabilities: NATIVE,
      resolve: () => Promise.resolve(null),
      capabilities: () => NATIVE,
      attach: () => undefined,
      update: () => undefined,
    } as unknown as SurfaceAdapter;
    expect(codeOf(() => runtime.registerAdapter(noDetach))).toBe('INVALID_INPUT');
  });

  it('rejects an incompatible contract version or contradictory capabilities', () => {
    const runtime = createSurfaceRuntime(makeWorkspace());
    const v2 = Object.assign(new MockAdapter('host.v2/1'), { apiVersion: 2 });
    expect(codeOf(() => runtime.registerAdapter(v2))).toBe('UNSUPPORTED_CAPABILITY');
    for (const declared of [
      caps({ attachStrategy: 'drawable' }), // native interaction without a native layer
      caps({ uvAddressing: false }), // cursor mapping without UV addressing
      caps({ safeDetach: false }), // rebinding without safe detachment
      caps({
        attachStrategy: 'proxy-only',
        nativeInteraction: 'none',
        transformFidelity: 'exact',
        uvAddressing: false,
        cursorMapping: false,
      }),
      { ...NATIVE, teleport: true } as never,
      { ...NATIVE, resize: 'sometimes' } as never,
    ]) {
      expect(codeOf(() => runtime.registerAdapter(new MockAdapter('host.x/1', declared)))).toBe(
        'UNSUPPORTED_CAPABILITY',
      );
    }
  });
});

describe('capability descriptors', () => {
  it('names the capabilities a handle claims beyond its declaration', () => {
    expect(exceededCapabilities(NATIVE, NATIVE)).toEqual([]);
    expect(
      exceededCapabilities(
        caps({ viewportSharing: 'single-owner' }),
        caps({ viewportSharing: 'shared' }),
      ),
    ).toEqual(['viewportSharing']);
    expect(
      exceededCapabilities(
        caps({ transformFidelity: 'approximate' }),
        caps({ transformFidelity: 'exact' }),
      ),
    ).toEqual(['transformFidelity']);
    expect(exceededCapabilities(caps({ placeholder: false }), caps({ placeholder: true }))).toEqual(
      ['placeholder'],
    );
    expect(
      exceededCapabilities(NATIVE, caps({ nativeInteraction: 'partial', resize: 'spatial' })),
    ).toEqual([]);
  });

  it('accepts a consistent proxy-only descriptor', () => {
    expect(
      capabilitiesIssue(
        caps({
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
    runtime.registerAdapter(new MockAdapter());
    await settle();
    expect(runtime.get('s')?.state).toBe('ready');
  });

  it('releases what an adapter bound when it is unregistered, keeping the placeholder', async () => {
    const ws = makeWorkspace();
    const runtime = createSurfaceRuntime(ws);
    const adapter = new MockAdapter();
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
