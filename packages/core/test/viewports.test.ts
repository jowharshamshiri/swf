import { describe, expect, it } from 'vitest';
import type { JsonValue, ProjectionKind, SceneCommand, ViewportSpec } from '../src/index.js';
import { SwfFailure } from '../src/index.js';
import { committed, makeWorkspace, record, rejected, window } from './helpers.js';

/** A projection kind taking `{ fov }` in degrees, in (0, 360]. */
const pano: ProjectionKind = {
  id: 'test.pano/1',
  configIssue: (config: JsonValue) => {
    const fov =
      typeof config === 'object' && config !== null && !Array.isArray(config)
        ? (config as Readonly<Record<string, JsonValue>>)['fov']
        : undefined;
    return typeof fov === 'number' && fov > 0 && fov <= 360 ? null : 'needs fov in (0, 360]';
  },
};

const camera = (id: string, extra: Record<string, unknown> = {}): SceneCommand => ({
  type: 'camera.create',
  camera: { id, ...extra },
});

const viewport = (id: string, extra: Partial<ViewportSpec> = {}): SceneCommand => ({
  type: 'viewport.create',
  viewport: {
    id,
    cameraId: 'cam',
    projection: { id: 'test.pano/1', config: { fov: 360 } },
    size: { width: 800, height: 400, devicePixelRatio: 2 },
    ...extra,
  },
});

const workspace = () => makeWorkspace({ projectionKinds: [pano] });

