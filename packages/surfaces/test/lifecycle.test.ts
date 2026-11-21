import { describe, expect, it } from 'vitest';
import type { PresentationHint } from '../src/index.js';
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

async function bound(adapter = new MockOpaqueAdapter(), ...extra: string[]) {
  const ws = makeWorkspace();
  const runtime = createSurfaceRuntime(ws);
  const events = record(runtime);
  runtime.registerAdapter(adapter);
  committed(
    ws.transaction([
      window('w'),
      surface('s', 'w', 'k'),
      ...extra.map((id) => surface(id, 'w', `key-${id}`)),
    ]),
  );
  await settle();
  return { ws, runtime, events, adapter };
}

function hint(viewportId: string, over: Partial<PresentationHint> = {}): PresentationHint {
  return {
    surfaceId: 's',
    viewportId,
    sceneRevision: 2,
    visible: true,
    mounted: true,
    sceneVisible: true,
    intersectionRatio: 1,
    occlusion: { value: 0, confidence: 'estimated' },
    projectedBounds: [10, 10, 320, 180],
    tier: 'full',
    attention: 'active',
    spatialBounds: [1.6, 0.9, 0.01],
    requestedIntrinsicSize: null,
    ...over,
  };
}

describe('presentation lifecycle', () => {
  it('walks ready → presented → hidden → presented → detaching → unbound', async () => {
    const { runtime, events, adapter } = await bound();
    const container = { layer: 'native' };
    expect(await runtime.present('s', 'v1', container)).toMatchObject({
      status: 'ok',
      presentation: { state: 'presented', viewports: [{ viewportId: 'v1', visible: true }] },
    });
    expect(await runtime.hide('s', 'v1')).toMatchObject({
      status: 'ok',
      presentation: { state: 'hidden' },
    });
    expect(await runtime.present('s', 'v1', container)).toMatchObject({
      status: 'ok',
      presentation: { state: 'presented' },
    });
    expect(await runtime.unbind('s')).toMatchObject({
      status: 'ok',
      presentation: { state: 'unbound', unboundReason: 'released' },
    });
    expect(transitions(events, 's')).toEqual([
      'none>unbound',
      'unbound>binding',
      'binding>ready',
      'ready>presented',
      'presented>hidden',
      'hidden>presented',
      'presented>detaching',
      'detaching>unbound',
    ]);
    // Revealing a hidden surface reuses its attachment: one attach, one detach in all.
    expect(adapter.methods().filter((m) => m === 'attach' || m === 'detach')).toEqual([
      'attach',
      'detach',
    ]);
    expect(adapter.producerTouched).toBe(0);
  });

  it('hands the adapter a target with the surface’s geometry and the backend’s container', async () => {
    const { ws, runtime, adapter } = await bound();
    const attached: unknown[] = [];
    const original = adapter.attach.bind(adapter);
    adapter.attach = (handle, target) => {
      attached.push(target);
      return original(handle, target);
    };
    const container = { layer: 'native' };
    await runtime.present('s', 'v1', container);
    expect(attached[0]).toMatchObject({
      surfaceId: 's',
      viewportId: 'v1',
      container,
      geometry: { kind: 'rect', fidelity: 'exact' },
    });
    expect(Object.isFrozen(attached[0])).toBe(true);
    expect(ws.getState().revision).toBe(1);
  });

  it('rejects presenting without a ready binding, or twice in one viewport, with typed errors', async () => {
    const adapter = new MockOpaqueAdapter();
    adapter.holding.add('slow');
    const { ws, runtime } = await bound(adapter);
    committed(ws.dispatch(surface('t', 'w', 'slow')));
    expect(await runtime.present('t', 'v1', {})).toMatchObject({
      status: 'rejected',
      error: { code: 'INVALID_TRANSITION', entityId: 't' },
    });
    committed(ws.dispatch(surface('u', 'w', null)));
    expect(await runtime.present('u', 'v1', {})).toMatchObject({
      status: 'rejected',
      error: { code: 'INVALID_TRANSITION' },
    });
    await runtime.present('s', 'v1', {});
    expect(await runtime.present('s', 'v1', {})).toMatchObject({
      status: 'rejected',
      error: { code: 'INVALID_TRANSITION' },
    });
    expect(await runtime.hide('s', 'v9')).toMatchObject({
      status: 'rejected',
      error: { code: 'INVALID_TRANSITION' },
    });
    expect(await runtime.present('nope', 'v1', {})).toMatchObject({
      status: 'rejected',
      error: { code: 'UNKNOWN_ENTITY' },
    });
  });

  it('releases a hidden attachment only when the handle declares safe detachment', async () => {
    const { runtime, adapter } = await bound();
    await runtime.present('s', 'v1', {});
    expect(await runtime.hide('s', 'v1', { release: true })).toMatchObject({
      status: 'ok',
      presentation: { state: 'ready', viewports: [] },
    });
    expect(adapter.methods().slice(-2)).toEqual(['update', 'detach']);

    const unsafe = await bound(
      new MockOpaqueAdapter(
        'host.view/1',
        mockCapabilities({ safeDetach: false, rebinding: false }),
      ),
    );
    await unsafe.runtime.present('s', 'v1', {});
    expect(await unsafe.runtime.hide('s', 'v1', { release: true })).toMatchObject({
      status: 'ok',
      presentation: { state: 'hidden', viewports: [{ viewportId: 'v1', visible: false }] },
    });
    expect(unsafe.adapter.methods()).not.toContain('detach');
  });

  it('moves an attachment to another container in its viewport, keeping it shown or hidden', async () => {
    const { runtime, adapter } = await bound();
    const before = { layer: 'old' };
    const after = { layer: 'new' };
    await runtime.present('s', 'v1', before);
    expect(await runtime.move('s', 'v1', after)).toMatchObject({
      status: 'ok',
      presentation: { state: 'presented', viewports: [{ viewportId: 'v1', visible: true }] },
    });
    const targets = adapter.calls.flatMap((c) =>
      c.method === 'attach' || c.method === 'detach'
        ? [`${c.method}:${(c.target?.container as { layer: string }).layer}`]
        : [],
    );
    expect(targets).toEqual(['attach:old', 'detach:old', 'attach:new']);
    // Moving to where it already is changes nothing.
    await runtime.move('s', 'v1', after);
    expect(adapter.methods().filter((m) => m === 'attach' || m === 'detach')).toHaveLength(3);
    // A hidden attachment stays hidden where it goes.
    await runtime.hide('s', 'v1');
    await runtime.move('s', 'v1', before);
    expect(runtime.get('s')).toMatchObject({
      state: 'hidden',
      viewports: [{ viewportId: 'v1', visible: false }],
    });
    expect(adapter.producerTouched).toBe(0);
  });

  it('refuses to move what is not attached there or cannot be detached safely', async () => {
    const { runtime } = await bound();
    expect(await runtime.move('s', 'v1', {})).toMatchObject({
      status: 'rejected',
      error: { code: 'INVALID_TRANSITION', entityId: 's' },
    });
    const unsafe = await bound(
      new MockOpaqueAdapter(
        'host.view/1',
        mockCapabilities({ safeDetach: false, rebinding: false }),
      ),
    );
    await unsafe.runtime.present('s', 'v1', {});
    expect(await unsafe.runtime.move('s', 'v1', {})).toMatchObject({
      status: 'rejected',
      error: { code: 'UNSUPPORTED_CAPABILITY', entityId: 's' },
    });
    expect(unsafe.adapter.methods()).not.toContain('detach');
  });

  it('puts a surface back where it was when attaching it in the new container fails', async () => {
    const { runtime, adapter } = await bound();
    const before = { layer: 'old' };
    await runtime.present('s', 'v1', before);
    const original = adapter.attach.bind(adapter);
    adapter.attach = (handle, target) =>
      target.container === before ? original(handle, target) : Promise.reject(new Error('no room'));
    expect(await runtime.move('s', 'v1', { layer: 'new' })).toMatchObject({
      status: 'rejected',
      error: { code: 'BIND_FAILED', retryable: true, details: { phase: 'move' } },
    });
    expect(runtime.get('s')).toMatchObject({ state: 'presented', viewports: [{ visible: true }] });
    // Its attachment is the old one again: hiding it with release detaches it from there.
    await runtime.hide('s', 'v1', { release: true });
    const last = adapter.calls.at(-1);
    expect(last?.method).toBe('detach');
    expect(last?.target?.container).toBe(before);

    // When even going back fails, the surface is in error and holds no attachment.
    const broken = await bound();
    await broken.runtime.present('s', 'v1', {});
    broken.adapter.attachFailing.add('k');
    expect(await broken.runtime.move('s', 'v1', {})).toMatchObject({ status: 'rejected' });
    expect(broken.runtime.get('s')).toMatchObject({ state: 'error', viewports: [] });
  });

  it('sends the adapter an advisory hidden hint when a surface is hidden', async () => {
    const { runtime, adapter } = await bound();
    await runtime.present('s', 'v1', {});
    runtime.deliverHint(hint('v1'));
    await runtime.hide('s', 'v1');
    const last = adapter.calls.at(-1);
    expect(last?.method).toBe('update');
    expect(last?.hint).toMatchObject({
      visible: false,
      tier: 'hidden',
      attention: 'background',
      projectedBounds: [10, 10, 320, 180],
    });
  });

  it('presents a single-owner handle in one viewport only, and a shared one in several', async () => {
    const { runtime, events } = await bound();
    await runtime.present('s', 'v1', {});
    expect(await runtime.present('s', 'v2', {})).toMatchObject({
      status: 'rejected',
      error: { code: 'UNSUPPORTED_CAPABILITY' },
    });
    expect(events.filter((e) => e.type === 'presentation.viewportChanged')).toHaveLength(1);

    const shared = await bound(
      new MockOpaqueAdapter('host.view/1', mockCapabilities({ viewportSharing: 'shared' })),
    );
    await shared.runtime.present('s', 'v1', {});
    expect(await shared.runtime.present('s', 'v2', {})).toMatchObject({
      status: 'ok',
      presentation: { viewports: [{ viewportId: 'v1' }, { viewportId: 'v2' }] },
    });
    await shared.runtime.hide('s', 'v1');
    expect(shared.runtime.get('s')?.state).toBe('presented');
    await shared.runtime.hide('s', 'v2');
    expect(shared.runtime.get('s')?.state).toBe('hidden');
  });

  it('never gives one single-owner endpoint two simultaneous owners through two surfaces', async () => {
    const { ws, runtime } = await bound();
    committed(
      ws.dispatch({
        type: 'node.duplicate',
        id: 'w',
        ids: { w: 'w2', s: 's2' },
        reuseBindingKeys: true,
      }),
    );
    await settle();
    expect(runtime.get('s2')?.state).toBe('ready');
    await runtime.present('s', 'v1', {});
    expect(await runtime.present('s2', 'v2', {})).toMatchObject({
      status: 'rejected',
      error: { code: 'UNSUPPORTED_CAPABILITY', entityId: 's2' },
    });
    await runtime.hide('s', 'v1', { release: true });
    expect(await runtime.present('s2', 'v2', {})).toMatchObject({ status: 'ok' });
  });

  it('turns a failed mount into an error on that surface only, retryable by the host', async () => {
    const adapter = new MockOpaqueAdapter();
    adapter.attachFailing.add('k');
    const { runtime } = await bound(adapter, 'other');
    expect(await runtime.present('s', 'v1', {})).toMatchObject({
      status: 'rejected',
      error: { code: 'BIND_FAILED', retryable: true, details: { phase: 'attach' } },
    });
    expect(runtime.get('s')).toMatchObject({ state: 'error', viewports: [] });
    expect(await runtime.present('other', 'v1', {})).toMatchObject({ status: 'ok' });
    adapter.attachFailing.delete('k');
    await runtime.bind('s');
    expect(await runtime.present('s', 'v2', {})).toMatchObject({ status: 'ok' });
  });

  it('detaches only the presentation attachment when the association is removed', async () => {
    const { ws, runtime, events, adapter } = await bound();
    await runtime.present('s', 'v1', {});
    const handle = runtime.handleOf('s');
    committed(ws.dispatch({ type: 'node.delete', id: 'w', mode: 'subtree' }));
    await settle();
    expect(transitions(events, 's').slice(-2)).toEqual([
      'presented>detaching',
      'detaching>detached',
    ]);
    expect(runtime.get('s')).toBeUndefined();
    const attach = adapter.calls.find((c) => c.method === 'attach');
    const detach = adapter.calls.filter((c) => c.method === 'detach');
    expect(detach).toEqual([
      { method: 'detach', handle, viewportId: 'v1', target: attach?.target },
    ]);
    expect(adapter.producerTouched).toBe(0);
  });

  it('releases an attachment that completes after its surface was removed', async () => {
    const adapter = new MockOpaqueAdapter();
    adapter.holdingAttach.add('k');
    const { ws, runtime } = await bound(adapter);
    const presenting = runtime.present('s', 'v1', {});
    await settle();
    committed(ws.dispatch({ type: 'surface.detach', id: 's' }));
    await settle();
    adapter.attachHeld.get('k')?.shift()?.();
    expect(await presenting).toMatchObject({ status: 'rejected', error: { code: 'CANCELLED' } });
    expect(adapter.methods().slice(-2)).toEqual(['attach', 'detach']);
    expect(runtime.getDiagnostics().map((d) => d.code)).toContain('STALE_COMPLETION');
  });

  it('passes hints through, coalescing repeats, and resends them when the spatial bounds change', async () => {
    const { ws, runtime, adapter } = await bound();
    await runtime.present('s', 'v1', {});
    expect(runtime.deliverHint(hint('v1'))).toEqual({ status: 'ok', delivered: true });
    expect(runtime.deliverHint(hint('v1'))).toEqual({ status: 'ok', delivered: false });
    expect(runtime.deliverHint(hint('v1', { tier: 'compact' }))).toEqual({
      status: 'ok',
      delivered: true,
    });
    expect(runtime.deliverHint(hint('v7'))).toMatchObject({
      status: 'rejected',
      error: { code: 'INVALID_TRANSITION' },
    });
    committed(ws.dispatch({ type: 'surface.patch', id: 's', bounds: [2, 1, 0.01] }));
    const resent = adapter.calls.at(-1);
    expect(resent?.hint).toMatchObject({
      tier: 'compact',
      spatialBounds: [2, 1, 0.01],
      sceneRevision: 2,
    });
    expect(adapter.calls.filter((c) => c.method === 'update')).toHaveLength(3);
  });

  it('treats a hint the adapter cannot take as advisory, leaving the surface as it was', async () => {
    const { runtime, adapter } = await bound();
    await runtime.present('s', 'v1', {});
    adapter.updateThrows = true;
    expect(runtime.deliverHint(hint('v1'))).toEqual({ status: 'ok', delivered: true });
    expect(runtime.get('s')?.state).toBe('presented');
    expect(runtime.getDiagnostics().at(-1)).toMatchObject({ code: 'HINT_IGNORED', surfaceId: 's' });
  });

  it('isolates a throwing listener and keeps delivering in order', async () => {
    const { ws, runtime } = await bound();
    runtime.subscribe(() => {
      throw new Error('listener bug');
    });
    const later = record(runtime);
    committed(ws.dispatch(surface('t', 'w', 'k2')));
    await settle();
    expect(transitions(later, 't')).toEqual(['none>unbound', 'unbound>binding', 'binding>ready']);
    expect(runtime.getDiagnostics().map((d) => d.code)).toContain('LISTENER_THREW');
  });

  it('releases every attachment on dispose, also when the workspace is disposed', async () => {
    const { ws, runtime, adapter } = await bound(
      new MockOpaqueAdapter('host.view/1', mockCapabilities({ viewportSharing: 'shared' })),
      'other',
    );
    await runtime.present('s', 'v1', {});
    await runtime.present('s', 'v2', {});
    await runtime.present('other', 'v1', {});
    await ws.dispose();
    await settle();
    expect(runtime.disposed).toBe(true);
    expect(adapter.calls.filter((c) => c.method === 'detach')).toHaveLength(3);
    expect(runtime.list()).toEqual([]);
    expect(await runtime.present('s', 'v1', {})).toMatchObject({ status: 'rejected' });
    expect(adapter.producerTouched).toBe(0);
    await runtime.dispose();
  });

  it('rebinds through the lifecycle when the host commits a new key', async () => {
    const { ws, runtime, events, adapter } = await bound();
    await runtime.present('s', 'v1', {});
    committed(ws.dispatch({ type: 'surface.rebind', id: 's', bindingKey: 'k2' }));
    await settle();
    expect(transitions(events, 's').slice(-4)).toEqual([
      'presented>detaching',
      'detaching>unbound',
      'unbound>binding',
      'binding>ready',
    ]);
    expect(runtime.handleOf('s')).toMatchObject({ key: 'k2' });
    expect(adapter.calls.find((c) => c.method === 'detach')?.handle).toMatchObject({ key: 'k' });
  });
});
