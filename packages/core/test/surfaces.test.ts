import type { Vec3 } from '@swf/math';
import { mat4ApproxEquals, mat4TransformPoint, quatFromAxisAngle, ray } from '@swf/math';
import { describe, expect, it } from 'vitest';
import type { GeometryProvider, SceneCommand, SurfaceSpec } from '../src/index.js';
import { surfaceEffectiveState, surfaceWorldMatrix, worldMatrix } from '../src/index.js';
import { at, committed, expectClose, makeWorkspace, record, rejected, window } from './helpers.js';

function surface(id: string, ownerNodeId: string, extra: Partial<SurfaceSpec> = {}): SceneCommand {
  return {
    type: 'surface.attach',
    surface: {
      id,
      ownerNodeId,
      bindingKey: `key-${id}`,
      adapterTypeId: 'host.view/1',
      bounds: [1.6, 0.9, 0.01],
      ...extra,
    },
  };
}

describe('surface associations', () => {
  it('attaches zero or more surfaces to a node, in slot order, with documented defaults', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('w')));
    expect(ws.getState().nodes.get('w')?.surfaceIds).toEqual([]);
    committed(
      ws.transaction([surface('a', 'w'), surface('b', 'w'), surface('c', 'w', { index: 0 })]),
    );
    const state = ws.getState();
    expect(state.nodes.get('w')?.surfaceIds).toEqual(['c', 'a', 'b']);
    expect(state.surfaces.get('a')).toMatchObject({
      ownerNodeId: 'w',
      bindingKey: 'key-a',
      adapterTypeId: 'host.view/1',
      transform: { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      geometry: { kind: 'rect', params: null },
      interaction: 'content',
      label: null,
    });
  });

  it('places each surface relative to its owner, independently and with any rotation', () => {
    const ws = makeWorkspace();
    const tilt = {
      position: [0.5, 0.2, 0.1] as Vec3,
      rotation: quatFromAxisAngle([1, 1, 0], 0.7),
      scale: [1, 1, 1] as Vec3,
    };
    committed(
      ws.transaction([
        window('w', { transform: at([0, 0, -3], Math.PI / 2) }),
        surface('s', 'w', { transform: tilt }),
        surface('t', 'w'),
      ]),
    );
    const owner = worldMatrix(ws.getState().nodes, 'w');
    const s = surfaceWorldMatrix(ws.getState(), 's');
    expect(s).toBeDefined();
    expectClose(
      mat4TransformPoint(s ?? ([] as never), [0, 0, 0]),
      mat4TransformPoint(owner ?? ([] as never), [0.5, 0.2, 0.1]),
    );
    committed(ws.dispatch({ type: 'node.patch', id: 'w', transform: at([2, 0, -3]) }));
    expectClose(
      mat4TransformPoint(surfaceWorldMatrix(ws.getState(), 't') ?? ([] as never), [0, 0, 0]),
      [2, 0, -3],
    );
    expect(ws.getState().surfaces.get('s')?.transform.rotation).toEqual(
      Object.freeze([...tilt.rotation]),
    );
  });

  it('shares one ID space with nodes and validates its fields by path', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(window('w')));
    expect(rejected(ws.dispatch(surface('w', 'w'))).error.message).toMatch(/already in use/);
    const bad = (extra: Partial<SurfaceSpec>) =>
      rejected(ws.dispatch(surface('s', 'w', extra))).error.path;
    expect(bad({ adapterTypeId: 'video' })).toBe('commands[0].surface.adapterTypeId');
    expect(bad({ adapterTypeId: 'host.video/0' })).toBe('commands[0].surface.adapterTypeId');
    expect(bad({ bindingKey: ' ' })).toBe('commands[0].surface.bindingKey');
    expect(bad({ bounds: [1, 0, 1] })).toBe('commands[0].surface.bounds');
    expect(bad({ interaction: 'maybe' as never })).toBe('commands[0].surface.interaction');
    expect(bad({ ownerNodeId: 'nope' })).toBe('commands[0].surface.ownerNodeId');
    committed(ws.dispatch(surface('s', 'w', { bindingKey: null })));
    expect(ws.getState().surfaces.get('s')?.bindingKey).toBeNull();
  });

  it('passes binding keys through verbatim, never interpreting them', () => {
    const ws = makeWorkspace();
    const key = 'javascript:alert(1)//<script>';
    committed(ws.transaction([window('w'), surface('s', 'w', { bindingKey: key })]));
    expect(ws.getState().surfaces.get('s')?.bindingKey).toBe(key);
  });

  it('moves a surface to another node keeping its world placement, or its local one', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('a', { transform: at([1, 0, -3], 0.4) }),
        window('b', { transform: at([-2, 1, -4], -0.3) }),
        surface('s', 'a', { transform: at([0.2, 0.1, 0]) }),
      ]),
    );
    const before = surfaceWorldMatrix(ws.getState(), 's');
    committed(
      ws.dispatch({ type: 'surface.move', id: 's', ownerNodeId: 'b', keep: 'world', index: 0 }),
    );
    const state = ws.getState();
    expect(state.nodes.get('a')?.surfaceIds).toEqual([]);
    expect(state.nodes.get('b')?.surfaceIds).toEqual(['s']);
    expect(
      mat4ApproxEquals(
        surfaceWorldMatrix(state, 's') ?? ([] as never),
        before ?? ([] as never),
        1e-12,
      ),
    ).toBe(true);
    committed(ws.dispatch({ type: 'surface.move', id: 's', ownerNodeId: 'a', keep: 'local' }));
    expect(ws.getState().surfaces.get('s')?.transform).toBe(state.surfaces.get('s')?.transform);
  });

  it('rejects a keep-world move that would need shear', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('stretched', { transform: at([0, 0, 0], 0, [3, 1, 1]) }),
        window('w', { transform: at([0, 0, -2]) }),
        surface('s', 'w', { transform: at([0, 0, 0], Math.PI / 4) }),
      ]),
    );
    expect(
      rejected(
        ws.dispatch({ type: 'surface.move', id: 's', ownerNodeId: 'stretched', keep: 'world' }),
      ).error.message,
    ).toMatch(/shear/);
  });

  it('reorders surfaces, rebinds in one transaction, and detaches only the association', () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('w'), surface('a', 'w'), surface('b', 'w')]));
    committed(ws.dispatch({ type: 'surface.reorder', id: 'b', index: 0 }));
    expect(ws.getState().nodes.get('w')?.surfaceIds).toEqual(['b', 'a']);
    const events = record(ws);
    const placed = ws.getState().surfaces.get('a');
    committed(
      ws.dispatch({
        type: 'surface.rebind',
        id: 'a',
        bindingKey: 'other',
        adapterTypeId: 'host.other/2',
      }),
    );
    const rebound = ws.getState().surfaces.get('a');
    expect(rebound).toMatchObject({ bindingKey: 'other', adapterTypeId: 'host.other/2' });
    expect(rebound?.transform).toBe(placed?.transform);
    expect(events.find((e) => e.type === 'surface.rebound')?.payload).toEqual({
      surfaceId: 'a',
      previous: { bindingKey: 'key-a', adapterTypeId: 'host.view/1' },
      binding: { bindingKey: 'other', adapterTypeId: 'host.other/2' },
    });
    expect(rejected(ws.dispatch({ type: 'surface.rebind', id: 'a' } as never)).error.path).toBe(
      'commands[0].bindingKey',
    );
    committed(ws.dispatch({ type: 'surface.detach', id: 'a' }));
    expect(ws.getState().surfaces.has('a')).toBe(false);
    expect(ws.getState().nodes.get('w')?.surfaceIds).toEqual(['b']);
  });

  it('removes a deleted node’s surface associations, and only those', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('parent'),
        window('kid', { parentId: 'parent' }),
        surface('p1', 'parent'),
        surface('k1', 'kid'),
      ]),
    );
    const events = record(ws);
    committed(ws.dispatch({ type: 'node.delete', id: 'parent', mode: 'detachChildren' }));
    expect([...ws.getState().surfaces.ids()]).toEqual(['k1']);
    expect(events.filter((e) => e.type === 'surface.detached').map((e) => e.payload)).toEqual([
      { surfaceId: 'p1', ownerNodeId: 'parent' },
    ]);
    committed(ws.dispatch({ type: 'node.delete', id: 'kid', mode: 'subtree' }));
    expect(ws.getState().surfaces.size).toBe(0);
  });

  it('duplicates surfaces as layout only, unless binding keys are reused explicitly', () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('w'), surface('s', 'w', { label: 'video' })]));
    const copy = committed(
      ws.dispatch({ type: 'node.duplicate', id: 'w', ids: { w: 'w2', s: 's2' } }),
    );
    expect(copy.createdIds).toEqual(['w2', 's2']);
    expect(ws.getState().nodes.get('w2')?.surfaceIds).toEqual(['s2']);
    expect(ws.getState().surfaces.get('s2')).toMatchObject({
      ownerNodeId: 'w2',
      bindingKey: null,
      label: 'video',
    });
    const shared = committed(
      ws.dispatch({ type: 'node.duplicate', id: 'w', reuseBindingKeys: true }),
    );
    const sharedSurface = shared.createdIds[1] ?? '';
    expect(ws.getState().surfaces.get(sharedSurface)?.bindingKey).toBe('key-s');
  });

  it('blocks operator changes to a locked surface but not host changes', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([window('w'), window('v'), surface('s', 'w', { flags: { locked: true } })]),
    );
    const user = { source: 'user' } as const;
    for (const command of [
      { type: 'surface.patch', id: 's', transform: at([1, 0, 0]) },
      { type: 'surface.patch', id: 's', bounds: [2, 2, 0.01] },
      { type: 'surface.move', id: 's', ownerNodeId: 'v' },
      { type: 'surface.detach', id: 's' },
    ] as SceneCommand[]) {
      expect(rejected(ws.dispatch(command, user)).error.code).toBe('LOCKED');
    }
    committed(ws.dispatch({ type: 'surface.patch', id: 's', transform: at([1, 0, 0]) }));
  });

  it('inherits visibility from its owner', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('w'),
        surface('s', 'w'),
        surface('t', 'w', { flags: { visible: false } }),
      ]),
    );
    expect(surfaceEffectiveState(ws.getState(), 's')).toEqual({
      active: true,
      visible: true,
      selectable: true,
    });
    expect(surfaceEffectiveState(ws.getState(), 't')?.visible).toBe(false);
    committed(ws.dispatch({ type: 'node.archive', id: 'w' }));
    expect(surfaceEffectiveState(ws.getState(), 's')).toEqual({
      active: false,
      visible: false,
      selectable: false,
    });
  });

  it('undoes and redoes surface changes exactly, including a cascade through node deletion', () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('w'), surface('s', 'w')]));
    const before = ws.getState();
    committed(ws.dispatch({ type: 'node.delete', id: 'w', mode: 'subtree' }));
    expect(ws.getState().surfaces.size).toBe(0);
    const events = record(ws);
    committed(ws.undo());
    expect(ws.getState().surfaces.get('s')).toBe(before.surfaces.get('s'));
    expect(ws.getState().nodes.get('w')).toBe(before.nodes.get('w'));
    expect(events.map((e) => e.type)).toEqual([
      'node.created',
      'surface.attached',
      'node.childrenChanged',
      'transaction.committed',
    ]);
    committed(ws.redo());
    expect(ws.getState().surfaces.size).toBe(0);
    expect(ws.history().at(-1)).toMatchObject({
      commandTypes: ['node.delete'],
      changedSurfaceIds: ['s'],
    });
  });

  it('reports surface changes in commit events', () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('w'), window('v')]));
    const events = record(ws);
    committed(ws.transaction([surface('s', 'w'), surface('t', 'w')]));
    expect(events.map((e) => e.type)).toEqual([
      'surface.attached',
      'surface.attached',
      'node.surfacesChanged',
      'transaction.committed',
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      changedSurfaceIds: ['s', 't'],
      createdIds: ['s', 't'],
    });
    events.length = 0;
    committed(
      ws.transaction([
        { type: 'surface.move', id: 's', ownerNodeId: 'v' },
        {
          type: 'surface.patch',
          id: 't',
          transform: at([0, 1, 0]),
          label: 'T',
          interaction: 'none',
        },
      ]),
    );
    expect(events.map((e) => e.type)).toEqual([
      'surface.moved',
      'surface.transformCommitted',
      'surface.updated',
      'node.surfacesChanged',
      'node.surfacesChanged',
      'transaction.committed',
    ]);
    expect(events[2]?.payload).toEqual({ surfaceId: 't', fields: ['interaction', 'label'] });
  });
});