describe('cameras and viewports', () => {
  it('creates them with documented defaults and reports each as view-state events', () => {
    const ws = workspace();
    const events = record(ws);
    committed(ws.transaction([camera('cam'), viewport('v')]));
    const state = ws.getState();
    expect(state.cameras.get('cam')).toMatchObject({
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      near: 0.05,
      far: null,
      label: null,
    });
    expect(state.viewports.get('v')).toMatchObject({
      cameraId: 'cam',
      projection: { id: 'test.pano/1', config: { fov: 360 } },
      mode: 'panorama',
      size: { width: 800, height: 400, devicePixelRatio: 2 },
      navigation: 'camera',
      renderer: null,
      compositor: null,
    });
    expect(events.map((e) => e.type)).toEqual([
      'camera.created',
      'viewport.created',
      'transaction.committed',
    ]);
    events.length = 0;
    committed(
      ws.transaction([
        { type: 'camera.patch', id: 'cam', rotation: [0, 0.7071069, 0, 0.7071069], far: 100 },
        { type: 'viewport.patch', id: 'v', size: { width: 400, height: 200, devicePixelRatio: 1 } },
      ]),
    );
    // A rotation within tolerance of unit length is stored renormalized.
    const [x, y, z, w] = ws.getState().cameras.get('cam')?.rotation ?? [];
    expect(Math.abs(Math.hypot(x ?? 0, y ?? 0, z ?? 0, w ?? 0) - 1)).toBeLessThan(1e-15);
    expect(y).toBeCloseTo(Math.SQRT1_2, 12);
    expect(events.slice(0, 2).map((e) => e.payload)).toEqual([
      { cameraId: 'cam', fields: ['rotation', 'far'] },
      { viewportId: 'v', fields: ['size'] },
    ]);
  });

  it('keeps a copy of the projection configuration, not the caller’s object', () => {
    const ws = workspace();
    const config = { fov: 180 };
    committed(
      ws.transaction([camera('cam'), viewport('v', { projection: { id: 'test.pano/1', config } })]),
    );
    config.fov = 9999;
    expect(ws.getState().viewports.get('v')?.projection.config).toEqual({ fov: 180 });
    expect(Object.isFrozen(ws.getState().viewports.get('v')?.projection.config)).toBe(true);
  });

  it('rejects invalid cameras and viewports, naming the field', () => {
    const ws = workspace();
    committed(ws.transaction([camera('cam'), window('w')]));
    const bad = (command: SceneCommand) => rejected(ws.dispatch(command)).error;
    expect(bad(camera('c2', { near: 0 })).path).toBe('commands[0].camera.near');
    expect(bad(camera('c2', { near: 1, far: 1 })).path).toBe('commands[0].camera.far');
    expect(bad(camera('c2', { rotation: [0, 0, 0, 0] })).path).toBe('commands[0].camera.rotation');
    expect(bad(camera('w')).path).toBe('commands[0].camera.id');
    expect(bad({ type: 'camera.patch', id: 'cam', near: 5, far: 4 }).path).toBe('commands[0].far');
    committed(ws.dispatch({ type: 'camera.patch', id: 'cam', far: 10 }));
    expect(bad({ type: 'camera.patch', id: 'cam', near: 10 }).path).toBe('commands[0].near');

    expect(bad(viewport('v', { cameraId: 'none' }))).toMatchObject({
      code: 'UNKNOWN_ENTITY',
      path: 'commands[0].viewport.cameraId',
    });
    const unknownKind = bad(viewport('v', { projection: { id: 'other/1', config: null } }));
    expect(unknownKind).toMatchObject({
      code: 'INVALID_INPUT',
      path: 'commands[0].viewport.projection.id',
    });
    const badConfig = bad(viewport('v', { projection: { id: 'test.pano/1', config: { fov: 0 } } }));
    expect(badConfig.path).toBe('commands[0].viewport.projection.config');
    expect(badConfig.message).toContain('needs fov in (0, 360]');
    expect(
      bad(viewport('v', { projection: { id: 'test.pano/1' } as ViewportSpec['projection'] })).path,
    ).toBe('commands[0].viewport.projection.config');
    expect(bad(viewport('v', { size: { width: 0, height: 1, devicePixelRatio: 1 } })).path).toMatch(
      /^commands\[0\]\.viewport\.size/,
    );
    expect(bad(viewport('v', { navigation: 'fly' as never })).path).toBe(
      'commands[0].viewport.navigation',
    );
    expect(bad(viewport('v', { renderer: 'webgl' })).path).toBe('commands[0].viewport.renderer');
    expect(ws.getState().viewports.size).toBe(0);
  });

  it('keeps one ID space across nodes, surfaces, cameras and viewports', () => {
    const ws = workspace();
    committed(ws.transaction([window('w'), camera('cam'), viewport('v')]));
    expect(rejected(ws.dispatch(window('cam'))).error.path).toBe('commands[0].node.id');
    expect(rejected(ws.dispatch(viewport('w'))).error.path).toBe('commands[0].viewport.id');
    expect(rejected(ws.dispatch(camera('v'))).error.path).toBe('commands[0].camera.id');
  });

  it('refuses to delete a camera a viewport still uses', () => {
    const ws = workspace();
    committed(ws.transaction([camera('cam'), viewport('v')]));
    expect(rejected(ws.dispatch({ type: 'camera.delete', id: 'cam' })).error.message).toContain(
      'viewport "v"',
    );
    committed(
      ws.transaction([
        { type: 'viewport.delete', id: 'v' },
        { type: 'camera.delete', id: 'cam' },
      ]),
    );
    expect(ws.getState().cameras.size).toBe(0);
  });

  it('treats camera and viewport changes as view state: never undone, never touching the layout', () => {
    const ws = workspace();
    committed(ws.dispatch(window('w')));
    const node = ws.getState().nodes.get('w');
    committed(ws.transaction([camera('cam'), viewport('v')]));
    committed(ws.dispatch({ type: 'camera.patch', id: 'cam', position: [1, 2, 3] }));
    committed(
      ws.dispatch({
        type: 'viewport.patch',
        id: 'v',
        projection: { id: 'test.pano/1', config: { fov: 90 } },
      }),
    );
    expect(ws.getState().nodes.get('w')).toBe(node);
    expect(ws.history()).toHaveLength(1);
    expect(ws.undo().status).toBe('committed');
    const state = ws.getState();
    expect(state.nodes.has('w')).toBe(false);
    expect(state.cameras.get('cam')?.position).toEqual([1, 2, 3]);
    expect(state.viewports.get('v')?.projection.config).toEqual({ fov: 90 });
    expect(ws.canUndo()).toBe(false);
  });
});

