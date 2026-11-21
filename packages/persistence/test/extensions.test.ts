import { MockOpaqueAdapter } from '@swf/conformance';
import type { JsonValue } from '@swf/core';
import { SwfFailure } from '@swf/core';
import { createSurfaceRuntime } from '@swf/surfaces';
import { describe, expect, it } from 'vitest';
import type { PersistenceExtension } from '../src/index.js';
import { DEFAULT_SNAPSHOT_LIMITS, validateDocument } from '../src/index.js';
import { commit, layout, persistenceOf, settle, workspace } from './fixtures.js';

/** An extension whose state is whatever `state` returns. */
function extension(
  namespace: string,
  state: () => unknown,
  over: Partial<PersistenceExtension> = {},
): PersistenceExtension {
  return { namespace, version: 1, capture: state, restore: () => undefined, ...over };
}

describe('extension state (FR-162, FR-187, DATA-020, FR-169)', () => {
  it('captures each namespace’s state as its own frozen copy, in namespace order', async () => {
    const p = persistenceOf(layout());
    const notes = { items: ['a'], open: true };
    const seen: string[] = [];
    p.registerExtension(
      extension('ext.notes', (...args: unknown[]) => {
        const [context] = args as [{ namespace: string; signal: AbortSignal }];
        seen.push(context.namespace);
        expect(context.signal.aborted).toBe(false);
        return notes;
      }),
    );
    p.registerExtension(extension('host.board', () => ({ columns: 3 }), { version: 2 }));
    const { document, failures } = await p.capture();
    expect(failures).toEqual([]);
    expect(seen).toEqual(['ext.notes']);
    expect(Object.keys(document.extensions)).toEqual(['ext.notes', 'host.board']);
    expect(document.extensions['ext.notes']).toEqual({
      version: 1,
      data: { items: ['a'], open: true },
    });
    expect(document.extensions['host.board']?.version).toBe(2);
    // The extension's own object is not shared with the snapshot.
    notes.items.push('b');
    expect(document.extensions['ext.notes']?.data).toEqual({ items: ['a'], open: true });
    expect(Object.isFrozen(document.extensions['ext.notes']?.data)).toBe(true);
  });

  it('isolates a failing extension: the others and the layout are captured, its last state kept', async () => {
    const p = persistenceOf(layout(), { hookTimeoutMs: 20 });
    let mode: 'ok' | 'throw' | 'hang' | 'function' = 'ok';
    p.registerExtension(
      extension('ext.flaky', () => {
        switch (mode) {
          case 'ok':
            return { saved: 1 };
          case 'throw':
            throw new Error('database closed');
          case 'hang':
            return new Promise(() => undefined);
          case 'function':
            return { run: () => 1 };
        }
      }),
    );
    p.registerExtension(extension('ext.steady', () => 'fine'));
    await p.capture();
    for (const [next, code, message] of [
      ['throw', 'EXTENSION_FAILED', /failed to capture its state: database closed/],
      ['hang', 'EXTENSION_FAILED', /did not capture its state within 20 ms/],
      ['function', 'INVALID_INPUT', /extensions.ext.flaky.data.run must be JSON data/],
    ] as const) {
      mode = next;
      const { document, failures } = await p.capture();
      expect(failures).toEqual([
        {
          kind: 'extension',
          id: 'ext.flaky',
          error: expect.objectContaining({
            code,
            message: expect.stringMatching(message) as unknown,
          }) as unknown,
        },
      ]);
      expect(document.extensions['ext.flaky']).toEqual({ version: 1, data: { saved: 1 } });
      expect(document.extensions['ext.steady']?.data).toBe('fine');
      expect(document.nodes).toHaveLength(2);
    }
  });

  it('stops a capture its caller cancels', async () => {
    const p = persistenceOf(layout());
    let signal: AbortSignal | null = null;
    p.registerExtension(
      extension('ext.slow', (...args: unknown[]) => {
        signal = (args[0] as { signal: AbortSignal }).signal;
        return new Promise(() => undefined);
      }),
    );
    const controller = new AbortController();
    const capture = p.capture({ signal: controller.signal });
    await settle();
    controller.abort();
    const { failures } = await capture;
    expect(failures[0]?.error.code).toBe('CANCELLED');
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
  });

  it('holds each namespace to 1 MiB and all of them to 10 MiB by default', async () => {
    expect(DEFAULT_SNAPSHOT_LIMITS).toEqual({
      maxBytes: 32 * 1024 * 1024,
      extensionBytes: 1024 * 1024,
      extensionTotalBytes: 10 * 1024 * 1024,
    });
    const p = persistenceOf(layout());
    // 1 MiB of data, quotes included, fits; one byte more does not.
    let size = 1024 * 1024 - 2;
    p.registerExtension(extension('ext.big', () => 'x'.repeat(size)));
    expect((await p.capture()).failures).toEqual([]);
    size += 1;
    const over = await p.capture();
    expect(over.failures[0]?.error).toMatchObject({
      code: 'QUOTA_EXCEEDED',
      path: 'extensions.ext.big.data',
      details: { bytes: 1024 * 1024 + 1, limit: 1024 * 1024 },
    });
    // What it held before stays.
    expect((over.document.extensions['ext.big']?.data as string).length).toBe(1024 * 1024 - 2);
    // Eleven namespaces of nearly 1 MiB each go over 10 MiB: the last one is left out.
    const q = persistenceOf(layout());
    for (let i = 0; i < 11; i++) {
      q.registerExtension(
        extension(`ext.n${String(i).padStart(2, '0')}`, () => 'y'.repeat(1024 * 1024 - 10)),
      );
    }
    const all = await q.capture();
    expect(Object.keys(all.document.extensions)).toHaveLength(10);
    expect(all.failures).toEqual([
      expect.objectContaining({
        id: 'ext.n10',
        error: expect.objectContaining({ code: 'QUOTA_EXCEEDED' }) as unknown,
      }),
    ]);
  });

  it('keeps the state of namespaces whose owner is absent, exactly as it was', async () => {
    const source = persistenceOf(layout());
    source.registerExtension(extension('ext.gone', () => ({ z: [1, { y: 'two' }], a: null })));
    source.registerPolicy({ id: 'host.snap/1', capture: () => ({ distance: 0.08 }) });
    const text = source.export((await source.capture()).document);

    // Another session without that extension or policy loads the snapshot, then saves again.
    const ws = layout();
    const p = persistenceOf(ws);
    p.registerExtension(extension('ext.here', () => 1));
    p.retain(p.import(text));
    commit(ws, [{ type: 'node.patch', id: 'a', label: 'Renamed' }]);
    const again = (await p.capture()).document;
    expect(again.extensions['ext.gone']).toEqual(p.import(text).extensions['ext.gone']);
    expect(JSON.stringify(again.extensions['ext.gone'])).toBe(
      '{"version":1,"data":{"a":null,"z":[1,{"y":"two"}]}}',
    );
    expect(again.policies['host.snap/1']).toEqual({ distance: 0.08 });
    expect(again.extensions['ext.here']?.data).toBe(1);
  });

  it('validates registrations and keeps namespaces unique', () => {
    const p = persistenceOf(layout());
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error instanceof SwfFailure ? `${error.error.code} ${error.message}` : String(error);
      }
      return 'accepted';
    };
    expect(code(() => p.registerExtension(extension('notes', () => 1)))).toMatch(
      /INVALID_INPUT .*namespace/,
    );
    expect(code(() => p.registerExtension(extension('swf.notes', () => 1)))).toMatch(/namespace/);
    expect(code(() => p.registerExtension(extension('ext.a', () => 1, { version: 0 })))).toMatch(
      /version/,
    );
    expect(
      code(() =>
        p.registerExtension({
          namespace: 'ext.a',
          version: 1,
          capture: () => 1,
        } as unknown as PersistenceExtension),
      ),
    ).toMatch(/must implement restore\(\)/);
    const stop = p.registerExtension(extension('ext.a', () => 1));
    expect(code(() => p.registerExtension(extension('ext.a', () => 2)))).toMatch(
      /already registered/,
    );
    stop();
    stop();
    expect(code(() => p.registerExtension(extension('ext.a', () => 2)))).toBe('accepted');
    expect(code(() => p.registerPolicy({ id: 'snap', capture: () => 1 }))).toMatch(/versioned ID/);
  });
});

