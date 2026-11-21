/// <reference types="vite/client" />
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { SceneCommand, Workspace } from '@swf/core';
import { SwfFailure, worldMatrix } from '@swf/core';
import { quatFromAxisAngle } from '@swf/math';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { WorkspaceDocument } from '../src/index.js';
import {
  parseDocument,
  SNAPSHOT_ENGINE,
  SNAPSHOT_SCHEMA,
  SNAPSHOT_SCHEMA_ID,
  snapshotLimits,
  validateDocument,
} from '../src/index.js';
import schemaFile from '../src/schema/swf.workspace-1.schema.json?raw';
import { commit, edited, layout, persistenceOf, REMOVE, workspace } from './fixtures.js';

const schemaAccepts = new Ajv2020({ strict: true, allowUnionTypes: true }).compile(SNAPSHOT_SCHEMA);

async function captured(ws: Workspace = layout()): Promise<WorkspaceDocument> {
  return (await persistenceOf(ws).capture()).document;
}

/** The validator's failure for a value: its code and path, or null when it accepts. */
function verdict(value: unknown, limits = snapshotLimits()) {
  try {
    validateDocument(value, limits);
    return null;
  } catch (error) {
    if (error instanceof SwfFailure) {
      return { code: error.error.code, path: error.error.path, message: error.message };
    }
    throw error;
  }
}

describe('the snapshot format (FR-160, FR-161, DATA-014, DATA-018, §15.2)', () => {
  it('holds the scene, its views and bindingKeys with the format, engine and time', async () => {
    const document = await captured();
    expect(document).toMatchObject({
      schema: SNAPSHOT_SCHEMA_ID,
      engine: SNAPSHOT_ENGINE,
      createdAt: 5000,
      workspaceId: 'ws',
      revision: 1,
      rootIds: ['a'],
      orbitRootId: 'a',
      focusedId: 'a',
      policies: {},
      extensions: {},
    });
    expect(document.nodes.map((n) => [n.id, n.parentId, n.childIds])).toEqual([
      ['a', null, ['b']],
      ['b', 'a', []],
    ]);
    expect(document.nodes[0]).toMatchObject({
      label: 'Notes',
      metadata: { 'host.colour': 'teal' },
    });
    expect(document.surfaces[0]).toMatchObject({
      bindingKey: 'editor-42',
      adapterTypeId: 'host.editor/1',
    });
    expect(document.cameras[0]?.position).toEqual([0, 1.6, 0]);
    expect(document.viewports[0]).toMatchObject({ mode: 'panorama', size: { width: 1600 } });
    expect(Object.keys(document)).toEqual([
      'schema',
      'engine',
      'createdAt',
      'workspaceId',
      'revision',
      'rootIds',
      'nodes',
      'surfaces',
      'cameras',
      'viewports',
      'orbitRootId',
      'selection',
      'focusedId',
      'policies',
      'extensions',
    ]);
  });

  it('exports canonical text that imports back to the same snapshot', async () => {
    const p = persistenceOf(layout());
    const { document } = await p.capture();
    const text = p.export(document);
    expect(p.import(text)).toEqual(document);
    expect(p.export(p.import(text))).toBe(text);
    // Two captures of an unchanged workspace differ in nothing but what the clock says.
    expect(p.export((await p.capture()).document)).toBe(text);
  });
});

