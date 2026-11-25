import { ManualFrames, MockCompositor, MockRenderer } from '@swf/conformance';
import type { SceneCommand, Workspace } from '@swf/core';
import { createWorkspace, SwfFailure } from '@swf/core';
import { createPresentationRegistry, createPresenter } from '@swf/presentation';
import { createSurfaceRuntime } from '@swf/surfaces';
import { describe, expect, it } from 'vitest';
import {
  createDiagnostics,
  createOperationTrace,
  disclosureOf,
  exportDiagnostics,
} from '../src/index.js';

/** A window with a labelled, bound, tagged surface: everything an export must keep private. */
const windowCommands = (id: string, key: string): SceneCommand[] => [
  {
    type: 'node.create',
    node: {
      id,
      kind: 'window',
      label: `Secret plan ${id}`,
      tags: ['confidential'],
      metadata: { 'host.crm.customer': 'ACME' },
      bounds: [1, 0.6, 0.01],
    },
  },
  {
    type: 'surface.attach',
    surface: {
      id: `${id}-s`,
      ownerNodeId: id,
      bindingKey: key,
      adapterTypeId: 'test.view/1',
      label: `Secret view ${id}`,
      bounds: [1, 0.6, 0.01],
    },
  },
];

/** The same operations, on a workspace with the given clocks. */
function operate(ws: Workspace): void {
  ws.transaction(windowCommands('a', 'file:///home/me/plan.pdf'), { source: 'user' });
  ws.transaction(windowCommands('b', 'file:///home/me/plan.pdf'), { source: 'host' });
  ws.dispatch(
    {
      type: 'node.patch',
      id: 'a',
      label: 'Renamed secret',
      transform: { position: [1, 0, -3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
    },
    { source: 'user', causeId: 'gesture-1' },
  );
  // Refused: the node does not exist. Its message names the ID it looked for.
  ws.dispatch({ type: 'node.delete', id: 'missing', mode: 'subtree' }, { source: 'user' });
  ws.undo({ source: 'user' });
}

describe('the operation trace (AUD-002)', () => {
  it('records every transaction, committed or refused, in order, with what undo reversed', () => {
    const ws = createWorkspace({ id: 'ws' });
    const trace = createOperationTrace({ workspace: ws });
    operate(ws);
    const entries = trace.entries();
    expect(entries.map((e) => [e.seq, e.outcome, e.commandTypes.join('+')])).toEqual([
      [1, 'committed', 'node.create+surface.attach'],
      [2, 'committed', 'node.create+surface.attach'],
      [3, 'committed', 'node.patch'],
      [4, 'rejected', 'node.delete'],
      [5, 'committed', 'node.patch'],
    ]);
    expect(entries[2]).toMatchObject({ causeId: 'gesture-1', source: 'user', revision: 3 });
    expect(entries[3]).toMatchObject({
      revision: 3,
      previousRevision: 3,
      commands: null,
      error: { code: 'UNKNOWN_ENTITY' },
    });
    expect(entries[4]).toMatchObject({
      commands: null,
      history: { action: 'undo', transactionId: entries[2]?.transactionId },
    });
  });

  it('serializes the same operations to the same text, whatever the clocks', () => {
    const traceOf = (start: number, step: number) => {
      let t = start;
      const ws = createWorkspace({ id: 'ws', now: () => (t += step), timer: () => (t += step) });
      const trace = createOperationTrace({ workspace: ws });
      operate(ws);
      return trace.serialize();
    };
    const one = traceOf(0, 1);
    expect(traceOf(5_000_000, 7)).toBe(one);
    // Timings make it differ, so they are disclosed only on request.
    expect(one).not.toContain('durationMs');
  });

  it('keeps labels, binding keys, host data and messages out unless they are disclosed', () => {
    const ws = createWorkspace({ id: 'ws' });
    const trace = createOperationTrace({ workspace: ws });
    operate(ws);
    const text = trace.serialize();
    for (const secret of ['Secret', 'plan.pdf', 'confidential', 'ACME', 'host.crm', 'missing']) {
      expect(text).not.toContain(secret);
    }
    const parsed = JSON.parse(text) as { entries: { commands: unknown }[] };
    const first = JSON.stringify(parsed.entries[0]?.commands);
    const second = JSON.stringify(parsed.entries[1]?.commands);
    // The same key keeps the same token: that the two windows show the same content stays clear.
    expect(first).toContain('"bindingKey":"binding-1"');
    expect(second).toContain('"bindingKey":"binding-1"');
    expect(first).toContain('"label":"[label]"');
    expect(first).toContain('"metadata":"[host data]"');
    expect(first).toContain('"tags":"[host data]"');
    // IDs, adapter types and numbers stay: what is needed to reproduce the operations.
    expect(first).toContain('"adapterTypeId":"test.view/1"');
    const open = trace.serialize({
      labels: true,
      bindingKeys: true,
      hostData: true,
      messages: true,
      timings: true,
    });
    for (const secret of ['Secret plan a', 'plan.pdf', 'confidential', 'ACME', 'missing']) {
      expect(open).toContain(secret);
    }
    expect(open).toContain('durationMs');
  });

  it('keeps the newest entries within its capacity and counts the rest', () => {
    const ws = createWorkspace({ id: 'ws' });
    const trace = createOperationTrace({ workspace: ws, capacity: 2 });
    operate(ws);
    expect(trace.entries().map((e) => e.seq)).toEqual([4, 5]);
    expect(trace.dropped()).toBe(3);
    trace.clear();
    expect(trace.entries()).toEqual([]);
    trace.dispose();
    trace.dispose();
    ws.transaction(windowCommands('c', 'k'));
    expect(trace.entries()).toEqual([]);
  });

  it('refuses an invalid capacity or something it cannot disclose, naming it', () => {
    const ws = createWorkspace({ id: 'ws' });
    expect(() => createOperationTrace({ workspace: ws, capacity: 0 })).toThrow(SwfFailure);
    const trace = createOperationTrace({ workspace: ws });
    expect(() => trace.serialize({ pixels: true } as never)).toThrow(/disclosure.pixels/);
    expect(() => trace.serialize({ labels: 'yes' } as never)).toThrow(/disclosure.labels/);
    // A name every object inherits is not something an export can disclose.
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const disclosure = JSON.parse(`{"${name}": true}`) as never;
      expect(() => disclosureOf(disclosure)).toThrow(new RegExp(`disclosure.${name} is not`));
      expect(() => trace.serialize(disclosure)).toThrow(SwfFailure);
    }
  });
});

describe('the diagnostics export (PRIV-003, AN-009, AN-011, AN-002)', () => {
  function rig() {
    let t = 0;
    let timed = 0;
    // The timer reads 2 ms later each time: a transaction reads it as it starts and ends.
    const ws = createWorkspace({ id: 'ws', now: () => (t += 1), timer: () => (timed += 2) });
    const runtime = createSurfaceRuntime(ws, { autoBind: false });
    const registry = createPresentationRegistry();
    registry.registerRenderer(new MockRenderer());
    registry.registerCompositor(new MockCompositor());
    const presenter = createPresenter({
      workspace: ws,
      runtime,
      registry,
      frames: new ManualFrames(),
      showDegraded: () => () => undefined,
    });
    const diagnostics = createDiagnostics({ workspace: ws, runtime, presenter, registry });
    const trace = createOperationTrace({ workspace: ws });
    operate(ws);
    return { ws, runtime, presenter, diagnostics, trace };
  }

  it('measures scene operations by command type: counts, outcomes, nodes, revisions, durations', () => {
    const { diagnostics } = rig();
    const operations = Object.fromEntries(
      diagnostics.read().operations.map((o) => [o.commandType, o]),
    );
    expect(operations['node.create']).toMatchObject({
      committed: 2,
      rejected: 0,
      affectedNodes: 2,
      lastRevision: 2,
      lastDurationMs: 2,
      maxDurationMs: 2,
      totalDurationMs: 4,
    });
    // The undo of the move counts as a node.patch too: it changed the same node back.
    expect(operations['node.patch']).toMatchObject({ committed: 2, affectedNodes: 2 });
    expect(operations['node.delete']).toMatchObject({ committed: 0, rejected: 1 });
  });

  it('exports identifiers, numbers and error codes only, unless more is chosen', () => {
    const { ws, diagnostics, trace } = rig();
    const text = exportDiagnostics({
      report: diagnostics.read(),
      scene: ws.getState(),
      trace,
      measures: { input: { picks: 3, lastPickMs: 0.4 } },
      exportedAt: 1234,
    });
    for (const secret of ['Secret', 'plan.pdf', 'confidential', 'ACME', 'host.crm']) {
      expect(text).not.toContain(secret);
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      export: 'swf.diagnostics/1',
      workspaceId: 'ws',
      exportedAt: 1234,
      disclosed: { labels: false, bindingKeys: false, hostData: false, messages: false },
      measures: { input: { picks: 3, lastPickMs: 0.4 } },
    });
    expect(parsed).not.toHaveProperty('labels');
    expect(parsed).not.toHaveProperty('bindings');
    expect(parsed).not.toHaveProperty('hostData');
    const chosen = JSON.parse(
      exportDiagnostics({
        report: diagnostics.read(),
        scene: ws.getState(),
        disclosure: { labels: true, bindingKeys: true, hostData: true },
        exportedAt: 1234,
      }),
    ) as Record<string, unknown>;
    expect(chosen).toMatchObject({
      labels: { nodes: { a: 'Secret plan a' }, surfaces: { 'a-s': 'Secret view a' } },
      bindings: { 'b-s': { bindingKey: 'file:///home/me/plan.pdf', adapterTypeId: 'test.view/1' } },
      hostData: { a: { tags: ['confidential'], metadata: { 'host.crm.customer': 'ACME' } } },
    });
  });

  it('refuses measures that are not JSON data', () => {
    const { ws, diagnostics } = rig();
    expect(() =>
      exportDiagnostics({
        report: diagnostics.read(),
        scene: ws.getState(),
        measures: { element: { node: () => undefined } },
        exportedAt: 0,
      }),
    ).toThrow(SwfFailure);
  });
});