describe('surface geometry', () => {
  it('validates polygons against the surface bounds and the vertex limit', () => {
    const ws = makeWorkspace({ geometryLimits: { maxPolygonVertices: 4 } });
    committed(ws.dispatch(window('w')));
    const bad = (params: unknown) =>
      rejected(
        ws.dispatch(
          surface('s', 'w', {
            bounds: [2, 2, 0.01],
            geometry: { kind: 'polygon', params: params as never },
          }),
        ),
      ).error.message;
    expect(
      bad({
        points: [
          [0, 0],
          [1, 0],
        ],
      }),
    ).toMatch(/at least 3/);
    expect(
      bad({
        points: [
          [0, 0],
          [1, 0],
          [0, 1.5],
        ],
      }),
    ).toMatch(/outside the surface bounds/);
    // A bow tie with non-zero area: edges 0 and 2 cross.
    expect(
      bad({
        points: [
          [-1, -1],
          [1, 1],
          [1, -1],
          [-1, 0.5],
        ],
      }),
    ).toMatch(/edges 0 and 2 cross/);
    expect(
      bad({
        points: [
          [0, 0],
          [1, 0],
          [0.5, 0],
          [0.2, 0],
        ],
      }),
    ).toMatch(/no area|cross/);
    expect(
      bad({
        points: [
          [-1, -1],
          [1, -1],
          [1, 0],
          [1, 1],
          [-1, 1],
        ],
      }),
    ).toMatch(/more than the limit of 4/);
    expect(bad({ vertices: [] })).toMatch(/exactly one field/);
    committed(
      ws.dispatch(
        surface('s', 'w', {
          bounds: [2, 2, 0.01],
          geometry: {
            kind: 'polygon',
            params: {
              points: [
                [-1, -1],
                [1, -1],
                [0, 1],
              ],
            },
          },
        }),
      ),
    );
    const unfit = rejected(
      ws.dispatch({ type: 'surface.patch', id: 's', bounds: [1, 1, 0.01] }),
    ).error;
    expect(unfit.path).toBe('commands[0].bounds');
    expect(unfit.message).toMatch(/does not fit the surface's polygon geometry: .*outside/);
  });

  it('rejects unregistered kinds, oversized params and non-JSON params', () => {
    const ws = makeWorkspace({ geometryLimits: { maxParamsBytes: 64 } });
    committed(ws.dispatch(window('w')));
    expect(
      rejected(ws.dispatch(surface('s', 'w', { geometry: { kind: 'host.sphere', params: null } })))
        .error.message,
    ).toMatch(/not registered/);
    expect(
      rejected(ws.dispatch(surface('s', 'w', { geometry: { kind: 'rect', params: { a: 1 } } })))
        .error.message,
    ).toMatch(/takes no params/);
    const huge = { points: Array.from({ length: 40 }, (_, i) => [i / 100, 0]) };
    expect(
      rejected(ws.dispatch(surface('s', 'w', { geometry: { kind: 'polygon', params: huge } })))
        .error.message,
    ).toMatch(/more than the maxParamsBytes limit of 64/);
    expect(
      rejected(
        ws.dispatch(
          surface('s', 'w', {
            geometry: { kind: 'polygon', params: { points: [[NaN, 0]] } },
          }),
        ),
      ).error.path,
    ).toBe('commands[0].surface.geometry.params.points[0][0]');
  });

  it('resolves geometry for rendering and picking: world placement, normal and top-left UVs', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('w', { transform: at([0, 0, -3]) }),
        surface('s', 'w', { bounds: [2, 1, 0.01] }),
      ]),
    );
    const geometry = ws.surfaceGeometry('s');
    expect(geometry).toMatchObject({ kind: 'rect', supported: true, fidelity: 'exact' });
    expectClose(geometry?.normal ?? [], [0, 0, 1]);
    const hit = geometry?.intersect(ray([-0.5, 0.25, 0], [0, 0, -1]));
    expect(hit?.distance).toBeCloseTo(3, 12);
    expectClose(hit?.uv ?? [], [0.25, 0.25]);
    expect(geometry?.intersect(ray([1.5, 0, 0], [0, 0, -1]))).toBeNull();
    expect(geometry?.intersect(ray([0, 0, 0], [0, 0, 1]))).toBeNull();
  });

  it('picks through the polygon only, with UVs over the surface rectangle', () => {
    const ws = makeWorkspace();
    committed(
      ws.transaction([
        window('w'),
        surface('s', 'w', {
          bounds: [2, 2, 0.01],
          geometry: {
            kind: 'polygon',
            params: {
              points: [
                [-1, -1],
                [1, -1],
                [-1, 1],
              ],
            },
          },
        }),
      ]),
    );
    const geometry = ws.surfaceGeometry('s');
    expect(geometry?.intersect(ray([-0.5, -0.5, 1], [0, 0, -1]))?.uv).toEqual([0.25, 0.75]);
    expect(geometry?.intersect(ray([0.5, 0.5, 1], [0, 0, -1]))).toBeNull();
    expect(geometry?.localBounds).toEqual({ min: [-1, -1, -0.005], max: [1, 1, 0.005] });
  });

  it('uses a registered geometry kind, and falls back to an approximate rectangle without it', () => {
    let calls = 0;
    const strip: GeometryProvider = {
      kind: 'host.strip',
      fidelity: 'approximate',
      validate: (params) =>
        typeof params === 'number' && params > 0 && params <= 1
          ? null
          : 'params must be a fraction',
      localBounds: (params, bounds) => ({
        min: [-bounds[0] / 2, -((params as number) * bounds[1]) / 2, 0],
        max: [bounds[0] / 2, ((params as number) * bounds[1]) / 2, 0],
      }),
      normal: () => [0, 0, 1],
      intersect: () => {
        calls += 1;
        return null;
      },
    };
    const ws = makeWorkspace({ geometry: [strip] });
    committed(ws.dispatch(window('w')));
    expect(
      rejected(ws.dispatch(surface('s', 'w', { geometry: { kind: 'host.strip', params: 2 } })))
        .error.message,
    ).toMatch(/fraction/);
    committed(ws.dispatch(surface('s', 'w', { geometry: { kind: 'host.strip', params: 0.5 } })));
    const geometry = ws.surfaceGeometry('s');
    expect(geometry).toMatchObject({ supported: true, fidelity: 'approximate' });
    geometry?.intersect(ray([0, 0, 1], [0, 0, -1]));
    expect(calls).toBe(1);
    const other = makeWorkspace();
    const remove = other.registerGeometry(strip);
    committed(
      other.transaction([
        window('w'),
        surface('s', 'w', { geometry: { kind: 'host.strip', params: 0.5 } }),
      ]),
    );
    remove();
    const fallback = other.surfaceGeometry('s');
    expect(fallback).toMatchObject({
      supported: false,
      fidelity: 'approximate',
      kind: 'host.strip',
    });
    expect(fallback?.intersect(ray([0, 0, 1], [0, 0, -1]))).not.toBeNull();
  });

  it('refuses resizing a surface whose geometry kind is no longer registered, naming its bounds', () => {
    const strip: GeometryProvider = {
      kind: 'host.strip',
      fidelity: 'approximate',
      validate: (params) => (typeof params === 'number' ? null : 'params must be a number'),
      localBounds: (_params, bounds) => ({
        min: [-bounds[0] / 2, -bounds[1] / 2, 0],
        max: [bounds[0] / 2, bounds[1] / 2, 0],
      }),
      normal: () => [0, 0, 1],
      intersect: () => null,
    };
    const ws = makeWorkspace();
    const remove = ws.registerGeometry(strip);
    committed(
      ws.transaction([
        window('w'),
        surface('s', 'w', { geometry: { kind: 'host.strip', params: 0.5 } }),
      ]),
    );
    remove();
    const refused = rejected(
      ws.dispatch({ type: 'surface.patch', id: 's', bounds: [2, 2, 0.01] }),
    ).error;
    expect(refused).toMatchObject({ code: 'INVALID_INPUT', path: 'commands[0].bounds' });
    expect(refused.message).toMatch(/geometry kind "host\.strip".*not registered/);
    expect(ws.getState().surfaces.get('s')?.bounds).toEqual([1.6, 0.9, 0.01]);
    // A new geometry in the same command is checked on its own, so the resize goes through.
    committed(
      ws.dispatch({
        type: 'surface.patch',
        id: 's',
        bounds: [2, 2, 0.01],
        geometry: { kind: 'rect', params: null },
      }),
    );
    expect(ws.getState().surfaces.get('s')).toMatchObject({
      bounds: [2, 2, 0.01],
      geometry: { kind: 'rect', params: null },
    });
  });

  it('reads a command’s own fields only, never inherited ones', () => {
    const ws = makeWorkspace();
    committed(ws.transaction([window('w'), surface('s', 'w')]));
    const inherited = Object.assign(Object.create({ params: null }) as object, { kind: 'rect' });
    expect(
      rejected(ws.dispatch(surface('t', 'w', { geometry: inherited as never }))).error,
    ).toMatchObject({ code: 'INVALID_INPUT', path: 'commands[0].surface.geometry.params' });
    const rebind = Object.assign(Object.create({ bindingKey: 'inherited' }) as object, {
      type: 'surface.rebind',
      id: 's',
    });
    expect(rejected(ws.dispatch(rebind as never)).error).toMatchObject({
      code: 'INVALID_INPUT',
      path: 'commands[0].bindingKey',
    });
    expect(ws.getState().surfaces.get('s')?.bindingKey).toBe('key-s');
  });

  it('refuses a geometry limit named after a prototype member', () => {
    for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const limits = JSON.parse(`{"${name}": 1}`) as Record<string, number>;
      expect(() => makeWorkspace({ geometryLimits: limits })).toThrow(
        `geometryLimits.${name} is not a known limit`,
      );
    }
  });

  it('rejects geometry providers that are not namespaced, taken or malformed', () => {
    const ws = makeWorkspace();
    const provider = {
      kind: 'sphere',
      fidelity: 'exact',
      validate: () => null,
      localBounds: () => ({ min: [0, 0, 0], max: [0, 0, 0] }),
      normal: () => null,
      intersect: () => null,
    } as GeometryProvider;
    expect(() => ws.registerGeometry(provider)).toThrow(/namespaced/);
    expect(() => ws.registerGeometry({ ...provider, kind: 'polygon' })).toThrow(/namespaced/);
    ws.registerGeometry({ ...provider, kind: 'host.sphere' });
    expect(() => ws.registerGeometry({ ...provider, kind: 'host.sphere' })).toThrow(
      /already registered/,
    );
    expect(() =>
      ws.registerGeometry({ ...provider, kind: 'host.cube', fidelity: 'perfect' as never }),
    ).toThrow(/fidelity/);
  });

  it('isolates a geometry provider that throws as a rejected transaction', () => {
    const ws = makeWorkspace({
      geometry: [
        {
          kind: 'host.bad',
          fidelity: 'exact',
          validate: () => {
            throw new Error('boom');
          },
          localBounds: () => ({ min: [0, 0, 0], max: [1, 1, 1] }),
          normal: () => null,
          intersect: () => null,
        },
      ],
    });
    committed(ws.dispatch(window('w')));
    expect(
      rejected(ws.dispatch(surface('s', 'w', { geometry: { kind: 'host.bad', params: null } })))
        .error.message,
    ).toMatch(/geometry provider "host\.bad": its validate threw: boom/);
  });
});