describe('the published schema and the validator (SEC-011, DATA-018)', () => {
  it('is published as a file, identical to the exported schema', () => {
    const file = JSON.parse(schemaFile) as unknown;
    expect(file).toEqual(SNAPSHOT_SCHEMA);
    expect(SNAPSHOT_SCHEMA['properties']).toMatchObject({ schema: { const: SNAPSHOT_SCHEMA_ID } });
  });

  it('accepts what a workspace produces, as the schema does', async () => {
    const document = await captured();
    expect(schemaAccepts(JSON.parse(JSON.stringify(document)))).toBe(true);
    expect(verdict(document)).toBeNull();
  });

  it('rejects, with the schema, every malformed field, naming the path', async () => {
    const document = await captured();
    const cases: [string, unknown, string][] = [
      ['schema', 'swf.workspace/2', 'schema'],
      ['engine', 'swf persistence', 'engine'],
      ['createdAt', -1, 'createdAt'],
      ['revision', 1.5, 'revision'],
      ['nodes.0.id', ' ', 'nodes[0].id'],
      ['nodes.0.kind', 3, 'nodes[0].kind'],
      ['nodes.0.bounds', [1, 0, 1], 'nodes[0].bounds'],
      ['nodes.0.transform.scale', [1, -1, 1], 'nodes[0].transform.scale'],
      ['nodes.0.transform.rotation', [0, 0, 1], 'nodes[0].transform.rotation'],
      ['nodes.0.flags.visible', 'yes', 'nodes[0].flags.visible'],
      ['nodes.0.status', 'deleted', 'nodes[0].status'],
      ['nodes.0.tags', ['x', 'x'], 'nodes[0].tags[1]'],
      ['nodes.0.metadata', { colour: 'teal' }, 'nodes[0].metadata.colour'],
      ['nodes.0.metadata', { 'swf.owned': 1 }, 'nodes[0].metadata.swf.owned'],
      [
        'nodes.0.metadata',
        { 'host.x': { constructor: 1 } },
        'nodes[0].metadata.host.x.constructor',
      ],
      ['nodes.0.handle', {}, 'nodes[0].handle'],
      ['nodes.0.label', REMOVE, 'nodes[0].label'],
      ['surfaces.0.bindingKey', '', 'surfaces[0].bindingKey'],
      ['surfaces.0.adapterTypeId', 'editor', 'surfaces[0].adapterTypeId'],
      ['surfaces.0.interaction', 'all', 'surfaces[0].interaction'],
      ['surfaces.0.geometry.params', REMOVE, 'surfaces[0].geometry.params'],
      ['cameras.0.near', 0, 'cameras[0].near'],
      ['viewports.0.size.devicePixelRatio', 0, 'viewports[0].size.devicePixelRatio'],
      ['viewports.0.navigation', 'fly', 'viewports[0].navigation'],
      ['viewports.0.renderer', 'dom', 'viewports[0].renderer'],
      ['selection', ['a', 'a'], 'selection[1]'],
      ['policies', { interaction: {} }, 'policies.interaction'],
      ['extensions', { notes: { version: 1, data: 1 } }, 'extensions.notes'],
      ['extensions', { 'ext.notes': { version: 0, data: 1 } }, 'extensions.ext.notes.version'],
      ['extensions', { 'ext.notes': { version: 1 } }, 'extensions.ext.notes.data'],
      [
        'extensions',
        { 'ext.notes': { version: 1, data: 1, extra: 1 } },
        'extensions.ext.notes.extra',
      ],
      ['runtime', { handle: 1 }, 'runtime'],
      ['viewports', REMOVE, 'viewports'],
    ];
    for (const [path, value, expected] of cases) {
      const broken = edited(document, [path, value]);
      expect(schemaAccepts(broken), `the schema accepted ${path}`).toBe(false);
      expect(verdict(broken), path).toMatchObject({ code: 'SNAPSHOT_INVALID', path: expected });
    }
  });

  it('rejects, beyond the schema, what it states only in words: rotations, references, cycles and sizes', async () => {
    const document = await captured();
    const cases: [readonly (readonly [string, unknown])[], string, RegExp][] = [
      [
        [['nodes.0.transform.rotation', [0, 0, 0, 2]]],
        'nodes[0].transform.rotation',
        /unit quaternion/,
      ],
      [[['cameras.0.far', 0.01]], 'cameras[0].far', /greater than near/],
      [[['cameras.0.id', 'a']], 'cameras[0].id', /repeats the ID "a"/],
      [[['nodes.1.parentId', 'gone']], 'nodes[0].childIds[0]', /parentId is not "a"/],
      [[['surfaces.0.ownerNodeId', 'b']], 'nodes[0].surfaceIds[0]', /whose owner is "b"/],
      [[['viewports.0.cameraId', 'gone']], 'viewports[0].cameraId', /missing camera/],
      [
        [
          ['rootIds', []],
          ['nodes.0.parentId', 'b'],
          ['nodes.1.childIds', ['a']],
        ],
        'nodes[0].parentId',
        /cycle of the hierarchy/,
      ],
    ];
    for (const [edits, path, message] of cases) {
      const broken = edited(document, ...edits);
      expect(schemaAccepts(broken), path).toBe(true);
      const v = verdict(broken);
      expect(v, path).toMatchObject({ code: 'SNAPSHOT_INVALID', path });
      expect(v?.message).toMatch(message);
    }
    // Extension data over its namespace's limit.
    const limits = snapshotLimits({ extensionBytes: 16, extensionTotalBytes: 24 });
    const big = edited(document, [
      'extensions',
      { 'ext.notes': { version: 1, data: 'x'.repeat(20) } },
    ]);
    expect(schemaAccepts(big)).toBe(true);
    expect(verdict(big, limits)).toMatchObject({
      code: 'SNAPSHOT_INVALID',
      path: 'extensions.ext.notes.data',
      message: expect.stringMatching(/22 bytes, over the limit of 16 per namespace/) as unknown,
    });
    const two = edited(document, [
      'extensions',
      {
        'ext.a': { version: 1, data: 'x'.repeat(11) },
        'ext.b': { version: 1, data: 'y'.repeat(11) },
      },
    ]);
    expect(verdict(two, limits)).toMatchObject({ path: 'extensions.ext.b.data' });
  });

  it('reads text safely: size first, then syntax, non-finite numbers, deep nesting and the prototype', async () => {
    const document = await captured();
    const text = JSON.stringify(document);
    const fail = (input: unknown, limits = snapshotLimits()) => {
      try {
        parseDocument(input, limits);
      } catch (error) {
        if (error instanceof SwfFailure) {
          return error.error;
        }
        throw error;
      }
      throw new Error('accepted');
    };
    expect(fail(text, snapshotLimits({ maxBytes: 100 }))).toMatchObject({
      code: 'SNAPSHOT_INVALID',
      details: { limit: 100 },
    });
    expect(fail('{"schema":')).toMatchObject({
      code: 'SNAPSHOT_INVALID',
      message: expect.stringMatching(/is not JSON/) as unknown,
    });
    expect(fail(text.replace('"createdAt":5000', '"createdAt":1e999'))).toMatchObject({
      path: 'createdAt',
    });
    expect(fail(text.replace('"position":[0,1.6,0]', '"position":[0,1e400,0]'))).toMatchObject({
      path: 'cameras[0].position',
    });
    const deep = '['.repeat(100) + ']'.repeat(100);
    expect(
      fail(text.replace('"extensions":{}', `"extensions":{"ext.x":{"version":1,"data":${deep}}}`)),
    ).toMatchObject({
      message: expect.stringMatching(/nests deeper than 64 levels/) as unknown,
    });
    const polluted = text.replace(
      '"extensions":{}',
      '"extensions":{"ext.x":{"version":1,"data":{"__proto__":{"polluted":true}}}}',
    );
    expect(fail(polluted)).toMatchObject({ path: 'extensions.ext.x.data.__proto__' });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(
      fail(text.replace('"schema":"swf.workspace/1"', '"schema":"swf.workspace/0"')),
    ).toMatchObject({
      path: 'schema',
      details: { sourceVersion: 'swf.workspace/0' },
    });
    expect(fail(42)).toMatchObject({ code: 'SNAPSHOT_INVALID' });
  });
});

