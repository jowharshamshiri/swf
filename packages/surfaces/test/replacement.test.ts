import { describe, expect, it } from 'vitest';
import { createSurfaceRuntime } from '../src/index.js';
import { committed, makeWorkspace, record, settle, surface, window } from './fixtures.js';
import { mockCapabilities, MockOpaqueAdapter } from '@swf/conformance';

async function presented(adapter = new MockOpaqueAdapter()) {
  const ws = makeWorkspace();
  const runtime = createSurfaceRuntime(ws);
  runtime.registerAdapter(adapter);
  committed(ws.transaction([window('w'), surface('s', 'w', 'old')]));
  await settle();
  const container = { layer: 'native' };
  await runtime.present('s', 'v1', container);
  const events = record(runtime);
  const sceneEvents: string[] = [];
  ws.subscribe((e) => sceneEvents.push(e.type));
  return { ws, runtime, adapter, events, sceneEvents, container };
}

describe('binding replacement', () => {
  it('attaches the new endpoint first, commits once, then releases the old attachment', async () => {
    const { ws, runtime, adapter, events, sceneEvents } = await presented();
    const old = runtime.handleOf('s');
    const revision = ws.getState().revision;
    adapter.calls.length = 0;
    const order: string[] = [];
    ws.subscribe((e) => {
      if (e.type === 'surface.rebound') {
        order.push(`commit after ${adapter.methods().join(',')}`);
      }
    });
    const result = await runtime.replaceBinding('s', { bindingKey: 'new' }, { source: 'user' });
    expect(result).toMatchObject({
      status: 'ok',
      presentation: { state: 'presented', binding: { bindingKey: 'new' }, replacing: false },
    });
    expect(order).toEqual(['commit after resolve,capabilities,attach']);
    expect(adapter.calls.map((c) => `${c.method}:${c.handle?.key ?? c.key ?? ''}`)).toEqual([
      'resolve:new',
      'capabilities:new',
      'attach:new',
      'detach:old',
    ]);
    expect(adapter.calls.find((c) => c.method === 'detach')?.handle).toBe(old);
    expect(runtime.handleOf('s')).toMatchObject({ key: 'new' });
    // One transaction, one undoable step, and no detour through unbound.
    expect(ws.getState().revision).toBe(revision + 1);
    expect(ws.getState().surfaces.get('s')?.bindingKey).toBe('new');
    expect(ws.history().at(-1)).toMatchObject({ commandTypes: ['surface.rebind'], source: 'user' });
    expect(sceneEvents.filter((t) => t.startsWith('surface.'))).toEqual(['surface.rebound']);
    expect(events.filter((e) => e.type === 'presentation.stateChanged')).toEqual([]);
    expect(events.map((e) => e.type)).toEqual(['presentation.replaced']);
  });

  it('keeps the old binding presented and the scene unchanged when the new key is unknown', async () => {
    const { ws, runtime, adapter } = await presented();
    adapter.unknown.add('ghost');
    const revision = ws.getState().revision;
    const result = await runtime.replaceBinding('s', { bindingKey: 'ghost' });
    expect(result).toMatchObject({ status: 'rejected', error: { code: 'BIND_FAILED' } });
    expect(runtime.get('s')).toMatchObject({
      state: 'presented',
      binding: { bindingKey: 'old' },
      replacing: false,
    });
    expect(ws.getState().revision).toBe(revision);
    expect(adapter.methods()).not.toContain('detach');
  });

  it('rolls back when the new endpoint cannot be mounted: the new attachment is released, the old kept', async () => {
    const { ws, runtime, adapter } = await presented();
    adapter.attachFailing.add('bad');
    const revision = ws.getState().revision;
    const old = runtime.handleOf('s');
    const result = await runtime.replaceBinding('s', { bindingKey: 'bad' });
    expect(result).toMatchObject({
      status: 'rejected',
      error: { code: 'BIND_FAILED', details: { phase: 'attach' } },
    });
    expect(ws.getState().revision).toBe(revision);
    expect(runtime.handleOf('s')).toBe(old);
    expect(runtime.get('s')?.state).toBe('presented');
    const detached = adapter.calls.filter((c) => c.method === 'detach');
    expect(detached.map((c) => c.handle?.key)).toEqual(['bad']);
  });

  it('gives up cleanly when the surface is removed during the handoff', async () => {
    const adapter = new MockOpaqueAdapter();
    const { ws, runtime } = await presented(adapter);
    adapter.holdingAttach.add('new');
    const replacing = runtime.replaceBinding('s', { bindingKey: 'new' });
    await settle();
    expect(runtime.get('s')?.replacing).toBe(true);
    expect(await runtime.hide('s', 'v1')).toMatchObject({
      status: 'rejected',
      error: { code: 'INVALID_TRANSITION' },
    });
    committed(ws.dispatch({ type: 'surface.detach', id: 's' }));
    await settle();
    adapter.attachHeld.get('new')?.shift()?.();
    expect(await replacing).toMatchObject({ status: 'rejected', error: { code: 'CANCELLED' } });
    expect(ws.getState().surfaces.has('s')).toBe(false);
    const detached = adapter.calls.filter((c) => c.method === 'detach').map((c) => c.handle?.key);
    expect(detached.sort()).toEqual(['new', 'old']);
  });

  it('refuses to hand off from an unbound surface, to an unregistered adapter, or a single owner into two viewports', async () => {
    const ws = makeWorkspace();
    const runtime = createSurfaceRuntime(ws);
    committed(ws.transaction([window('w'), surface('s', 'w', 'k')]));
    expect(await runtime.replaceBinding('s', { bindingKey: 'x' })).toMatchObject({
      status: 'rejected',
      error: { code: 'INVALID_TRANSITION' },
    });
    const shared = new MockOpaqueAdapter(
      'host.view/1',
      mockCapabilities({ viewportSharing: 'shared' }),
      {
        handleCapabilities: (handle) =>
          mockCapabilities({ viewportSharing: handle.key === 'solo' ? 'single-owner' : 'shared' }),
      },
    );
    runtime.registerAdapter(shared);
    await settle();
    expect(
      await runtime.replaceBinding('s', { bindingKey: 'x', adapterTypeId: 'host.other/1' }),
    ).toMatchObject({ status: 'rejected', error: { code: 'ADAPTER_UNAVAILABLE' } });
    await runtime.present('s', 'v1', {});
    await runtime.present('s', 'v2', {});
    expect(await runtime.replaceBinding('s', { bindingKey: 'solo' })).toMatchObject({
      status: 'rejected',
      error: { code: 'UNSUPPORTED_CAPABILITY' },
    });
    expect(runtime.get('s')?.binding.bindingKey).toBe('k');
  });

  it('hands the new binding the generation it commits as', async () => {
    const { runtime, adapter } = await presented();
    const before = runtime.get('s')?.generation ?? -1;
    adapter.contexts.length = 0;
    expect(await runtime.replaceBinding('s', { bindingKey: 'new' })).toMatchObject({
      status: 'ok',
    });
    const after = runtime.get('s')?.generation;
    expect(after).toBe(before + 1);
    expect(adapter.contexts.map((c) => c.generation)).toEqual([after]);
  });

  it('refuses to hand a single-owner endpoint over while another surface presents it, as present does', async () => {
    const { ws, runtime, adapter } = await presented();
    committed(ws.transaction([window('w2'), surface('s2', 'w2', 'other')]));
    await settle();
    await runtime.present('s2', 'v2', {});
    const revision = ws.getState().revision;
    expect(await runtime.replaceBinding('s2', { bindingKey: 'old' })).toMatchObject({
      status: 'rejected',
      error: {
        code: 'UNSUPPORTED_CAPABILITY',
        entityId: 's2',
        message: expect.stringMatching(/already presented by surface "s"/) as unknown,
      },
    });
    expect(runtime.get('s2')).toMatchObject({
      state: 'presented',
      binding: { bindingKey: 'other' },
      replacing: false,
    });
    expect(ws.getState().revision).toBe(revision);
    // The endpoint was never mounted a second time.
    expect(
      adapter.calls.filter((c) => c.method === 'attach' && c.handle?.key === 'old'),
    ).toHaveLength(1);
    // Once the endpoint is free, it can be handed over.
    await runtime.hide('s', 'v1', { release: true });
    expect(await runtime.replaceBinding('s2', { bindingKey: 'old' })).toMatchObject({
      status: 'ok',
    });
  });

  it('refuses to present a single-owner endpoint another surface is handing over to', async () => {
    const adapter = new MockOpaqueAdapter();
    const { ws, runtime } = await presented(adapter);
    committed(ws.transaction([window('w2'), surface('s2', 'w2', 'next')]));
    await settle();
    adapter.holdingAttach.add('next');
    const replacing = runtime.replaceBinding('s', { bindingKey: 'next' });
    await settle();
    expect(runtime.get('s')?.replacing).toBe(true);
    expect(await runtime.present('s2', 'v2', {})).toMatchObject({
      status: 'rejected',
      error: {
        code: 'UNSUPPORTED_CAPABILITY',
        entityId: 's2',
        message: expect.stringMatching(/already presented by surface "s"/) as unknown,
      },
    });
    adapter.attachHeld.get('next')?.shift()?.();
    expect(await replacing).toMatchObject({ status: 'ok' });
  });

  it('hands off across adapters and reports the new capabilities', async () => {
    const { ws, runtime, events } = await presented();
    const drawable = new MockOpaqueAdapter(
      'host.canvas/1',
      mockCapabilities({
        attachStrategy: 'drawable',
        nativeInteraction: 'none',
        viewportSharing: 'shared',
      }),
    );
    runtime.registerAdapter(drawable);
    const result = await runtime.replaceBinding('s', {
      bindingKey: 'frame',
      adapterTypeId: 'host.canvas/1',
    });
    expect(result).toMatchObject({
      status: 'ok',
      presentation: {
        binding: { adapterTypeId: 'host.canvas/1' },
        capabilities: { attachStrategy: 'drawable' },
      },
    });
    expect(ws.getState().surfaces.get('s')?.adapterTypeId).toBe('host.canvas/1');
    expect(events.map((e) => e.type)).toEqual([
      'adapter.registered',
      'presentation.replaced',
      'presentation.capabilitiesChanged',
    ]);
    // The new binding's context is live after the handoff.
    drawable.contexts[0]?.reportUnavailable('canvas lost');
    await settle();
    expect(runtime.get('s')?.state).toBe('error');
  });
});