describe('policy parameters and changes (FR-160, CFG-003)', () => {
  it('saves policy parameters and counts their changes, as it counts commits', async () => {
    const ws = layout();
    const p = persistenceOf(ws);
    const heard: number[] = [];
    p.subscribe(() => heard.push(p.changes()));
    let settings: JsonValue = { slopPx: 4 };
    let changed: () => void = () => undefined;
    const stop = p.registerPolicy({
      id: 'swf.interaction/1',
      capture: () => settings,
      watch: (notify) => {
        changed = notify;
        return () => {
          changed = () => undefined;
        };
      },
    });
    expect((await p.capture()).document.policies).toEqual({ 'swf.interaction/1': { slopPx: 4 } });
    settings = { slopPx: 7 };
    changed();
    commit(ws, [{ type: 'node.patch', id: 'b', label: 'B' }]);
    // A preview leaves the committed scene, and so the saved layout, as it was.
    ws.preview('drag', [{ type: 'node.patch', id: 'b', label: 'C' }]);
    expect(heard).toEqual([1, 2]);
    const capture = await p.capture();
    expect(capture.changes).toBe(2);
    expect(capture.document.policies['swf.interaction/1']).toEqual({ slopPx: 7 });
    stop();
    changed();
    expect(p.changes()).toBe(2);
  });

  it('isolates a throwing change listener and keeps its failure', () => {
    const ws = layout();
    const p = persistenceOf(ws);
    p.subscribe(() => {
      throw new Error('listener bug');
    });
    let heard = 0;
    p.subscribe(() => (heard += 1));
    commit(ws, [{ type: 'node.patch', id: 'b', label: 'B' }]);
    expect(heard).toBe(1);
    expect(p.getDiagnostics()).toEqual([
      expect.objectContaining({
        code: 'LISTENER_THREW',
        message: expect.stringMatching(/listener bug/) as unknown,
      }),
    ]);
  });
});

describe('what a snapshot never holds (FR-202, DATA-014, QA-011)', () => {
  it('holds binding keys, never the handles, elements or callbacks they resolve to', async () => {
    const ws = workspace();
    const runtime = createSurfaceRuntime(ws);
    const adapter = new MockOpaqueAdapter('host.editor/1');
    runtime.registerAdapter(adapter);
    layout(ws);
    await settle();
    expect(runtime.get('a-s')?.state).toBe('ready');
    const handle = runtime.handleOf('a-s') as { key: string; serial: number };
    await runtime.present('a-s', 'v', { element: 'a live element', listener: () => 1 });
    const p = persistenceOf(ws);
    const text = p.export((await p.capture()).document);
    expect(text).toContain('"bindingKey":"editor-42"');
    expect(text).not.toContain('a live element');
    expect(text).not.toContain('"serial"');
    expect(text).not.toContain(`"serial":${String(handle.serial)}`);
    // Everything in it is plain data: it survives a JSON round trip unchanged.
    expect(validateDocument(JSON.parse(text))).toEqual(p.import(text));
    await runtime.dispose();
  });
});
