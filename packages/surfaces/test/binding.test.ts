import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSurfaceRuntime } from '../src/index.js';
import {
  committed,
  makeWorkspace,
  record,
  settle,
  surface,
  transitions,
  window,
} from './fixtures.js';
import { mockCapabilities, MockOpaqueAdapter } from '@swf/conformance';

afterEach(() => {
  vi.useRealTimers();
});

function setup(options: Parameters<typeof createSurfaceRuntime>[1] = {}) {
  const ws = makeWorkspace();
  const runtime = createSurfaceRuntime(ws, options);
  const events = record(runtime);
  committed(ws.dispatch(window('w')));
  return { ws, runtime, events };
}

describe('binding', () => {
  it('binds a new surface asynchronously, passing the key verbatim with an abort signal', async () => {
    const { ws, runtime, events } = setup();
    const adapter = new MockOpaqueAdapter();
    runtime.registerAdapter(adapter);
    const key = 'javascript:alert(1)';
    committed(ws.dispatch(surface('s', 'w', key)));
    expect(runtime.get('s')?.state).toBe('binding');
    await settle();
    expect(runtime.get('s')).toMatchObject({
      state: 'ready',
      capabilities: mockCapabilities(),
      error: null,
    });
    expect(transitions(events, 's')).toEqual(['none>unbound', 'unbound>binding', 'binding>ready']);
    expect(adapter.calls[0]).toEqual({ method: 'resolve', key });
    expect(adapter.signals[0]?.aborted).toBe(false);
    // Binding is presentation only: it commits nothing to the scene.
    expect(ws.getState().revision).toBe(2);
  });

  it('keeps an unbound placeholder with identity and geometry when no adapter is registered, then binds in place', async () => {
    const { ws, runtime, events } = setup();
    committed(
      ws.dispatch(
        surface('s', 'w', 'k', {
          transform: { position: [0.1, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        }),
      ),
    );
    expect(runtime.get('s')).toMatchObject({
      state: 'unbound',
      unboundReason: 'adapter-unavailable',
    });
    const record = ws.getState().surfaces.get('s');
    expect(ws.surfaceGeometry('s')).toBeDefined();
    const revision = ws.getState().revision;
    runtime.registerAdapter(new MockOpaqueAdapter());
    await settle();
    expect(runtime.get('s')?.state).toBe('ready');
    expect(ws.getState().surfaces.get('s')).toBe(record);
    expect(ws.getState().revision).toBe(revision);
    expect(transitions(events, 's')).toEqual(['none>unbound', 'unbound>binding', 'binding>ready']);
  });

  it('shows a placeholder for a surface with no key, and binds once the host assigns one', async () => {
    const { ws, runtime } = setup();
    runtime.registerAdapter(new MockOpaqueAdapter());
    committed(ws.dispatch(surface('s', 'w', null)));
    await settle();
    expect(runtime.get('s')).toMatchObject({ state: 'unbound', unboundReason: 'no-binding-key' });
    committed(ws.dispatch({ type: 'surface.rebind', id: 's', bindingKey: 'k' }));
    await settle();
    expect(runtime.get('s')).toMatchObject({ state: 'ready', binding: { bindingKey: 'k' } });
  });

  it('leaves an unknown key unbound, and a failing resolve in a retryable error isolated to its surface', async () => {
    const { ws, runtime, events } = setup();
    const adapter = new MockOpaqueAdapter();
    adapter.unknown.add('ghost');
    adapter.failing.add('broken');
    runtime.registerAdapter(adapter);
    committed(
      ws.transaction([
        surface('a', 'w', 'ghost'),
        surface('b', 'w', 'broken'),
        surface('c', 'w', 'fine'),
      ]),
    );
    await settle();
    expect(runtime.get('a')).toMatchObject({
      state: 'unbound',
      unboundReason: 'unknown-binding-key',
    });
    expect(runtime.get('b')?.state).toBe('error');
    expect(runtime.get('b')?.error).toMatchObject({
      code: 'BIND_FAILED',
      retryable: true,
      entityId: 'b',
      details: { phase: 'resolve', reason: 'cannot open broken' },
    });
    expect(runtime.get('c')?.state).toBe('ready');
    expect(transitions(events, 'b')).toEqual(['none>unbound', 'unbound>binding', 'binding>error']);
    // Failures are never retried on their own: the host retries.
    await settle();
    expect(adapter.calls.filter((c) => c.method === 'resolve' && c.key === 'broken')).toHaveLength(
      1,
    );
    adapter.failing.delete('broken');
    const retried = await runtime.bind('b');
    expect(retried).toMatchObject({ status: 'ok', presentation: { state: 'ready', error: null } });
    expect(transitions(events, 'b').slice(-2)).toEqual(['error>binding', 'binding>ready']);
  });

  it('times out after 15 s by default as a retryable failure, aborting the resolve', async () => {
    vi.useFakeTimers();
    const { ws, runtime } = setup();
    // It ignores cancellation, so it can still answer after the timeout.
    const adapter = new MockOpaqueAdapter('host.view/1', mockCapabilities(), {
      ignoresAbort: true,
    });
    adapter.holding.add('slow');
    runtime.registerAdapter(adapter);
    committed(ws.dispatch(surface('s', 'w', 'slow')));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(runtime.get('s')?.state).toBe('binding');
    await vi.advanceTimersByTimeAsync(1);
    expect(runtime.get('s')?.error).toMatchObject({
      code: 'BIND_FAILED',
      retryable: true,
      details: { reason: 'timeout' },
    });
    expect(adapter.signals[0]?.aborted).toBe(true);
    // A late answer to the timed-out attempt changes nothing and is never attached.
    adapter.release('slow');
    await settle();
    expect(runtime.get('s')).toMatchObject({ state: 'error', capabilities: null });
    expect(runtime.handleOf('s')).toBeUndefined();
    expect(adapter.methods()).not.toContain('attach');
  });

  it('honours a configured timeout, and lets an adapter opt out while staying cancellable', async () => {
    vi.useFakeTimers();
    const ws = makeWorkspace();
    const runtime = createSurfaceRuntime(ws, { bindingTimeoutMs: 50 });
    const quick = new MockOpaqueAdapter();
    quick.holding.add('k');
    const patient = new MockOpaqueAdapter('host.slow/1', mockCapabilities(), {
      untimedBinding: true,
    });
    patient.holding.add('k');
    runtime.registerAdapter(quick);
    runtime.registerAdapter(patient);
    committed(
      ws.transaction([
        window('w'),
        surface('a', 'w', 'k'),
        surface('b', 'w', 'k', { adapterTypeId: 'host.slow/1' }),
      ]),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runtime.get('a')?.state).toBe('error');
    expect(runtime.get('b')?.state).toBe('binding');
    committed(ws.dispatch({ type: 'surface.detach', id: 'b' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(patient.signals[0]?.aborted).toBe(true);
    expect(runtime.get('b')).toBeUndefined();
  });

  it('discards an answer when the surface is rebound while that answer is being negotiated', async () => {
    const { ws, runtime } = setup();
    let rebound = false;
    const adapter = new MockOpaqueAdapter('host.view/1', mockCapabilities(), {
      handleCapabilities: (handle) => {
        // The host reacts to the answer by pointing the surface elsewhere, before the runtime
        // has finished negotiating it.
        if (handle.key === 'old' && !rebound) {
          rebound = true;
          committed(ws.dispatch({ type: 'surface.rebind', id: 's', bindingKey: 'new' }));
        }
        return mockCapabilities();
      },
    });
    runtime.registerAdapter(adapter);
    committed(ws.dispatch(surface('s', 'w', 'old')));
    await settle();
    await settle();
    expect(runtime.get('s')).toMatchObject({ state: 'ready', binding: { bindingKey: 'new' } });
    expect(runtime.handleOf('s')).toMatchObject({ key: 'new' });
    expect(runtime.getDiagnostics().map((d) => d.code)).toContain('STALE_COMPLETION');
  });

  it('never starts resolving for a surface removed before its binding began', async () => {
    const { ws, runtime } = setup();
    const adapter = new MockOpaqueAdapter();
    runtime.registerAdapter(adapter);
    committed(ws.dispatch(surface('s', 'w', 'k')));
    committed(ws.dispatch({ type: 'surface.detach', id: 's' }));
    await settle();
    expect(adapter.methods()).toEqual([]);
    expect(runtime.get('s')).toBeUndefined();
  });

  it('never lets a completion that arrives after the window was deleted resurrect it', async () => {
    const { ws, runtime } = setup();
    // An adapter that keeps working after cancellation and answers late anyway.
    const adapter = new MockOpaqueAdapter('host.view/1', mockCapabilities(), {
      ignoresAbort: true,
    });
    adapter.holding.add('k');
    runtime.registerAdapter(adapter);
    committed(ws.dispatch(surface('s', 'w', 'k')));
    await settle();
    committed(ws.dispatch({ type: 'node.delete', id: 'w', mode: 'subtree' }));
    await settle();
    expect(runtime.get('s')).toBeUndefined();
    expect(adapter.signals[0]?.aborted).toBe(true);
    const revision = ws.getState().revision;
    adapter.release('k');
    await settle();
    expect(runtime.get('s')).toBeUndefined();
    expect(ws.getState().surfaces.has('s')).toBe(false);
    expect(ws.getState().nodes.has('w')).toBe(false);
    expect(ws.getState().revision).toBe(revision);
    expect(adapter.methods()).not.toContain('attach');
  });

  it('never lets a stale completion replace a newer binding', async () => {
    const { ws, runtime } = setup();
    const adapter = new MockOpaqueAdapter('host.view/1', mockCapabilities(), {
      ignoresAbort: true,
    });
    adapter.holding.add('old');
    runtime.registerAdapter(adapter);
    committed(ws.dispatch(surface('s', 'w', 'old')));
    await settle();
    committed(ws.dispatch({ type: 'surface.rebind', id: 's', bindingKey: 'new' }));
    await settle();
    const bound = runtime.handleOf('s');
    expect(bound).toMatchObject({ key: 'new' });
    adapter.release('old');
    await settle();
    expect(runtime.handleOf('s')).toBe(bound);
    expect(runtime.get('s')?.binding.bindingKey).toBe('new');
  });

  it('rebinds in place when an undo brings a deleted surface back, with a new generation', async () => {
    const { ws, runtime } = setup();
    runtime.registerAdapter(new MockOpaqueAdapter());
    committed(ws.dispatch(surface('s', 'w', 'k')));
    await settle();
    const first = runtime.get('s')?.generation ?? 0;
    committed(ws.dispatch({ type: 'surface.detach', id: 's' }));
    await settle();
    committed(ws.undo());
    await settle();
    expect(runtime.get('s')?.state).toBe('ready');
    expect(runtime.get('s')?.generation).toBeGreaterThanOrEqual(1);
    expect(first).toBeGreaterThanOrEqual(1);
  });

  it('rejects handle capabilities beyond the declaration or malformed ones', async () => {
    const { ws, runtime } = setup();
    const adapter = new MockOpaqueAdapter('host.view/1', mockCapabilities(), {
      handleCapabilities: (handle) =>
        handle.key === 'greedy'
          ? mockCapabilities({ viewportSharing: 'shared' })
          : ({ ...mockCapabilities(), bogus: 1 } as never),
    });
    runtime.registerAdapter(adapter);
    committed(ws.transaction([surface('a', 'w', 'greedy'), surface('b', 'w', 'odd')]));
    await settle();
    expect(runtime.get('a')?.error?.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(runtime.get('a')?.error?.message).toMatch(
      /exceed the declared capabilities \(viewportSharing\)/,
    );
    expect(runtime.get('b')?.error?.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('applies capability changes the endpoint announces while current, and ignores stale ones', async () => {
    const { ws, runtime, events } = setup();
    const adapter = new MockOpaqueAdapter();
    runtime.registerAdapter(adapter);
    committed(ws.dispatch(surface('s', 'w', 'k')));
    await settle();
    const [context] = adapter.contexts;
    context?.announceCapabilities(mockCapabilities({ safeDetach: false, rebinding: false }));
    await settle();
    expect(runtime.get('s')?.capabilities?.safeDetach).toBe(false);
    expect(events.filter((e) => e.type === 'presentation.capabilitiesChanged')).toHaveLength(1);
    expect(runtime.getDiagnostics().map((d) => d.code)).toContain('CAPABILITIES_CHANGED');
    committed(ws.dispatch({ type: 'surface.rebind', id: 's', bindingKey: 'k2' }));
    await settle();
    context?.announceCapabilities(mockCapabilities({ transparency: false }));
    context?.reportUnavailable('gone');
    await settle();
    expect(runtime.get('s')).toMatchObject({ state: 'ready', capabilities: mockCapabilities() });
    adapter.contexts[1]?.announceCapabilities(mockCapabilities({ viewportSharing: 'shared' }));
    await settle();
    expect(runtime.get('s')?.error?.code).toBe('UNSUPPORTED_CAPABILITY');
  });

  it('turns an endpoint that becomes unavailable into a retryable error, releasing its attachment', async () => {
    const { ws, runtime } = setup();
    const adapter = new MockOpaqueAdapter();
    runtime.registerAdapter(adapter);
    committed(ws.dispatch(surface('s', 'w', 'k')));
    await settle();
    await runtime.present('s', 'v1', {});
    adapter.contexts[0]?.reportUnavailable('device unplugged');
    await settle();
    expect(runtime.get('s')).toMatchObject({
      state: 'error',
      viewports: [],
      error: { code: 'BIND_FAILED', retryable: true, details: { reason: 'device unplugged' } },
    });
    expect(adapter.methods().slice(-1)).toEqual(['detach']);
  });

  it('waits for an explicit bind when automatic binding is off', async () => {
    const { ws, runtime } = setup({ autoBind: false });
    runtime.registerAdapter(new MockOpaqueAdapter());
    committed(ws.dispatch(surface('s', 'w', 'k')));
    await settle();
    expect(runtime.get('s')?.state).toBe('unbound');
    expect(await runtime.bind('s')).toMatchObject({
      status: 'ok',
      presentation: { state: 'ready' },
    });
    expect(await runtime.bind('s')).toMatchObject({
      status: 'rejected',
      error: { code: 'INVALID_TRANSITION' },
    });
    expect(await runtime.bind('nope')).toMatchObject({
      status: 'rejected',
      error: { code: 'UNKNOWN_ENTITY' },
    });
  });
});