describe('workspace orbit root', () => {
  it('is set to an existing node or null, and reported with the previous value', () => {
    const ws = workspace();
    committed(ws.transaction([window('a'), window('b')]));
    const events = record(ws);
    committed(ws.dispatch({ type: 'orbitRoot.set', nodeId: 'a' }));
    committed(ws.dispatch({ type: 'orbitRoot.set', nodeId: 'b' }));
    expect(ws.getState().orbitRootId).toBe('b');
    expect(events.filter((e) => e.type === 'orbitRoot.changed').map((e) => e.payload)).toEqual([
      { nodeId: 'a', previous: null },
      { nodeId: 'b', previous: 'a' },
    ]);
    expect(rejected(ws.dispatch({ type: 'orbitRoot.set', nodeId: 'none' })).error).toMatchObject({
      code: 'UNKNOWN_ENTITY',
      path: 'commands[0].nodeId',
    });
    committed(ws.dispatch({ type: 'orbitRoot.set', nodeId: null }));
    expect(ws.getState().orbitRootId).toBeNull();
  });

  it('is cleared when its node is deleted, and not restored by undoing the deletion', () => {
    const ws = workspace();
    committed(ws.transaction([window('a'), { type: 'orbitRoot.set', nodeId: 'a' }]));
    const events = record(ws);
    committed(ws.dispatch({ type: 'node.delete', id: 'a', mode: 'subtree' }));
    expect(ws.getState().orbitRootId).toBeNull();
    expect(events.find((e) => e.type === 'orbitRoot.changed')?.payload).toEqual({
      nodeId: null,
      previous: 'a',
    });
    committed(ws.undo());
    expect(ws.getState().nodes.has('a')).toBe(true);
    expect(ws.getState().orbitRootId).toBeNull();
  });
});

describe('projection kinds', () => {
  it('are registered on the workspace and withdrawn by the returned function', () => {
    const ws = makeWorkspace();
    committed(ws.dispatch(camera('cam')));
    expect(rejected(ws.dispatch(viewport('v'))).error.path).toBe(
      'commands[0].viewport.projection.id',
    );
    const remove = ws.registerProjectionKind(pano);
    committed(ws.dispatch(viewport('v')));
    remove();
    expect(rejected(ws.dispatch(viewport('v2'))).error.path).toBe(
      'commands[0].viewport.projection.id',
    );
    // A viewport created while the kind was registered keeps its setting.
    expect(ws.getState().viewports.get('v')?.projection.id).toBe('test.pano/1');
  });

  it('reject malformed kinds and taken IDs as invalid input', () => {
    const ws = workspace();
    const code = (kind: unknown) => {
      try {
        ws.registerProjectionKind(kind as ProjectionKind);
      } catch (error) {
        return error instanceof SwfFailure ? error.error.code : String(error);
      }
      return 'registered';
    };
    expect(code(pano)).toBe('INVALID_INPUT');
    expect(code(null)).toBe('INVALID_INPUT');
    expect(code({ id: 'pano', configIssue: () => null })).toBe('INVALID_INPUT');
    expect(code({ id: 'x/1' })).toBe('INVALID_INPUT');
    expect(code({ id: 'x/1', configIssue: () => null })).toBe('registered');
    expect(() => makeWorkspace({ projectionKinds: [pano, pano] })).toThrow(SwfFailure);
  });

  it('report a configuration check that throws as an invalid configuration', () => {
    const ws = makeWorkspace({
      projectionKinds: [
        {
          id: 'broken/1',
          configIssue: () => {
            throw new Error('boom');
          },
        },
      ],
    });
    committed(ws.dispatch(camera('cam')));
    const error = rejected(
      ws.dispatch(viewport('v', { projection: { id: 'broken/1', config: null } })),
    ).error;
    expect(error.path).toBe('commands[0].viewport.projection.config');
    expect(error.message).toContain('boom');
  });
});
