/// <reference types="vite/client" />
import { MockOpaqueAdapter } from '@swf/conformance';
import type { JsonValue, Workspace } from '@swf/core';
import { createWorkspace } from '@swf/core';
import { createSurfaceRuntime } from '@swf/surfaces';
import { describe, expect, it } from 'vitest';
import type { PersistenceExtension, RestoreOutcome, SchemaMigration } from '../src/index.js';
import {
  createPersistence,
  migrateDocument,
  SNAPSHOT_MIGRATIONS,
  SNAPSHOT_SCHEMA_ID,
} from '../src/index.js';
import { commit, edited, layout, PANORAMA, persistenceOf, settle, workspace } from './fixtures.js';

/** Snapshots of each format, as published: each still restores. */
const fixtures = {
  1: import.meta.glob<string>('../fixtures/swf.workspace-1/*.json', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
  2: import.meta.glob<string>('../fixtures/swf.workspace-2/*.json', {
    query: '?raw',
    import: 'default',
    eager: true,
  }),
};

/** A fixture of format `version` by its file name. */
function fixtureOf(version: 1 | 2, name: string): string {
  const text = fixtures[version][`../fixtures/swf.workspace-${String(version)}/${name}`];
  if (text === undefined) {
    throw new Error(`no swf.workspace/${String(version)} fixture ${name}`);
  }
  return text.trimEnd();
}

/** A layout's snapshot text, taken from a workspace of its own. */
async function snapshotText(ws: Workspace = layout()): Promise<string> {
  const p = persistenceOf(ws);
  return p.export((await p.capture()).document);
}

function restored(outcome: RestoreOutcome) {
  if (outcome.status !== 'restored') {
    throw new Error(`rejected: ${outcome.error.code} ${outcome.error.message}`);
  }
  return outcome;
}

function rejectedWith(outcome: RestoreOutcome) {
  if (outcome.status !== 'rejected') {
    throw new Error('it was restored');
  }
  return outcome.error;
}

/** The scene of a workspace without what identifies its own copy. */
const sceneOf = (ws: Workspace) => ({ ...ws.serialize(), workspaceId: null, revision: null });

describe('restoring a snapshot (FR-002, FR-163, FR-165, FR-167, API-011)', () => {
  it('brings a layout into another workspace exactly, as one revision', async () => {
    const source = layout();
    const text = await snapshotText(source);
    const target = workspace();
    const outcome = restored(await persistenceOf(target).restore(text));
    expect(outcome).toMatchObject({
      sourceVersion: SNAPSHOT_SCHEMA_ID,
      targetVersion: SNAPSHOT_SCHEMA_ID,
      migrations: [],
      failures: [],
      revision: 1,
    });
    expect(sceneOf(target)).toEqual(sceneOf(source));
  });

  it('replaces, never duplicates, however often the same snapshot is restored', async () => {
    const text = await snapshotText();
    const ws = workspace();
    const p = persistenceOf(ws);
    restored(await p.restore(text));
    const once = ws.getState();
    restored(await p.restore(text));
    restored(await p.restore(JSON.parse(text)));
    expect(ws.getState().nodes.size).toBe(2);
    expect(ws.getState().nodes.get('a')).toBe(once.nodes.get('a'));
    expect(sceneOf(ws)).toEqual({ ...sceneOf(layout()) });
  });

  it('changes nothing when the snapshot is corrupted, oversized, cyclic or of an unknown format (§33.2 scenario 8)', async () => {
    const text = await snapshotText();
    const document = JSON.parse(text) as Record<string, unknown>;
    const ws = layout(workspace());
    commit(ws, [{ type: 'node.patch', id: 'a', label: 'current' }]);
    const p = persistenceOf(ws, { limits: { maxBytes: text.length + 10 } });
    let restoredCalls = 0;
    p.registerExtension({
      namespace: 'ext.notes',
      version: 1,
      capture: () => ({ mine: true }),
      restore: () => {
        restoredCalls += 1;
      },
    });
    const before = ws.getState();
    const known = (await p.capture()).document.extensions;
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    const cases: [string, unknown, Record<string, unknown>][] = [
      [
        'corrupted',
        text.slice(0, text.length / 2),
        { code: 'SNAPSHOT_INVALID', message: expect.stringMatching(/is not JSON/) },
      ],
      [
        'oversized',
        text.replace('"label":"Notes"', `"label":"${'x'.repeat(100)}"`),
        { code: 'SNAPSHOT_INVALID', details: { limit: text.length + 10 } },
      ],
      [
        'cyclic data',
        edited(document as never, ['nodes.0.metadata', { 'host.loop': loop }]),
        { code: 'SNAPSHOT_INVALID', message: expect.stringMatching(/contains itself/) },
      ],
      [
        'cyclic hierarchy',
        edited(
          document as never,
          ['rootIds', []],
          ['nodes.0.parentId', 'b'],
          ['nodes.1.childIds', ['a']],
        ),
        {
          code: 'SNAPSHOT_INVALID',
          path: 'nodes[0].parentId',
          details: { sourceVersion: SNAPSHOT_SCHEMA_ID },
        },
      ],
      [
        'unknown format',
        { ...document, schema: 'swf.workspace/9' },
        { code: 'SNAPSHOT_INVALID', path: 'schema', details: { sourceVersion: 'swf.workspace/9' } },
      ],
      [
        'unregistered projection',
        edited(document as never, ['viewports.0.projection.id', 'other.pano/1']),
        {
          code: 'SNAPSHOT_INVALID',
          path: 'viewports[0].projection.id',
          details: { sourceVersion: SNAPSHOT_SCHEMA_ID },
        },
      ],
    ];
    for (const [what, input, expected] of cases) {
      const error = rejectedWith(await p.restore(input));
      expect(error, what).toMatchObject(expected);
      expect(error.message.length, what).toBeGreaterThan(10);
    }
    expect(ws.getState()).toBe(before);
    expect(restoredCalls).toBe(0);
    expect((await p.capture()).document.extensions).toEqual(known);
    // A stale expectation is refused too.
    expect(rejectedWith(await p.restore(text, { expectedRevision: 0 }))).toMatchObject({
      code: 'CONFLICT',
      details: { sourceVersion: SNAPSHOT_SCHEMA_ID },
    });
  });

  it('restores missing bindings as named placeholders that bind in place later (AC-009, FR-170)', async () => {
    const text = await snapshotText();
    const ws = workspace();
    const runtime = createSurfaceRuntime(ws);
    const p = persistenceOf(ws);
    restored(await p.restore(text));
    await settle();
    // No adapter yet: the layout is there, the surface a placeholder that keeps its key.
    expect(runtime.get('a-s')).toMatchObject({
      state: 'unbound',
      unboundReason: 'adapter-unavailable',
      binding: { bindingKey: 'editor-42', adapterTypeId: 'host.editor/1' },
    });
    expect(ws.getState().nodes.get('a')?.label).toBe('Notes');
    // A later snapshot still holds the binding.
    expect((await p.capture()).document.surfaces[0]?.bindingKey).toBe('editor-42');
    // The adapter arrives: the surface binds where it is, as the same surface.
    const position = ws.getState().nodes.get('a')?.transform.position;
    runtime.registerAdapter(new MockOpaqueAdapter('host.editor/1'));
    await settle();
    expect(runtime.get('a-s')?.state).toBe('ready');
    expect(ws.getState().nodes.get('a')?.transform.position).toBe(position);
    expect(ws.getState().surfaces.size).toBe(1);
    await runtime.dispose();
  });
});

describe('policies and extensions taking back their state (FR-162, FR-169, FR-187)', () => {
  function extension(
    namespace: string,
    over: Partial<PersistenceExtension> = {},
  ): PersistenceExtension & { got: JsonValue[] } {
    const got: JsonValue[] = [];
    return {
      namespace,
      version: 1,
      capture: () => ({ from: namespace }),
      restore: (data) => {
        got.push(data);
      },
      got,
      ...over,
    };
  }

  async function savedWith(setup: (p: ReturnType<typeof persistenceOf>) => void): Promise<string> {
    const p = persistenceOf(layout());
    setup(p);
    return p.export((await p.capture()).document);
  }

  it('gives each extension and policy its own state back, and keeps that of absent owners', async () => {
    const text = await savedWith((p) => {
      p.registerExtension(extension('ext.notes', { capture: () => ({ items: ['a'] }) }));
      p.registerExtension(extension('ext.gone', { capture: () => ({ keep: 'me' }) }));
      p.registerPolicy({ id: 'swf.interaction/1', capture: () => ({ slopPx: 7 }) });
      p.registerPolicy({ id: 'host.gone/1', capture: () => ({ x: 1 }) });
    });
    const p = persistenceOf(workspace());
    const notes = extension('ext.notes');
    p.registerExtension(notes);
    const settings: JsonValue[] = [];
    p.registerPolicy({
      id: 'swf.interaction/1',
      capture: () => ({ slopPx: 4 }),
      restore: (parameters) => {
        settings.push(parameters);
      },
    });
    const outcome = restored(await p.restore(text));
    expect(notes.got).toEqual([{ items: ['a'] }]);
    expect(settings).toEqual([{ slopPx: 7 }]);
    expect(outcome.warnings).toEqual([
      'extension "ext.gone" is not registered: its state is kept as it was',
      'policy "host.gone/1" is not registered: its parameters are kept as they were',
    ]);
    const again = (await p.capture()).document;
    expect(again.extensions['ext.gone']).toEqual({ version: 1, data: { keep: 'me' } });
    expect(again.policies['host.gone/1']).toEqual({ x: 1 });
  });

  it('migrates an older extension state on a copy, and keeps one it cannot migrate', async () => {
    const text = await savedWith((p) => {
      p.registerExtension(extension('ext.notes', { capture: () => ({ list: ['a', 'b'] }) }));
      p.registerExtension(extension('ext.stuck', { capture: () => ({ v: 1 }) }));
      p.registerExtension(extension('ext.future', { version: 5, capture: () => ({ v: 5 }) }));
    });
    const ws = workspace();
    const p = persistenceOf(ws);
    const notes = extension('ext.notes', {
      version: 2,
      migrate: (data, from) => {
        expect(from).toBe(1);
        const old = data as { list: string[] };
        old.list.push('mutated copy');
        return { items: old.list.map((text) => ({ text })) };
      },
    });
    const stuck = extension('ext.stuck', { version: 2 });
    const future = extension('ext.future', { version: 2 });
    p.registerExtension(notes);
    p.registerExtension(stuck);
    p.registerExtension(future);
    const outcome = restored(await p.restore(text));
    expect(notes.got).toEqual([
      { items: [{ text: 'a' }, { text: 'b' }, { text: 'mutated copy' }] },
    ]);
    expect(outcome.warnings).toContain(
      'extension "ext.notes" state was migrated from version 1 to 2',
    );
    expect(outcome.failures.map((f) => [f.id, f.error.code, f.error.path])).toEqual([
      ['ext.future', 'EXTENSION_FAILED', 'extensions.ext.future.version'],
      ['ext.stuck', 'EXTENSION_FAILED', 'extensions.ext.stuck.version'],
    ]);
    expect(stuck.got).toEqual([]);
    // The layout is restored; what could not be migrated is kept as it was for later snapshots.
    expect(ws.getState().nodes.size).toBe(2);
    // The extension that took back its state is captured as it is now; the two that could not
    // take theirs back are held, their state from the snapshot kept, never captured over.
    const again = await p.capture();
    expect(again.document.extensions['ext.notes']).toEqual({
      version: 2,
      data: { from: 'ext.notes' },
    });
    expect(again.document.extensions['ext.stuck']).toEqual({ version: 1, data: { v: 1 } });
    expect(again.document.extensions['ext.future']).toEqual({ version: 5, data: { v: 5 } });
    expect(again.failures.map((f) => [f.id, f.error.details?.['reason']])).toEqual([
      ['ext.stuck', 'held'],
      ['ext.future', 'held'],
    ]);
  });

  it('reports an extension that fails to take back its state, and keeps the layout restored', async () => {
    const text = await savedWith((p) => {
      p.registerExtension(extension('ext.broken'));
      p.registerExtension(extension('ext.slow'));
    });
    const ws = workspace();
    const p = createPersistence({ workspace: ws.persistence(), hookTimeoutMs: 20 });
    p.registerExtension(
      extension('ext.broken', {
        restore: () => {
          throw new Error('cannot open');
        },
      }),
    );
    p.registerExtension(extension('ext.slow', { restore: () => new Promise(() => undefined) }));
    const outcome = restored(await p.restore(text));
    expect(outcome.failures.map((f) => [f.id, f.error.message])).toEqual([
      ['ext.broken', 'extension "ext.broken" failed to restore its state: cannot open'],
      ['ext.slow', 'extension "ext.slow" did not restore its state within 20 ms'],
    ]);
    expect(ws.getState().nodes.size).toBe(2);
    // Their state from the snapshot stays in later snapshots until a restore they take back.
    const again = await p.capture();
    expect(again.document.extensions['ext.broken']?.data).toEqual({ from: 'ext.broken' });
    expect(again.failures.map((f) => f.id)).toEqual(['ext.broken', 'ext.slow']);
  });
});

interface Placed {
  id: string;
  transform: { position: number[]; rotation: number[] };
}

describe('migrations (MIG-003, MIG-004)', () => {
  /** A host's earlier layout format: windows by name with a position, nothing else. */
  const legacy = {
    schema: 'host.legacy-layout/1',
    windows: [
      { name: 'Notes', x: -1, y: 0.2, z: -3 },
      { name: 'Board', x: 1, y: 0, z: -3 },
    ],
  };
  const converter: SchemaMigration = {
    from: 'host.legacy-layout/1',
    to: SNAPSHOT_SCHEMA_ID,
    migrate(document) {
      const windows = [
        ...(document['windows'] as { name: string; x: number; y: number; z: number }[]),
      ];
      // The step changes its own copy freely.
      (document as { windows: unknown[] }).windows.length = 0;
      return {
        document: {
          schema: SNAPSHOT_SCHEMA_ID,
          engine: 'host.converter/1',
          createdAt: 0,
          workspaceId: 'legacy',
          revision: 0,
          rootIds: windows.map((_, i) => `w${String(i)}`),
          nodes: windows.map((w, i) => ({
            id: `w${String(i)}`,
            kind: 'window',
            parentId: null,
            childIds: [],
            surfaceIds: [],
            transform: { position: [w.x, w.y, w.z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
            bounds: [1.6, 0.9, 0.01],
            flags: {
              visible: true,
              selectable: true,
              draggable: true,
              resizable: true,
              rotatable: true,
              pointerEnabled: true,
              locked: false,
              presentationPriority: 0,
            },
            label: w.name,
            tags: [],
            metadata: {},
            status: 'active',
            createdAt: 0,
            updatedAt: 0,
          })),
          surfaces: [],
          cameras: [],
          viewports: [],
          orbitRootId: null,
          selection: [],
          focusedId: null,
          policies: {},
          extensions: {},
        },
        warnings: ['window sizes were not recorded; they are the default 1.6 × 0.9'],
      };
    },
  };

  it('steps swf.workspace/1 to /2, standing each window and surface upright and saying which', () => {
    expect(SNAPSHOT_MIGRATIONS.map((m) => [m.from, m.to])).toEqual([
      ['swf.workspace/1', 'swf.workspace/2'],
    ]);
    const v1 = JSON.parse(fixtureOf(1, 'layout.json')) as {
      nodes: Placed[];
      surfaces: Placed[];
    };
    // A surface turned on its window, too.
    const viewer = v1.surfaces.find((surface) => surface.id === 'viewer-view');
    if (viewer === undefined) {
      throw new Error('no viewer-view in the fixture');
    }
    viewer.transform.rotation = [0, 0.6, 0, 0.8];
    const before = new Map(v1.nodes.map((n) => [n.id, n.transform]));
    const migrated = migrateDocument(v1);
    expect(migrated).toMatchObject({
      sourceVersion: 'swf.workspace/1',
      targetVersion: 'swf.workspace/2',
      steps: [
        {
          from: 'swf.workspace/1',
          to: 'swf.workspace/2',
          warnings: [
            'window "editor" was turned, which a card does not show: it stands upright now',
            'surface "viewer-view" was turned, which a card does not show: it stands upright now',
          ],
        },
      ],
    });
    const after = new Map(migrated.document.nodes.map((n) => [n.id, n.transform]));
    expect(after.get('editor')?.rotation).toEqual([0, 0, 0, 1]);
    expect(
      migrated.document.surfaces.find((surface) => surface.id === 'viewer-view')?.transform
        .rotation,
    ).toEqual([0, 0, 0, 1]);
    // Where each stands is kept; a group keeps its rotation, turning its windows round the camera.
    expect(after.get('editor')?.position).toEqual(before.get('editor')?.position);
    expect(after.get('desk')).toEqual(before.get('desk'));
    // The document given is not changed.
    expect(viewer.transform.rotation).toEqual([0, 0.6, 0, 0.8]);
    expect(() => migrateDocument({ schema: 'swf.workspace/0' })).toThrow(/is not supported/);
  });

  it('runs a step on a copy of its own, recording source, target and warnings', async () => {
    const frozen = JSON.parse(JSON.stringify(legacy)) as typeof legacy;
    Object.freeze(frozen.windows);
    const migrated = migrateDocument(frozen, { migrations: [converter] });
    expect(frozen.windows).toHaveLength(2);
    expect(migrated).toMatchObject({
      sourceVersion: 'host.legacy-layout/1',
      targetVersion: SNAPSHOT_SCHEMA_ID,
      steps: [
        {
          from: 'host.legacy-layout/1',
          to: SNAPSHOT_SCHEMA_ID,
          warnings: [expect.stringMatching(/window sizes/)],
        },
      ],
    });
    expect(migrated.document.nodes.map((n) => n.label)).toEqual(['Notes', 'Board']);
    // Restoring through it.
    const ws = workspace();
    const p = persistenceOf(ws, { migrations: [converter] });
    const outcome = restored(await p.restore(JSON.stringify(legacy)));
    expect(outcome).toMatchObject({
      sourceVersion: 'host.legacy-layout/1',
      warnings: [expect.stringMatching(/window sizes/)],
    });
    expect([...ws.getState().nodes.values()].map((n) => n.label)).toEqual(['Notes', 'Board']);
  });

  it('fails without changing anything when a step throws, writes another format or a bad result', async () => {
    const ws = layout();
    const before = ws.getState();
    const cases: [SchemaMigration['migrate'], Record<string, unknown>][] = [
      [
        () => {
          throw new Error('unreadable');
        },
        {
          code: 'MIGRATION_FAILED',
          details: { sourceVersion: 'host.legacy-layout/1', from: 'host.legacy-layout/1' },
        },
      ],
      [
        () => ({ document: { schema: 'swf.workspace/7' } }),
        { code: 'MIGRATION_FAILED', path: 'schema' },
      ],
      [
        () => ({ document: { schema: SNAPSHOT_SCHEMA_ID } }),
        { code: 'SNAPSHOT_INVALID', details: { sourceVersion: 'host.legacy-layout/1' } },
      ],
    ];
    for (const [migrate, expected] of cases) {
      const p = persistenceOf(ws, { migrations: [{ ...converter, migrate }] });
      expect(rejectedWith(await p.restore(legacy))).toMatchObject(expected);
    }
    // A chain that leads back to where it started is not followed forever.
    const loop: SchemaMigration[] = [
      { from: 'a/1', to: 'b/1', migrate: (d) => ({ document: { ...d, schema: 'b/1' } }) },
      { from: 'b/1', to: 'a/1', migrate: (d) => ({ document: { ...d, schema: 'a/1' } }) },
    ];
    expect(() => migrateDocument({ schema: 'a/1' }, { migrations: loop })).toThrow(
      /is not supported/,
    );
    expect(ws.getState()).toBe(before);
  });

  /** A workspace restored from `text`, and the snapshot it writes back. */
  const roundTrip = async (text: string) => {
    const createdAt = (JSON.parse(text) as { createdAt: number }).createdAt;
    const ws = createWorkspace({
      id: 'restored',
      projectionKinds: [PANORAMA, { id: 'fixture.pano/1', configIssue: () => null }],
    });
    const p = createPersistence({ workspace: ws.persistence(), now: () => createdAt });
    const outcome = restored(await p.restore(text));
    return { outcome, again: p.export((await p.capture()).document) };
  };
  const withoutId = (text: string) => text.replace(/"workspaceId":"[^"]*"/, '');

  it('reads every swf.workspace/2 fixture and writes it back byte for byte', async () => {
    const names = Object.keys(fixtures[2]).map((path) => path.split('/').at(-1));
    expect(names).toEqual(['empty.json', 'extensions.json', 'layout.json']);
    for (const name of names) {
      const fixture = fixtureOf(2, name ?? '');
      const { outcome, again } = await roundTrip(fixture);
      expect(outcome.failures, name).toEqual([]);
      expect(withoutId(again), name).toBe(withoutId(fixture));
    }
  });

  it('restores every swf.workspace/1 fixture as its swf.workspace/2 fixture', async () => {
    const names = Object.keys(fixtures[1]).map((path) => path.split('/').at(-1));
    expect(names).toEqual(['empty.json', 'extensions.json', 'layout.json']);
    for (const name of names) {
      const { outcome, again } = await roundTrip(fixtureOf(1, name ?? ''));
      expect(outcome.sourceVersion, name).toBe('swf.workspace/1');
      expect(withoutId(again), name).toBe(withoutId(fixtureOf(2, name ?? '')));
    }
  });
});