describe('round trips (NFR-012)', () => {
  const coordinate = fc.double({ min: -1000, max: 1000, noNaN: true });
  const windowArb = fc.record({
    parent: fc.nat(),
    position: fc.tuple(coordinate, coordinate, coordinate),
    axis: fc.constantFrom([0, 1, 0] as const, [1, 0, 0] as const, [0.6, 0, 0.8] as const),
    angle: fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
    scale: fc.tuple(
      fc.double({ min: 0.1, max: 10, noNaN: true }),
      fc.double({ min: 0.1, max: 10, noNaN: true }),
      fc.double({ min: 0.1, max: 10, noNaN: true }),
    ),
    size: fc.double({ min: 0.01, max: 10, noNaN: true }),
    surface: fc.boolean(),
    note: fc.option(
      fc.oneof(fc.string(), fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true })),
    ),
  });

  it('keeps the graph, every transform and every ID, within 1e-9', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(windowArb, { minLength: 1, maxLength: 10 }), async (windows) => {
        const ws = workspace();
        const commands: SceneCommand[] = windows.flatMap((w, i): SceneCommand[] => {
          const parentIndex = w.parent % (i + 1);
          return [
            {
              type: 'node.create',
              node: {
                id: `n${String(i)}`,
                kind: 'window',
                parentId: parentIndex === i ? null : `n${String(parentIndex)}`,
                bounds: [w.size, w.size, 0.01],
                transform: {
                  position: w.position,
                  rotation: quatFromAxisAngle(w.axis, w.angle),
                  scale: w.scale,
                },
                ...(w.note === null ? {} : { metadata: { 'host.note': w.note } }),
              },
            },
            ...(w.surface
              ? [
                  {
                    type: 'surface.attach' as const,
                    surface: {
                      id: `s${String(i)}`,
                      ownerNodeId: `n${String(i)}`,
                      bindingKey: `key-${String(i)}`,
                      adapterTypeId: 'host.view/1',
                      bounds: [w.size, w.size, 0.01] as [number, number, number],
                    },
                  },
                ]
              : []),
          ];
        });
        commit(ws, commands);
        const p = persistenceOf(ws);
        const back = p.import(p.export((await p.capture()).document));
        const live = ws.getState();
        expect(back.nodes.map((n) => n.id).sort()).toEqual(
          [...live.nodes.values()].map((n) => n.id).sort(),
        );
        expect(back.rootIds).toEqual(live.rootIds);
        const nodes = new Map(back.nodes.map((n) => [n.id, n]));
        for (const node of live.nodes.values()) {
          const stored = nodes.get(node.id);
          expect(stored?.parentId).toBe(node.parentId);
          expect(stored?.childIds).toEqual(node.childIds);
          expect(stored?.surfaceIds).toEqual(node.surfaceIds);
          const close = (a: readonly number[] | undefined, b: readonly number[]) =>
            b.every((v, k) => Math.abs((a?.[k] ?? NaN) - v) <= 1e-9);
          expect(close(stored?.transform.position, node.transform.position)).toBe(true);
          expect(close(stored?.transform.rotation, node.transform.rotation)).toBe(true);
          expect(close(stored?.transform.scale, node.transform.scale)).toBe(true);
          // And where the node ends up in the world, too.
          const lookup = {
            get: (id: string) => nodes.get(id),
            has: (id: string) => nodes.has(id),
            size: nodes.size,
            values: () => nodes.values(),
          };
          const a = worldMatrix(lookup, node.id) ?? [];
          const b = worldMatrix(live.nodes, node.id) ?? [];
          expect(
            a.every((v, k) => Math.abs(v - (b[k] ?? NaN)) <= 1e-9 * Math.max(1, Math.abs(v))),
          ).toBe(true);
        }
        expect(back.surfaces.map((s) => [s.id, s.ownerNodeId, s.bindingKey])).toEqual(
          [...live.surfaces.values()]
            .map((s) => [s.id, s.ownerNodeId, s.bindingKey])
            .sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
        );
      }),
      { numRuns: 150 },
    );
  });
});
